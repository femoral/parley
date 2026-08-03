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
import { readOperatorFileText } from "./read-operator-file.js";
import { runProbe } from "./probe.js";

/**
 * The `antigravity` vendor adapter — real delegation to Google's Antigravity
 * CLI (`agy` binary, #286 / ADR-0026). Verified against `agy` v1.1.7
 * (2026-08-02); see `docs/research/antigravity-cli-automation.md` for the
 * surface. Breaking rename of the retired `gemini` vendor id — no alias
 * (ADR-0026).
 *
 * Headless one-shot (research §2 / §9):
 *   agy --output-format stream-json --dangerously-skip-permissions
 *       --model <id> [--effort low|medium|high]
 *       [--add-dir …] --print-timeout <budget> -p <prompt>
 *
 * Structured output is NDJSON (`event` discriminator with nested payload) even
 * though `--output-format` is absent from 1.1.7 `--help` (research §2). Exit
 * codes lie both ways — success requires `result.status === "SUCCESS"` **and**
 * a non-empty `response` **and** no `jetski: no output produced` stderr line
 * (research §2/§5).
 *
 * MCP is global-only under `$HOME/.gemini/config/mcp_config.json` (research
 * §3). Per-task injection uses a private `HOME` (the only home lever —
 * research §1) seeded with the operator's OAuth token + installation_id
 * (mode 0600), plus a stdio MCP bridge that proxies to the daemon child REST
 * surface (no Streamable-HTTP/`headers` support on agy — research §3/§9).
 * Correlation rides in env / embedded constants, not headers.
 *
 * Resume: `--conversation <uuid>` across process invocations; conversations
 * live under the home, so prepare and resume must share the same HOME
 * (research §4).
 *
 * Effort: only `low|medium|high` (research §6). Strip only those suffixes when
 * parsing `agy models`; `-thinking` is part of the model id. Suffixless models
 * (e.g. `claude-sonnet-4-6`) reject `--effort` entirely — never pass it unless
 * `task.effort` is set (allowlist is the spawn authority). Discovery is a real
 * `listModels` probe with efforts (ADR-0026) — not a hand-maintained id list.
 *
 * Network: no lever at all (research §5). Refuse `network:false` for every
 * sandbox value rather than under-isolate (ADR-0023). Do not pass `--sandbox`
 * (fails open). `--mode plan|accept-edits` are no-ops in print mode — do not
 * map postures onto them.
 */

/** Default binary; override via `PARLEY_ANTIGRAVITY_BIN` (smoke tests, custom installs). */
const DEFAULT_ANTIGRAVITY_BIN = "agy";

/**
 * Private per-task home relative to the task cwd (research §1 / §3 / §9).
 * Isolation-marker segment that {@link resolveOperatorVendorHome} refuses so
 * a delegated child cannot inject task-controlled paths into discovery.
 */
export const ANTIGRAVITY_HOME_REL = ".parley-antigravity";

/** Relative path of the materialized stdio MCP bridge under the private home. */
const MCP_BRIDGE_REL = path.join(ANTIGRAVITY_HOME_REL, "parley-mcp-bridge.mjs");

const MCP_SERVER_NAME = "parley";

/** Probe command recorded as catalog `source` on refresh (research §7). */
const MODELS_SOURCE = "agy models";

/** Cap on oauth/token reads from the operator home. */
const OPERATOR_AUTH_MAX_BYTES = 256 * 1024;

/** Credential file mode (research §9: antigravity-oauth-token is mode 0600). */
const CREDENTIAL_MODE = 0o600;

/**
 * Effort suffixes stripped from piped/TTY model listing ids (research §6/§7).
 * Only these three — never `-thinking` or any other trailing token.
 */
const EFFORT_SUFFIX_RE = /-(high|medium|low)$/;

/** Valid `--effort` values (research §6). */
const VALID_EFFORTS = new Set(["low", "medium", "high"]);

/**
 * Headless auto-deny diagnostic (research §2/§5). The only failure signal when
 * tools are permission-denied with exit 0 + empty SUCCESS response.
 */
const JETSKI_DENY_RE = /^jetski:\s*no output produced/i;

/** Antigravity posture declaration (research §5, ADR-0023). */
const ANTIGRAVITY_ENFORCEMENT: AdapterEnforcement = {
  "read-only": {
    level: "approximate",
    via: "permissions.allow read tools only; host-wide reads, silent deny on write/command",
  },
  workspace: {
    level: "none",
    via: "dangerously-skip-permissions; no write confinement (path-scoped allow rules do not work)",
  },
  full: {
    level: "enforced",
    via: "dangerously-skip-permissions, no --sandbox",
  },
  "network:false": {
    level: "refused",
    via: "no network lever exists (research §5); prepare refuses rather than under-isolate",
  },
};

