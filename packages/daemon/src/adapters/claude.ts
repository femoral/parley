import type {
  HubInfo,
  MaterializedFile,
  SandboxMode,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
} from "./types.js";
import { VENDOR_DIAG_PREFIX } from "./types.js";

/**
 * The `claude` vendor adapter — real delegation to Claude Code (`claude` binary,
 * spec §9, ADR-0004/0006). Verified against Claude Code 2.1.211 (2026-07-16); see
 * `docs/research/claude-code-cli-automation.md` for the surface.
 *
 * Claude is a **materialized-files** adapter (like grok): the hub is injected via
 * a temp MCP JSON file + `--mcp-config` / `--strict-mcp-config` (research §3).
 * Headless streaming requires **both** `--output-format stream-json` and
 * `--verbose` (research §2) — without `--verbose` the CLI exits 1 with no events.
 *
 * Posture maps to `--permission-mode` + `--allowedTools` (research §5, #107):
 * workspace → `acceptEdits` with hub/builtin allowlist; read-only → `dontAsk`
 * + read-class + hub tools; full → `bypassPermissions`. Claude has no simple
 * sandbox CLI enum like codex; OS-level Bash network lockdown is optional via
 * `--settings` when `network:false`.
 *
 * `parseEvent` is deliberately tolerant: any unknown or changed line yields `[]`
 * and the raw JSONL log (the durable record) keeps it. Exit codes are unreliable
 * (auth failure can exit 0 with `result.is_error: true`) — always parse the stream.
 */

/** Default binary; override via `PARLEY_CLAUDE_BIN` (smoke tests, custom installs). */
const DEFAULT_CLAUDE_BIN = "claude";

const MCP_SERVER_NAME = "parley";

/** Relative path of the materialized MCP config (research §3 / §9). */
const MCP_CONFIG_PATH = ".parley/claude-mcp.json";

/** Relative path of the materialized settings (research §5). */
const SETTINGS_PATH = ".parley/claude-settings.json";

/**
 * Headroom (ms) added to the answer timeout when raising Claude's per-tool MCP
 * timeout. A blocking `ask_orchestrator` waits up to the answer timeout; the
 * vendor timeout must sit strictly above it so the question is never killed by
 * the default 60s HTTP first-byte timer (research §3).
 */
const TOOL_TIMEOUT_HEADROOM_MS = 60_000;

/**
 * Auth env keys Claude Code reads for headless runs (research §6). Only forward
 * when the parent has them set — same pattern as grok's `XAI_API_KEY`.
 */
const AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

function toolTimeoutMs(answerTimeoutMs: number): number {
  return answerTimeoutMs + TOOL_TIMEOUT_HEADROOM_MS;
}

/**
 * Normalized posture → Claude `--permission-mode` + optional `--allowedTools`
 * (research §5 / §9, adapter-validation-a / #107).
 *
 * - `read-only` → `dontAsk` + allowlist Read/Grep/Glob + `mcp__parley__*`.
 *   Plan mode is exploration-only and was never proven to execute hub MCP
 *   tools (`submit_report` / `ask_orchestrator`); `dontAsk` denies anything
 *   not pre-allowed, so the allowlist is load-bearing for the protocol.
 * - `workspace` → `acceptEdits` + allowlist Read/Edit/Write/Bash +
 *   `mcp__parley__*`. Middle ground for auto file edits without granting
 *   full-host `bypassPermissions` (which skips protected-path checks).
 * - `full` → `bypassPermissions` (docs: isolated containers only). No
 *   allowlist — full tool privilege.
 *
 * Gap vs codex: Claude's Bash OS sandbox is settings-driven, not a simple CLI
 * enum; we only enable it for `network:false` (see {@link settingsJson}).
 */
function permissionMode(sandbox: SandboxMode): string {
  switch (sandbox) {
    case "read-only":
      return "dontAsk";
    case "full":
      return "bypassPermissions";
    case "workspace":
    default:
      return "acceptEdits";
  }
}

/**
 * Tool allowlist for non-`full` postures. Ensures hub tools always pass the
 * permission gate under `acceptEdits` / `dontAsk` (#107). Comma form matches
 * Claude Code 2.1.211 `--allowedTools` help.
 */
function allowedToolsArg(sandbox: SandboxMode): string | undefined {
  switch (sandbox) {
    case "read-only":
      // Read-class builtins + hub protocol tools only.
      return "Read,Grep,Glob,mcp__parley__*";
    case "full":
      return undefined;
    case "workspace":
    default:
      return "Read,Edit,Write,Bash,mcp__parley__*";
  }
}

/**
 * MCP JSON materialized into the task cwd and pointed at with `--mcp-config`
 * (research §3). Streamable HTTP + static headers + per-server timeout raised
 * above `answerTimeoutMs`. Paired with `--strict-mcp-config` so user/project
 * MCP and claude.ai connectors never bleed in.
 */
