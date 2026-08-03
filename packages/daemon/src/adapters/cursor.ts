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
import { runProbe } from "./probe.js";

/**
 * The `cursor` vendor adapter — real delegation to the Cursor CLI
 * (`cursor-agent` binary; the installer also ships the collision-prone alias
 * `agent`). Verified live against Cursor CLI 2026-08-03 (#300 / ADR-0027).
 *
 * Headless one-shot:
 *   cursor-agent -p --output-format stream-json --approve-mcps --trust
 *                [--force] [--model <id>] [--add-dir …] <prompt>
 *
 * `-p/--print` is a boolean flag; the prompt is a positional and MUST stay
 * last (extraArgs land in the flags region before it). `--trust` is
 * load-bearing headless: without it an untrusted workspace exits 1 with a
 * plain-text trust prompt before any JSON event (verified).
 *
 * Child channel is **mcp**: cursor discovers project config from the task cwd,
 * so the hub is injected by materializing `.cursor/mcp.json` (per-server
 * `headers` verified honored — `x-parley-task` arrives on every request) and
 * spawning with `--approve-mcps`. There is no `--mcp-config`-style flag, so a
 * repo that commits its own `.cursor/mcp.json` gets it shadowed in the task
 * worktree, and the operator's global `~/.cursor/mcp.json` servers still load
 * beside the hub (accepted bleed — ADR-0025 posture).
 *
 * **60s MCP tool-call cap (verified, no knob):** cursor's MCP client times a
 * tool call out at 60s (`MCP error -32001`); the per-server `timeout` field
 * and `MCP_TOOL_TIMEOUT`/`MCP_TIMEOUT` env are all ignored, and tools/call
 * carries no progress token. A blocking `ask_orchestrator` answered within
 * ~60s works on the fast path; slower answers surface as a tool error to the
 * child and are delivered on the resume path instead (spawn-per-turn design).
 * Prepare emits a PARLEY-DIAG line when `answerTimeoutMs` exceeds the cap.
 *
 * Posture maps to materialized `.cursor/cli.json` permissions + `--force`
 * (ADR-0023 / #300). Deny rules hold even under `--force` (verified: Write and
 * Shell both blocked, files not created). `--sandbox enabled` is a **no-op on
 * Linux** (verified: wrote outside the workspace and reached the network), so
 * it is never passed and the `workspace` cell is declared `none`.
 *
 * Models are **opaque ids with no effort axis** (ADR-0027): effort, thinking,
 * fast and context variants are baked into the id (`gpt-5.3-codex-low`,
 * `claude-opus-5-thinking-high`) with an irregular suffix grammar. `--model`
 * passes `task.model` through unchanged; a set `task.effort` is ignored with a
 * PARLEY-DIAG line. Discovery is probe-only (`--list-models`), each id one
 * entry with `efforts: []`.
 *
 * `parseEvent` is deliberately tolerant: unknown lines yield `[]` and the raw
 * JSONL log is the durable record. Stream shape (verified): `system/init`
 * (session_id), `assistant` (content text blocks), `tool_call`
 * started/completed with typed variants (`shellToolCall`, `editToolCall`,
 * `mcpToolCall`, `getMcpToolsToolCall`, …), terminal `result` (is_error +
 * camelCase usage). Plan-availability errors (`ActionRequiredError: Named
 * models unavailable …`) arrive as plain text with exit 1.
 */

/** Default binary; override via `PARLEY_CURSOR_BIN` (smoke tests, custom installs). */
const DEFAULT_CURSOR_BIN = "cursor-agent";

const MCP_SERVER_NAME = "parley";

/** Project-scoped MCP config cursor discovers from the task cwd (no flag exists). */
const MCP_CONFIG_PATH = ".cursor/mcp.json";

/** Project-scoped permissions file (allow/deny lists) cursor merges over global. */
const CLI_CONFIG_PATH = ".cursor/cli.json";

/** Probe command recorded as catalog `source` on refresh (ADR-0027). */
const MODELS_SOURCE = "cursor-agent --list-models";

