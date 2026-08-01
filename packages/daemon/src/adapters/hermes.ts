import fs from "node:fs";
import path from "node:path";
import { displayVendorPath, resolveOperatorVendorHome } from "@useparley/core";
import type {
  AdapterEnforcement,
  HubInfo,
  MaterializedFile,
  ModelEntry,
  ProbedModels,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
} from "./types.js";
import { VENDOR_DIAG_PREFIX, withPostureDiagnostics } from "./types.js";

/** Hermes: WRITE_SAFE_ROOT soft FS; no local network filter (#279). */
const HERMES_ENFORCEMENT: AdapterEnforcement = {
  "read-only": {
    level: "approximate",
    via: "HERMES_WRITE_SAFE_ROOT limited to private home (terminal may still write)",
  },
  workspace: {
    level: "approximate",
    via: "HERMES_WRITE_SAFE_ROOT=worktree+gitdirs",
  },
  full: { level: "enforced", via: "unset HERMES_WRITE_SAFE_ROOT" },
  "network:false": { level: "none", via: "local backend has no egress filter" },
};

/**
 * The `hermes` vendor adapter — real delegation to Nous Research Hermes Agent
 * (`hermes` binary, v0.17.0 surface; docs/research/hermes-cli-automation.md).
 *
 * Hermes has **no streaming JSONL event surface** (research LOUD CAVEAT / §2).
 * Quiet mode emits final assistant text on stdout and a `session_id: …` line on
 * stderr. The engine dual-feeds stdout **and** stderr into `parseEvent` (#107),
 * so the stderr session line is captured without adapter buffering. This adapter
 * is files-heavy like grok: materialize a private `HERMES_HOME` under the
 * worktree (config.yaml with MCP hub + posture + effort), spawn
 * `hermes chat --quiet`, and synthesize thin `VendorEvent`s from plain text
 * lines.
 *
 * Capability limit (#107 major): quiet mode has **no** live tool/command/usage
 * stream. Progress is opaque (message lines only); usage only if a JSON usage
 * row appears (synthetic fixture / future export). Switching to `hermes acp`
 * or post-exit `state.db` scrape would be a larger redesign — left as documented
 * residual.
 *
 * Sandbox fidelity is partial (research §5): Hermes has no Codex-style
 * `--sandbox` matrix. We map posture via `HERMES_WRITE_SAFE_ROOT` +
 * `terminal.backend: local` and always force `--yolo` / `approvals.mode: off`.
 * Local backend has **no OS-level network filter**; `network:false` is a
 * documented residual gap (docker air-gap would require a different lifecycle).
 *
 * `listModels` is omitted — `hermes model` is interactive only (research §7).
 * Model discovery uses `readModels` against the operator's curated
 * `model_catalog.json` cache (#283).
 */

/** Default binary; override via `PARLEY_HERMES_BIN` (smoke tests, custom installs). */
const DEFAULT_HERMES_BIN = "hermes";

/**
 * Private Hermes home relative to the task cwd. Isolated from the operator's
 * `~/.hermes` so children never write sessions/skills/memory into the user
 * install (research §3 / risk #8). Must be stable across prepare→resume so
 * `--resume` finds the same SQLite `state.db`. Also the isolation-marker
 * segment `resolveOperatorVendorHome` refuses for discovery reads.
 */
export const HERMES_HOME_REL = path.join(".parley", "hermes-home");

/**
 * Headroom added to the answer timeout when raising Hermes' per-tool MCP
 * timeout (`mcp_servers.*.timeout`, default 300s — research §3). Same
 * load-bearing concern as codex's `tool_timeout_sec`.
 */
const TOOL_TIMEOUT_HEADROOM_SEC = 60;

/**
 * Provider auth env vars named in research §6. Forward only when set in the
 * parent — no universal `HERMES_API_KEY`.
 */
const AUTH_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
] as const;

// Control chars for YAML string escaping (same approach as toml.ts).
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  "g",
);

/**
 * Double-quoted YAML scalar. Escapes backslash, quote, and control characters
 * so a hub URL or header value cannot inject an extra config line.
 */
