import fs from "node:fs";
import path from "node:path";
import { displayVendorPath, resolveOperatorVendorHome } from "@useparley/core";
import type {
  AdapterEnforcement,
  HubInfo,
  MaterializedFile,
  ModelEntry,
  ProbedModels,
  SandboxMode,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
  VendorModels,
} from "./types.js";
import { VENDOR_DIAG_PREFIX, withPostureDiagnostics } from "./types.js";
import { runProbe } from "./probe.js";
import { parseToml, tomlString, type TomlTable, type TomlValue } from "./toml.js";

/**
 * The `grok` vendor adapter — real delegation to Grok Build (`grok` binary,
 * spec §9, ADR-0004/0006). Verified against grok 0.2.93 (2026-07-09); see
 * `docs/research/grok-build-cli-automation.md` for the surface and the
 * deviations noted below.
 *
 * Grok has no per-invocation MCP flag, so the hub is injected by materializing
 * `.grok/config.toml` into the task cwd via `SpawnPlan.files` (the daemon writes
 * it pre-spawn and git-excludes it from the worktree). Sandbox posture maps to
 * `GROK_SANDBOX` env profiles; approvals are force-disabled with
 * `--always-approve`; the Claude/Cursor config scanners are turned off per child
 * so the user's Claude setup never bleeds into the delegated task.
 *
 * The streaming-json event schema and exit codes are undocumented and the binary
 * auto-updates ~daily, so `--no-auto-update` pins the version and `parseEvent` is
 * deliberately tolerant: any unknown or changed line yields `[]` and the raw
 * JSONL log (the durable record) keeps it. Golden fixtures under
 * `tests/fixtures/grok/` pin the observed 0.2.93 shape.
 */

/** Default binary; override via `PARLEY_GROK_BIN` (smoke tests, custom installs). */
const DEFAULT_GROK_BIN = "grok";

/**
 * Claude-config scanners, all defaulting **on** in grok (verified in the 0.2.93
 * binary). Disabled per child so the orchestrator's own Claude Code config
 * (`~/.claude.json` MCP servers, `.claude/` rules/skills/agents/hooks) never
 * leaks into the delegated task. Parley's own canonical surface reaches grok via
 * the worktree's `AGENTS.md`/`.agents` (translated in worktree.ts), which grok
 * reads natively regardless of these flags.
 */
const CLAUDE_SCANNER_VARS = [
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
] as const;

/**
 * Disables grok's permission-rule import from the user's Claude settings
 * (`~/.claude/settings.json` and friends), which the scanner vars above do NOT
 * cover (#179): a user-scope `permissions.deny: ["NotebookEdit"]` maps onto
 * grok's `edit` tool class and denies every file mutation in the child —
 * deny > allow, so `--always-approve` cannot save it.
 *
 * This is an undocumented, underscore-private override (grok's
 * `permission/claude_settings` "first_gate"); the supported equivalent —
 * `[claude_compat] imported = true` — is only honoured in the user-scope
 * `~/.grok/config.toml`, which parley must not mutate. Verified against grok
 * 0.2.106. Re-verify on a grok bump with:
 * `_GROK_CLAUDE_MARKER_OVERRIDE=1 grok inspect` → Permissions "0 loaded"
 * (run in a cwd whose user-level Claude settings contain permission rules).
 */
const CLAUDE_PERMISSION_IMPORT_OVERRIDE = "_GROK_CLAUDE_MARKER_OVERRIDE";

/**
 * Upper bound on the preflight `grok inspect --json` permission probe (#186).
 * Most failure modes are still fail-open (tagged diagnostics). Sandboxed
 * postures that cannot start the child are fail-closed in prepare (#247).
 * Observed latency ~50ms.
 */
const INSPECT_PROBE_TIMEOUT_MS = 5000;

/**
 * Grok's sandbox-refusal signature on Linux when bubblewrap is missing or
 * unusable (verified against grok 0.2.112). Matched case-insensitively against
 * the probe's combined error text. Matching sharpens the preflight message;
 * under a sandboxed posture any non-unavailable probe failure still fails
 * prepare even when this does not match (signature-drift fallback, #247).
 */
const SANDBOX_REFUSAL_SIGNATURE =
  /bubblewrap|bwrap|mount-namespace|could not enforce its|refusing to start with denied paths/i;

/**
 * Grok honours Claude's `MCP_TIMEOUT` (ms) env **before** its own
 * `GROK_MCP_STARTUP_TIMEOUT_SECS`, so a value the orchestrator exported for its
 * own Claude MCP setup would silently govern grok children's hub-connect
 * timeout. We pin it to a deterministic value (grok's own 30s startup default)
 * so the parent's value can never leak in — the engine spreads `SpawnPlan.env`
 * over `process.env`, so overriding is the only way to neutralize it (env values
 * are strings; there is no "unset").
 */
