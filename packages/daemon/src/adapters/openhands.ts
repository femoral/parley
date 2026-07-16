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
 * The `openhands` vendor adapter — real delegation to OpenHands CLI (`openhands`
 * binary, PyPI package `openhands`, not the legacy `openhands-ai` library).
 * Verified against OpenHands CLI 1.16.0 / SDK 1.21.0 (2026-07-16); see
 * `docs/research/openhands-cli-automation.md` for the surface.
 *
 * File/env-heavy like grok, not flags-only like codex:
 *  - Headless one-shot: `openhands --headless --json --override-with-envs -t …`
 *    (research §2). Headless hard-codes `NeverConfirm` (approvals off).
 *  - MCP hub is injected by materializing `mcp.json` under a task-private
 *    `OPENHANDS_PERSISTENCE_DIR` (research §3) — there is no per-invocation MCP
 *    flag or env carrying MCP JSON.
 *  - Isolation: private `OPENHANDS_PERSISTENCE_DIR` / `OPENHANDS_CONVERSATIONS_DIR`
 *    so the user's `~/.openhands` never bleeds into the child (research §1/§9).
 *  - Session id is **not** in JSONL events; scrape trailing
 *    `Conversation ID: <hex>` text (research §4/§9) into synthetic `session_meta`.
 *  - Token usage is **not** in the stream (research §8); optionally appears on
 *    `ConversationStateUpdateEvent` (UNKNOWN) or only in on-disk `base_state.json`
 *    after exit.
 *
 * Sandbox posture (research §5): the CLI path is a host-local workspace
 * (`LocalWorkspace(working_dir=OPENHANDS_WORK_DIR|cwd)`). There is **no** CLI
 * sandbox matrix and **no** network-off lever. Closest safe posture we can
 * implement: always set `OPENHANDS_WORK_DIR` + spawn `cwd` to the task worktree
 * (soft workspace affinity). `read-only` and `network:false` cannot be enforced
 * by OpenHands itself — document the gap, do not claim they are real.
 *
 * MCP tool timeout (research §3): SDK hardcodes `MCP_TOOL_TIMEOUT_SECONDS = 300`
 * with no CLI/config dial. Unlike codex's `tool_timeout_sec`, we cannot raise it
 * above `task.answerTimeoutMs`. // UNKNOWN(research): how to raise without
 * patching the SDK.
 *
 * Effort (research §6): no CLI flag and no `LLM_REASONING_EFFORT` under
 * `--override-with-envs` (env override only has api_key/base_url/model). When
 * `task.effort` is set we materialize a minimal `agent_settings.json` with
 * `llm.reasoning_effort`. // UNKNOWN(research): whether a partial Agent JSON
 * merges cleanly with env-created agents, or replaces and breaks headless.
 */

/** Default binary; override via `PARLEY_OPENHANDS_BIN` (smoke tests, custom installs). */
const DEFAULT_OPENHANDS_BIN = "openhands";

const MCP_SERVER_NAME = "parley";

/**
 * Task-private plumbing under the worktree (relative to `task.cwd`). Kept out of
 * the user's `~/.openhands` and git-excluded by the engine via `SpawnPlan.files`.
 */
const PERSIST_REL = ".parley-openhands/persist";
const CONVERSATIONS_REL = ".parley-openhands/conversations";

/** Trailing stdout conversation id (research §4) — hex 32 or dashed UUID. */
const CONVERSATION_ID_RE = /Conversation ID:\s*([0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}|[0-9a-fA-F]{32})\b/;

/**
 * MCP config written to `$OPENHANDS_PERSISTENCE_DIR/mcp.json` (research §3).
 * Format verified via `openhands mcp add` / `RemoteMCPServer.model_dump()`.
 */
function mcpJson(hub: HubInfo): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            url: hub.url,
            transport: "http",
            headers: hub.headers,
            enabled: true,
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Minimal agent settings for reasoning effort (research §6). Full Agent JSON is
 * the disk format; we only set the effort field when asked.
 */
function agentSettingsJson(effort: string): string {
  return (
    JSON.stringify(
      {
        llm: {
          reasoning_effort: effort,
        },
      },
      null,
      2,
    ) + "\n"
  );
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
 * Normalize conversation id to dashed UUID when it is 32 hex digits (research §4:
 * trailing stdout is undashed; resume accepts both; store prefers dashed form).
 */
function normalizeSessionId(raw: string): string {
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex)) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return raw;
}