function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(CONTROL_CHARS, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

function toolTimeoutSec(answerTimeoutMs: number): number {
  return Math.ceil(answerTimeoutMs / 1000) + TOOL_TIMEOUT_HEADROOM_SEC;
}

function hermesHomeAbs(cwd: string): string {
  return path.join(cwd, HERMES_HOME_REL);
}

/**
 * Map Parley posture → Hermes write-root + config terminal block (research §5).
 *
 * Fidelity notes (documented gaps, not full Codex parity):
 * - **read-only**: `HERMES_WRITE_SAFE_ROOT` limited to the private home so
 *   `write_file`/`patch` cannot touch the worktree. Terminal can still write
 *   on the local backend (research: "Poor without docker").
 * - **workspace**: safe root = worktree + private/common gitdirs + HERMES_HOME
 *   so `git commit` works (same grant pattern as codex writable_roots).
 * - **full**: unset `HERMES_WRITE_SAFE_ROOT` (unrestricted host user access).
 * - **network:false**: local backend has no egress filter. We do not flip to
 *   docker here (different mount/cwd semantics; research residual gap).
 */
function postureEnv(task: TaskSpec, homeAbs: string): Record<string, string> {
  const env: Record<string, string> = {};
  switch (task.sandbox) {
    case "read-only":
      // Only Hermes state is writable via write_file/patch tools.
      env.HERMES_WRITE_SAFE_ROOT = homeAbs;
      break;
    case "workspace": {
      const roots = [
        task.cwd,
        homeAbs,
        ...(task.gitDir !== undefined ? [task.gitDir] : []),
        ...(task.gitCommonDir !== undefined ? [task.gitCommonDir] : []),
      ];
      env.HERMES_WRITE_SAFE_ROOT = [...new Set(roots)].join(":");
      break;
    }
    case "full":
      // Unset — do not put HERMES_WRITE_SAFE_ROOT in env.
      break;
  }
  return env;
}

/**
 * Materialized `$HERMES_HOME/config.yaml` (research §3, §5, §6, §9 checklist).
 * Carries MCP hub injection (no CLI MCP flags), approvals off, optional
 * reasoning effort, and local terminal backend.
 */
function configYaml(task: TaskSpec, hub: HubInfo): string {
  const lines: string[] = [
    "# Generated by parley — do not edit; regenerated on every (re)spawn.",
    "approvals:",
    "  mode: off",
    "agent:",
    "  max_turns: 90",
  ];
  // Effort has no CLI flag on v0.17.0 (research §6) — config only.
  if (task.effort !== null) {
    lines.push(`  reasoning_effort: ${yamlString(task.effort)}`);
  }
  lines.push(
    "terminal:",
    "  backend: local",
    // UNKNOWN(research): docker_network only applies to docker backend; local
    // has no OS-level network sandbox (research §5). Residual host egress when
    // task.network is false.
    "mcp_servers:",
    "  parley:",
    `    url: ${yamlString(hub.url)}`,
    "    headers:",
  );
  for (const [key, value] of Object.entries(hub.headers)) {
    // Quote both key and value so arbitrary header names stay valid YAML.
    lines.push(`      ${yamlString(key)}: ${yamlString(value)}`);
  }
  lines.push(
    `    timeout: ${toolTimeoutSec(task.answerTimeoutMs)}`,
    "    connect_timeout: 15",
    "    enabled: true",
    "",
  );
  return lines.join("\n");
}

/** Provider keys from research §6 — only when present on the parent env. */
function authEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of AUTH_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Auth / provider failure markers seen on quiet stdout (research §2 VERIFIED
 * auth-failure sample) and other run-terminal error shapes from §9 table.
 */
function isFatalErrorText(text: string): boolean {
  return (
    /No inference provider configured/i.test(text) ||
    /^Error:\s/i.test(text) ||
    /hermes -z:\s*agent failed:/i.test(text) ||
    /agent failed:/i.test(text)
  );
}

// ---------------------------------------------------------------------------
// Model discovery (#283) — on-disk catalog is hermes' only live channel.
// ---------------------------------------------------------------------------

/**
 * Versioned curated catalog under `$HERMES_HOME/cache/model_catalog.json`
 * (hermes_cli/model_catalog.py). Schema v1: `version`, `updated_at`,
 * `providers.<name>.models[]` with `id`, optional `description`, optional
 * boolean `default`. No efforts of any kind.
 */
const MODEL_CATALOG_REL = path.join("cache", "model_catalog.json");

/**
 * Per-provider `/v1/models` cache at `$HERMES_HOME/provider_models_cache.json`
 * (hermes_cli/models.py). The curated manifest is a *superset* of what the
 * operator can actually run (tier / tool-call filtering happens at runtime);
 * when this cache is present and readable we prefer the intersection.
 */
const PROVIDER_MODELS_CACHE_FILE = "provider_models_cache.json";

/** Cap on model_catalog.json — real manifests are a few KB; leave headroom. */
export const HERMES_MODEL_CATALOG_MAX_BYTES = 2 * 1024 * 1024;

/** Cap on provider_models_cache.json (best-effort cross-check only). */
export const HERMES_PROVIDER_MODELS_CACHE_MAX_BYTES = 2 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

/**
 * Build the catalog `source` string for a manifest read, including version
 * and freshness stamp when present (caches can be arbitrarily stale).
 * `catalogPath` should already be tilde-collapsed when written to models.json.
 * Never includes credential material.
 */
export function hermesModelsCatalogSource(
  catalogPath: string,
  version: number | null,
  updatedAt: string | null,
): string {
  const parts: string[] = [];
  if (version !== null) parts.push(`version=${version}`);
  if (updatedAt !== null && updatedAt !== "") parts.push(`updated_at=${updatedAt}`);
  if (parts.length === 0) return catalogPath;
  return `${catalogPath} (${parts.join(", ")})`;
}

/**
 * Compose ModelEntry.notes from description + per-provider default markers.
 * `default` marks a default *model* for a provider — never a default effort
 * (`default_effort` stays null). Surfaces via notes deliberately rather than
 * inventing a ModelEntry field (#283).
 */
function hermesModelNotes(
  description: string | undefined,
  defaultFor: readonly string[],
): string | undefined {
  const parts: string[] = [];
  if (description !== undefined && description !== "") parts.push(description);
  if (defaultFor.length > 0) {
    parts.push(`default_for=${defaultFor.join(",")}`);
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}

/** One curated row with its originating provider (for per-provider intersect). */
export type HermesCatalogRow = {
  provider: string;
  id: string;
  description?: string;
  isDefault: boolean;
};

/**
 * Parse hermes' on-disk `model_catalog.json` (#283). Fail-soft for callers:
 * never throws. Distinguishes usable empty (`error: null`, e.g. providers
 * with no models / empty providers map) from present-but-unusable (`error`
 * set — malformed JSON or unexpected shape).
 *
 * Secret hygiene: walks only `version`, `updated_at`, and
 * `providers.*.models[]` fields (`id` / `description` / `default`). Never
 * returns, logs, or re-serializes free-form `metadata` (fixtures plant a
 * dummy secret there).
 *
 * Efforts: always empty; `default_effort` always null. Do not fabricate.
 *
 * Same model id may appear under multiple providers (observed openrouter ∩
 * nous). Rows stay one-per-(provider, model) so per-provider intersection
 * with `provider_models_cache.json` is exact; {@link hermesRowsToModelEntries}
 * then collapses by id and unions `default_for` markers.
 */
export function parseHermesModelCatalog(json: string): {
  rows: HermesCatalogRow[];
  models: ModelEntry[];
  version: number | null;
  updatedAt: string | null;
  /** Non-null when the file content is present but unusable. */
  error: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      rows: [],
      models: [],
      version: null,
      updatedAt: null,
      error: "malformed model_catalog.json",
    };
  }
  const root = asRecord(parsed);
  if (!root) {
    return {
      rows: [],
      models: [],
      version: null,
      updatedAt: null,
      error: "unexpected model_catalog.json shape",
    };
  }
  const version = typeof root.version === "number" ? root.version : null;
  const updatedAt = typeof root.updated_at === "string" ? root.updated_at : null;
  const providers = root.providers;
  if (providers === undefined) {
    // Valid JSON without providers is empty/fresh — not an error.
    return { rows: [], models: [], version, updatedAt, error: null };
  }
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    return {
      rows: [],
      models: [],
      version,
      updatedAt,
      error: "unexpected model_catalog.json shape",
    };
  }
  const rows: HermesCatalogRow[] = [];
  for (const [providerName, rawBlock] of Object.entries(
    providers as Record<string, unknown>,
  )) {
    if (providerName === "") continue;
    const block = asRecord(rawBlock);
    if (!block) continue;
    const models = block.models;
    if (!Array.isArray(models)) continue;
    for (const raw of models) {
      const m = asRecord(raw);
      if (!m) continue;
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (id === "") continue;
      const description = typeof m.description === "string" ? m.description : undefined;
      rows.push({
        provider: providerName,
        id,
        ...(description === undefined ? {} : { description }),
        isDefault: m.default === true,
      });
    }
  }
  return {
    rows,
    models: hermesRowsToModelEntries(rows),
    version,
    updatedAt,
    error: null,
  };
}