const MCP_STARTUP_TIMEOUT_MS = "30000";

/** The name of the custom no-network sandbox profile materialized per child. */
const NO_NETWORK_PROFILE = "parley-restricted";

/**
 * Map the normalized posture (spec §8, ADR-0006 matrix) to grok's `GROK_SANDBOX`
 * mechanism. `full` maps to `off` (danger-full-access) and is inherently
 * network-on. For sandboxed modes (`workspace` / `read-only`), a custom
 * profile (materialized as `.grok/sandbox.toml`) always extends the built-in
 * base so we can grant the worktree gitdirs as extra writable paths (#278) and,
 * when `network:false`, set `restrict_network` — the only lever grok exposes
 * for network isolation.
 *
 * As of grok 0.2.112 (verified 2026-07-27), **both** built-in profiles
 * (`workspace`, `read-only`) and custom profiles are fail-closed on a host
 * whose kernel can't apply the mount-namespace deny set (e.g. no bubblewrap on
 * Linux): grok refuses to start rather than run unsandboxed. The default
 * workspace+network path therefore requires a usable bubblewrap on Linux; the
 * deliberate escape hatch is `sandbox: "full"` (`GROK_SANDBOX=off`). Parley
 * gates this in the preflight probe so the failure is an actionable prepare
 * error rather than an opaque child exit (#247).
 */
function sandboxEnv(task: TaskSpec): {
  env: Record<string, string>;
  /** The built-in profile a custom profile should extend, if any. */
  base: string | null;
} {
  switch (task.sandbox) {
    case "read-only":
      // Read-only worktree; `GROK_WRITE_FILE=0` is belt-and-braces on top of the
      // sandbox profile.
      return { env: { GROK_SANDBOX: "read-only", GROK_WRITE_FILE: "0" }, base: "read-only" };
    case "full":
      // Full access — no sandbox. Network is unrestricted; `network:false` does
      // not apply to `full` (matches the spec §8 matrix, which maps full → off).
      return { env: { GROK_SANDBOX: "off" }, base: null };
    case "workspace":
    default:
      // Write to the worktree, read elsewhere; skip the in-sandbox bash approval
      // prompt (approvals are already force-disabled).
      return {
        env: { GROK_SANDBOX: "workspace", GROK_SANDBOX_AUTO_ALLOW_BASH: "1" },
        base: "workspace",
      };
  }
}

/**
 * The `.grok/config.toml` injected into the task cwd (project scope allows
 * `[mcp_servers]`, `[plugins]`, `[permission]`). Carries the daemon's MCP hub as
 * an HTTP server with the correlation header(s), disables grok's own worktree
 * creation (parley owns the worktree), and pins the approval posture (the CLI
 * `--always-approve` is authoritative; this is belt-and-braces).
 */