/** Join text blocks from `llm_message.content[]` (research §2 MessageEvent). */
function messageText(llmMessage: unknown): string {
  const msg = asRecord(llmMessage);
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

/**
 * Map OpenHands accumulated token usage fields (research §8) onto VendorEvent.usage
 * with both harness names and canonical keys when derivable.
 */
function usageFromAccumulated(acc: Record<string, unknown>): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(acc)) {
    if (typeof value === "number") usage[key] = value;
  }
  // Canonical keys when the harness names are present.
  if (typeof acc.prompt_tokens === "number") usage.input_tokens = acc.prompt_tokens;
  if (typeof acc.completion_tokens === "number") usage.output_tokens = acc.completion_tokens;
  if (typeof acc.cache_read_tokens === "number") usage.cached_tokens = acc.cache_read_tokens;
  return usage;
}

/**
 * Try to pull usage from a ConversationStateUpdateEvent-shaped payload (research
 * §8 — UNKNOWN whether local `--json` ever emits this; parse defensively).
 */
function usageFromStateUpdate(event: Record<string, unknown>): Record<string, number> | undefined {
  // Common shapes: nested stats, or a value field carrying stats.
  const candidates = [event.stats, asRecord(event.value)?.stats, event.data]
    .map(asRecord)
    .filter((r): r is Record<string, unknown> => r !== undefined);

  for (const stats of candidates) {
    const usageToMetrics = asRecord(stats.usage_to_metrics);
    const agent = asRecord(usageToMetrics?.agent);
    const acc = asRecord(agent?.accumulated_token_usage);
    if (acc) {
      const usage = usageFromAccumulated(acc);
      if (typeof agent?.accumulated_cost === "number") usage.cost = agent.accumulated_cost;
      if (Object.keys(usage).length > 0) return usage;
    }
  }
  return undefined;
}