/**
 * Project curated rows into ModelEntry values. Empty efforts; null
 * default_effort. Per-provider `default` lands in notes as
 * `default_for=<provider>` — never in `default_effort`.
 *
 * Same model id under multiple providers (observed openrouter ∩ nous) is
 * collapsed to one entry so `refreshCatalog`'s by-id merge does not silently
 * drop a provider's default marker: `default_for` lists are unioned in
 * provider order of first appearance, and the first non-empty description
 * wins. Row count after collapse can be less than the raw 41+32 sum when
 * the curated lists overlap; fixtures used for the 73-count acceptance
 * check use non-overlapping ids.
 */
export function hermesRowsToModelEntries(rows: readonly HermesCatalogRow[]): ModelEntry[] {
  const byId = new Map<string, { description?: string; defaultFor: string[] }>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (existing === undefined) {
      byId.set(row.id, {
        ...(row.description === undefined || row.description === ""
          ? {}
          : { description: row.description }),
        defaultFor: row.isDefault ? [row.provider] : [],
      });
      continue;
    }
    if (
      (existing.description === undefined || existing.description === "") &&
      row.description !== undefined &&
      row.description !== ""
    ) {
      existing.description = row.description;
    }
    if (row.isDefault && !existing.defaultFor.includes(row.provider)) {
      existing.defaultFor.push(row.provider);
    }
  }
  const entries: ModelEntry[] = [];
  for (const [id, agg] of byId) {
    const notes = hermesModelNotes(agg.description, agg.defaultFor);
    entries.push({
      id,
      efforts: [],
      default_effort: null,
      ...(notes === undefined ? {} : { notes }),
    });
  }
  return entries;
}