function configToml(hub: HubInfo): string {
  const lines = [
    "# Generated by parley — do not edit; regenerated on every (re)spawn.",
    'new_session_worktree_mode = "never"',
    'permission_mode = "always-approve"',
    "",
    "[mcp_servers.parley]",
    'type = "http"',
    `url = ${tomlString(hub.url)}`,
  ];
  const headers = Object.entries(hub.headers);
  if (headers.length > 0) {
    lines.push("", "[mcp_servers.parley.headers]");
    for (const [key, value] of headers) {
      lines.push(`${tomlString(key)} = ${tomlString(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Deduplicated writable git metadata roots for the custom sandbox profile.
 * Both live outside the worktree cwd (git's worktree layout) and both are
 * written during `git commit` — same grant pair as codex `writable_roots`.
 * `undefined` entries (e.g. `--cwd` tasks with no parley worktree) are omitted.
 */
function gitWritableRoots(task: TaskSpec): string[] {
  return [...new Set([task.gitDir, task.gitCommonDir].filter((r): r is string => r !== undefined))];
}

/**
 * A custom sandbox profile that extends a built-in base. Materialized for every
 * sandboxed posture (`workspace` / `read-only`):
 * - under `workspace`, grants `task.gitDir` / `task.gitCommonDir` as
 *   `read_write` when set so `git commit` works in a parley worktree (#278);
 * - sets `restrict_network = true` only when `task.network` is false.
 * `read-only` never gets write grants (same as codex `writable_roots`).
 *
 * When neither grant nor network restriction applies (network-on workspace with
 * no gitdirs, or network-on read-only), the profile still materializes as a pure
 * `extends` of the base — harmless, and keeps `GROK_SANDBOX` / probe env uniform
 * for all sandboxed postures.
 */
function sandboxToml(base: string, task: TaskSpec): string {
  const lines = [
    "# Generated by parley — sandboxed posture (spec §8).",
    `[profiles.${NO_NETWORK_PROFILE}]`,
    `extends = ${tomlString(base)}`,
  ];
  if (!task.network) {
    lines.push("restrict_network = true");
  }
  // Only workspace grants writes; read-only must stay non-writable.
  if (task.sandbox === "workspace") {
    const roots = gitWritableRoots(task);
    if (roots.length > 0) {
      lines.push(`read_write = [${roots.map(tomlString).join(", ")}]`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** The probe command recorded as the catalog entry's `source` on refresh. */
const MODELS_SOURCE = "grok models";

/** On-disk cache under the operator's grok home (#282). */
const MODELS_CACHE_FILE = "models_cache.json";
/** Operator config with optional `[model.*]` BYOK / agent-variant tables (#282). */
const OPERATOR_CONFIG_FILE = "config.toml";

/**
 * Cap on models_cache.json — real caches embed model info blobs and can hold
 * co-located api_key fields; never slurp unbounded.
 */
export const GROK_MODELS_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** Cap on operator config.toml (auth co-located under `[model.*]` env_key paths). */
export const GROK_CONFIG_MAX_BYTES = 2 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function isTomlTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Load-bearing cache filter (#282): skip hidden models and anything not
 * `supported_in_api === true`. Missing flags are treated as excluded — same
 * class of mistake as skipping codex's visibility/API filters.
 */
function isGrokCacheListedModel(info: Record<string, unknown>): boolean {
  return info.hidden !== true && info.supported_in_api === true;
}

/**
 * Map one models_cache entry's `info` blob to a catalog row. Credentials that
 * may sit on the parent entry (`api_key`) are never read.
 */
function modelEntryFromGrokCacheInfo(info: Record<string, unknown>): ModelEntry | null {
  if (!isGrokCacheListedModel(info)) return null;
  const id = asString(info.id) || asString(info.model);
  if (id === "") return null;
  const effortsRaw = info.reasoning_efforts;
  const efforts: string[] = [];
  let defaultEffort: string | null =
    typeof info.reasoning_effort === "string" ? info.reasoning_effort : null;
  if (Array.isArray(effortsRaw)) {
    for (const raw of effortsRaw) {
      const e = asRecord(raw);
      if (!e) continue;
      const effort = asString(e.value) || asString(e.id);
      if (effort === "") continue;
      efforts.push(effort);
      if (e.default === true) defaultEffort = effort;
    }
  }
  const label = typeof info.name === "string" && info.name !== "" ? info.name : undefined;
  return {
    id,
    efforts,
    default_effort: defaultEffort,
    ...(label === undefined ? {} : { label }),
  };
}

/**
 * Parse grok's on-disk `models_cache.json` (#282). Shape (verified 0.2.112):
 * `{ fetched_at, models: { [id]: { info: { hidden, supported_in_api,
 * reasoning_efforts[], … }, api_key?, … } } }`. Fail-soft for callers: never
 * throws. Distinguishes usable empty from present-but-unusable. Project only
 * model keys — never return/log co-located `api_key` fields.
 */
export function parseGrokModelsCache(json: string): {
  models: ModelEntry[];
  cacheFetchedAt: string | null;
  error: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { models: [], cacheFetchedAt: null, error: "malformed models_cache.json" };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { models: [], cacheFetchedAt: null, error: "unexpected models_cache.json shape" };
  }
  const cacheFetchedAt = typeof root.fetched_at === "string" ? root.fetched_at : null;
  const modelsObj = root.models;
  // Empty-but-valid: `{}` object or empty array.
  if (Array.isArray(modelsObj)) {
    if (modelsObj.length === 0) {
      return { models: [], cacheFetchedAt, error: null };
    }
    // Array form is unexpected for grok (dict-keyed in real homes).
    return {
      models: [],
      cacheFetchedAt,
      error: "unexpected models_cache.json shape",
    };
  }
  const modelsMap = asRecord(modelsObj);
  if (!modelsMap) {
    return {
      models: [],
      cacheFetchedAt,
      error: "unexpected models_cache.json shape",
    };
  }
  const entries: ModelEntry[] = [];
  for (const raw of Object.values(modelsMap)) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const info = asRecord(entry.info);
    if (!info) continue;
    const model = modelEntryFromGrokCacheInfo(info);
    if (model) entries.push(model);
  }
  return { models: entries, cacheFetchedAt, error: null };
}

/**
 * Collect `[model.*]` leaf tables from a parsed grok config.toml. Bare headers
 * with dots nest (`[model.grok-4.5-build]` → grok-4 / 5-build); reconstruct the
 * dotted id from the path. Credentials (`env_key`, keys under the table) are
 * never returned.
 */
function collectGrokConfigModelIds(table: TomlTable, prefix: string, out: string[]): void {
  let hasNested = false;
  let hasLeaf = false;
  for (const value of Object.values(table)) {
    if (isTomlTable(value)) hasNested = true;
    else hasLeaf = true;
  }
  // Intermediate nest nodes (only child tables) are not models themselves.
  if (prefix !== "" && (hasLeaf || !hasNested)) {
    out.push(prefix);
  }
  for (const [key, value] of Object.entries(table)) {
    if (!isTomlTable(value)) continue;
    const next = prefix === "" ? key : `${prefix}.${key}`;
    collectGrokConfigModelIds(value, next, out);
  }
}

/**
 * Project model ids from grok operator `config.toml` `[model.*]` tables (#282).
 * Agent variants / BYOK models often live only here — the cache can hold a
 * single listed model. Never re-serializes the TOML tree (secret hygiene).
 */
export function parseGrokModelsConfig(text: string): {
  models: ModelEntry[];
  defaultModel: string | null;
  error: string | null;
} {
  // parseToml is fail-soft; only reject obviously truncated headers that would
  // silently drop content the operator intended as a model table.
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (line.startsWith("[") && !line.startsWith("[[") && !line.endsWith("]")) {
      return {
        models: [],
        defaultModel: null,
        error: "malformed config.toml (unterminated table header)",
      };
    }
  }
  const root = parseToml(text);
  const modelsTable = root.models;
  const defaultModel =
    isTomlTable(modelsTable) && typeof modelsTable.default === "string"
      ? modelsTable.default
      : null;
  const modelRoot = root.model;
  if (!isTomlTable(modelRoot)) {
    return { models: [], defaultModel, error: null };
  }
  const ids: string[] = [];
  collectGrokConfigModelIds(modelRoot, "", ids);
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    // Config tables carry no effort list — empty; probe/cache may enrich via merge.
    entries.push({ id, efforts: [], default_effort: null });
  }
  return { models: entries, defaultModel, error: null };
}

/** Catalog source string for a grok cache read (freshness stamp when present). */
export function grokModelsCacheSource(cachePath: string, cacheFetchedAt: string | null): string {
  if (cacheFetchedAt !== null) {
    return `${cachePath} (cache fetched_at=${cacheFetchedAt})`;
  }
  return cachePath;
}

/**
 * Union cache models with config.toml `[model.*]` ids. Same-id: cache wins
 * (richer efforts). Order: cache first, then config-only ids.
 */
export function mergeGrokDiskModels(
  cacheModels: ModelEntry[],
  configModels: ModelEntry[],
): ModelEntry[] {
  const byId = new Map<string, ModelEntry>();
  for (const m of cacheModels) byId.set(m.id, m);
  for (const m of configModels) {
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  return [...byId.values()];
}

function readOperatorFileText(
  filePath: string,
  fileLabel: string,
  maxBytes: number,
): { text: string | null; error: string | null } {
  try {
    const stat = fs.statSync(filePath);
    // #288: refuse non-files (FIFO, dir, device). readFileSync on a FIFO
    // blocks the daemon event loop forever.
    if (!stat.isFile()) {
      return { text: null, error: `${fileLabel} is not a regular file` };
    }
    if (stat.size > maxBytes) {
      return {
        text: null,
        error: `${fileLabel} exceeds size cap (${maxBytes} bytes)`,
      };
    }
    return { text: fs.readFileSync(filePath, "utf8"), error: null };
  } catch (err) {
    if (isEnoent(err)) return { text: null, error: null };
    return {
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** True when the posture asks grok for OS isolation (built-in or custom profile). */
export function isSandboxedGrokPosture(sandbox: SandboxMode): boolean {
  return sandbox === "workspace" || sandbox === "read-only";
}

/** True when `message` matches grok's sandbox-refusal signature (0.2.112). */
export function isGrokSandboxRefusalSignature(message: string): boolean {
  return SANDBOX_REFUSAL_SIGNATURE.test(message);
}

/**
 * Classified outcome of the preflight `grok inspect --json` probe.
 *
 * - `ok` — exit 0 with a recognized permissions shape
 * - `shape_drift` — exit 0 but unrecognized/unparseable output (permission
 *   tripwire only; always fail-open)
 * - `unavailable` — probe never ran (missing binary, timeout); always fail-open
 * - `failed` — probe ran and refused (non-zero exit / other exec error); fatal
 *   under sandboxed postures, fail-open under `full`
 */
export type GrokProbeOutcome =
  | { kind: "ok"; loaded: number; sources: string }
  | { kind: "shape_drift"; message: string }
  | { kind: "unavailable"; reason: "missing_binary" | "timeout"; message: string }
  | { kind: "failed"; message: string };

/** Decision produced by {@link decideGrokPermissionProbe}. */
export type GrokProbeDecision =
  | { action: "quiet" }
  | { action: "diagnostic"; text: string }
  | { action: "fatal"; error: string };

/**
 * Distro-neutral install hint for bubblewrap. Deliberately does not hard-code
 * `apt` (or any other package manager) — the host that reported #247 is NixOS.
 */
const BUBBLEWRAP_INSTALL_HINT =
  "Install bubblewrap (the `bwrap` binary) for your distribution";

/**
 * Actionable prepare-failure message when a sandboxed grok posture cannot be
 * enforced on this host (#247). When `signatureMatched` is true the wording
 * names bubblewrap; otherwise it degrades to the raw probe error (drift
 * fallback).
 */
export function formatGrokSandboxUnenforceableError(
  sandbox: SandboxMode,
  opts: { signatureMatched: boolean; probeMessage: string },
): string {
  const escape =
    'Use a profile with sandbox: "full" to run without OS isolation.';
  if (opts.signatureMatched) {
    return (
      `grok sandbox posture "${sandbox}" cannot be enforced on this host ` +
      `(bubblewrap missing or unusable). ${BUBBLEWRAP_INSTALL_HINT}, or ` +
      escape
    );
  }
  return (
    `grok sandbox posture "${sandbox}" cannot be enforced on this host. ` +
    `Preflight probe failed: ${opts.probeMessage}. ${escape}`
  );
}

/**
 * Classify an error thrown by `runProbe` / `execFile` into a
 * {@link GrokProbeOutcome}. Pure: safe to unit-test without a real binary.
 *
 * Includes `stderr` in the message when present so sandbox-refusal signatures
 * on the probe's error stream are still matched if Node omits them from
 * `Error.message`.
 */
export function classifyGrokProbeError(err: unknown): GrokProbeOutcome {
  let message = err instanceof Error ? err.message : String(err);
  if (err !== null && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (
      typeof stderr === "string" &&
      stderr.length > 0 &&
      !message.includes(stderr.trim())
    ) {
      message = `${message}\n${stderr}`;
    }
  }
  const code =
    err !== null && typeof err === "object" && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  if (code === "ENOENT") {
    return { kind: "unavailable", reason: "missing_binary", message };
  }
  const killed =
    err !== null && typeof err === "object" && "killed" in err
      ? Boolean((err as { killed?: unknown }).killed)
      : false;
  if (killed || /ETIMEDOUT|timed?\s*out|TIMEOUT/i.test(message)) {
    return { kind: "unavailable", reason: "timeout", message };
  }
  return { kind: "failed", message };
}

/**
 * Pure decision for the preflight permission probe (#186 / #247).
 *
 * Fail-open (tagged diagnostic) for: permission-rule hits, shape drift, missing
 * binary, timeout, and any failure under `sandbox: full`.
 *
 * Fail-closed (fatal prepare error) for: any non-unavailable probe failure under
 * a sandboxed posture (`workspace` / `read-only`). Signature match sharpens the
 * message; lack of match still fails with the raw probe error (drift fallback).
 */
export function decideGrokPermissionProbe(
  outcome: GrokProbeOutcome,
  sandbox: SandboxMode,
): GrokProbeDecision {
  switch (outcome.kind) {
    case "ok": {
      if (outcome.loaded === 0) return { action: "quiet" };
      return {
        action: "diagnostic",
        text:
          `${VENDOR_DIAG_PREFIX} claude_permission_import loaded=${outcome.loaded} ` +
          `sources=[${outcome.sources}] — imported permission rules reached the child ` +
          `despite the #179 gate; edits may be denied`,
      };
    }
    case "shape_drift":
      return {
        action: "diagnostic",
        text: `${VENDOR_DIAG_PREFIX} permission_probe failed: ${outcome.message}`,
      };
    case "unavailable":
      return {
        action: "diagnostic",
        text: `${VENDOR_DIAG_PREFIX} permission_probe failed: ${outcome.message}`,
      };
    case "failed": {
      if (!isSandboxedGrokPosture(sandbox)) {
        return {
          action: "diagnostic",
          text: `${VENDOR_DIAG_PREFIX} permission_probe failed: ${outcome.message}`,
        };
      }
      const signatureMatched = isGrokSandboxRefusalSignature(outcome.message);
      return {
        action: "fatal",
        error: formatGrokSandboxUnenforceableError(sandbox, {
          signatureMatched,
          probeMessage: outcome.message,
        }),
      };
    }
  }
}

