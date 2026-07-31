import fs from "node:fs";
import path from "node:path";
import { resolveOperatorVendorHome, type SelectedModel } from "@useparley/core";
import type {
  AdapterEnforcement,
  HubInfo,
  MaterializedFile,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
} from "./types.js";
import { VENDOR_DIAG_PREFIX, withPostureDiagnostics } from "./types.js";

/** Cline: soft shell permissions only; no OS FS/network sandbox (#279). */
const CLINE_ENFORCEMENT: AdapterEnforcement = {
  "read-only": {
    level: "approximate",
    via: "CLINE_COMMAND_PERMISSIONS deny-all shell (edit tools may still write)",
  },
  workspace: { level: "none", via: "unconstrained tools + auto-approve" },
  full: { level: "enforced", via: "unconstrained tools + auto-approve (unrestricted as requested)" },
  "network:false": { level: "none", via: "no first-class network toggle" },
};

/**
 * The `cline` vendor adapter — real delegation to the Cline agent CLI
 * (`cline` binary from the `cline` npm package, not experimental `@cline/cli`
 * / `clite`). Verified against cline 3.0.42 (2026-07-16); see
 * `docs/research/cline-cli-automation.md` for the surface.
 *
 * Cline is a **files-heavy** adapter (Grok-like): there is no per-invocation
 * MCP flag on the prompt command (research §3), so the hub is injected by
 * materializing `cline_mcp_settings.json` under a task-private `--data-dir`
 * (`.cline-parley/` in the worktree). State isolation also keeps the run out
 * of the user's `~/.cline`.
 *
 * Sandbox gap (research §5): Cline has no codex-style FS sandbox or network
 * toggle. We always force `--auto-approve true` for headless automation, map
 * `read-only` to a deny-all shell allowlist via `CLINE_COMMAND_PERMISSIONS`
 * (edit tools may still write — documented below), and leave `network:false`
 * unenforced with an explicit comment. Prefer Parley worktrees as the
 * boundary.
 *
 * MCP tool timeout (research §3 / #107): we set per-server `timeoutMs` to
 * `answerTimeoutMs + 60s` headroom in `cline_mcp_settings.json`. Whether Cline
 * 3.0.42 honors that field is still only type-surface evidence
 * (`CreateMcpToolsOptions.timeoutMs`); treat long `ask_orchestrator` as a known
 * residual risk if the binary ignores the field.
 *
 * Session id (research §4 / #107): **not present** on the NDJSON stream in
 * 3.0.42. After the child exits, a small Node wrapper scrapes
 * `<data-dir>/sessions/<id>/<id>.json` and prints a synthetic
 * `{type:"parley_session_scrape",session_id}` line so `parseEvent` can emit
 * `session_meta` without cross-task adapter state.
 *
 * Resume (#107 critical): headless `--id` + `--json` is **VERIFIED broken** on
 * 3.0.42 (`JSON output mode requires a prompt argument…` even with a trailing
 * prompt). `resume()` always rejects with a clear error — do not ship broken
 * `--id` as if it works. Session ids are still scraped for observability /
 * future fixed Cline releases.
 *
 * Provider (#107 major): when exactly one BYOK provider key is present in the
 * parent env (e.g. only `ANTHROPIC_API_KEY`), we pass `-P <provider>` so Cline
 * does not stay on the default `cline` provider. Explicit `-P` / `--provider`
 * in `extraArgs` wins.
 *
 * No `listModels` — `cline models` is not a subcommand (research §7).
 */

/** Default binary; override via `PARLEY_CLINE_BIN` (smoke tests, custom installs). */
const DEFAULT_CLINE_BIN = "cline";

/**
 * Task-private Cline state dir, relative to `task.cwd`. Holds sessions,
 * settings (incl. MCP), and providers so we never touch `~/.cline`
 * (research §1 / §3 / §9).
 */
const DATA_DIR_REL = ".cline-parley";

/** Relative path of the materialized MCP settings file under the worktree. */
const MCP_SETTINGS_REL = `${DATA_DIR_REL}/settings/cline_mcp_settings.json`;

/**
 * Post-exit wrapper that scrapes session id from the private data-dir and
 * appends a synthetic NDJSON line. Relative to `task.cwd` (materialized).
 */
const SESSION_WRAP_REL = `${DATA_DIR_REL}/parley-session-wrap.mjs`;

