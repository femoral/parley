import path from "node:path";
import type {
  HubInfo,
  MaterializedFile,
  ModelEntry,
  ProbedModels,
  SandboxMode,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
} from "./types.js";
import { VENDOR_DIAG_PREFIX } from "./types.js";
import { runProbe } from "./probe.js";

/**
 * The `pi` vendor adapter — real delegation to Pi Coding Agent (`pi` binary from
 * `@earendil-works/pi-coding-agent`, research docs/research/pi-cli-automation.md,
 * verified 0.80.7). Spec §9, ADR-0004/0006.
 *
 * Pi is a **materialized-files** adapter (like grok): native MCP is not built
 * in (research §3, "No MCP" philosophy). The hub is injected by writing
 * `.mcp.json` for the community `pi-mcp-adapter` package (must be installed
 * via `pi install npm:pi-mcp-adapter` or loaded with `-e` — see
 * `PARLEY_PI_MCP_ADAPTER`). There is **no native filesystem/network sandbox**
 * (research §5); soft read-only maps to `--tools`, workspace/full share the
 * default tool set, and `network:false` cannot be expressed in-process.
 *
 * Headless shape: `pi --mode json -p …` (spawn-per-turn, ADR-0004). Exit codes
 * are uninformative (always 0) — fatal failures live in the stream
 * (`stopReason === "error"`). Golden fixtures under `tests/fixtures/pi/` pin
 * the observed 0.80.7 event shapes from the research doc.
 */

/** Default binary; override via `PARLEY_PI_BIN` (smoke tests, custom installs). */
const DEFAULT_PI_BIN = "pi";

/**
 * Headroom (ms) added to `answerTimeoutMs` when setting pi-mcp-adapter's
 * `requestTimeoutMs` (research §3 / §9). Mirrors codex's tool_timeout headroom
 * so a blocking `ask_orchestrator` is never killed before the orchestrator answers.
 */
const REQUEST_TIMEOUT_HEADROOM_MS = 60_000;

/**
 * Fixed Pi thinking levels used as catalog efforts (research §7: `--list-models`
 * only reports thinking yes/no, not per-row enums).
 */
const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Provider auth env keys named in research §6. Only forwarded when set in the
 * parent env (same pattern as grok's `XAI_API_KEY`).
 */
const AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "MISTRAL_API_KEY",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "HF_TOKEN",
] as const;

/** The probe command recorded as the catalog entry's `source` on refresh. */
const MODELS_SOURCE = "pi --list-models";

/**
 * Soft sandbox via tool allowlists (research §5). Pi has no OS sandbox or
 * network flag in-process:
 *  - `read-only` → read tools only (no bash/edit/write)
 *  - `workspace` / `full` → default tools (identical in-process; full has no
 *    extra privilege flag)
 *  - `network:false` → **not expressible**; document-only gap (host/container
 *    isolation required for real network off)
 */
function sandboxArgs(sandbox: SandboxMode): string[] {
  switch (sandbox) {
    case "read-only":
      // Soft read-only: no bash / edit / write (research §5 table).
      return ["--tools", "read,grep,find,ls"];
    case "full":
    case "workspace":
    default:
      // No native write sandbox; default built-in tools.
      return [];
  }
}

function requestTimeoutMs(answerTimeoutMs: number): number {
  return answerTimeoutMs + REQUEST_TIMEOUT_HEADROOM_MS;
}

/**
 * Project `.mcp.json` for pi-mcp-adapter (research §3). `requestTimeoutMs` is
 * raised above the answer timeout; `directTools` registers parley's hub tools
 * natively; `samplingAutoApprove` is required for non-UI sampling sessions.
 *
 * UNKNOWN(research): whether pi-mcp-adapter reads root `.mcp.json` without
 * project trust — we pass `--approve` as belt-and-braces (research §5/§9).
 */