/**
 * Parse `provider_models_cache.json` into a map of provider → model id set.
 * Fail-soft: malformed / unexpected → empty map (caller falls back to the
 * full manifest). Never surfaces credential fingerprints (`fp`) or raw body.
 */
export function parseHermesProviderModelsCache(json: string): {
  byProvider: Map<string, Set<string>>;
  /** Non-null when the file is present but clearly unusable. */
  error: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { byProvider: new Map(), error: "malformed provider_models_cache.json" };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { byProvider: new Map(), error: "unexpected provider_models_cache.json shape" };
  }
  const byProvider = new Map<string, Set<string>>();
  for (const [provider, raw] of Object.entries(root)) {
    if (provider === "") continue;
    const entry = asRecord(raw);
    if (!entry) continue;
    const models = entry.models;
    if (!Array.isArray(models) || models.length === 0) continue;
    const ids = new Set<string>();
    for (const item of models) {
      if (typeof item === "string" && item.trim() !== "") ids.add(item.trim());
    }
    if (ids.size > 0) byProvider.set(provider, ids);
  }
  return { byProvider, error: null };
}

/**
 * Per-provider intersection of curated rows with the provider models cache.
 *
 * When the cache has a non-empty id set for a provider, keep only that
 * provider's rows whose id is in the set. Providers absent from the cache
 * keep their full curated list (partial cache must not wipe the other
 * provider). When the cache map is empty, return rows unchanged (manifest
 * alone).
 *
 * Id-form mismatch guard: the two on-disk files do not share a verified id
 * schema (curated rows may be `vendor/model` while the runtime cache holds
 * bare API ids). If intersecting a provider that had curated models would
 * drop *every* row for that provider, keep the unfiltered curated rows
 * instead — otherwise discovery silently zeros the catalog and
 * `refreshCatalog` falls through to the empty shipped hermes entry.
 */