/** Env the wrap script uses to find sessions (absolute data-dir). */
const DATA_DIR_ENV = "PARLEY_CLINE_DATA_DIR";

const MCP_SERVER_NAME = "parley";

/** Headroom above answer timeout for MCP `timeoutMs` (ms). */
const MCP_TIMEOUT_HEADROOM_MS = 60_000;

/**
 * Auth env keys named in research §6. Forward only when set in the parent env
 * (Grok's `XAI_API_KEY` pattern). Prefer env over `-k` so keys are not
 * persisted into `<data-dir>/settings/providers.json` (research §6).
 */
const AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLINE_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "V0_API_KEY",
] as const;

/**
 * Map a single present BYOK env key → `-P` provider id (research §6 / #107).
 * `CLINE_API_KEY` alone leaves the default `cline` provider (no flag needed).
 */
const ENV_KEY_TO_PROVIDER: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  AI_GATEWAY_API_KEY: "ai-gateway",
  V0_API_KEY: "v0",
  // CLINE_API_KEY → default provider "cline" (omit -P)
};

/**
 * Shell permission JSON for the closest `read-only` posture Cline allows
 * (research §5). Deny-all shell; there is no hard FS read-only mode and no
 * verified CLI switch to disable edit/write tools — the agent can still
 * modify files via those tools. Documented gap vs codex/grok.
 */
const READ_ONLY_COMMAND_PERMISSIONS = JSON.stringify({
  allow: [] as string[],
  deny: ["*"],
  allowRedirects: false,
});

/**
 * Heuristic tool-name matchers for normalizing agent tool content into
 * `command` / `file_change`. Exact Cline tool ids for 3.0.42 content events
 * were not captured on the auth-fail runs (research §2) — // UNKNOWN(research).
 */
const SHELL_TOOL_RE = /^(execute_command|run_command|bash|shell|command|run_terminal)/i;
const FILE_TOOL_RE =
  /^(write_to_file|replace_in_file|write_file|edit_file|apply_diff|search_and_replace|create_file|delete_file|editedExistingFile|newFileCreated)/i;

function dataDirAbs(task: TaskSpec): string {
  return path.resolve(task.cwd, DATA_DIR_REL);
}

function mcpTimeoutMs(answerTimeoutMs: number): number {
  return answerTimeoutMs + MCP_TIMEOUT_HEADROOM_MS;
}

/**
 * MCP hub config for streamable HTTP + correlation headers (research §3
 * canonical shape). Written under the isolated data-dir settings path.
 * `timeoutMs` is best-effort (#107) — schema/types mention it; live honor
 * on 3.0.42 is not fully proven.
 */
function mcpSettingsJson(hub: HubInfo, answerTimeoutMs: number): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            // Best-effort raise above answer timeout (#107 major).
            timeoutMs: mcpTimeoutMs(answerTimeoutMs),
            transport: {
              type: "streamableHttp",
              url: hub.url,
              headers: hub.headers,
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
 * Node wrap script: run `cline …`, pass through stdout/stderr, then scrape the
 * newest session manifest under PARLEY_CLINE_DATA_DIR and emit a synthetic
 * scrape line. Concurrent-safe (no adapter instance state).
 */
function sessionWrapScript(): string {
  return `// Generated by parley cline adapter — scrape session id after exit (#107).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.${DATA_DIR_ENV};
const [bin, ...args] = process.argv.slice(2);
if (!bin) {
  console.error("parley-session-wrap: missing cline binary argv");
  process.exit(1);
}

function newestSessionId() {
  if (!dataDir) return undefined;
  const sessionsRoot = path.join(dataDir, "sessions");
  let bestId;
  let bestMtime = -1;
  let dirs;
  try {
    dirs = fs.readdirSync(sessionsRoot);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const jsonPath = path.join(sessionsRoot, dir, \`\${dir}.json\`);
    try {
      const st = fs.statSync(jsonPath);
      if (st.mtimeMs < bestMtime) continue;
      const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const id =
        typeof raw.session_id === "string" && raw.session_id !== ""
          ? raw.session_id
          : dir;
      bestMtime = st.mtimeMs;
      bestId = id;
    } catch {
      // skip unreadable / partial session files
    }
  }
  return bestId;
}

const child = spawn(bin, args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});
child.on("error", (err) => {
  console.error(String(err));
  process.exit(1);
});
child.on("close", (code) => {
  const sid = newestSessionId();
  if (sid) {
    process.stdout.write(
      JSON.stringify({ type: "parley_session_scrape", session_id: sid }) + "\\n",
    );
  }
  process.exit(code === null ? 1 : code);
});
`;
}

function authEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of AUTH_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Auto `-P <provider>` when exactly one BYOK key is present and the caller did
 * not already pass `-P` / `--provider` in extraArgs (#107 major).
 */
export function providerFlags(
  task: TaskSpec,
  env: NodeJS.ProcessEnv,
): string[] {
  const extra = task.extraArgs;
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i];
    if (a === "-P" || a === "--provider") return [];
    if (typeof a === "string" && (a.startsWith("-P=") || a.startsWith("--provider="))) {
      return [];
    }
  }

  const presentByok = AUTH_ENV_KEYS.filter(
    (key) => env[key] !== undefined && ENV_KEY_TO_PROVIDER[key] !== undefined,
  );
  if (presentByok.length !== 1) return [];
  const provider = ENV_KEY_TO_PROVIDER[presentByok[0]!];
  if (provider === undefined) return [];
  return ["-P", provider];
}