function mcpJson(task: TaskSpec, hub: HubInfo): string {
  const timeout = requestTimeoutMs(task.answerTimeoutMs);
  return (
    JSON.stringify(
      {
        mcpServers: {
          parley: {
            url: hub.url,
            headers: hub.headers,
            auth: false,
            lifecycle: "eager",
            requestTimeoutMs: timeout,
            directTools: ["ask_orchestrator", "submit_report"],
          },
        },
        settings: {
          requestTimeoutMs: timeout,
          samplingAutoApprove: true,
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Private session storage under the task cwd (research §4 `--session-dir`).
 * Must match between prepare and resume so `--session` resolves.
 */
function sessionDir(task: TaskSpec): string {
  return path.join(task.cwd, ".pi", "sessions");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Join text blocks from a Pi message `content` array. */
function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

/**
 * Normalize Pi `message.usage` (research §8) into VendorEvent.usage: keep
 * harness field names and add canonical keys when derivable.
 */
function normalizeUsage(raw: unknown): Record<string, number> | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(u)) {
    if (typeof value === "number") usage[key] = value;
  }
  // Nested cost.total → optional float `cost` (research §8 table).
  const cost = asRecord(u.cost);
  if (cost && typeof cost.total === "number") usage.cost = cost.total;

  // Canonical keys for engine/aggregation (derivable from Pi field names).
  if (typeof u.input === "number") usage.input_tokens = u.input;
  if (typeof u.output === "number") usage.output_tokens = u.output;
  if (typeof u.cacheRead === "number") usage.cached_tokens = u.cacheRead;

  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** MCP / report tools whose failures warrant a PARLEY-DIAG tag (research §9). */
function isHubTool(toolName: string): boolean {
  return (
    toolName === "ask_orchestrator" ||
    toolName === "submit_report" ||
    toolName === "parley" ||
    toolName.startsWith("mcp")
  );
}

/**
 * Parse `pi --list-models` plain-text table into normalized model entries
 * (research §7). Format is unpinned whitespace columns; match defensively.
 * Efforts are the fixed Pi thinking levels (table only has yes/no). Throws when
 * no rows parse so refresh keeps the existing catalog entry.
 *
 * Observed 0.80.7 shape:
 *   provider      model                         context  max-out  thinking  images
 *   openai-codex  gpt-5.5                       272K     128K     yes       yes
 */
export function parsePiModels(text: string): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || /^provider\s+model\b/i.test(trimmed)) continue;
    // Columns: provider model context max-out thinking images (research §7).
    // Require ≥4 fields so prose like "No models here." never parses as a row.
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const provider = parts[0]!;
    const model = parts[1]!;
    const context = parts[2]!;
    // Context column is a size token (e.g. 128K / 272K / 500K), not free text.
    if (!/^\d+[KkMmGg]?$/.test(context)) continue;
    if (provider === "provider" || model === "model") continue;
    // Prefer provider/model so ids are unique across providers (research §6
    // `--model` accepts provider/id patterns).
    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      efforts: [...PI_THINKING_LEVELS],
      default_effort: null,
    });
  }
  if (entries.length === 0) {
    throw new Error("pi --list-models: no model rows parsed from output");
  }
  return entries;
}