export function intersectHermesRowsWithProviderCache(
  rows: readonly HermesCatalogRow[],
  byProvider: Map<string, Set<string>>,
): HermesCatalogRow[] {
  if (byProvider.size === 0) return [...rows];

  const rowsByProvider = new Map<string, HermesCatalogRow[]>();
  for (const row of rows) {
    const list = rowsByProvider.get(row.provider);
    if (list === undefined) {
      rowsByProvider.set(row.provider, [row]);
    } else {
      list.push(row);
    }
  }

  const out: HermesCatalogRow[] = [];
  for (const [provider, providerRows] of rowsByProvider) {
    const allowed = byProvider.get(provider);
    if (allowed === undefined) {
      out.push(...providerRows);
      continue;
    }
    const kept = providerRows.filter((row) => allowed.has(row.id));
    // Empty intersection for a non-empty curated provider → id form mismatch;
    // fall back to that provider's full curated list rather than wiping it.
    if (kept.length === 0 && providerRows.length > 0) {
      out.push(...providerRows);
    } else {
      out.push(...kept);
    }
  }
  return out;
}

/**
 * Best-effort read of a regular file under the size cap. Returns:
 *  - `{ kind: "missing" }` on ENOENT
 *  - `{ kind: "error", message }` for oversize / non-file / unreadable
 *  - `{ kind: "ok", text }` on success
 * Never includes file body in error messages (secret hygiene).
 */
function readCappedFile(
  filePath: string,
  fileLabel: string,
  maxBytes: number,
): { kind: "missing" } | { kind: "error"; message: string } | { kind: "ok"; text: string } {
  try {
    // TOCTOU accepted: stat then read. isFile() stops the static-FIFO /
    // device hang (#288); a path swapped to FIFO between the two calls
    // can still block, and a regular file on a hung network mount blocks
    // regardless. Bound open is not portable enough for our Node target.
    const stat = fs.statSync(filePath);
    // #288: refuse non-files (FIFO, dir, device). readFileSync on a FIFO
    // blocks the daemon event loop forever — treat as present-but-unusable
    // so refreshCatalog can warn and fall through.
    if (!stat.isFile()) {
      return { kind: "error", message: `${fileLabel} is not a regular file` };
    }
    if (stat.size > maxBytes) {
      return {
        kind: "error",
        message: `${fileLabel} exceeds size cap (${maxBytes} bytes)`,
      };
    }
    return { kind: "ok", text: fs.readFileSync(filePath, "utf8") };
  } catch (err) {
    if (isEnoent(err)) return { kind: "missing" };
    const message = err instanceof Error ? err.message : String(err);
    // Never append file body; fs errors may embed the path (collapsed later
    // by refreshCatalog via collapseOperatorHomeInText).
    return { kind: "error", message };
  }
}

/**
 * Optional post-hoc usage JSON (research §8 schema shape). Quiet mode never
 * emits this; parseEvent still normalizes it if a line looks like a session
 * usage row (or a test fixture / future sessions-export pipe).
 */
function tryParseUsageLine(line: string): VendorEvent[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  // Require at least one harness usage field so random JSON is not treated as usage.
  const harnessKeys = [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "estimated_cost_usd",
  ] as const;
  if (!harnessKeys.some((k) => typeof obj[k] === "number")) return null;

  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number" && key !== "id") usage[key] = value;
  }
  // Canonical keys when derivable from Hermes field names (research §8 / task).
  if (typeof obj.input_tokens === "number") usage.input_tokens = obj.input_tokens;
  if (typeof obj.output_tokens === "number") usage.output_tokens = obj.output_tokens;
  // cache_read_tokens is Hermes' cached-input analogue → cached_tokens.
  if (typeof obj.cache_read_tokens === "number") {
    usage.cache_read_tokens = obj.cache_read_tokens;
    usage.cached_tokens = obj.cache_read_tokens;
  }
  const session_id = typeof obj.id === "string" ? obj.id : undefined;
  return [{ kind: "session_meta", session_id, usage }];
}

