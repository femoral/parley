import path from "node:path";
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
} from "./types.js";
import { VENDOR_DIAG_PREFIX, withPostureDiagnostics } from "./types.js";
import { runProbe } from "./probe.js";

/** Pi: soft tool allowlists; network:false refused in prepare (#107 / #279). */
const PI_ENFORCEMENT: AdapterEnforcement = {
  "read-only": { level: "approximate", via: "--tools read-only allowlist" },
  workspace: { level: "none", via: "default tools; no write sandbox" },
  full: { level: "enforced", via: "default tools; unrestricted as requested" },
  "network:false": { level: "refused", via: "prepare refuses (#107)" },
};

/**
 * The `pi` vendor adapter — real delegation to Pi Coding Agent (`pi` binary from
 * `@earendil-works/pi-coding-agent`, research docs/research/pi-cli-automation.md,
 * verified 0.80.7). Spec §9, ADR-0004/0006.
 *
 * Pi has **no native MCP client** (research §3, "No MCP" philosophy). Parley
 * injects hub tools by materializing a **Parley-owned extension**
 * (`.parley/pi-hub-extension.ts`) and loading it with `--no-extensions -e`
 * (adapter-validation-a / #107). The extension registers `ask_orchestrator` /
 * `submit_report` via the daemon child REST surface (`POST /child/ask`,
 * `POST /child/report`) so we never depend on community `pi-mcp-adapter` or its
 * cold `directTools` metadata cache.
 *
 * Optional escape hatch: `PARLEY_PI_MCP_ADAPTER` still loads an external
 * extension path instead of (or in addition to) the built-in hub extension
 * when set — used for experiments; default path always ships the Parley hub.
 *
 * There is **no native filesystem/network sandbox** (research §5); soft
 * read-only maps to `--tools`, workspace/full share the default tool set, and
 * `network:false` is refused loudly (cannot be expressed in-process).
 *
 * Headless shape: `pi --mode json -p …` (spawn-per-turn, ADR-0004). Exit codes
 * are uninformative (always 0) — fatal failures live in the stream
 * (`stopReason === "error"`). Golden fixtures under `tests/fixtures/pi/` pin
 * the observed 0.80.7 event shapes from the research doc.
 */

/** Default binary; override via `PARLEY_PI_BIN` (smoke tests, custom installs). */
const DEFAULT_PI_BIN = "pi";

/** Relative path of the materialized Parley hub extension (research §3 alt path). */
const HUB_EXTENSION_PATH = ".parley/pi-hub-extension.ts";

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
 *  - `network:false` → **not expressible**; prepare refuses (see
 *    {@link assertPiNetworkPosture})
 */
function sandboxArgs(sandbox: SandboxMode): string[] {
  switch (sandbox) {
    case "read-only":
      // Soft read-only: no bash / edit / write (research §5 table).
      // Always include hub tools so submit_report works under --tools allowlist.
      return ["--tools", "read,grep,find,ls,ask_orchestrator,submit_report"];
    case "full":
    case "workspace":
    default:
      // No native write sandbox; default built-in tools + extension hub tools.
      return [];
  }
}

/**
 * Loud capability gap: Pi cannot enforce network-off in-process (#107).
 */
export function assertPiNetworkPosture(task: TaskSpec): void {
  if (task.network) return;
  throw new Error(
    "pi: network:false is not expressible in-process (no OS/network sandbox " +
      "flag). Refuse rather than under-isolate (#107). Use network:true or wrap " +
      "the child in an external netns/container.",
  );
}

/**
 * Derive the daemon base URL from the hub MCP URL (`…/mcp` → origin+path root).
 */
function hubBaseUrl(hubUrl: string): string {
  try {
    const u = new URL(hubUrl);
    // Strip a trailing /mcp segment when present.
    u.pathname = u.pathname.replace(/\/mcp\/?$/, "") || "/";
    // Avoid trailing slash for clean join.
    const base = u.toString().replace(/\/$/, "");
    return base === "" ? hubUrl : base;
  } catch {
    return hubUrl.replace(/\/mcp\/?$/, "");
  }
}

/**
 * Materialized Pi extension that registers Parley protocol tools against the
 * child REST surface (ADR-0011). Avoids pi-mcp-adapter + directTools cache
 * entirely (adapter-validation-a critical findings).
 *
 * Hub base URL and correlation headers are embedded at materialize time (per
 * task) so the extension needs no env plumbing for identity.
 */