export function createPiAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_PI_BIN ?? DEFAULT_PI_BIN;

  /**
   * Env shared by fresh runs and resumes: hermetic startup network, auth
   * passthrough (research §6). Does **not** set a private `PI_CODING_AGENT_DIR`
   * by default — that would isolate auth.json/OAuth; callers that need full
   * home isolation should set it externally after provisioning keys.
   */
  function baseEnv(): Record<string, string> {
    const result: Record<string, string> = {
      // Hermetic startup: no version check / package telemetry (research §6).
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    };
    for (const key of AUTH_ENV_KEYS) {
      const value = env[key];
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
    return [{ path: ".mcp.json", contents: mcpJson(task, hub) }];
  }

  /**
   * Flags after the mode/prompt head. Order: isolation → model/effort → soft
   * sandbox → project trust → optional MCP extension path → extraArgs.
   *
   * `--approve` loads project resources (`.mcp.json` / `.pi/*`) headlessly
   * (research §5). Interactive permission popups do not exist in core Pi.
   */
  function commonArgv(task: TaskSpec): string[] {
    const argv: string[] = [
      "--offline", // research §6 / §9 — hermetic startup network
      "--session-dir",
      sessionDir(task), // research §4 — private session storage
    ];
    if (task.model !== null) argv.push("--model", task.model);
    // Effort maps to core `--thinking` (research §6). `--effort` is not core
    // (pi-effort extension only); pass the opaque string through as thinking.
    if (task.effort !== null) argv.push("--thinking", task.effort);
    argv.push(...sandboxArgs(task.sandbox));
    argv.push("--approve"); // research §5 — trust project materialization headlessly
    // Optional explicit load of pi-mcp-adapter (or a Parley-owned extension).
    // When set, also disable discovery so the user's global extensions cannot
    // bleed into the child (research §9 risk #8).
    const mcpExt = env.PARLEY_PI_MCP_ADAPTER;
    if (mcpExt !== undefined && mcpExt !== "") {
      argv.push("--no-extensions", "-e", mcpExt);
    }
    // extraArgs land in the flags region (prompt is a -p value, never ambiguous).
    argv.push(...task.extraArgs);
    return argv;
  }

  return {
    id: "pi",

    prepare(task, hub): Promise<SpawnPlan> {
      // Fresh one-shot: `pi --mode json -p <prompt> …` (research §2 / §9).
      return Promise.resolve({
        argv: [bin, "--mode", "json", "-p", task.prompt, ...commonArgv(task)],
        env: baseEnv(),
        files: files(task, hub),
        cwd: task.cwd,
      });
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (ADR-0004, research §4): `--session <id>` with the
      // same `--session-dir` as prepare. `task.prompt` is the orchestrator answer.
      if (task.sessionId === undefined) {
        // Without a session id Pi would start a brand-new session (or -c most
        // recent, which is wrong for multi-task hosts). Fail loudly like grok.
        return Promise.reject(new Error(`pi resume for task ${task.id} has no session id`));
      }
      return Promise.resolve({
        argv: [
          bin,
          "--mode",
          "json",
          "-p",
          task.prompt,
          "--session",
          task.sessionId,
          ...commonArgv(task),
        ],
        env: baseEnv(),
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
        case "session":
          // First JSONL line: session header with resumable id (research §2/§4).
          return [
            {
              kind: "session_meta",
              session_id: typeof event.id === "string" ? event.id : undefined,
            },
          ];

        case "message_end": {
          const message = asRecord(event.message);
          if (!message) return [];
          const role = asString(message.role);
          const stopReason = asString(message.stopReason);
          const out: VendorEvent[] = [];

          // Run-terminal auth/API failures (exit code still 0 — research §2).
          if (stopReason === "error") {
            out.push({
              kind: "error",
              text: asString(message.errorMessage) || "pi stopReason=error",
              fatal: true,
            });
          } else if (role === "assistant") {
            // Prefer full text at message_end over text_delta streams (research §9).
            const text = textFromContent(message.content);
            if (text !== "") out.push({ kind: "message", text });
          }

          // Usage on assistant message_end / also present on error messages.
          if (role === "assistant") {
            const usage = normalizeUsage(message.usage);
            if (usage) out.push({ kind: "session_meta", usage });
          }
          return out;
        }

        case "message_update": {
          // Optional streaming display — skipped so we don't duplicate message_end.
          // Prefer end-of-message text (research §9).
          return [];
        }

        case "tool_execution_start": {
          const toolName = asString(event.toolName);
          const args = asRecord(event.args) ?? {};
          if (toolName === "bash") {
            return [{ kind: "command", text: asString(args.command) }];
          }
          if (toolName === "write" || toolName === "edit") {
            // Defensive arg shapes: path / file_path / filePath (research §9).
            const p =
              asString(args.path) || asString(args.file_path) || asString(args.filePath);
            return [{ kind: "file_change", text: p }];
          }
          return [];
        }

        case "tool_execution_end": {
          // Mid-run tool failures are non-fatal; the agent may recover.
          if (event.isError !== true) return [];
          const toolName = asString(event.toolName);
          const result = asRecord(event.result);
          const detail =
            textFromContent(result?.content) ||
            asString(result?.message) ||
            asString(event.errorMessage) ||
            "tool error";
          if (isHubTool(toolName)) {
            return [
              {
                kind: "error",
                text: `${VENDOR_DIAG_PREFIX} tool=${toolName} failed: ${detail}`,
              },
            ];
          }
          return [{ kind: "error", text: detail }];
        }

        case "extension_error":
          // Extension load/runtime failures (research §9).
          return [
            {
              kind: "error",
              text:
                asString(event.message) ||
                asString(event.error) ||
                "pi extension_error",
            },
          ];

        case "agent_start":
        case "agent_end":
        case "agent_settled":
        case "turn_start":
        case "turn_end":
        case "message_start":
        case "tool_execution_update":
          // Lifecycle / mid-stream — opaque (raw log is durable).
          return [];

        default:
          return [];
      }
    },

    sessionId(events: VendorEvent[]): string | undefined {
      // Last session_meta with a session_id (opening `session` line — research §9).
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "session_meta" && event.session_id !== undefined) {
          return event.session_id;
        }
      }
      return undefined;
    },

    async listModels(): Promise<ProbedModels> {
      // Plain-text table (research §7); no --json flag.
      const stdout = await runProbe(bin, ["--list-models"]);
      return { source: MODELS_SOURCE, models: parsePiModels(stdout) };
    },
  };
}