/**
 * Map normalized posture to Cline mechanisms (research §5). Cline has no
 * codex-style sandbox flags; closest safe postures:
 *  - always private `--data-dir` (state isolation, not OS FS sandbox)
 *  - always `--auto-approve true` (headless; default already true)
 *  - `read-only` → deny-all `CLINE_COMMAND_PERMISSIONS` (shell only)
 *  - `network:false` → **no first-class toggle** (UNKNOWN whether command
 *    permissions can block network; not equivalent to codex `network_access`)
 *  - `full` / `workspace` → unconstrained tools with auto-approve
 */
function postureEnv(task: TaskSpec): Record<string, string> {
  const env: Record<string, string> = {};
  if (task.sandbox === "read-only") {
    env.CLINE_COMMAND_PERMISSIONS = READ_ONLY_COMMAND_PERMISSIONS;
  }
  // network:false — intentionally no env mapping (research §5 UNKNOWN:
  // no first-class network toggle; command permissions are not equivalent
  // to codex network_access). task.network is intentionally unused.
  return env;
}

/**
 * Flags shared by prepare: headless JSON, auto-approve, isolated data-dir,
 * worktree cwd, optional provider/model/effort, then extraArgs. The positional
 * prompt is appended by the caller so extraArgs never land after it
 * (TaskSpec / ADR-0009).
 *
 * Do **not** pass `--worktree` — Cline would create its own detached worktree
 * under `~/.cline/worktrees/`; Parley owns worktrees (research §9).
 */
function commonArgv(task: TaskSpec, env: NodeJS.ProcessEnv): string[] {
  const argv = [
    "--json",
    "--auto-approve",
    "true",
    "--data-dir",
    dataDirAbs(task),
    "-c",
    task.cwd,
  ];
  // Provider auto-select when a single BYOK key is present (#107).
  argv.push(...providerFlags(task, env));
  // Model / effort — opaque passthrough (research §6).
  if (task.model !== null) argv.push("-m", task.model);
  if (task.effort !== null) argv.push("--thinking", task.effort);
  // extraArgs in the flags region before the positional prompt.
  argv.push(...task.extraArgs);
  return argv;
}

function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
  return [
    { path: MCP_SETTINGS_REL, contents: mcpSettingsJson(hub, task.answerTimeoutMs) },
    { path: SESSION_WRAP_REL, contents: sessionWrapScript() },
  ];
}

function baseEnv(task: TaskSpec, env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...postureEnv(task),
    ...authEnv(env),
    // Absolute data-dir for the post-exit session scrape wrapper (#107).
    [DATA_DIR_ENV]: dataDirAbs(task),
  };
}

/**
 * Wrap argv so a Node script runs cline, then emits a session scrape line.
 * Uses `process.execPath` so we do not depend on `node` being on PATH.
 */