/**
 * Cursor's hard MCP tool-call timeout (verified 2026-08-03: -32001 at exactly
 * 60s; no config or env knob, no progress token to reset it). Not adjustable —
 * used only to decide when to warn about the ask fast-path.
 */
export const CURSOR_MCP_TOOL_TIMEOUT_MS = 60_000;

/** Plain-text fatal line for plan/model availability (verified: exit 1, no JSON). */
const ACTION_REQUIRED_RE = /^ActionRequiredError:/;

/**
 * Posture declaration (#279 / ADR-0023), from live verification 2026-08-03:
 * cli.json denies hold even under --force (read-only is real at the tool
 * layer); nothing confines workspace writes (permissions cannot express
 * "inside cwd only" — deny beats allow — and --sandbox is a Linux no-op);
 * WebFetch deny covers only the WebFetch tool, shell keeps raw network.
 */
const CURSOR_ENFORCEMENT: AdapterEnforcement = {
  "read-only": {
    level: "approximate",
    via: "cli.json deny Write/Shell + no --force (denies verified to hold); reads + hub MCP allowed",
  },
  workspace: {
    level: "none",
    via: "--force; cli.json cannot scope writes to the workspace and --sandbox is a no-op on Linux",
  },
  full: { level: "enforced", via: "--force (unrestricted as requested)" },
  "network:false": {
    level: "approximate",
    via: "cli.json deny WebFetch(*); shell and MCP network unrestricted",
  },
};

/**
 * MCP config materialized into the task cwd (verified: per-server `headers`
 * are sent on every request). No `timeout` field — cursor ignores it; the 60s
 * cap is structural (see module docs).
 */
function mcpConfigJson(hub: HubInfo): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            url: hub.url,
            headers: hub.headers,
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Project permissions for the posture (verified semantics: deny beats allow
 * and beats --force). read-only denies Write/Shell wholesale and allows reads
 * + hub MCP tools (MCP calls verified to execute without --force under this
 * file). network:false adds the WebFetch deny in every sandbox mode — it is
 * an independent lever and cannot weaken `full`'s sandbox axis.
 */
export function cursorCliConfigJson(task: Pick<TaskSpec, "sandbox" | "network">): string {
  const allow: string[] = [`Mcp(${MCP_SERVER_NAME}:*)`];
  const deny: string[] = [];
  if (task.sandbox === "read-only") {
    allow.unshift("Read(**)");
    deny.push("Write(**)", "Shell(**)");
  }
  if (!task.network) {
    deny.push("WebFetch(*)");
  }
  return JSON.stringify({ permissions: { allow, deny } }, null, 2) + "\n";
}

/**
 * Parse `cursor-agent --list-models` stdout into catalog entries (ADR-0027).
 *
 * Piped output keeps ANSI colour codes (verified) — strip them first. Rows are
 * `<id> - <label>`; the `Available models` header, blank lines and the
 * trailing `Tip: …` are dropped. Every id is one opaque model: `efforts: []`,
 * `default_effort: null` — never split effort/thinking/fast suffixes out of
 * the id (the grammar is irregular: `xhigh` vs `extra-high`, `none`,
 * `minimal`, `-fast`, `1M`).
 */
export function parseCursorModels(text: string): ModelEntry[] {
  const models: ModelEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex -- intentional ESC CSI strip; piped output keeps ANSI
    const line = rawLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").trim();
    if (line === "") continue;
    if (/^available models/i.test(line)) continue;
    if (/^tip:/i.test(line)) continue;
    if (/^error/i.test(line)) continue;

    const match = line.match(/^(\S+) - (.+)$/);
    if (!match) continue;
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      efforts: [],
      default_effort: null,
      label: match[2]!.trim(),
    });
  }

  if (models.length === 0) {
    throw new Error("cursor-agent --list-models: no model ids parsed from output");
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
 * Map cursor's camelCase `result.usage` (verified: inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens) into a usage bag: raw names kept as-is
 * plus the canonical cross-vendor keys.
 */
function mapResultUsage(result: Record<string, unknown>): Record<string, number> | undefined {
  const raw = asRecord(result.usage);
  if (!raw) return undefined;
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
  }
  if (typeof usage.inputTokens === "number") usage.input_tokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number") usage.output_tokens = usage.outputTokens;
  if (typeof usage.cacheReadTokens === "number") usage.cached_tokens = usage.cacheReadTokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Join an assistant message's text content blocks (verified shape). */
function assistantText(message: Record<string, unknown> | undefined): string {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === "text") {
      const t = asString(b.text);
      if (t !== "") parts.push(t);
    }
  }
  return parts.join("");
}