function mcpConfigJson(task: TaskSpec, hub: HubInfo): string {
  const timeout = toolTimeoutMs(task.answerTimeoutMs);
  return (
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: "http",
            url: hub.url,
            headers: hub.headers,
            timeout,
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Settings JSON for hermetic + optional network lockdown (research §5).
 *
 * Always disables claude.ai connectors. When `network:false` and sandbox is not
 * `full`, enables the Bash sandbox with a localhost allowlist so the hub remains
 * reachable.
 *
 * // UNKNOWN(research): whether MCP hub HTTP traffic is subject to the Bash
 * // sandbox network proxy. Research §5 notes sandbox network applies to Bash
 * // first; we still allowlist 127.0.0.1 / localhost for safety.
 */
function settingsJson(task: TaskSpec): string {
  const settings: Record<string, unknown> = {
    disableClaudeAiConnectors: true,
  };
  if (!task.network && task.sandbox !== "full") {
    settings.sandbox = {
      enabled: true,
      network: {
        allowedDomains: ["localhost", "127.0.0.1"],
      },
    };
  }
  return JSON.stringify(settings, null, 2) + "\n";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Pull numeric fields from a usage-like object into a flat record. */
function numericUsage(obj: Record<string, unknown> | undefined): Record<string, number> {
  const usage: Record<string, number> = {};
  if (!obj) return usage;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
  }
  return usage;
}

/**
 * Map Claude `result.usage` into VendorEvent.usage (research §8 / §9): keep the
 * harness field names and add canonical keys when derivable.
 */
function mapResultUsage(result: Record<string, unknown>): Record<string, number> {
  const raw = numericUsage(asRecord(result.usage));
  const usage: Record<string, number> = { ...raw };

  // Canonical keys for cross-vendor display (when derivable from harness names).
  if (typeof raw.input_tokens === "number") usage.input_tokens = raw.input_tokens;
  if (typeof raw.output_tokens === "number") usage.output_tokens = raw.output_tokens;
  // Prefer cache reads as "cached"; fall back to creation if only that is present.
  if (typeof raw.cache_read_input_tokens === "number") {
    usage.cached_tokens = raw.cache_read_input_tokens;
  } else if (typeof raw.cache_creation_input_tokens === "number") {
    usage.cached_tokens = raw.cache_creation_input_tokens;
  }

  if (typeof result.total_cost_usd === "number") {
    usage.total_cost_usd = result.total_cost_usd;
  }

  return usage;
}

/** Normalize assistant content blocks → thin VendorEvents (research §9). */
function parseAssistantContent(content: unknown): VendorEvent[] {
  if (!Array.isArray(content)) return [];
  const events: VendorEvent[] = [];
  const textParts: string[] = [];

  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    switch (b.type) {
      case "text": {
        const t = asString(b.text);
        if (t !== "") textParts.push(t);
        break;
      }
      case "tool_use": {
        const name = asString(b.name);
        const input = asRecord(b.input);
        if (name === "Bash") {
          events.push({
            kind: "command",
            text: input ? asString(input.command) : "",
          });
        } else if (name === "Edit" || name === "Write") {
          // File-mutating tools → file_change with the path when present.
          const filePath =
            input && typeof input.file_path === "string"
              ? input.file_path
              : input && typeof input.path === "string"
                ? input.path
                : name;
          events.push({ kind: "file_change", text: filePath });
        }
        // Other tools (Read, MCP, …) stay opaque — raw JSONL retains them.
        break;
      }
      // thinking, etc. — opaque
      default:
        break;
    }
  }

  if (textParts.length > 0) {
    events.unshift({ kind: "message", text: textParts.join("") });
  }
  return events;
}

export function createClaudeAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_CLAUDE_BIN ?? DEFAULT_CLAUDE_BIN;

  /** Env shared by fresh runs and resumes: auth + raised MCP tool timeout. */
  function baseEnv(task: TaskSpec): Record<string, string> {
    const result: Record<string, string> = {
      // Raise global MCP tool timeout above answerTimeoutMs (research §3).
      MCP_TOOL_TIMEOUT: String(toolTimeoutMs(task.answerTimeoutMs)),
      // Env equivalent of disableClaudeAiConnectors (research §3) — belt-and-braces
      // with the settings file so parent/user connector state cannot leak.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    };
    for (const key of AUTH_ENV_KEYS) {
      const value = env[key];
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  /** Files materialized pre-spawn: MCP config + settings (research §3 / §5 / §9). */
  function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
    return [
      { path: MCP_CONFIG_PATH, contents: mcpConfigJson(task, hub) },
      { path: SETTINGS_PATH, contents: settingsJson(task) },
    ];
  }

  /**
   * Flags after `-p <prompt>` (and optional `--resume`): stream-json+verbose,
   * hermetic MCP, permission posture, optional model/effort, git extra dirs,
   * then extraArgs in the flags region (never after an ambiguous positional
   * prompt — TaskSpec contract / ADR-0009).
   *
   * We do **not** pass `--bare`: it skips keychain OAuth and requires
   * `ANTHROPIC_API_KEY` / apiKeyHelper (research §2 / §6). Isolation is via
   * `--strict-mcp-config` + settings / `ENABLE_CLAUDEAI_MCP_SERVERS=false`.
   */
  function commonArgv(task: TaskSpec): string[] {
    const argv: string[] = [
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      MCP_CONFIG_PATH,
      "--strict-mcp-config",
      "--permission-mode",
      permissionMode(task.sandbox),
      "--settings",
      SETTINGS_PATH,
    ];
    const allowed = allowedToolsArg(task.sandbox);
    if (allowed !== undefined) argv.push("--allowedTools", allowed);
    if (task.model !== null) argv.push("--model", task.model);
    // Reasoning effort (research §6) — opaque string passed through unchanged.
    if (task.effort !== null) argv.push("--effort", task.effort);
    // Extra writable roots for worktree gitdirs (research §2 / §5). `--add-dir`
    // grants file access; Claude has no --cd — spawn cwd is task.cwd.
    if (task.gitDir !== undefined) argv.push("--add-dir", task.gitDir);
    if (task.gitCommonDir !== undefined && task.gitCommonDir !== task.gitDir) {
      argv.push("--add-dir", task.gitCommonDir);
    }
    // extraArgs land in the flags region (prompt is a -p value earlier).
    argv.push(...task.extraArgs);
    return argv;
  }

  return {
    id: "claude",
    childChannel: "mcp",

    prepare(task, hub): Promise<SpawnPlan> {
      // Fresh single-turn run (research §2 / §9): `claude -p <prompt> …`.
      // Capture session_id from system/init (or result) for resume.
      return Promise.resolve({
        argv: [bin, "-p", task.prompt, ...commonArgv(task)],
        env: baseEnv(task),
        files: files(task, hub),
        cwd: task.cwd,
      });
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (research §4): `--resume <session-id>` with the
      // orchestrator's answer as the follow-up prompt. Same cwd as the original
      // run (session lookup is project/cwd-scoped). Re-materialize MCP/settings.
      if (task.sessionId === undefined) {
        // Without --resume Claude starts a brand-new session, silently delivering
        // the answer to an agent with no conversation context. Fail loudly —
        // the engine reruns session-less stalled tasks via prepare().
        return Promise.reject(new Error(`claude resume for task ${task.id} has no session id`));
      }
      return Promise.resolve({
        argv: [
          bin,
          "-p",
          task.prompt,
          "--resume",
          task.sessionId,
          ...commonArgv(task),
        ],
        env: baseEnv(task),
        files: files(task, hub),
        cwd: task.cwd,
      });
    },

    parseEvent(line: string): VendorEvent[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return []; // opaque non-JSON vendor noise — the raw log keeps it
      }
      const event = asRecord(parsed);
      if (!event) return [];

      switch (event.type) {
        case "system": {
          // Primary session id capture on init (research §4 / §9).
          if (event.subtype === "init") {
            return [
              {
                kind: "session_meta",
                session_id:
                  typeof event.session_id === "string" ? event.session_id : undefined,
              },
            ];
          }
          // api_retry, plugin_install, hook events — opaque.
          return [];
        }
        case "assistant": {
          const message = asRecord(event.message);
          return parseAssistantContent(message?.content);
        }
        case "user": {
          // Tool results — keep opaque unless the tool_result is an error, then
          // surface a non-fatal diagnostic (agent may recover).
          const message = asRecord(event.message);
          const content = message?.content;
          if (!Array.isArray(content)) return [];
          for (const block of content) {
            const b = asRecord(block);
            if (!b || b.type !== "tool_result") continue;
            if (b.is_error === true) {
              const name = asString(b.tool_use_id);
              const errText =
                typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
              // Failed MCP/tool calls tagged for greppable diag.log (like codex).
              return [
                {
                  kind: "error",
                  text:
                    `${VENDOR_DIAG_PREFIX} tool_result tool_use_id=${name} ` +
                    `failed: ${errText}`,
                },
              ];
            }
          }
          return [];
        }
        case "result": {
          // Terminal event: session id + usage; is_error is run-terminal fatal
          // (exit codes are unreliable — research §2 / §8 / §9).
          const events: VendorEvent[] = [
            {
              kind: "session_meta",
              session_id:
                typeof event.session_id === "string" ? event.session_id : undefined,
              usage: mapResultUsage(event),
            },
          ];
          if (event.is_error === true) {
            const text =
              typeof event.result === "string" && event.result !== ""
                ? event.result
                : typeof event.terminal_reason === "string"
                  ? event.terminal_reason
                  : "claude result is_error";
            events.push({ kind: "error", text, fatal: true });
          }
          return events;
        }
        case "rate_limit_event":
        case "stream_event":
          return [];
        default:
          // Unknown/changed shapes must never fail the task (schema drifts).
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

    // listModels omitted: research §7 found no dedicated `claude models` command.
    // The informal `claude -p "/model" --output-format json` text probe is
    // unpinned and may drift; catalog stays hand-editable until a stable probe
    // exists.
  };
}