/**
 * Parse `grok models` plain-text output into normalized model entries (#29,
 * research §3). The listing is default + bullet ids, no `--json` and no
 * per-model efforts, so efforts are carried forward from the existing catalog
 * entry (a hand-patch survives a refresh) and default empty for new ids. Format
 * is unpinned, so match defensively; throws when no ids parse, so the refresh
 * path keeps the existing entry rather than replacing it with nothing.
 *
 * Observed 0.2.93 shape:
 *   Available models:
 *     * grok-4.5 (default)
 *     - grok-composer-2.5-fast
 */
export function parseGrokModels(text: string, existing: VendorModels | undefined): ModelEntry[] {
  const priorEfforts = new Map(
    (existing?.models ?? []).map((m) => [m.id, m] as const),
  );
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^\s*[-*]\s+(\S+)/.exec(line);
    if (!match) continue; // headers ("Default model:", "Available models:") skipped
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const prior = priorEfforts.get(id);
    entries.push({
      id,
      efforts: prior?.efforts ?? [],
      default_effort: prior?.default_effort ?? null,
    });
  }
  if (entries.length === 0) {
    throw new Error("grok models: no model ids parsed from output");
  }
  return entries;
}

const GROK_ENFORCEMENT: AdapterEnforcement = {
  "read-only": { level: "enforced", via: "bubblewrap OS sandbox; fail-closed without bwrap (#247)" },
  workspace: {
    level: "enforced",
    via: "bubblewrap OS sandbox + worktree gitdir grants; fail-closed without bwrap (#247/#278)",
  },
  full: { level: "enforced", via: "GROK_SANDBOX=off" },
  "network:false": {
    level: "enforced",
    via: "restrict_network in custom sandbox profile (sandboxed postures; ignored for full)",
  },
};