function wrappedArgv(task: TaskSpec, env: NodeJS.ProcessEnv, prompt: string): string[] {
  const wrapAbs = path.resolve(task.cwd, SESSION_WRAP_REL);
  const bin = env.PARLEY_CLINE_BIN ?? DEFAULT_CLINE_BIN;
  return [process.execPath, wrapAbs, bin, ...commonArgv(task, env), prompt];
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
 * Map Cline usage objects (camelCase, research §8) into VendorEvent.usage,
 * keeping harness field names and adding canonical
 * input_tokens / output_tokens / cached_tokens when derivable.
 */
function mapUsage(raw: unknown): Record<string, number> | undefined {
  const obj = asRecord(raw);
  if (!obj) return undefined;
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number") usage[key] = value;
  }
  if (Object.keys(usage).length === 0) return undefined;

  // Canonical keys when camelCase totals are present.
  if (typeof obj.inputTokens === "number") usage.input_tokens = obj.inputTokens;
  else if (typeof obj.totalInputTokens === "number") usage.input_tokens = obj.totalInputTokens;

  if (typeof obj.outputTokens === "number") usage.output_tokens = obj.outputTokens;
  else if (typeof obj.totalOutputTokens === "number") usage.output_tokens = obj.totalOutputTokens;

  if (typeof obj.cacheReadTokens === "number") usage.cached_tokens = obj.cacheReadTokens;
  else if (typeof obj.totalCacheReadTokens === "number") {
    usage.cached_tokens = obj.totalCacheReadTokens;
  }

  return usage;
}

/** Prefer aggregateUsage for whole-run totals when both are present (research §8). */
function usageFromRunResult(event: Record<string, unknown>): Record<string, number> | undefined {
  return mapUsage(event.aggregateUsage) ?? mapUsage(event.usage);
}

/**
 * Normalize nested agent_event payload (research §9). Field names for text /
 * tool content beyond the auth-fail error shape are partially UNKNOWN — parse
 * defensively.
 */
function parseAgentEvent(event: Record<string, unknown>): VendorEvent[] {
  const type = event.type;
  switch (type) {
    case "content_start":
    case "content_end":
    case "content_update": {
      const contentType = asString(event.contentType || event.content_type);
      if (contentType === "text" || contentType === "") {
        // Prefer final text on content_end; mid-stream updates may only have delta.
        const text =
          asString(event.text) || asString(event.content) || asString(event.delta);
        if (type === "content_update" && text === "") return [];
        if (type === "content_start" && text === "") return [];
        if (text !== "") return [{ kind: "message", text }];
        return [];
      }
      if (contentType === "tool" || contentType === "tool_use" || contentType === "tool_call") {
        return parseToolContent(event);
      }
      // reasoning / other content — opaque
      return [];
    }
    case "usage": {
      const usage = mapUsage(event);
      return usage ? [{ kind: "session_meta", usage }] : [];
    }
    case "error": {
      const err = asRecord(event.error);
      const message = err ? asString(err.message) : asString(event.message);
      // recoverable:false → fatal; recoverable:true → mid-run non-fatal
      // (research §9: fatal: !event.recoverable).
      const recoverable = event.recoverable === true;
      return [{ kind: "error", text: message, fatal: !recoverable }];
    }
    case "done": {
      const out: VendorEvent[] = [];
      const text = asString(event.text);
      if (text !== "") out.push({ kind: "message", text });
      const usage = mapUsage(event.usage) ?? mapUsage(event);
      if (usage) out.push({ kind: "session_meta", usage });
      return out;
    }
    case "iteration_start":
    case "iteration_end":
    case "notice":
      return [];
    default:
      return [];
  }
}

function parseToolContent(event: Record<string, unknown>): VendorEvent[] {
  // UNKNOWN(research): exact tool name / input field layout on content events.
  const name =
    asString(event.toolName) ||
    asString(event.tool_name) ||
    asString(event.name) ||
    asString(asRecord(event.tool)?.name);
  const input =
    asString(event.input) ||
    asString(event.arguments) ||
    asString(event.command) ||
    (typeof event.input === "object" && event.input !== null
      ? JSON.stringify(event.input)
      : "");
  const summary = [name, input].filter(Boolean).join(" ").trim();

  if (name !== "" && SHELL_TOOL_RE.test(name)) {
    return [{ kind: "command", text: summary || name }];
  }
  if (name !== "" && FILE_TOOL_RE.test(name)) {
    return [{ kind: "file_change", text: summary || name }];
  }
  // Unknown tool → opaque (raw JSONL keeps it).
  return [];
}

/**
 * Read the newest session_id under a Cline data-dir (research §4 / #107).
 * Exported for unit tests that reproduce the disk layout without the wrap script.
 */