/**
 * Loud capability gap: refuse network:false for every sandbox (research §5
 * gotcha 12). Call before building argv so the task fails with a clear error.
 */
export function assertAntigravityNetworkPosture(task: TaskSpec): void {
  if (task.network) return;
  throw new Error(
    `antigravity: network:false is not enforced for sandbox=${task.sandbox} ` +
      `(agy has no network lever — research §5). Refuse rather than under-isolate. ` +
      `Use network:true, or wrap the child in a real netns/container.`,
  );
}

/** Absolute private home for this task (stable across prepare → resume). */
export function antigravityHomeAbs(cwd: string): string {
  return path.join(cwd, ANTIGRAVITY_HOME_REL);
}

/**
 * Format `answerTimeoutMs` as a Go duration for `--print-timeout` (research
 * §2 default `5m0s`). Ceiling to whole seconds so short timeouts never round
 * to zero.
 */
export function formatPrintTimeout(answerTimeoutMs: number): string {
  const totalSec = Math.max(1, Math.ceil(Math.max(0, answerTimeoutMs) / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m${seconds}s`;
}

/**
 * Parse `agy models` stdout into catalog entries (research §7).
 *
 * Piped form (what probes get): one id per line, no labels.
 * TTY form: `id<spaces>label` — split on the first run of 2+ spaces.
 *
 * Strip only trailing `-high`/`-medium`/`-low` → base id + effort. Collect
 * efforts per base id only from listed rows — never synthesize.
 *
 * Label capture: the TTY two-column branch is kept for unit tests and for a
 * future settings-selection feature that needs the label↔id bridge (settings
 * store a display *label*, not an id — research §7). Real `listModels` probes
 * pipe stdout, so labels are never present on the refresh path; reviving them
 * requires allocating a pty for `agy models`.
 */
export function parseAgyModels(text: string): ModelEntry[] {
  // Map base id → { efforts (order preserved), label? }
  const byId = new Map<string, { efforts: string[]; seen: Set<string>; label?: string }>();

  for (const rawLine of text.split(/\r?\n/)) {
    // Strip spinner/ANSI residue that can precede TTY rows (research §7).
    // eslint-disable-next-line no-control-regex -- intentional ESC CSI strip; research §7 TTY spinner/ANSI
    const line = rawLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").trim();
    if (line === "") continue;
    // Drop spinner / status chatter that is not a model row.
    if (/^fetching available models/i.test(line)) continue;
    if (/^error:/i.test(line)) continue;

    let idPart = line;
    let label: string | undefined;
    // TTY-only label column (research §7). Unreachable on piped probes —
    // keep for tests / future pty allocation; do not invent labels from ids.
    const split = line.match(/^(\S+)\s{2,}(.+)$/);
    if (split) {
      idPart = split[1]!;
      label = split[2]!.trim();
      if (label === "") label = undefined;
    }

    const effortMatch = EFFORT_SUFFIX_RE.exec(idPart);
    let baseId = idPart;
    let effort: string | undefined;
    if (effortMatch) {
      baseId = idPart.slice(0, effortMatch.index);
      effort = effortMatch[1];
    }
    if (baseId === "") continue;

    let entry = byId.get(baseId);
    if (entry === undefined) {
      entry = { efforts: [], seen: new Set() };
      byId.set(baseId, entry);
    }
    if (effort !== undefined && VALID_EFFORTS.has(effort) && !entry.seen.has(effort)) {
      entry.seen.add(effort);
      entry.efforts.push(effort);
    }
    // Prefer the first non-empty label we see for this base id.
    if (label !== undefined && entry.label === undefined) {
      entry.label = label;
    }
  }

  const models: ModelEntry[] = [];
  for (const [id, data] of byId) {
    models.push({
      id,
      efforts: data.efforts,
      default_effort: null,
      ...(data.label !== undefined ? { label: data.label } : {}),
    });
  }
  if (models.length === 0) {
    throw new Error("agy models: no model ids parsed from output");
  }
  return models;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Map `result.usage` into a usage bag (research §8). Prefer result.usage as
 * authoritative over per-step usage. Expose harness field names as-is plus
 * canonical `cached_tokens` from `cache_read_tokens` when present.
 */
function usageFromAgy(usageObj: unknown): Record<string, number> | undefined {
  const obj = asRecord(usageObj);
  if (!obj) return undefined;
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number") usage[key] = value;
  }
  if (typeof obj.cache_read_tokens === "number") {
    usage.cached_tokens = obj.cache_read_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Derive daemon base URL from hub MCP URL (`…/mcp` → origin). */
function hubBaseUrl(hubUrl: string): string {
  try {
    const u = new URL(hubUrl);
    u.pathname = u.pathname.replace(/\/mcp\/?$/, "") || "/";
    return u.toString().replace(/\/$/, "");
  } catch {
    return hubUrl.replace(/\/mcp\/?$/, "");
  }
}

/**
 * Self-contained stdio MCP bridge (research §3/§9). Speaks a minimal MCP
 * JSON-RPC surface over stdin/stdout and proxies tools to the daemon child
 * REST surface (ADR-0011) so we never depend on Streamable-HTTP or headers
 * support in agy. Hub base + task id are embedded at materialize time.
 *
 * // UNKNOWN(research §3): end-to-end MCP tool naming/namespacing through
 * // agy's `call_mcp_tool` dispatcher was not live-verified — the bridge
 * // advertises the same two tool names the preamble teaches.
 */
function mcpBridgeSource(hub: HubInfo, answerTimeoutMs: number): string {
  const base = hubBaseUrl(hub.url);
  const taskId =
    hub.headers["x-parley-task"] ??
    hub.headers["X-Parley-Task"] ??
    Object.values(hub.headers)[0] ??
    "";
  const fetchTimeoutMs = answerTimeoutMs + 60_000;
  // Keep this as plain JS so `node` can run it without a TypeScript loader.
  return `// Generated by parley — do not edit; regenerated on every (re)spawn.
// Antigravity stdio MCP bridge → daemon child REST (research §3/§9).
import readline from "node:readline";

const HUB_BASE = ${JSON.stringify(base)};
const TASK_ID = ${JSON.stringify(taskId)};
const FETCH_TIMEOUT_MS = ${fetchTimeoutMs};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

async function postJson(pathname, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(HUB_BASE + pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-parley-task": TASK_ID,
      },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const TOOLS = [
  {
    name: "submit_report",
    description:
      "Submit the final task report. Required before finishing: a task only " +
      "completes when a schema-valid report is submitted.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        outcome: { type: "string" },
        files_changed: { type: "array", items: { type: "string" } },
      },
      additionalProperties: true,
    },
  },
  {
    name: "ask_orchestrator",
    description:
      "Ask the orchestrator a blocking question when stuck. Blocks until the " +
      "orchestrator answers. Use only when you genuinely cannot proceed.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    },
  },
];

async function handleCall(name, args) {
  if (name === "submit_report") {
    const { ok, status, json } = await postJson("/child/report", args ?? {});
    if (!ok) {
      const err =
        (json && Array.isArray(json.errors) && json.errors.join("; ")) ||
        (json && typeof json.error === "string" && json.error) ||
        ("report rejected (HTTP " + status + ")");
      return { content: [{ type: "text", text: String(err) }], isError: true };
    }
    return { content: [{ type: "text", text: "report accepted" }] };
  }
  if (name === "ask_orchestrator") {
    const question = args && args.question;
    if (typeof question !== "string" || question.trim() === "") {
      return {
        content: [{ type: "text", text: "ask_orchestrator requires a non-empty 'question' string" }],
        isError: true,
      };
    }
    const { ok, status, json } = await postJson("/child/ask", { question });
    if (!ok) {
      const err =
        (json && typeof json.error === "string" && json.error) ||
        ("ask failed (HTTP " + status + ")");
      return { content: [{ type: "text", text: String(err) }], isError: true };
    }
    const answer = json && typeof json.answer === "string" ? json.answer : JSON.stringify(json);
    return { content: [{ type: "text", text: answer }] };
  }
  return {
    content: [{ type: "text", text: "unknown tool: " + name }],
    isError: true,
  };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  const id = msg.id;
  const method = msg.method;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "parley", version: "0.0.0" },
      },
    });
    continue;
  }
  if (method === "notifications/initialized" || method === "initialized") {
    continue;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    continue;
  }
  if (method === "tools/call") {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    try {
      const result = await handleCall(name, args);
      send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        },
      });
    }
    continue;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    continue;
  }
  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found: " + String(method) },
    });
  }
}
`;
}

/**
 * Per-task `mcp_config.json` under the private home (research §3). Stdio
 * bridge only — no `serverUrl`/SSE path (connection UNVERIFIED; no headers).
 */
function mcpConfigJson(task: TaskSpec, hub: HubInfo): string {
  const bridgeAbs = path.join(task.cwd, MCP_BRIDGE_REL);
  const taskId =
    hub.headers["x-parley-task"] ??
    hub.headers["X-Parley-Task"] ??
    Object.values(hub.headers)[0] ??
    task.id;
  return (
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: "node",
            args: [bridgeAbs],
            env: {
              // Correlation in env (research §3/§9) — also embedded in bridge.
              PARLEY_HUB_URL: hubBaseUrl(hub.url),
              PARLEY_TASK_ID: taskId,
            },
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * `settings.json` for read-only posture (research §5).
 *
 * Best-effort until §5 is extended: research verified granting patterns
 * `write_file(*)` and `command(*)`, plus `read_file` as the permission name
 * in agy's own denial hint. Path-scoped patterns do not work. Tool names from
 * `init.tools` (e.g. `view_file`, `code_search`, `call_mcp_tool`) are **not**
 * verified permission names — inventing them risks silent auto-deny of the
 * MCP child channel. Keep only the verified-adjacent entry.
 *
 * // UNKNOWN(research §5): whether `read_file(*)` alone is sufficient for
 * // useful RO agent work, and the full permission-name vocabulary.
 */
function settingsJsonReadOnly(): string {
  return (
    JSON.stringify(
      {
        permissions: {
          // UNKNOWN(research §5): only verified-adjacent permission name;
          // read-only posture remains approximate (enforcement declaration).
          allow: ["read_file(*)"],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Minimal settings so the home layout exists for workspace/full runs.
 * Approvals come from argv `--dangerously-skip-permissions` (research §5);
 * do not invent `permissions.allow` shapes beyond `<tool>(*)`.
 */
function settingsJsonDefault(): string {
  return JSON.stringify({}, null, 2) + "\n";
}

/**
 * Read operator auth material for seeding the task home (research §1/§6).
 * Missing token → clear prepare error (unauthenticated runs block ~60s then
 * exit 1 — research §6 gotcha).
 */
function readOperatorAuth(
  env: NodeJS.ProcessEnv,
): { token: string; installationId: string | null; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const home = resolveOperatorVendorHome("antigravity", env);
  if (home === null) {
    throw new Error(
      "antigravity: cannot resolve operator home (~/.gemini); set HOME or " +
        "sign in with `agy` interactively first (research §1/§6).",
    );
  }
  const tokenPath = path.join(home, "antigravity-cli", "antigravity-oauth-token");
  const idPath = path.join(home, "antigravity-cli", "installation_id");
  const tokenRead = readOperatorFileText(
    tokenPath,
    "antigravity-oauth-token",
    OPERATOR_AUTH_MAX_BYTES,
  );
  if (tokenRead.error !== null) {
    throw new Error(
      `antigravity: cannot read OAuth token at ${displayVendorPath(tokenPath, env)}: ` +
        `${tokenRead.error}. Sign in with \`agy\` interactively first (research §6).`,
    );
  }
  if (tokenRead.text === null || tokenRead.text.trim() === "") {
    throw new Error(
      `antigravity: missing OAuth token at ${displayVendorPath(tokenPath, env)}. ` +
        "Sign in with `agy` interactively first — unauthenticated headless runs " +
        "block ~60s then exit 1 (research §6).",
    );
  }
  const idRead = readOperatorFileText(idPath, "installation_id", OPERATOR_AUTH_MAX_BYTES);
  if (idRead.error !== null) {
    diagnostics.push(
      `${VENDOR_DIAG_PREFIX} antigravity: installation_id unreadable at ` +
        `${displayVendorPath(idPath, env)}: ${idRead.error} (continuing without it)`,
    );
  }
  return {
    token: tokenRead.text,
    installationId: idRead.text,
    diagnostics,
  };
}