/**
 * Normalize one `tool_call` event (verified variants). `started` yields the
 * activity event (command / file_change); `completed` yields a PARLEY-DIAG
 * error when the variant's result is a denial or error (non-fatal — the agent
 * may recover, e.g. cursor auto-retries a timed-out MCP call). Unknown
 * variants stay opaque.
 */
function parseToolCall(event: Record<string, unknown>): VendorEvent[] {
  const toolCall = asRecord(event.tool_call);
  if (!toolCall) return [];

  if (event.subtype === "started") {
    const shell = asRecord(toolCall.shellToolCall);
    if (shell) {
      const args = asRecord(shell.args);
      const command = args ? asString(args.command) : "";
      return command !== "" ? [{ kind: "command", text: command }] : [];
    }
    const edit = asRecord(toolCall.editToolCall) ?? asRecord(toolCall.writeToolCall);
    if (edit) {
      const args = asRecord(edit.args);
      const path = args ? asString(args.path) : "";
      return path !== "" ? [{ kind: "file_change", text: path }] : [];
    }
    // mcpToolCall / getMcpToolsToolCall / read variants — opaque; raw log keeps them.
    return [];
  }

  if (event.subtype === "completed") {
    for (const [variant, value] of Object.entries(toolCall)) {
      const call = asRecord(value);
      const result = call ? asRecord(call.result) : undefined;
      if (!result) continue;
      const error = asRecord(result.error);
      if (error) {
        const text = asString(error.error) || JSON.stringify(error);
        return [{ kind: "error", text: `${VENDOR_DIAG_PREFIX} ${variant} failed: ${text}` }];
      }
      const denied =
        asRecord(result.permissionDenied) ?? asRecord(result.writePermissionDenied);
      if (denied) {
        const text = asString(denied.error) || "blocked by permissions configuration";
        return [{ kind: "error", text: `${VENDOR_DIAG_PREFIX} ${variant} denied: ${text}` }];
      }
    }
    return [];
  }

  return [];
}