export function scrapeClineSessionId(dataDir: string): string | undefined {
  const sessionsRoot = path.join(dataDir, "sessions");
  let bestId: string | undefined;
  let bestMtime = -1;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(sessionsRoot);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const jsonPath = path.join(sessionsRoot, dir, `${dir}.json`);
    try {
      const st = fs.statSync(jsonPath);
      if (st.mtimeMs < bestMtime) continue;
      const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
        session_id?: unknown;
      };
      const id =
        typeof raw.session_id === "string" && raw.session_id !== ""
          ? raw.session_id
          : dir;
      bestMtime = st.mtimeMs;
      bestId = id;
    } catch {
      // skip
    }
  }
  return bestId;
}

export function createClineAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  return withPostureDiagnostics({
    id: "cline",
    childChannel: "mcp",
    enforcement: CLINE_ENFORCEMENT,

    prepare(task, hub): Promise<SpawnPlan> {
      // Fresh headless one-shot (research §2 / §9) via session-scrape wrapper:
      //   node parley-session-wrap.mjs cline --json … "<prompt>"
      return Promise.resolve({
        argv: wrappedArgv(task, env, task.prompt),
        env: baseEnv(task, env),
        files: files(task, hub),
        cwd: task.cwd,
      });
    },

    resume(task, _hub): Promise<SpawnPlan> {
      // #107 critical: headless `--id` + `--json` is VERIFIED broken on 3.0.42.
      // Refuse rather than ship a broken resume argv that exits 1 without context.
      return Promise.reject(
        new Error(
          `cline resume is unsupported on 3.0.42: headless --id + --json fails ` +
            `("JSON output mode requires a prompt argument or piped stdin") even ` +
            `with a trailing prompt. Session ids are still scraped from --data-dir ` +
            `for observability; multi-turn needs a fixed Cline release` +
            (task.sessionId !== undefined ? ` (scraped id was ${task.sessionId})` : ""),
        ),
      );
    },

    parseEvent(line: string): VendorEvent[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return []; // opaque non-JSON — raw log keeps it
      }
      const event = asRecord(parsed);
      if (!event) return [];

      switch (event.type) {
        case "parley_session_scrape": {
          // Synthetic post-exit line from the wrap script (#107 critical).
          const session_id = asString(event.session_id);
          return session_id !== "" ? [{ kind: "session_meta", session_id }] : [];
        }
        case "hook_event": {
          // agent_start carries agentId/taskId which are NOT the resume
          // session id (research §4). Emit empty — optional session_meta
          // without session_id is noise for sessionId().
          return [];
        }
        case "agent_event": {
          const nested = asRecord(event.event);
          if (!nested) return [];
          return parseAgentEvent(nested);
        }
        case "run_result": {
          // Terminal summary (research §8 / §9): usage + fatal error when
          // finishReason is "error". Prefer aggregateUsage for whole-run totals.
          const out: VendorEvent[] = [];
          const usage = usageFromRunResult(event);
          if (usage) out.push({ kind: "session_meta", usage });
          if (event.finishReason === "error") {
            out.push({
              kind: "error",
              text: asString(event.text) || "cline run_result finishReason=error",
              fatal: true,
            });
          }
          return out;
        }
        case "error": {
          // Top-level error on stdout or stderr (research §2 / §9) — run-terminal.
          // Engine dual-feeds stderr into parseEvent (#107).
          const text = asString(event.message);
          // Tag approval-shaped failures that cancel our MCP tools (headless
          // has no TTY) so diag.log is greppable — same VENDOR_DIAG_PREFIX
          // pattern as codex's mcp_tool_call guardian gate.
          const lower = text.toLowerCase();
          if (
            lower.includes("approval") ||
            lower.includes("auto-approve") ||
            (lower.includes("mcp") && (lower.includes("cancel") || lower.includes("denied")))
          ) {
            return [
              {
                kind: "error",
                text: `${VENDOR_DIAG_PREFIX} cline: ${text}`,
                fatal: true,
              },
            ];
          }
          return [{ kind: "error", text, fatal: true }];
        }
        default:
          // Unknown / docs-stale shapes (say/ask) → opaque.
          return [];
      }
    },

    sessionId(events: VendorEvent[]): string | undefined {
      // Last session_meta with a session_id (codex pattern). On 3.0.42 the
      // stream never carries one; the wrap script's parley_session_scrape line
      // is the side channel (#107).
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "session_meta" && event.session_id !== undefined) {
          return event.session_id;
        }
      }
      return undefined;
    },

    // listModels omitted — no CLI enumeration command (research §7).
    // Selected-model read (#284): not a catalog — pre-fill + rejection only.
    readSelectedModel(): SelectedModel | null {
      return readClineSelectedModel(env);
    },
  });
}