export function createHermesAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_HERMES_BIN ?? DEFAULT_HERMES_BIN;

  /** Env shared by prepare and resume: isolation, yolo, write root, auth. */
  function baseEnv(task: TaskSpec): Record<string, string> {
    const homeAbs = hermesHomeAbs(task.cwd);
    return {
      HERMES_HOME: homeAbs,
      // Belt-and-braces with --yolo / --accept-hooks (research §5).
      HERMES_YOLO_MODE: "1",
      HERMES_ACCEPT_HOOKS: "1",
      ...postureEnv(task, homeAbs),
      ...authEnv(env),
    };
  }

  function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
    return [
      {
        path: path.join(HERMES_HOME_REL, "config.yaml"),
        contents: configYaml(task, hub),
      },
    ];
  }

  /**
   * Flags after `hermes chat` and before `-q <prompt>`: quiet headless posture,
   * optional model, optional resume session, then extraArgs (TaskSpec contract —
   * never after the prompt value).
   */
  function flagArgs(task: TaskSpec, resumeSessionId: string | undefined): string[] {
    const argv: string[] = [
      "chat",
      "--quiet",
      "--yolo",
      "--accept-hooks",
      "--source",
      "tool",
    ];
    if (resumeSessionId !== undefined) {
      argv.push("--resume", resumeSessionId);
    }
    if (task.model !== null) {
      argv.push("-m", task.model);
    }
    // extraArgs in the flags region before -q (research §9 / TaskSpec contract).
    argv.push(...task.extraArgs);
    return argv;
  }

  function spawnPlan(
    task: TaskSpec,
    hub: HubInfo,
    resumeSessionId: string | undefined,
  ): SpawnPlan {
    return {
      argv: [bin, ...flagArgs(task, resumeSessionId), "-q", task.prompt],
      env: baseEnv(task),
      files: files(task, hub),
      cwd: task.cwd,
    };
  }

  return withPostureDiagnostics({
    id: "hermes",
    childChannel: "mcp",
    enforcement: HERMES_ENFORCEMENT,

    prepare(task, hub): Promise<SpawnPlan> {
      // Fresh headless one-shot (research §2 / §9):
      //   hermes chat --quiet --yolo --accept-hooks --source tool -q <prompt>
      // Do NOT use `hermes -z` (no session id). Do NOT pass `--worktree` /
      // `--safe-mode` / `--ignore-user-config` (research §9 risks).
      return Promise.resolve(spawnPlan(task, hub, undefined));
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (research §4): same HERMES_HOME + --resume <id>.
      // Without a session id, hermes would start fresh or --continue the wrong
      // concurrent session — reject like grok.
      if (task.sessionId === undefined) {
        return Promise.reject(new Error(`hermes resume for task ${task.id} has no session id`));
      }
      return Promise.resolve(spawnPlan(task, hub, task.sessionId));
    },

    parseEvent(line: string): VendorEvent[] {
      // Quiet mode is plain text, not JSONL (research LOUD CAVEAT / §9 table A).
      // Unknown / empty → [] always; the raw log remains the durable record.
      if (line === "") return [];

      // stderr session line (research §2 / §4). Engine dual-feeds stderr into
      // parseEvent (#107 critical) — without that feed, sessionId() stayed
      // undefined and multi-turn resume never started.
      const sessionMatch = /^session_id:\s*(\S+)\s*$/.exec(line);
      if (sessionMatch) {
        return [{ kind: "session_meta", session_id: sessionMatch[1] }];
      }

      // Optional usage JSON (research §8) — not emitted by quiet mode live.
      const usageEvents = tryParseUsageLine(line);
      if (usageEvents !== null) return usageEvents;

      // Leading/trailing whitespace-only: opaque.
      const text = line; // keep full line for message fidelity
      if (text.trim() === "") return [];

      // Run-terminal auth / agent failures (research §2 VERIFIED + §9).
      if (isFatalErrorText(text)) {
        return [{ kind: "error", text, fatal: true }];
      }

      // Actionable integration diagnostics if Hermes ever surfaces approval
      // cancellation of our MCP tools on a text line (yolo should prevent this;
      // keep the greppable prefix if the text looks like a cancelled hub call).
      if (/mcp_parley_|submit_report|ask_orchestrator/i.test(text) && /cancel|denied|approval/i.test(text)) {
        return [
          {
            kind: "error",
            text: `${VENDOR_DIAG_PREFIX} hermes MCP/approval issue: ${text}`,
          },
        ];
      }

      // Non-empty stdout chunk → assistant message (research §9).
      return [{ kind: "message", text }];
    },

    sessionId(events: VendorEvent[]): string | undefined {
      // Last session_meta with a session_id (research §4: trust last line after
      // mid-run context compression may rotate ids).
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "session_meta" && event.session_id !== undefined) {
          return event.session_id;
        }
      }
      return undefined;
    },

    // listModels omitted: hermes model is interactive TUI only (research §7).
    // Disk channel (readModels) is the only live discovery path (#283).

    async readModels(): Promise<ProbedModels> {
      // Operator home only — resolveOperatorVendorHome refuses the adapter's
      // own isolation marker (`.parley/hermes-home` on HERMES_HOME) so a child
      // that re-invokes `parley models --refresh` cannot inject task-controlled
      // ids. Absent catalog = quiet empty; present-but-unusable rejects so
      // refresh can warn and fall through to the shipped empty entry.
      const home = resolveOperatorVendorHome("hermes", env);
      if (home === null) {
        return { source: MODEL_CATALOG_REL, models: [] };
      }
      const catalogPath = path.join(home, MODEL_CATALOG_REL);
      const sourceBase = displayVendorPath(catalogPath, env);

      const catalogRead = readCappedFile(
        catalogPath,
        "model_catalog.json",
        HERMES_MODEL_CATALOG_MAX_BYTES,
      );
      if (catalogRead.kind === "missing") {
        return {
          source: hermesModelsCatalogSource(sourceBase, null, null),
          models: [],
        };
      }
      if (catalogRead.kind === "error") {
        throw new Error(catalogRead.message);
      }

      // Secret hygiene: parse → project model keys only. Never log raw text,
      // never re-serialize metadata (dummy secrets live there in fixtures).
      const { rows, version, updatedAt, error } = parseHermesModelCatalog(catalogRead.text);
      if (error !== null) {
        throw new Error(error);
      }

      // Optional cross-check: provider_models_cache.json sits beside cache/
      // (at HERMES_HOME root). Failures here never reject — the curated
      // manifest alone is still a useful catalog when the runtime cache is
      // missing, oversize, a FIFO, or malformed.
      let filteredRows = rows;
      const providerCachePath = path.join(home, PROVIDER_MODELS_CACHE_FILE);
      const providerRead = readCappedFile(
        providerCachePath,
        PROVIDER_MODELS_CACHE_FILE,
        HERMES_PROVIDER_MODELS_CACHE_MAX_BYTES,
      );
      if (providerRead.kind === "ok") {
        const { byProvider, error: cacheError } = parseHermesProviderModelsCache(
          providerRead.text,
        );
        if (cacheError === null && byProvider.size > 0) {
          filteredRows = intersectHermesRowsWithProviderCache(rows, byProvider);
        }
        // Malformed provider cache: ignore and use full manifest (documented
        // residual — intersecting on bad data would empty a good catalog).
      }

      return {
        source: hermesModelsCatalogSource(sourceBase, version, updatedAt),
        models: hermesRowsToModelEntries(filteredRows),
      };
    },
  });
}

export const HERMES_MODEL_CATALOG_REL = MODEL_CATALOG_REL;
export const HERMES_PROVIDER_MODELS_CACHE_FILE = PROVIDER_MODELS_CACHE_FILE;