export function createCursorAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_CURSOR_BIN ?? DEFAULT_CURSOR_BIN;

  /**
   * Optional API-key passthrough. Auth is normally the operator's `~/.cursor`
   * login (flags-only home, ADR-0025); `CURSOR_API_KEY` is an operator-supplied
   * override channel, never a parley-managed secret.
   */
  function baseEnv(): Record<string, string> {
    const result: Record<string, string> = {};
    if (env.CURSOR_API_KEY !== undefined) result.CURSOR_API_KEY = env.CURSOR_API_KEY;
    return result;
  }

  /** Files materialized pre-spawn: hub MCP config + posture permissions. */
  function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
    return [
      { path: MCP_CONFIG_PATH, contents: mcpConfigJson(hub) },
      { path: CLI_CONFIG_PATH, contents: cursorCliConfigJson(task) },
    ];
  }

  /**
   * Flags between the boolean `-p` and the positional prompt. `--trust`
   * always (headless trust prompt exits 1 otherwise); `--force` for
   * workspace/full only — read-only relies on print-mode propose-only plus
   * the cli.json denies. Never `--sandbox` (Linux no-op, verified).
   */
  function commonArgv(task: TaskSpec): string[] {
    const argv: string[] = [
      "--output-format",
      "stream-json",
      "--approve-mcps",
      "--trust",
    ];
    if (task.sandbox !== "read-only") argv.push("--force");
    if (task.model !== null && task.model !== "") {
      // Opaque id passthrough (ADR-0027) — effort/thinking/fast live in the id.
      argv.push("--model", task.model);
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
    // extraArgs in the flags region — the prompt positional comes after.
    argv.push(...task.extraArgs);
    return argv;
  }

  /** Adapter-specific spawn diagnostics (fail-open; never block the spawn). */
  function spawnDiagnostics(task: TaskSpec): string[] {
    const out: string[] = [];
    if (task.effort !== null && task.effort !== "") {
      out.push(
        `${VENDOR_DIAG_PREFIX} cursor: effort "${task.effort}" ignored — cursor bakes ` +
          `effort into the model id (ADR-0027); pick a suffixed model id instead`,
      );
    }
    if (task.answerTimeoutMs > CURSOR_MCP_TOOL_TIMEOUT_MS) {
      out.push(
        `${VENDOR_DIAG_PREFIX} cursor: MCP tool calls cap at 60s (no knob; verified) — ` +
          `an ask_orchestrator answered slower than that surfaces as a tool timeout to ` +
          `the child; the answer is delivered on resume instead`,
      );
    }
    return out;
  }

  function spawnPlan(task: TaskSpec, hub: HubInfo, resumeSessionId?: string): SpawnPlan {
    const argv = [bin, "-p", ...commonArgv(task)];
    if (resumeSessionId !== undefined) {
      argv.push("--resume", resumeSessionId);
    }
    argv.push(task.prompt);
    return {
      argv,
      env: baseEnv(),
      files: files(task, hub),
      cwd: task.cwd,
      diagnostics: spawnDiagnostics(task),
    };
  }

  return withPostureDiagnostics({
    id: "cursor",
    childChannel: "mcp",
    enforcement: CURSOR_ENFORCEMENT,

    prepare(task, hub): Promise<SpawnPlan> {
      return Promise.resolve(spawnPlan(task, hub));
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (verified: --resume <chatId> keeps context and
      // the same session_id). Without a chat id cursor starts a brand-new
      // session, silently delivering the answer to an agent with no context —
      // fail loudly (claude precedent).
      if (task.sessionId === undefined) {
        return Promise.reject(new Error(`cursor resume for task ${task.id} has no session id`));
      }
      return Promise.resolve(spawnPlan(task, hub, task.sessionId));
    },

    parseEvent(line: string): VendorEvent[] {
      // Plain-text fatal (verified): plan/model availability errors are not
      // JSON and exit 1 — the only signal for a run that never streamed.
      if (ACTION_REQUIRED_RE.test(line.trim())) {
        return [{ kind: "error", text: `${VENDOR_DIAG_PREFIX} ${line.trim()}`, fatal: true }];
      }

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
          // session_id on init (verified). `model` here is a display label
          // ("Auto", "GPT-5.4 Nano Medium"), not a catalog id — never report
          // it as vendor model provenance (#154 wants ids, not labels).
          if (event.subtype === "init") {
            const sessionId = asString(event.session_id);
            return sessionId !== ""
              ? [{ kind: "session_meta", session_id: sessionId }]
              : [];
          }
          return [];
        }
        case "assistant": {
          const text = assistantText(asRecord(event.message));
          return text !== "" ? [{ kind: "message", text }] : [];
        }
        case "tool_call":
          return parseToolCall(event);
        case "result": {
          // Terminal event (verified): session id + camelCase usage; is_error
          // marks a run-terminal failure (exit codes are not trusted).
          const meta: VendorEvent = { kind: "session_meta" };
          const sessionId = asString(event.session_id);
          if (sessionId !== "") meta.session_id = sessionId;
          const usage = mapResultUsage(event);
          if (usage !== undefined) meta.usage = usage;
          const events: VendorEvent[] = [meta];
          if (event.is_error === true) {
            const text = asString(event.result) || "cursor result is_error";
            events.push({ kind: "error", text, fatal: true });
          }
          return events;
        }
        // thinking deltas, user echo, raw stream deltas — opaque.
        default:
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
      // Probe-only discovery (ADR-0027): no readModels (no enumerable on-disk
      // catalog), no shipped entry, no readSelectedModel. Output keeps ANSI
      // when piped — parseCursorModels strips it.
      const stdout = await runProbe(bin, ["--list-models"]);
      return { source: MODELS_SOURCE, models: parseCursorModels(stdout) };
    },
  });
}