/** Exported for tests that assert the private data-dir relative path. */
export const CLINE_DATA_DIR_REL = DATA_DIR_REL;
export const CLINE_MCP_SETTINGS_REL = MCP_SETTINGS_REL;
export const CLINE_SESSION_WRAP_REL = SESSION_WRAP_REL;
export const CLINE_DATA_DIR_ENV = DATA_DIR_ENV;

/**
 * Relative path of the operator providers settings file under the cline home
 * (`~/.cline/data/settings/providers.json`). Co-locates credentials with
 * model data — parsers must extract only model/reasoning keys (#284).
 */
const PROVIDERS_SETTINGS_REL = path.join("data", "settings", "providers.json");

/** Cap on providers.json — credentials co-located; never slurp unbounded. */
export const CLINE_PROVIDERS_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Project only the selected model + reasoning effort out of cline's
 * `providers.json` (#284).
 *
 * The file co-locates API keys under each provider's settings — we walk only
 * `lastUsedProvider` → `providers.<id>.settings.model` and
 * `settings.reasoning.effort`, and never return, log, or re-serialize anything
 * else. Fail-soft: never throws; `model: null` means no selection known.
 *
 * Parser errors must not embed source fragments (modern `JSON.parse` does) —
 * callers only see our fixed shape messages, never `err.message`.
 */
export function parseClineSelectedModel(text: string): {
  model: string | null;
  effort: string | null;
  error: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never interpolate the parser error — it can embed file content (secrets).
    return { model: null, effort: null, error: "malformed providers.json" };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { model: null, effort: null, error: "unexpected providers.json shape" };
  }
  const lastUsed =
    typeof root.lastUsedProvider === "string" ? root.lastUsedProvider : null;
  if (lastUsed === null || lastUsed === "") {
    // Empty/fresh settings without a selection — not an error.
    return { model: null, effort: null, error: null };
  }
  const providers = asRecord(root.providers);
  if (!providers) {
    return { model: null, effort: null, error: "unexpected providers.json shape" };
  }
  const provider = asRecord(providers[lastUsed]);
  if (!provider) {
    return { model: null, effort: null, error: null };
  }
  const settings = asRecord(provider.settings) ?? provider;
  const rawModel = typeof settings.model === "string" ? settings.model.trim() : null;
  if (rawModel === null || rawModel === "") {
    return { model: null, effort: null, error: null };
  }
  let effort: string | null = null;
  const reasoning = asRecord(settings.reasoning);
  if (reasoning && typeof reasoning.effort === "string") {
    const e = reasoning.effort.trim();
    // Surface the stored effort when present. `enabled` is informational —
    // the CLI still records the effort value alongside it.
    if (e !== "") effort = e;
  }
  return { model: rawModel, effort, error: null };
}

/**
 * Read the operator's cline selection from providers.json (#284). Fail soft
 * on every path — never throws; never logs credential material.
 */
export function readClineSelectedModel(
  env: NodeJS.ProcessEnv = process.env,
): SelectedModel | null {
  const home = resolveOperatorVendorHome("cline", env);
  if (home === null) return null;
  const settingsPath = path.join(home, PROVIDERS_SETTINGS_REL);
  let text: string;
  try {
    // TOCTOU accepted: stat then read (same rationale as goose/openhands —
    // isFile() stops the static-FIFO hang; race-to-FIFO and hung mounts are
    // accepted fail-soft residual risk on an advisory path).
    const stat = fs.statSync(settingsPath);
    // #288 / #284: refuse non-files (FIFO, dir, device). readFileSync on a
    // FIFO blocks the daemon event loop forever — selection is fail-soft null.
    if (!stat.isFile()) return null;
    if (stat.size > CLINE_PROVIDERS_MAX_BYTES) return null;
    text = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return null;
  }
  const { model, effort } = parseClineSelectedModel(text);
  if (model === null || model === "") return null;
  return { model, effort };
}
