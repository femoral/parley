import type {
  AdapterEnforcement,
  HubInfo,
  ModelEntry,
  ProbedModels,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
  VendorModels,
} from "./types.js";
import { VENDOR_DIAG_PREFIX, withPostureDiagnostics } from "./types.js";
import { runProbe } from "./probe.js";

/**
 * The `kilo` vendor adapter — real delegation to Kilo Code CLI (`kilo` binary,
 * OpenCode fork; GitHub #103). Verified surface pinned to `@kilocode/cli@7.4.9`
 * — see `docs/research/kilo-cli-automation.md`.
 *
 * Closer to Grok (config injection) than Codex (pure `-c` flags): the hub and
 * posture ride `KILO_CONFIG_CONTENT` (inline JSON; hermetic, no worktree file
 * pollution — research §3). Approvals are force-disabled with `--auto` plus
 * config `permission`; JSONL events come from `kilo run --format json`.
 *
 * Load-bearing caveats from the research doc:
 *  - Auth/API failures still exit 0 while emitting a JSON `error` event — the
 *    adapter must treat stream `error` as fatal (research §2 / §9).
 *  - MCP `timeout` defaults to 5s; we raise it above `answerTimeoutMs` (research §3).
 *  - `sandbox.network: "deny"` blocks remote MCP tool calls (breaks the hub).
 *  - With sandbox enabled, `.git` is always read-only — tasks that must commit
 *    leave sandbox disabled (research §5).
 *
 * Event shapes for the success path: OpenCode-lineage fixtures match the 7.4.9
 * binary emission path (`nA("step_start"|"tool_use"|"text"|"step_finish"|…)`
 * with `part.tool` / `part.tokens` — **binary-verified** 2026-07-16, #107).
 * Live authenticated success streams were still not captured (no provider keys
 * in validation). `parseEvent` is deliberately tolerant: unknown/changed lines
 * yield `[]`.
 *
 * BYOK (#107 minor→applied): when parent sets common provider keys
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) they are forwarded so users without
 * `KILO_API_KEY` can still hit configured providers.
 */

/** Default binary; override via `PARLEY_KILO_BIN` (smoke tests, custom installs). */
const DEFAULT_KILO_BIN = "kilo";

const MCP_SERVER_NAME = "parley";

/**
 * Headroom added to the answer timeout when raising Kilo's MCP request timeout
 * (config `mcp.<name>.timeout` and `experimental.mcp_timeout`, both ms; schema
 * default is 5000 — far below Parley's answer timeout; research §3 / §9).
 */
const MCP_TIMEOUT_HEADROOM_MS = 60_000;

/**
 * Provider BYOK keys documented for config `{env:…}` injection (research §6).
 * Forward when set so isolation does not drop provider credentials that Kilo
 * would otherwise only see from global config (#107).
 */
const BYOK_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "AZURE_OPENAI_API_KEY",
] as const;

/** The probe command recorded as the catalog entry's `source` on refresh. */
const MODELS_SOURCE = "kilo models";

/**
 * Shell/bash-like tool names → `command` events (research §9 table). OpenCode
 * lineage uses `bash`; binary also has shell-adjacent strings — match a small
 * allow-list rather than inventing unknown names.
 */
const COMMAND_TOOLS = new Set(["bash", "shell"]);

/**
 * File-mutating tool names → `file_change` events (research §9 table).
 * // UNKNOWN(research): exact write/edit tool ids under live Kilo 7.4.9 not
 * re-verified; names mirror OpenCode lineage / common agent tool labels.
 */
const FILE_CHANGE_TOOLS = new Set([
  "write",
  "edit",
  "patch",
  "multiedit",
  "str_replace",
  "create",
]);

function mcpTimeoutMs(answerTimeoutMs: number): number {
  return answerTimeoutMs + MCP_TIMEOUT_HEADROOM_MS;
}

/**
 * Permission config for the injected `KILO_CONFIG_CONTENT` (research §5 matrix).
 *
 * Kilo has no codex-style three-mode sandbox flag; posture is config-driven
 * permissions (+ optional OS sandbox object). Headless recipe always pairs this
 * with `--auto` so tools never prompt.
 *
 * Gap: there is no true OS-level read-only mode flag. `read-only` is approximated
 * by a deny-by-default permission object that still allows read/grep/glob and
 * namespaced Parley MCP tools (`parley_*`).
 */