export function createGrokAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_GROK_BIN ?? DEFAULT_GROK_BIN;

  /**
   * The env shared by fresh runs and resumes: auth, sandbox, scanner posture,
   * and the daemon-local xAI usage proxy base URL (#95).
   *
   * `GROK_XAI_API_BASE_URL` precedence (highest last at the child process):
   * 1. Parent process env — when set, we omit the key from `plan.env` so the
   *    engine's `{...process.env, ...plan.env}` spawn keeps the parent value
   *    (explicit user override / debugging; never clobber).
   * 2. This adapter's proxy URL (`http://127.0.0.1:<hubPort>/xai/<taskId>/v1`)
   *    when the parent did not set the var — same port as the MCP hub.
   * 3. `vendors.grok.env` / `profiles.<name>.env` via `applyVendorConfig`
   *    (`plan.env < vendors.env < profile.env`) still override (2) after prepare.
   *
   * Caveat (`restrict_network`): when `task.network` is false the custom bwrap
   * profile may block loopback to the proxy. Capture is fail-open — the child
   * either reaches the real API without attribution or fails to talk to the
   * model; sandbox exemption (research proposal #2) is NOT implemented.
   */
  function baseEnv(task: TaskSpec, hub: HubInfo): Record<string, string> {
    const { env: sandbox } = sandboxEnv(task);
    const result: Record<string, string> = {
      ...sandbox,
      // Pin the MCP startup timeout so a Claude-oriented parent value can't leak.
      MCP_TIMEOUT: MCP_STARTUP_TIMEOUT_MS,
    };
    // Every sandboxed posture uses the custom profile (gitdir grants + optional
    // network restriction). `files()` materializes the matching sandbox.toml.
    if (isSandboxedGrokPosture(task.sandbox)) {
      result.GROK_SANDBOX = NO_NETWORK_PROFILE;
    }
    // Turn off every Claude-config scanner (they default on).
    for (const key of CLAUDE_SCANNER_VARS) result[key] = "0";
    // Gate the Claude-settings permission import the scanners don't cover (#179).
    result[CLAUDE_PERMISSION_IMPORT_OVERRIDE] = "1";
    // Auth passes through opaquely (per-token billing); only when the parent set it.
    if (env.XAI_API_KEY !== undefined) result.XAI_API_KEY = env.XAI_API_KEY;
    // Route built-in-model API-key traffic through the daemon proxy for usage
    // capture (#95). Hub URL already carries the shared ephemeral port.
    if (env.GROK_XAI_API_BASE_URL === undefined) {
      try {
        const origin = new URL(hub.url).origin;
        result.GROK_XAI_API_BASE_URL = `${origin}/xai/${task.id}/v1`;
      } catch {
        // Malformed hub URL — skip proxy injection rather than fail prepare.
      }
    }
    return result;
  }

  /**
   * Files materialized pre-spawn: the MCP config, plus a custom sandbox profile
   * for every sandboxed posture (workspace / read-only).
   */
  function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
    const materialized: MaterializedFile[] = [
      { path: ".grok/config.toml", contents: configToml(hub) },
    ];
    if (isSandboxedGrokPosture(task.sandbox)) {
      const { base } = sandboxEnv(task);
      if (base !== null) {
        materialized.push({ path: ".grok/sandbox.toml", contents: sandboxToml(base, task) });
      }
    }
    return materialized;
  }

  /**
   * Preflight permission probe (#186 / #247): run `grok inspect --json` with
   * the child's exact cwd and env posture.
   *
   * Two jobs:
   * 1. Permission tripwire (#186): report Claude-settings permission rules that
   *    would load despite the `#179` gate. Fail-open on shape drift / missing
   *    binary / timeout.
   * 2. Sandbox capability gate (#247): when the resolved posture is sandboxed
   *    (`workspace` / `read-only`) and the probe fails for a reason other than
   *    "couldn't run the probe at all", reject prepare with an actionable
   *    error. Grok's inspect path *is* the child's startup path for the
   *    sandbox, so a refuse-to-start here would otherwise become an opaque
   *    child exit with empty stdout.
   */
  async function permissionProbe(task: TaskSpec, childEnv: Record<string, string>): Promise<string[]> {
    let stdout: string;
    try {
      stdout = await runProbe(bin, ["inspect", "--json"], {
        cwd: task.cwd,
        // Mirror the engine's spawn env exactly ({...process.env, ...plan.env})
        // so the probe sees the child's posture, not the daemon's.
        env: { ...process.env, ...childEnv },
        timeoutMs: INSPECT_PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      const decision = decideGrokPermissionProbe(classifyGrokProbeError(err), task.sandbox);
      if (decision.action === "fatal") throw new Error(decision.error);
      if (decision.action === "diagnostic") return [decision.text];
      return [];
    }

    // Probe exited 0 — permission tripwire only (always fail-open on shape drift).
    try {
      const parsed = JSON.parse(stdout) as {
        permissions?: { loaded?: unknown; sources?: unknown };
      };
      const loaded = parsed.permissions?.loaded;
      if (typeof loaded !== "number") {
        const decision = decideGrokPermissionProbe(
          {
            kind: "shape_drift",
            message: "unrecognized `grok inspect --json` permissions shape",
          },
          task.sandbox,
        );
        return decision.action === "diagnostic" ? [decision.text] : [];
      }
      const sources = Array.isArray(parsed.permissions?.sources)
        ? parsed.permissions.sources.filter((s): s is string => typeof s === "string").join(", ")
        : "?";
      const decision = decideGrokPermissionProbe(
        { kind: "ok", loaded, sources },
        task.sandbox,
      );
      if (decision.action === "diagnostic") return [decision.text];
      return [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const decision = decideGrokPermissionProbe({ kind: "shape_drift", message }, task.sandbox);
      return decision.action === "diagnostic" ? [decision.text] : [];
    }
  }

  /** Flags shared by fresh runs and resumes (headless streaming JSONL, pinned). */
  function commonArgv(task: TaskSpec): string[] {
    const argv = [
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--always-approve",
      "--cwd",
      task.cwd,
    ];
    if (task.model !== null) argv.push("-m", task.model);
    // Reasoning effort (#28, spec §9) — opaque string passed through unchanged;
    // `--reasoning-effort` (alias `--effort`), verified in grok 0.2.93.
    // Omitted flag means the vendor's own default; no flag emitted.
    if (task.effort !== null) argv.push("--reasoning-effort", task.effort);
    // extraArgs land in the flags region (before/with other flags; the prompt
    // is a separate -p value) so they are never ambiguous (TaskSpec contract).
    argv.push(...task.extraArgs);
    return argv;
  }

  return withPostureDiagnostics({
    id: "grok",
    childChannel: "mcp",
    enforcement: GROK_ENFORCEMENT,

    async prepare(task, hub): Promise<SpawnPlan> {
      // Fresh single-turn run: `grok -p <prompt> …`. The session id is captured
      // from the terminal `end` event and persisted for resume.
      const env = baseEnv(task, hub);
      return {
        argv: [bin, "-p", task.prompt, ...commonArgv(task)],
        env,
        files: files(task, hub),
        cwd: task.cwd,
        diagnostics: await permissionProbe(task, env),
      };
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (ADR-0004): `-r <session-id>` resumes the persisted
      // grok session; `task.prompt` is the orchestrator's answer, delivered as
      // the conversation's continuation. The config is re-materialized so the hub
      // and posture are present on the respawn too.
      //
      // NB: verified against grok 0.2.93 — resume is `-r/--resume`, NOT `-s`
      // (which now *creates* a new session with a fixed UUID). The spec §9 table
      // and research doc (written against ~0.2.73) say `-s`; the installed binary
      // is authoritative.
      if (task.sessionId === undefined) {
        // Without `-r` grok would start a brand-new session, silently delivering
        // the answer to an agent with no conversation context. Fail loudly
        // instead — the engine reruns session-less stalled tasks via prepare().
        return Promise.reject(new Error(`grok resume for task ${task.id} has no session id`));
      }
      const env = baseEnv(task, hub);
      return Promise.resolve(permissionProbe(task, env)).then((diagnostics) => ({
        argv: [bin, "-p", task.prompt, "-r", task.sessionId!, ...commonArgv(task)],
        env,
        files: files(task, hub),
        cwd: task.cwd,
        diagnostics,
      }));
    },

    parseEvent(line: string): VendorEvent[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return []; // opaque non-JSON vendor noise — the raw log keeps it
      }
      if (typeof parsed !== "object" || parsed === null) return [];
      const event = parsed as Record<string, unknown>;
      switch (event.type) {
        case "text":
          // The assistant's visible output, streamed token-by-token.
          return typeof event.data === "string" ? [{ kind: "message", text: event.data }] : [];
        case "thought":
          // Reasoning chunks — opaque for display; the raw log retains them.
          return [];
        case "end":
          // Terminal event: carries `sessionId` (camelCase), used for resume.
          return [
            {
              kind: "session_meta",
              session_id: typeof event.sessionId === "string" ? event.sessionId : undefined,
            },
          ];
        case "error":
        case "fatal": {
          // Tagged with VENDOR_DIAG_PREFIX so vendor-surfaced errors land in
          // diag.log (#186) — grok's stream has no other anomaly channel.
          // `fatal` marks the run-terminal variant so the engine can carry it
          // into the failure detail (`lastError`).
          const message =
            typeof event.message === "string"
              ? event.message
              : typeof event.data === "string"
                ? event.data
                : "";
          return [
            {
              kind: "error",
              fatal: event.type === "fatal",
              text: `${VENDOR_DIAG_PREFIX} ${event.type}: ${message}`,
            },
          ];
        }
        default:
          // Unknown/changed shapes must never fail the task (schema is
          // undocumented and drifts across releases).
          return [];
      }
    },

    sessionId(events: VendorEvent[]): string | undefined {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "session_meta" && event.session_id !== undefined) {
          return event.session_id;
        }
      }
      return undefined;
    },

    async listModels(existing): Promise<ProbedModels> {
      // `grok models` prints the default + available ids as plain text (research
      // §3); efforts ride the existing catalog entry (grok exposes none here).
      const stdout = await runProbe(bin, ["models"]);
      return { source: MODELS_SOURCE, models: parseGrokModels(stdout, existing) };
    },

    async readModels(): Promise<ProbedModels> {
      // Operator home via resolveOperatorVendorHome (honours research-documented
      // GROK_HOME; adapter does not set GROK_HOME on spawn — isolation is
      // cwd-scoped config files). Merge models_cache.json with config.toml
      // `[model.*]` so agent variants outside the cache still appear (#282).
      // Absent files = quiet empty contribution; present-but-unusable rejects
      // so refreshCatalog can warn even when the probe fills the gap.
      const home = resolveOperatorVendorHome("grok", env);
      if (home === null) return { source: MODELS_CACHE_FILE, models: [] };

      const cachePath = path.join(home, MODELS_CACHE_FILE);
      const configPath = path.join(home, OPERATOR_CONFIG_FILE);
      const cacheSourceBase = displayVendorPath(cachePath, env);
      const configSourceBase = displayVendorPath(configPath, env);

      const cacheRead = readOperatorFileText(
        cachePath,
        MODELS_CACHE_FILE,
        GROK_MODELS_CACHE_MAX_BYTES,
      );
      if (cacheRead.error !== null) {
        throw new Error(cacheRead.error);
      }
      let cacheModels: ModelEntry[] = [];
      let cacheFetchedAt: string | null = null;
      if (cacheRead.text !== null) {
        // Secret hygiene: parse → project model keys only. Never log `text`.
        const parsed = parseGrokModelsCache(cacheRead.text);
        if (parsed.error !== null) throw new Error(parsed.error);
        cacheModels = parsed.models;
        cacheFetchedAt = parsed.cacheFetchedAt;
      }

      const configRead = readOperatorFileText(
        configPath,
        OPERATOR_CONFIG_FILE,
        GROK_CONFIG_MAX_BYTES,
      );
      if (configRead.error !== null) {
        throw new Error(configRead.error);
      }
      let configModels: ModelEntry[] = [];
      if (configRead.text !== null) {
        const parsed = parseGrokModelsConfig(configRead.text);
        if (parsed.error !== null) throw new Error(parsed.error);
        configModels = parsed.models;
      }

      const models = mergeGrokDiskModels(cacheModels, configModels);
      const sources: string[] = [];
      if (cacheRead.text !== null) {
        sources.push(grokModelsCacheSource(cacheSourceBase, cacheFetchedAt));
      }
      if (configModels.length > 0) {
        sources.push(configSourceBase);
      } else if (cacheRead.text === null && configRead.text !== null) {
        // Config present but no [model.*] — still name it so source is useful.
        sources.push(configSourceBase);
      }
      if (sources.length === 0) {
        return {
          source: grokModelsCacheSource(cacheSourceBase, null),
          models: [],
        };
      }
      return { source: sources.join(" + "), models };
    },
  });
}