function hubExtensionSource(hub: HubInfo, answerTimeoutMs: number): string {
  const base = hubBaseUrl(hub.url);
  const headersJson = JSON.stringify(hub.headers);
  // Abort slightly above answer timeout so the engine stall wins first, then
  // the extension surfaces a clean error if the socket hangs.
  const fetchTimeoutMs = answerTimeoutMs + 60_000;
  return `// Generated by parley — do not edit; regenerated on every (re)spawn.
// Parley hub tools via child REST (POST /child/report, POST /child/ask).
// Loaded with: pi --no-extensions -e ${HUB_EXTENSION_PATH}

const HUB_BASE = ${JSON.stringify(base)};
const HUB_HEADERS = ${headersJson} as Record<string, string>;
const FETCH_TIMEOUT_MS = ${fetchTimeoutMs};

async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<{ ok: boolean; status: number; json: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(HUB_BASE + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...HUB_HEADERS,
      },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export default function (pi: any) {
  pi.registerTool({
    name: "submit_report",
    label: "Submit Report",
    description:
      "Submit the final task report. Required before finishing: a task only " +
      "completes when a schema-valid report is submitted. Default schema: " +
      '{ summary: string (markdown), outcome: "success" | "partial" | "blocked", ' +
      "files_changed: string[] }.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        outcome: { type: "string" },
        files_changed: { type: "array", items: { type: "string" } },
      },
      additionalProperties: true,
    },
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const { ok, status, json } = await postJson("/child/report", params, signal);
      if (!ok) {
        const err =
          (json && Array.isArray(json.errors) && json.errors.join("; ")) ||
          (json && typeof json.error === "string" && json.error) ||
          ("report rejected (HTTP " + status + ")");
        return {
          content: [{ type: "text", text: String(err) }],
          details: { status, json },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: "report accepted" }],
        details: { accepted: true },
      };
    },
  });

  pi.registerTool({
    name: "ask_orchestrator",
    label: "Ask Orchestrator",
    description:
      "Ask the orchestrator a blocking question when stuck. Blocks until the " +
      "orchestrator answers; the answer is returned as the tool result. Use " +
      "only when you genuinely cannot proceed. Argument: { question: string }.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question for the orchestrator" },
      },
      required: ["question"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const question = params.question;
      if (typeof question !== "string" || question.trim() === "") {
        return {
          content: [{ type: "text", text: "ask_orchestrator requires a non-empty 'question' string" }],
          details: {},
          isError: true,
        };
      }
      const { ok, status, json } = await postJson("/child/ask", { question }, signal);
      if (!ok) {
        const err =
          (json && typeof json.error === "string" && json.error) ||
          ("ask failed (HTTP " + status + ")");
        return {
          content: [{ type: "text", text: String(err) }],
          details: { status, json },
          isError: true,
        };
      }
      const answer = json && typeof json.answer === "string" ? json.answer : JSON.stringify(json);
      return {
        content: [{ type: "text", text: answer }],
        details: { answer },
      };
    },
  });
}
`;
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
    return [
      {
        path: HUB_EXTENSION_PATH,
        contents: hubExtensionSource(hub, task.answerTimeoutMs),
      },
    ];
  }

  /**
   * Flags after the mode/prompt head. Order: isolation → model/effort → soft
   * sandbox → project trust → hub extension → optional external MCP path →
   * extraArgs.
   *
   * Always load the Parley hub extension with `--no-extensions -e` so user
   * global extensions cannot bleed in and hub tools are always present
   * (adapter-validation-a / #107). `PARLEY_PI_MCP_ADAPTER` may point at an
   * additional extension (e.g. experimental MCP adapter) loaded after the hub.
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
    // Hermetic extension load: disable discovery, load Parley hub always.
    argv.push("--no-extensions", "-e", HUB_EXTENSION_PATH);
    // Optional extra extension (legacy pi-mcp-adapter path or experiments).
    const mcpExt = env.PARLEY_PI_MCP_ADAPTER;
    if (mcpExt !== undefined && mcpExt !== "") {
      argv.push("-e", mcpExt);
    }
    // extraArgs land in the flags region (prompt is a -p value, never ambiguous).
    argv.push(...task.extraArgs);
    return argv;
  }

  return withPostureDiagnostics({
    id: "pi",
    childChannel: "mcp",
    enforcement: PI_ENFORCEMENT,

    prepare(task, hub): Promise<SpawnPlan> {
      try {
        assertPiNetworkPosture(task);
      } catch (err) {
        return Promise.reject(err);
      }
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
      try {
        assertPiNetworkPosture(task);
      } catch (err) {
        return Promise.reject(err);
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
  });
}