function permissionFor(task: TaskSpec): string | Record<string, string> {
  if (task.sandbox === "read-only") {
    return {
      "*": "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
      // MCP tools are namespaced `{server}_{tool}` (research §3).
      "parley_*": "allow",
    };
  }
  // workspace + full: open permissions (sandbox object carries isolation when used).
  return "allow";
}

/**
 * Optional OS sandbox object (research §5).
 *
 * Critical gaps documented for the engine/operator:
 *  - With `sandbox.enabled: true`, `.git` is always read-only — a sandboxed
 *    child cannot `git commit` in the worktree. Default workspace+network leaves
 *    sandbox **disabled** so hub MCP + commits work.
 *  - `sandbox.network: "deny"` blocks remote MCP tool calls — incompatible with
 *    the Parley hub. Applied only when the task explicitly asks for no network.
 *  - `writable_paths` / `allowed_hosts` can only expand from **global** config;
 *    project/`KILO_CONFIG_CONTENT` cannot grant extra writable roots (research §5
 *    quirk) — so `task.gitDir` / `gitCommonDir` cannot be injected here.
 */
function sandboxFor(task: TaskSpec): { enabled: boolean; network?: "allow" | "deny" } {
  if (task.sandbox === "full") {
    // Closest to danger-full-access; network is unrestricted (spec §8 matrix).
    return { enabled: false };
  }
  if (task.sandbox === "read-only") {
    // Optional OS sandbox on top of restrictive permissions; network follows task.
    return { enabled: true, network: task.network ? "allow" : "deny" };
  }
  // workspace: disable sandbox so git commits + hub MCP work (research §5).
  // network:false is the only case we turn sandbox on — isolation via
  // network-deny, accepting that hub MCP tools will be blocked.
  if (!task.network) {
    return { enabled: true, network: "deny" };
  }
  return { enabled: false };
}

/**
 * Full hermetic config injected via `KILO_CONFIG_CONTENT` (research §3 preferred
 * mechanism). Carries MCP hub + headers, raised timeouts, permission, and sandbox.
 */
function configContent(task: TaskSpec, hub: HubInfo): string {
  const timeout = mcpTimeoutMs(task.answerTimeoutMs);
  const config = {
    $schema: "https://app.kilo.ai/config.json",
    permission: permissionFor(task),
    sandbox: sandboxFor(task),
    experimental: {
      mcp_timeout: timeout,
    },
    mcp: {
      [MCP_SERVER_NAME]: {
        type: "remote",
        url: hub.url,
        headers: hub.headers,
        oauth: false,
        enabled: true,
        timeout,
      },
    },
  };
  return JSON.stringify(config);
}

/**
 * Env shared by fresh runs and resumes: auth passthrough, isolation pins, and
 * the injected config (research §3 / §6 / §9).
 */
