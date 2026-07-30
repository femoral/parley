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

/** OpenCode: permission-layer only; no OS sandbox; network partial (#279). */
const OPENCODE_ENFORCEMENT: AdapterEnforcement = {
  "read-only": { level: "approximate", via: "permission deny write/edit/bash (no OS sandbox)" },
  workspace: { level: "approximate", via: "permission policy only (no OS sandbox)" },
  full: { level: "enforced", via: "permission allow-all (unrestricted as requested)" },
  "network:false": {
    level: "approximate",
    via: "webfetch/websearch deny only; bash can still egress",
  },
};

/**
 * The `opencode` vendor adapter — real delegation to OpenCode CLI via spawn-per-turn
 * `opencode run --format json` (spec §9, ADR-0004/0006). Verified against OpenCode
 * CLI **1.18.2** (`opencode-ai@1.18.2`); see `docs/research/opencode-cli-automation.md`.
 *
 * Closer to grok (config/env injection) than codex (flags-only):
 * - MCP hub + permission posture ride `OPENCODE_CONFIG_CONTENT` (research §3, highest
 *   non-MDM precedence) so we never mutate the user's global
 *   `~/.config/opencode/opencode.json`.
 * - Approvals disabled with `--dangerously-skip-permissions` plus config
 *   `"permission"` (research §5). Flag drift: 1.18.2 docs/help also list
 *   `--auto` as the current-line name; ≤1.16.x only expose
 *   `--dangerously-skip-permissions` (adapter-validation-a / #107). We pin the
 *   older/stable name so common installer builds (1.16.x) still auto-approve.
 * - No OS sandbox (no bubblewrap/Landlock equivalent). Posture maps to the
 *   **permission** system only; network isolation is partial (`webfetch`/`websearch`
 *   deny; `bash` can still hit the network — documented capability gap).
 * - Process exit code is **0 even on fatal API/auth errors** — failure detail lives
 *   only in the JSONL `error` event (research §2). `parseEvent` marks those fatal.
 *
 * The streaming-json event schema is pinned by golden fixtures under
 * `tests/fixtures/opencode/` (real lines from research §2/§8).
 */

/** Default binary; override via `PARLEY_OPENCODE_BIN` (smoke tests, custom installs). */
const DEFAULT_OPENCODE_BIN = "opencode";

/**
 * Headroom added to the answer timeout when raising OpenCode's MCP `timeout`
 * (schema default **5000** ms — far too low for a blocking `ask_orchestrator`).
 * Research §3: units are ms. Official schema/docs still disagree on whether
 * `timeout` bounds tool **execution** vs tool **discovery** only
 * (adapter-validation-a: still UNKNOWN after live config merge). We raise it
 * well above `answerTimeoutMs` either way so a discovery-only timer cannot
 * starve hub setup, and rely on the injected `mcp.parley.timeout` surviving
 * `OPENCODE_CONFIG_CONTENT` merge (verified on 1.18.2).
 */
const MCP_TIMEOUT_HEADROOM_MS = 60_000;

/** The probe command recorded as the catalog entry's `source` on refresh. */
const MODELS_SOURCE = "opencode models";

/**
 * Provider / product auth env keys named in research §6. Forward only when set in
 * the parent env (opaque passthrough; never invent values).
 */
