import path from "node:path";
import type {
  HubInfo,
  MaterializedFile,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
} from "./types.js";
import { VENDOR_DIAG_PREFIX } from "./types.js";

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
 * MCP tool timeout (research §3): whether `timeoutMs` (or similar) is honored
 * inside `cline_mcp_settings.json` is UNKNOWN — not raised here. Codex-style
 * `tool_timeout_sec` does not apply; long `ask_orchestrator` calls rely on
 * Cline's default until re-verified.
 *
 * Session id (research §4): **not present** on the NDJSON stream in 3.0.42.
 * `sessionId()` follows the codex contract (last `session_meta` with
 * `session_id`) and will return undefined until a stream field appears or a
 * data-dir side channel is added. Headless `--id` resume is VERIFIED broken
 * on 3.0.42; `resume()` still builds the documented argv shape so a fixed
 * release can work, and rejects when no session id is supplied (Grok pattern).
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

const MCP_SERVER_NAME = "parley";

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

/**
 * MCP hub config for streamable HTTP + correlation headers (research §3
 * canonical shape). Written under the isolated data-dir settings path.
 */
function mcpSettingsJson(hub: HubInfo): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
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

function authEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of AUTH_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
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
 * Flags shared by prepare and resume: headless JSON, auto-approve, isolated
 * data-dir, worktree cwd, optional model/effort, then extraArgs. The positional
 * prompt is appended by the caller so extraArgs never land after it
 * (TaskSpec / ADR-0009).
 *
 * Do **not** pass `--worktree` — Cline would create its own detached worktree
 * under `~/.cline/worktrees/`; Parley owns worktrees (research §9).
 */
function commonArgv(task: TaskSpec): string[] {
  const argv = [
    "--json",
    "--auto-approve",
    "true",
    "--data-dir",
    dataDirAbs(task),
    "-c",
    task.cwd,
  ];
  // Model / effort — opaque passthrough (research §6).
  if (task.model !== null) argv.push("-m", task.model);
  if (task.effort !== null) argv.push("--thinking", task.effort);
  // extraArgs in the flags region before the positional prompt.
  argv.push(...task.extraArgs);
  return argv;
}

function files(hub: HubInfo): MaterializedFile[] {
  return [{ path: MCP_SETTINGS_REL, contents: mcpSettingsJson(hub) }];
}

function baseEnv(task: TaskSpec, env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...postureEnv(task),
    ...authEnv(env),
  };
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

export function createClineAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_CLINE_BIN ?? DEFAULT_CLINE_BIN;

  return {
    id: "cline",

    prepare(task, hub): Promise<SpawnPlan> {
      // Fresh headless one-shot (research §2 / §9):
      //   cline --json --auto-approve true --data-dir … -c <cwd> … "<prompt>"
      return Promise.resolve({
        argv: [bin, ...commonArgv(task), task.prompt],
        env: baseEnv(task, env),
        files: files(hub),
        cwd: task.cwd,
      });
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Documented resume argv (research §4 / §9). Headless `--id` + `--json`
      // is VERIFIED broken on 3.0.42 ("JSON output mode requires a prompt…");
      // still emit the shape so a fixed Cline can resume, and reject without
      // a session id so we never silently start a fresh conversation.
      if (task.sessionId === undefined) {
        return Promise.reject(new Error(`cline resume for task ${task.id} has no session id`));
      }
      return Promise.resolve({
        argv: [bin, ...commonArgv(task), "--id", task.sessionId, task.prompt],
        env: baseEnv(task, env),
        files: files(hub),
        cwd: task.cwd,
      });
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
      // stream never carries one (research §4); returns undefined until that
      // changes or a data-dir scrape is wired into the engine.
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "session_meta" && event.session_id !== undefined) {
          return event.session_id;
        }
      }
      return undefined;
    },

    // listModels omitted — no CLI enumeration command (research §7).
  };
}

/** Exported for tests that assert the private data-dir relative path. */
export const CLINE_DATA_DIR_REL = DATA_DIR_REL;
export const CLINE_MCP_SETTINGS_REL = MCP_SETTINGS_REL;