export function createAntigravityAdapter(
  env: NodeJS.ProcessEnv = process.env,
): VendorAdapter {
  const bin = env.PARLEY_ANTIGRAVITY_BIN ?? DEFAULT_ANTIGRAVITY_BIN;

  function files(task: TaskSpec, hub: HubInfo): {
    files: MaterializedFile[];
    diagnostics: string[];
  } {
    const auth = readOperatorAuth(env);
    const homeRel = ANTIGRAVITY_HOME_REL;
    const out: MaterializedFile[] = [
      {
        path: path.join(homeRel, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
        contents: auth.token.endsWith("\n") ? auth.token : `${auth.token}\n`,
        // research §9: operator token is mode 0600; engine honours MaterializedFile.mode
        mode: CREDENTIAL_MODE,
      },
      {
        path: path.join(
          homeRel,
          ".gemini",
          "antigravity-cli",
          "settings.json",
        ),
        contents:
          task.sandbox === "read-only" ? settingsJsonReadOnly() : settingsJsonDefault(),
      },
      {
        path: path.join(homeRel, ".gemini", "config", "mcp_config.json"),
        contents: mcpConfigJson(task, hub),
      },
      {
        path: MCP_BRIDGE_REL,
        contents: mcpBridgeSource(hub, task.answerTimeoutMs),
      },
    ];
    if (auth.installationId !== null && auth.installationId.trim() !== "") {
      out.push({
        path: path.join(homeRel, ".gemini", "antigravity-cli", "installation_id"),
        contents: auth.installationId.endsWith("\n")
          ? auth.installationId
          : `${auth.installationId}\n`,
        mode: CREDENTIAL_MODE,
      });
    }
    return { files: out, diagnostics: auth.diagnostics };
  }

  /**
   * Flags shared by fresh runs and resumes (research §2 / §9). Prompt is always
   * `-p <arg>` last among known flags so extraArgs stay unambiguous.
   */
  function commonArgv(task: TaskSpec): string[] {
    const argv: string[] = ["--output-format", "stream-json"];
    // Headless default denies every permissioned tool — including reads —
    // with exit 0 + empty SUCCESS (research §5). Always grant for workspace/full.
    if (task.sandbox !== "read-only") {
      argv.push("--dangerously-skip-permissions");
    }
    // Do NOT pass --sandbox (fails open — research §5 gotcha 11).
    // Do NOT pass --mode plan|accept-edits (no-ops in print mode — gotcha 14).
    if (task.model !== null && task.model !== "") {
      // Base id only — never a flattened effort-suffixed display id (§6/§9).
      argv.push("--model", task.model);
    }
    if (task.effort !== null && task.effort !== "") {
      // Only when set. Suffixless models hard-reject --effort (research §6 Q3);
      // the allowlist is the authority that prevents that combo at spawn.
      argv.push("--effort", task.effort);
    }
    if (task.gitDir !== undefined && task.gitDir !== "") {
      argv.push("--add-dir", task.gitDir);
    }
    if (
      task.gitCommonDir !== undefined &&
      task.gitCommonDir !== "" &&
      task.gitCommonDir !== task.gitDir
    ) {
      argv.push("--add-dir", task.gitCommonDir);
    }
    argv.push("--print-timeout", formatPrintTimeout(task.answerTimeoutMs));
    // extraArgs in the flags region (prompt is a separate -p value).
    argv.push(...task.extraArgs);
    return argv;
  }

  function spawnPlan(
    task: TaskSpec,
    hub: HubInfo,
    resumeSessionId: string | undefined,
  ): SpawnPlan {
    assertAntigravityNetworkPosture(task);
    const { files: materialFiles, diagnostics } = files(task, hub);
    const homeAbs = antigravityHomeAbs(task.cwd);
    const argv = [bin, ...commonArgv(task)];
    if (resumeSessionId !== undefined) {
      argv.push("--conversation", resumeSessionId);
    }
    argv.push("-p", task.prompt);
    return {
      argv,
      env: {
        // Only home lever (research §1). Auth + MCP + conversations re-root here.
        HOME: homeAbs,
      },
      files: materialFiles,
      cwd: task.cwd,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }

  return withPostureDiagnostics({
    id: "antigravity",
    childChannel: "mcp",
    enforcement: ANTIGRAVITY_ENFORCEMENT,

    prepare(task, hub): Promise<SpawnPlan> {
      try {
        return Promise.resolve(spawnPlan(task, hub, undefined));
      } catch (err) {
        return Promise.reject(err);
      }
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (research §4): --conversation <uuid> + same HOME.
      // Without a session id, agy would start fresh or --continue the wrong
      // concurrent session — reject like gemini/grok.
      if (task.sessionId === undefined) {
        return Promise.reject(
          new Error(`antigravity resume for task ${task.id} has no session id`),
        );
      }
      try {
        return Promise.resolve(spawnPlan(task, hub, task.sessionId));
      } catch (err) {
        return Promise.reject(err);
      }
    },

    parseEvent(line: string): VendorEvent[] {
      // stderr dual-feed (engine): jetski denial diagnostic (research §2/§5/§9).
      if (JETSKI_DENY_RE.test(line)) {
        return [
          {
            kind: "error",
            text: `${VENDOR_DIAG_PREFIX} ${line}`,
            fatal: true,
          },
        ];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return []; // opaque non-JSON
      }
      const event = asRecord(parsed);
      if (!event) return [];

      // Envelope is doubly nested: {"event":"result","result":{…}} (research §2).
      const kind = asString(event.event);
      if (kind === "") return [];

      switch (kind) {
        case "init": {
          // conversation_id at envelope level and inside init (research §4).
          const init = asRecord(event.init);
          const sessionId =
            asString(event.conversation_id) ||
            (init ? asString(init.conversation_id) : "");
          const model = init ? asString(init.model) : "";
          const meta: VendorEvent = { kind: "session_meta" };
          if (sessionId !== "") meta.session_id = sessionId;
          if (model !== "") meta.model = model;
          return sessionId !== "" || model !== "" ? [meta] : [];
        }

        case "step_update": {
          const step = asRecord(event.step_update);
          if (!step) return [];
          const stepType = asString(step.step_type);
          const state = asString(step.state);

          if (stepType === "agent_response") {
            const text = asString(step.text_delta);
            return text !== "" ? [{ kind: "message", text }] : [];
          }
          if (stepType === "tool" && state === "ACTIVE") {
            const name = asString(step.tool_name);
            const info = asRecord(step.tool_info);
            const params = info?.parameters;
            const text =
              params !== undefined
                ? `${name} ${JSON.stringify(params)}`
                : name;
            return name !== "" ? [{ kind: "command", text }] : [];
          }
          // tool DONE, user_input, checkpoint, unknown, anything new → opaque
          // (research §9 — never error on unknown step_type).
          return [];
        }

        case "result": {
          const result = asRecord(event.result);
          if (!result) return [];
          const status = asString(result.status);
          const response = asString(result.response);
          const usage = usageFromAgy(result.usage);
          const conversationId =
            asString(result.conversation_id) || asString(event.conversation_id);

          if (status === "ERROR" || status === "error") {
            const errText = asString(result.error) || "antigravity result status ERROR";
            const events: VendorEvent[] = [
              { kind: "error", text: errText, fatal: true },
            ];
            if (usage !== undefined || conversationId !== "") {
              const meta: VendorEvent = { kind: "session_meta" };
              if (usage !== undefined) meta.usage = usage;
              if (conversationId !== "") meta.session_id = conversationId;
              events.push(meta);
            }
            return events;
          }

          if (status === "SUCCESS" || status === "success") {
            // Success triple (research §2/§5/§9): SUCCESS + non-empty response
            // + no jetski line. Empty response is the silent auto-deny case.
            if (response.trim() === "") {
              const events: VendorEvent[] = [
                {
                  kind: "error",
                  text:
                    `${VENDOR_DIAG_PREFIX} antigravity result SUCCESS with empty response ` +
                    `(tools auto-denied in headless mode — research §5). ` +
                    `Pass --dangerously-skip-permissions or materialize permissions.allow.`,
                  fatal: true,
                },
              ];
              if (usage !== undefined || conversationId !== "") {
                const meta: VendorEvent = { kind: "session_meta" };
                if (usage !== undefined) meta.usage = usage;
                if (conversationId !== "") meta.session_id = conversationId;
                events.push(meta);
              }
              return events;
            }
            // Non-empty success — usage + session id; optional final message
            // is already streamed via step_update agent_response deltas.
            if (usage !== undefined || conversationId !== "") {
              const meta: VendorEvent = { kind: "session_meta" };
              if (usage !== undefined) meta.usage = usage;
              if (conversationId !== "") meta.session_id = conversationId;
              return [meta];
            }
            return [];
          }

          // Unknown status — opaque.
          return [];
        }

        default:
          // Unknown/changed event kinds must never fail the task (research §9).
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

    async listModels(): Promise<ProbedModels> {
      // Piped stdout is ids-only (research §7) — labels need a pty and are
      // unreachable on this path. Parse ids + effort suffixes only.
      // readModels omitted: no on-disk catalog (issue #286 out of scope).
      const stdout = await runProbe(bin, ["models"]);
      return { source: MODELS_SOURCE, models: parseAgyModels(stdout) };
    },
  });
}