const AUTH_ENV_KEYS = [
  "OPENCODE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

function mcpTimeoutMs(answerTimeoutMs: number): number {
  return answerTimeoutMs + MCP_TIMEOUT_HEADROOM_MS;
}

/**
 * Map normalized posture (spec §8, ADR-0006) onto OpenCode's permission system
 * (research §5). Soft policy only — not a kernel sandbox.
 *
 * Capability gap vs Codex/Grok: there is **no** `restrict_network` equivalent.
 * `network:false` only denies `webfetch`/`websearch`; `bash` can still curl.
 */
function permissionConfig(task: TaskSpec): unknown {
  const networkTools = task.network
    ? { webfetch: "allow", websearch: "allow" }
    : { webfetch: "deny", websearch: "deny" };

  switch (task.sandbox) {
    case "read-only":
      // Soft read-only: deny write/edit/bash at the permission layer. Agent cannot
      // be forced OS-readonly (no bubblewrap equivalent — research §5).
      return {
        edit: "deny",
        write: "deny",
        bash: "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        // Headless: never ask. MCP tools need allow under non-global maps
        // (exact parley_* permission key form is UNKNOWN(research) until hub
        // smoke-tested — global allow on remaining tools is the safe default).
        "*": "allow",
        external_directory: "deny",
        ...networkTools,
      };
    case "full":
      // Full agent freedom at the permission layer. Still no OS sandbox.
      // network:false still applies webfetch/websearch deny (best-effort only).
      return {
        "*": "allow",
        external_directory: "allow",
        ...networkTools,
      };
    case "workspace":
    default: {
      // Worktree writes allowed; outside cwd denied. Grant gitDir/gitCommonDir
      // when present — same worktree gitdir problem as Codex (research §5/§9).
      const external: Record<string, string> = { "*": "deny" };
      if (task.gitDir !== undefined) {
        external[`${task.gitDir}/**`] = "allow";
      }
      if (task.gitCommonDir !== undefined) {
        external[`${task.gitCommonDir}/**`] = "allow";
      }
      return {
        "*": "allow",
        external_directory: external,
        ...networkTools,
      };
    }
  }
}

/**
 * Inline config injected via `OPENCODE_CONFIG_CONTENT` (research §3 recommended
 * hermetic path). Carries MCP hub + permission posture + autoupdate pin.
 */
function configContent(task: TaskSpec, hub: HubInfo): string {
  const config = {
    autoupdate: false,
    permission: permissionConfig(task),
    mcp: {
      parley: {
        type: "remote",
        url: hub.url,
        enabled: true,
        oauth: false,
        // Raise above answerTimeoutMs (default 5s would kill ask_orchestrator).
        // UNKNOWN(research): schema says "MCP server requests"; docs say "fetching
        // tools". Load-bearing — smoke-test with a blocking hub tool before shipping.
        timeout: mcpTimeoutMs(task.answerTimeoutMs),
        headers: hub.headers,
      },
    },
  };
  return JSON.stringify(config);
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
 * Env shared by fresh runs and resumes: hermetic config injection, bleed control,
 * auth passthrough (research §3/§6/§9).
 */
function baseEnv(task: TaskSpec, hub: HubInfo, env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    OPENCODE_CONFIG_CONTENT: configContent(task, hub),
    // Pin reproducible CI behaviour (research §9 risk #7).
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    // Prevent ~/.claude bleed into the delegated child (research §9).
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    // UNKNOWN(research): binary string present; behavior not fully re-tested.
    // Intent: stop a worktree's own opencode.json from shadowing the hub.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    ...authEnv(env),
  };
}

/**
 * Flags shared by prepare/resume after the `run` head and before the prompt:
 * JSONL stream, auto-approve, working dir, optional model/effort, extraArgs.
 * Prompt is always last (after `--`) so flag parsers never swallow it (research §9).
 *
 * Auto-approve flag: `--dangerously-skip-permissions` (not `--auto`). On
 * OpenCode ≤1.16.x `--auto` is absent and yargs dumps help / fails the run;
 * 1.18.2 documents `--auto` as the friendlier alias for the same behaviour.
 * Prefer the long form so both pin and older host installs work (#107).
 * Permission posture still rides `OPENCODE_CONFIG_CONTENT` (structured map)
 * so explicit denies (read-only / network tools) remain load-bearing.
 */
function commonArgs(task: TaskSpec): string[] {
  const argv = [
    "--format",
    "json",
    "--dangerously-skip-permissions",
    "--dir",
    task.cwd,
  ];
  if (task.model !== null) argv.push("-m", task.model);
  // Effort → `--variant` (research §6); opaque string, omitted when null.
  if (task.effort !== null) argv.push("--variant", task.effort);
  // optional session title from task name (research §2).
  if (task.name !== null && task.name !== "") argv.push("--title", task.name);
  // extraArgs land in the flags region (before `--` / positional prompt).
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

/**
 * Build usage from a `step_finish` `part.tokens` object (research §8).
 * Emits harness field names plus canonical `input_tokens` / `output_tokens` /
 * `cached_tokens` when derivable. Engine shallow-merges successive usage objects
 * (supersede, not sum) — multi-step runs therefore keep the **last** step's
 * counts; summing would require engine changes outside this adapter's scope.
 */
function usageFromStepFinish(part: Record<string, unknown>): Record<string, number> | undefined {
  const tokens = asRecord(part.tokens);
  if (!tokens) {
    // Still surface cost if present without tokens.
    if (typeof part.cost === "number") return { cost: part.cost };
    return undefined;
  }
  const usage: Record<string, number> = {};
  if (typeof tokens.input === "number") {
    usage.input = tokens.input;
    usage.input_tokens = tokens.input;
  }
  if (typeof tokens.output === "number") {
    usage.output = tokens.output;
    usage.output_tokens = tokens.output;
  }
  if (typeof tokens.reasoning === "number") usage.reasoning = tokens.reasoning;
  if (typeof tokens.total === "number") usage.total = tokens.total;
  const cache = asRecord(tokens.cache);
  if (cache) {
    if (typeof cache.read === "number") {
      usage.cache_read = cache.read;
      usage.cached_tokens = cache.read;
    }
    if (typeof cache.write === "number") usage.cache_write = cache.write;
  }
  if (typeof part.cost === "number") usage.cost = part.cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Normalize a completed `tool_use` part into command / file_change / diag (research §9). */
function parseToolUse(part: Record<string, unknown>): VendorEvent[] {
  const tool = asString(part.tool);
  const state = asRecord(part.state);
  const input = asRecord(state?.input);
  const status = asString(state?.status);

  // Failed / cancelled MCP tools — most actionably our hub tools cancelled by a
  // permission gate with no TTY (research §9). Exact server-prefix form is
  // UNKNOWN(research) (`parley_*` / `parley_submit_report` etc.); match loosely.
  if (status !== "" && status !== "completed") {
    const looksLikeParley =
      tool.startsWith("parley") ||
      tool.includes("submit_report") ||
      tool.includes("ask_orchestrator");
    if (looksLikeParley) {
      const detail =
        asString(state?.output) || asString(state?.error) || status || "tool failed";
      return [
        {
          kind: "error",
          text: `${VENDOR_DIAG_PREFIX} tool_use tool=${tool} status=${status}: ${detail}`,
        },
      ];
    }
  }

  if (tool === "bash") {
    const command =
      asString(input?.command) || asString(state?.title) || tool;
    return [{ kind: "command", text: command }];
  }
  if (tool === "write" || tool === "edit" || tool === "patch") {
    const filepath =
      asString(input?.filePath) ||
      asString(input?.path) ||
      asString(asRecord(state?.metadata)?.filepath) ||
      tool;
    return [{ kind: "file_change", text: filepath }];
  }
  // Other / MCP tools — optional command with the tool name (research §9).
  if (tool !== "") return [{ kind: "command", text: tool }];
  return [];
}

/**
 * Parse `opencode models` plain-text output into normalized model entries
 * (research §7). One `provider/model` id per line; efforts are not in the plain
 * listing, so they ride the existing catalog entry (hand-patches survive refresh)
 * and default empty for new ids. Throws when no ids parse so refresh keeps the
 * existing entry rather than clobbering with nothing.
 */
export function parseOpencodeModels(
  text: string,
  existing: VendorModels | undefined,
): ModelEntry[] {
  const prior = new Map((existing?.models ?? []).map((m) => [m.id, m] as const));
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const id = line.trim();
    // Skip blanks and verbose JSON object lines.
    if (id === "" || id.startsWith("{") || id.startsWith("}")) continue;
    // Model ids look like provider/model (research §7).
    if (!id.includes("/")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const prev = prior.get(id);
    entries.push({
      id,
      efforts: prev?.efforts ?? [],
      default_effort: prev?.default_effort ?? null,
    });
  }
  if (entries.length === 0) {
    throw new Error("opencode models: no model ids parsed from output");
  }
  return entries;
}

export function createOpencodeAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN;

  return withPostureDiagnostics({
    id: "opencode",
    childChannel: "mcp",
    enforcement: OPENCODE_ENFORCEMENT,

    prepare(task, hub): Promise<SpawnPlan> {
      // Fresh headless one-shot (research §2/§9):
      //   opencode run --format json --dangerously-skip-permissions --dir <cwd> …
      return Promise.resolve({
        argv: [bin, "run", ...commonArgs(task), "--", task.prompt],
        env: baseEnv(task, hub, env),
        files: [],
        cwd: task.cwd,
      });
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (ADR-0004, research §4): `-s <sessionID>` continues
      // the persisted session; `task.prompt` is the orchestrator's answer. MCP +
      // permission config is re-injected via env every spawn (session resume does
      // not re-apply prior env).
      if (task.sessionId === undefined) {
        // Without `-s` opencode would start a brand-new session (or `-c` last
        // session for the directory — still wrong). Fail loudly like grok.
        return Promise.reject(
          new Error(`opencode resume for task ${task.id} has no session id`),
        );
      }
      return Promise.resolve({
        argv: [
          bin,
          "run",
          "-s",
          task.sessionId,
          ...commonArgs(task),
          "--",
          task.prompt,
        ],
        env: baseEnv(task, hub, env),
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

      const session_id =
        typeof event.sessionID === "string" ? event.sessionID : undefined;

      switch (event.type) {
        case "step_start":
          // Ignore step body; still capture session id (present on every line).
          return session_id !== undefined
            ? [{ kind: "session_meta", session_id }]
            : [];
        case "text": {
          const part = asRecord(event.part);
          const text = asString(part?.text);
          return text !== "" ? [{ kind: "message", text }] : [];
        }
        case "tool_use": {
          const part = asRecord(event.part);
          return part ? parseToolUse(part) : [];
        }
        case "step_finish": {
          const part = asRecord(event.part);
          const usage = part ? usageFromStepFinish(part) : undefined;
          return [
            {
              kind: "session_meta",
              session_id,
              ...(usage !== undefined ? { usage } : {}),
            },
          ];
        }
        case "error": {
          // Run-terminal (research §2/§9): exit code is often still 0; this is
          // where failure detail lives. Always fatal. sessionID is present on
          // error lines too (research §4) — emit session_meta so resume capture
          // still works on pure-error streams.
          const err = asRecord(event.error);
          const data = asRecord(err?.data);
          const text =
            asString(data?.message) || asString(err?.name) || asString(event.message) || "";
          const out: VendorEvent[] = [];
          if (session_id !== undefined) {
            out.push({ kind: "session_meta", session_id });
          }
          out.push({ kind: "error", text, fatal: true });
          return out;
        }
        default:
          // Unknown/changed shapes must never fail the task.
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

    async listModels(existing): Promise<ProbedModels> {
      // `opencode models` — one provider/model id per line (research §7).
      const stdout = await runProbe(bin, ["models"]);
      return { source: MODELS_SOURCE, models: parseOpencodeModels(stdout, existing) };
    },
  });
}