function baseEnv(
  env: NodeJS.ProcessEnv,
  task: TaskSpec,
  hub: HubInfo,
): Record<string, string> {
  const result: Record<string, string> = {
    // Pin version behavior for children (research §6 / §9 risk #8).
    KILO_DISABLE_AUTOUPDATE: "1",
    // Avoid Claude config bleed into the delegated child (research §6).
    KILO_DISABLE_CLAUDE_CODE: "1",
    // Prefer sole reliance on KILO_CONFIG_CONTENT for the hub + posture.
    // UNKNOWN(research): exact semantics of KILO_DISABLE_PROJECT_CONFIG not
    // verified against source; name is suggestive and listed in research §6.
    KILO_DISABLE_PROJECT_CONFIG: "1",
    KILO_CONFIG_CONTENT: configContent(task, hub),
  };
  // Auth / org routing — only when the parent set them (research §6).
  if (env.KILO_API_KEY !== undefined) result.KILO_API_KEY = env.KILO_API_KEY;
  if (env.KILO_ORG_ID !== undefined) result.KILO_ORG_ID = env.KILO_ORG_ID;
  // BYOK provider keys (#107): forward when set so hermetic KILO_CONFIG_CONTENT
  // runs are not limited to KILO_API_KEY alone.
  for (const key of BYOK_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Flags shared by prepare/resume, after the `run` head and before the positional
 * prompt: JSONL format, auto-approvals, cwd, optional model/effort, extraArgs.
 * Prompt is appended by the caller so extraArgs never land after it (TaskSpec).
 */
function commonArgs(task: TaskSpec): string[] {
  const argv = ["--format", "json", "--auto", "--dir", task.cwd];
  if (task.model !== null) argv.push("-m", task.model);
  // Reasoning effort → `--variant` (research §6); opaque passthrough.
  if (task.effort !== null) argv.push("--variant", task.effort);
  // extraArgs land in the flags region (before the positional prompt) so flag
  // parsers never swallow them as prompt text (TaskSpec contract / ADR-0009).
  argv.push(...task.extraArgs);
  return argv;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Lift `sessionID` from a raw event when present (research §4 — every line has it). */
function sessionIdOf(event: Record<string, unknown>): string | undefined {
  return typeof event.sessionID === "string" ? event.sessionID : undefined;
}

/**
 * Map `step_finish.part.tokens` (+ cost) into usage (research §8 / §9).
 * Keeps harness field names and adds canonical keys when derivable.
 */
function usageFromStepFinish(part: Record<string, unknown>): Record<string, number> | undefined {
  const tokens = asRecord(part.tokens);
  if (!tokens) return undefined;
  const usage: Record<string, number> = {};
  const input = asNumber(tokens.input);
  const output = asNumber(tokens.output);
  const reasoning = asNumber(tokens.reasoning);
  if (input !== undefined) {
    usage.input = input;
    usage.input_tokens = input;
  }
  if (output !== undefined) {
    usage.output = output;
    usage.output_tokens = output;
  }
  if (reasoning !== undefined) usage.reasoning = reasoning;
  const cache = asRecord(tokens.cache);
  if (cache) {
    const read = asNumber(cache.read);
    const write = asNumber(cache.write);
    if (read !== undefined) {
      usage.cache_read = read;
      usage.cached_tokens = read;
    }
    if (write !== undefined) usage.cache_write = write;
  }
  const cost = asNumber(part.cost);
  if (cost !== undefined) usage.cost = cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Nested error message from the verified 7.4.9 auth-failure shape (research §2). */
function errorText(event: Record<string, unknown>): string {
  const err = asRecord(event.error);
  if (!err) return asString(event.message);
  const data = asRecord(err.data);
  if (data && typeof data.message === "string") return data.message;
  if (typeof err.message === "string") return err.message;
  return asString(event.message);
}

/**
 * Parse `kilo models` plain-text output into normalized model entries (research §7).
 * One `provider/model` id per line; no efforts in the plain listing. Throws when
 * no ids parse so catalog refresh keeps the existing entry.
 */
export function parseKiloModels(text: string): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const id = line.trim();
    if (id === "") continue;
    // Defensive: skip accidental JSON blobs if someone passes --verbose output.
    if (id.startsWith("{") || id.startsWith("}") || id.startsWith("[")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, efforts: [], default_effort: null });
  }
  if (entries.length === 0) {
    throw new Error("kilo models: no model ids parsed from output");
  }
  return entries;
}

const KILO_ENFORCEMENT: AdapterEnforcement = {
  "read-only": { level: "approximate", via: "restrictive permissions + optional OS sandbox object" },
  workspace: { level: "none", via: "sandbox disabled so git commits + hub MCP work" },
  full: { level: "enforced", via: "sandbox disabled (unrestricted)" },
  "network:false": {
    level: "approximate",
    via: "sandbox.network=deny (also blocks hub MCP)",
  },
};

export function createKiloAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_KILO_BIN ?? DEFAULT_KILO_BIN;

  return withPostureDiagnostics({
    id: "kilo",
    childChannel: "mcp",
    enforcement: KILO_ENFORCEMENT,

    prepare(task, hub): Promise<SpawnPlan> {
      // Fresh headless one-shot: `kilo run --format json --auto --dir <cwd> …`
      // (research §2 / §9). Session id is captured from the first stream event.
      return Promise.resolve({
        argv: [bin, "run", ...commonArgs(task), task.prompt],
        env: baseEnv(env, task, hub),
        files: [],
        cwd: task.cwd,
      });
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (ADR-0004): `kilo run -s <sessionID> …` with the
      // orchestrator's answer as the follow-up prompt (research §4). Without a
      // session id, `kilo run` would start a brand-new session — fail loudly
      // instead (same posture as grok).
      if (task.sessionId === undefined) {
        return Promise.reject(new Error(`kilo resume for task ${task.id} has no session id`));
      }
      return Promise.resolve({
        argv: [bin, "run", ...commonArgs(task), "-s", task.sessionId, task.prompt],
        env: baseEnv(env, task, hub),
        files: [],
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
      const session_id = sessionIdOf(event);

      switch (event.type) {
        case "step_start":
          // Turn/step begins; every event carries sessionID (research §4 / §9).
          return [{ kind: "session_meta", session_id }];

        case "text": {
          // Assistant text chunk; `part.text` (research §2 / §9).
          const part = asRecord(event.part);
          const text = part ? asString(part.text) : "";
          return text !== "" || part !== undefined
            ? [{ kind: "message", text, session_id }]
            : [];
        }

        case "tool_use":
        case "tool_call": {
          // Completed tool call (research §2 / §9). Binary emits `tool_use` for
          // parts with `type==="tool"` (#107 binary verify); also accept
          // `tool_call` string inventory and missing part.
          const part = asRecord(event.part) ?? event;
          const tool =
            asString(part.tool) ||
            asString(part.name) ||
            asString(asRecord(part.tool)?.name);
          const toolLower = tool.toLowerCase();
          const state = asRecord(part.state);
          const input = asRecord(state?.input) ?? asRecord(part.input) ?? {};
          const status = asString(state?.status);

          // Failed call to our hub tools (or any tool with an error) — tag
          // Parley MCP failures as greppable diagnostics (approval/cancel etc.).
          const stateError = asRecord(state?.error);
          const failed =
            status === "error" ||
            status === "failed" ||
            status === "cancelled" ||
            stateError !== undefined;
          if (failed && (toolLower.startsWith("parley_") || toolLower === MCP_SERVER_NAME)) {
            const detail =
              (stateError ? asString(stateError.message) : "") ||
              asString(state?.output) ||
              status ||
              "failed";
            return [
              {
                kind: "error",
                text:
                  `${VENDOR_DIAG_PREFIX} tool_use tool=${tool || "?"} failed: ${detail}`,
                session_id,
              },
            ];
          }

          if (COMMAND_TOOLS.has(toolLower)) {
            const command = asString(input.command) || asString(part.title);
            return [{ kind: "command", text: command, session_id }];
          }
          if (FILE_CHANGE_TOOLS.has(toolLower)) {
            const path =
              asString(input.path) ||
              asString(input.file_path) ||
              asString(input.filePath) ||
              asString(input.filename);
            return [{ kind: "file_change", text: path, session_id }];
          }
          // Other tools (read, grep, MCP, …) stay opaque; raw JSONL is the record.
          return [];
        }

        case "step_finish": {
          // Step end; usage + cost on `part` (research §8 / §9).
          const part = asRecord(event.part) ?? {};
          const usage = usageFromStepFinish(part);
          return [{ kind: "session_meta", session_id, usage }];
        }

        case "error": {
          // Run-terminal: exit codes are untrustworthy (exit 0 on 401 — research §2).
          // Also emit session_meta so sessionId() can resume after error-only streams.
          const events: VendorEvent[] = [];
          if (session_id !== undefined) {
            events.push({ kind: "session_meta", session_id });
          }
          events.push({ kind: "error", text: errorText(event), fatal: true, session_id });
          return events;
        }

        default:
          // tool_result / step-start nested / unknown → opaque.
          // Success-path type set is binary-confirmed for step_*/text/tool_use/error;
          // live-auth capture still outstanding (#107 residual).
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

    async listModels(_existing: VendorModels | undefined): Promise<ProbedModels> {
      // `kilo models` prints one provider/model id per line (research §7).
      // Efforts/variants are not in the plain listing — catalog stays advisory.
      const stdout = await runProbe(bin, ["models"]);
      return { source: MODELS_SOURCE, models: parseKiloModels(stdout) };
    },
  });
}