export function createOpenhandsAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_OPENHANDS_BIN ?? DEFAULT_OPENHANDS_BIN;

  /**
   * Env shared by prepare and resume: isolation dirs, suppress banner, auth, model.
   * Sandbox: only soft workdir affinity (research §5) — no real matrix.
   */
  function baseEnv(task: TaskSpec): Record<string, string> {
    const persistDir = path.resolve(task.cwd, PERSIST_REL);
    const conversationsDir = path.resolve(task.cwd, CONVERSATIONS_REL);
    const result: Record<string, string> = {
      // Hide SDK banner on every invocation (research §1).
      OPENHANDS_SUPPRESS_BANNER: "1",
      // Task-private roots — never the user's ~/.openhands (research §1/§9).
      OPENHANDS_PERSISTENCE_DIR: persistDir,
      OPENHANDS_CONVERSATIONS_DIR: conversationsDir,
      // Soft workspace affinity (research §5): only lever we have.
      OPENHANDS_WORK_DIR: path.resolve(task.cwd),
    };

    // Auth env passthrough (research §6) — only the keys the doc names, only when set.
    if (env.LLM_API_KEY !== undefined) result.LLM_API_KEY = env.LLM_API_KEY;
    if (env.LLM_BASE_URL !== undefined) result.LLM_BASE_URL = env.LLM_BASE_URL;

    // Model: task.model wins; otherwise forward parent LLM_MODEL when present so
    // --override-with-envs headless still has the required pair (research §2/§6).
    if (task.model !== null) {
      result.LLM_MODEL = task.model;
    } else if (env.LLM_MODEL !== undefined) {
      result.LLM_MODEL = env.LLM_MODEL;
    }

    return result;
  }

  /** Materialize mcp.json (+ optional agent_settings for effort) under private persist. */
  function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
    const materialized: MaterializedFile[] = [
      { path: `${PERSIST_REL}/mcp.json`, contents: mcpJson(hub) },
    ];
    // UNKNOWN(research): partial agent_settings.json may not merge with env agent.
    if (task.effort !== null) {
      materialized.push({
        path: `${PERSIST_REL}/agent_settings.json`,
        contents: agentSettingsJson(task.effort),
      });
    }
    return materialized;
  }

  /**
   * Flags region shared by prepare/resume, before `-t <prompt>`.
   * extraArgs land here so they are never swallowed as the task string
   * (TaskSpec contract / ADR-0009).
   */
  function commonArgv(task: TaskSpec): string[] {
    // --headless: NeverConfirm approvals (research §2/§5).
    // --json: JSONL event dump on stdout (requires --headless).
    // --override-with-envs: apply LLM_API_KEY / LLM_MODEL / LLM_BASE_URL (research §6).
    return ["--headless", "--json", "--override-with-envs", ...task.extraArgs];
  }

  function planFor(task: TaskSpec, hub: HubInfo, resumeSessionId: string | undefined): SpawnPlan {
    const argv = [bin, ...commonArgv(task)];
    if (resumeSessionId !== undefined) {
      // Headless resume still requires -t (research §4).
      argv.push("--resume", resumeSessionId);
    }
    argv.push("-t", task.prompt);
    return {
      argv,
      env: baseEnv(task),
      files: files(task, hub),
      cwd: task.cwd,
    };
  }

  return {
    id: "openhands",

    prepare(task, hub): Promise<SpawnPlan> {
      return Promise.resolve(planFor(task, hub, undefined));
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (ADR-0004): --resume <id> -t <follow-up> (research §4).
      // Without a session id OpenHands cannot resume a conversation; fail loudly
      // like grok rather than starting a fresh run with no context.
      if (task.sessionId === undefined || task.sessionId === "") {
        return Promise.reject(new Error(`openhands resume for task ${task.id} has no session id`));
      }
      return Promise.resolve(planFor(task, hub, task.sessionId));
    },

    parseEvent(line: string): VendorEvent[] {
      // Non-JSON stdout pollution is expected (research §2): "Initializing agent…",
      // "Conversation ID: …", rich panels, etc. Scrape session id from text; else [].
      const trimmed = line.trim();
      if (trimmed === "") return [];

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const match = CONVERSATION_ID_RE.exec(line);
        if (match?.[1]) {
          return [
            {
              kind: "session_meta",
              session_id: normalizeSessionId(match[1]),
            },
          ];
        }
        return []; // opaque vendor noise — the raw log keeps it
      }

      const event = asRecord(parsed);
      if (!event) return [];

      // Discriminator is `kind`, not `type` (research §2 — docs schematic is wrong).
      switch (event.kind) {
        case "MessageEvent": {
          // User/agent text from llm_message content blocks (research §9).
          const text = messageText(event.llm_message);
          if (text === "") return [];
          return [{ kind: "message", text }];
        }
        case "ActionEvent": {
          const toolName = asString(event.tool_name);
          const action = asRecord(event.action);
          if (toolName === "terminal") {
            // TerminalAction: command string (research §2 sample).
            const command = asString(action?.command);
            return [{ kind: "command", text: command }];
          }
          if (toolName === "file_editor") {
            // FileEditorAction: command + path (research §2).
            const cmd = asString(action?.command);
            const filePath = asString(action?.path);
            const text = [cmd, filePath].filter(Boolean).join(" ");
            return [{ kind: "file_change", text }];
          }
          // Other / MCP tools: surface as message with tool name (research §9).
          if (toolName !== "") {
            return [{ kind: "message", text: `tool:${toolName}` }];
          }
          return [];
        }
        case "ObservationEvent":
          // Optional progress noise — skip (research §9).
          return [];
        case "AgentErrorEvent": {
          // Per-tool error; agent may recover (research §9) — non-fatal.
          const errText = asString(event.error) || asString(event.detail);
          const tool = asString(event.tool_name);
          const text =
            tool !== ""
              ? `${VENDOR_DIAG_PREFIX} agent_error tool=${tool}: ${errText}`
              : errText;
          return [{ kind: "error", text, fatal: false }];
        }
        case "ConversationErrorEvent": {
          // Run-terminal failure (auth, crash, …) — fatal even when exit code is 0
          // (research §2 exit codes / §9).
          const code = asString(event.code);
          const detail = asString(event.detail);
          const text =
            code !== "" && detail !== ""
              ? `${code}: ${detail}`
              : detail || code || "conversation error";
          return [{ kind: "error", text, fatal: true }];
        }
        case "ConversationStateUpdateEvent": {
          // UNKNOWN(research): whether local --json emits stats. Parse if present.
          const usage = usageFromStateUpdate(event);
          if (usage) return [{ kind: "session_meta", usage }];
          return [];
        }
        case "SystemPromptEvent":
          // Filtered out of --json callback (research §2); handle if it appears.
          return [];
        case "TokenEvent":
          // Raw token IDs, not billing counters (research §2/§8).
          return [];
        default:
          // Unknown/changed kinds must never fail the task.
          return [];
      }
    },

    sessionId(events: VendorEvent[]): string | undefined {
      // Last session_meta with a session_id (same as codex).
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "session_meta" && event.session_id !== undefined) {
          return event.session_id;
        }
      }
      return undefined;
    },

    // listModels omitted: no CLI enumeration command (research §7); only a static
    // SDK VERIFIED_MODELS allowlist, not a live probe.
  };
}
