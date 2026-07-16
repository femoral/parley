import type {
  HubInfo,
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
import { tomlString } from "./toml.js";

/**
 * The `codex` vendor adapter (spec §9, ADR-0004). Real delegation to OpenAI's
 * Codex CLI via spawn-per-turn `codex exec --json`. A flags-only adapter:
 * everything Parley needs (MCP injection, sandbox posture, auth, the raised MCP
 * tool timeout) rides `-c` config overrides and env, so `SpawnPlan.files` stays
 * empty. Verified against Codex CLI `0.144.0` (docs/research/codex-cli-automation.md).
 *
 * Two facts from that release shape the flag set and differ from the research
 * doc's early notes:
 *  - `codex exec` has no `-a/--ask-for-approval` flag (it errors); approvals are
 *    disabled via `-c approval_policy="never"` instead.
 *  - `codex exec resume` accepts neither `-s/--sandbox` nor `-C/--cd`; sandbox
 *    posture must ride `-c sandbox_mode=…` and the working root is the process
 *    cwd. So both `prepare` and `resume` express posture through `-c` overrides
 *    (identical mapping) and rely on the spawn cwd rather than `--cd`.
 */

const CODEX_BIN = "codex";
const MCP_SERVER_NAME = "parley";

/**
 * Headroom added to the answer timeout when raising codex's per-tool MCP timeout
 * (`tool_timeout_sec`, default 60s). A blocking `ask_orchestrator` call waits up
 * to the answer timeout; the vendor timeout must sit strictly above it so the
 * question is never killed before the orchestrator answers (spec §4 gotcha).
 */
const TOOL_TIMEOUT_HEADROOM_SEC = 60;

/** Normalized posture → codex `sandbox_mode` value (spec §8 / ADR-0006 matrix). */
function sandboxMode(mode: SandboxMode): string {
  switch (mode) {
    case "read-only":
      return "read-only";
    case "workspace":
      return "workspace-write";
    case "full":
      return "danger-full-access";
  }
}

function toolTimeoutSec(answerTimeoutMs: number): number {
  return Math.ceil(answerTimeoutMs / 1000) + TOOL_TIMEOUT_HEADROOM_SEC;
}

/**
 * The `-c key=value` config overrides shared by fresh runs and resumes — the
 * value portion is parsed as TOML, so strings are quoted and numbers bare. These
 * carry sandbox posture, disabled approvals, and the MCP injection identically
 * for `prepare` and `resume` (the seam: a resumed task keeps its posture).
 */
function configArgs(task: TaskSpec, hub: HubInfo): string[] {
  const overrides: string[] = [];
  const set = (kv: string): void => {
    overrides.push("-c", kv);
  };

  // Sandbox posture. Config form (not `-s`) because `codex exec resume` has no
  // sandbox flag; using it for both keeps the mapping identical.
  set(`sandbox_mode="${sandboxMode(task.sandbox)}"`);
  // Approvals disabled — the sandbox is the guardrail (ADR-0006). `codex exec`
  // has no `-a` flag; the config key is the headless equivalent.
  set(`approval_policy="never"`);
  // Reasoning effort (#28, spec §9) — opaque string passed through unchanged.
  // Omitted flag means the vendor's own default; no config emitted.
  if (task.effort !== null) {
    set(`model_reasoning_effort="${task.effort}"`);
  }
  // Network access only exists under workspace-write and is off by default
  // there. Enable it explicitly for the default posture; omit it (codex default
  // false) for `--no-network`. read-only/full ignore it entirely (spec §8).
  if (task.sandbox === "workspace" && task.network) {
    set(`sandbox_workspace_write.network_access=true`);
  }
  // Grant the worktree's private gitdir *and* the repo's common gitdir as
  // extra writable roots under workspace-write: both live outside `cwd`
  // (git's own worktree layout), and both are written during `git commit` —
  // the private gitdir for `HEAD`/`index.lock`, the common gitdir for
  // `objects/`/`refs/`. Granting only the former (as originally shipped)
  // still failed every `git add`/`git commit` in the worktree, since the
  // object database write happens against the common dir. read-only grants no
  // writes at all (unaffected); full is already unrestricted. Absent for
  // `--cwd`-bypassed tasks (no parley worktree).
  if (task.sandbox === "workspace" && task.gitDir !== undefined) {
    const roots = [...new Set([task.gitDir, task.gitCommonDir].filter((r) => r !== undefined))];
    set(`sandbox_workspace_write.writable_roots=[${roots.map(tomlString).join(", ")}]`);
  }

  // MCP injection: point codex's MCP client at the daemon's streamable-HTTP hub
  // and carry the per-task correlation header on every request (ADR-0003). `-c`
  // overrides are highest precedence and load for untrusted worktrees, unlike a
  // project `.codex/config.toml` (research §3).
  set(`mcp_servers.${MCP_SERVER_NAME}.url="${hub.url}"`);
  for (const [key, value] of Object.entries(hub.headers)) {
    set(`mcp_servers.${MCP_SERVER_NAME}.http_headers.${key}="${value}"`);
  }
  // Raise the per-tool timeout above the answer timeout (default 60s would kill a
  // blocking `ask_orchestrator` question). Load-bearing for Q&A (spec §4).
  set(`mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=${toolTimeoutSec(task.answerTimeoutMs)}`);

  return overrides;
}

/**
 * Flags common to both subcommands, after the `exec`/`exec resume` head and
 * before the positional prompt: JSONL events, the git-repo-check escape hatch
 * (Parley worktrees are repos, but `--cwd` tasks may not be), optional model
 * passthrough, and the shared config overrides.
 */
function commonArgs(task: TaskSpec, hub: HubInfo): string[] {
  // extraArgs land in the flags region (before the positional prompt) so flag
  // parsers never swallow them as prompt text (TaskSpec contract / ADR-0009).
  return [
    "--json",
    "--skip-git-repo-check",
    ...(task.model !== null ? ["-m", task.model] : []),
    ...configArgs(task, hub),
    ...task.extraArgs,
  ];
}

/** `CODEX_API_KEY` env auth passthrough — works only with `codex exec` (research §9). */
function authEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return env.CODEX_API_KEY ? { CODEX_API_KEY: env.CODEX_API_KEY } : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The probe command recorded as the catalog entry's `source`. */
const MODELS_SOURCE = "codex debug models";

/**
 * Parse the JSON catalog `codex debug models` emits into normalized model
 * entries (#29, research §2). Drops `visibility:"hide"` models (internal, e.g.
 * `codex-auto-review`) and the huge per-model `base_instructions` blob — we keep
 * only `slug`, `supported_reasoning_levels[].effort`, and
 * `default_reasoning_level`. Throws on non-JSON or a missing `models` array so
 * the refresh path can keep the existing entry rather than clobber it.
 */
export function parseCodexModels(json: string): ModelEntry[] {
  const root = asRecord(JSON.parse(json));
  const models = root?.models;
  if (!Array.isArray(models)) {
    throw new Error("codex debug models: missing 'models' array");
  }
  const entries: ModelEntry[] = [];
  for (const raw of models) {
    const m = asRecord(raw);
    if (!m) continue;
    if (m.visibility === "hide") continue; // internal model, not user-selectable
    const id = asString(m.slug);
    if (id === "") continue;
    const levels = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
      : [];
    const efforts = levels
      .map((level) => asString(asRecord(level)?.effort))
      .filter((effort) => effort !== "");
    const defaultEffort =
      typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : null;
    entries.push({ id, efforts, default_effort: defaultEffort });
  }
  return entries;
}

/** Normalize a single `item.completed` item to a thin VendorEvent (or `[]` opaque). */
function parseItem(item: unknown): VendorEvent[] {
  const it = asRecord(item);
  if (!it) return [];
  switch (it.type) {
    case "agent_message":
      return [{ kind: "message", text: asString(it.text) }];
    case "command_execution":
      return [{ kind: "command", text: asString(it.command) }];
    case "file_change": {
      const changes = Array.isArray(it.changes) ? it.changes : [];
      const paths = changes
        .map((c) => asRecord(c)?.path)
        .filter((p): p is string => typeof p === "string");
      return [{ kind: "file_change", text: paths.join(", ") }];
    }
    case "error":
      // A mid-run error item — the agent may recover and work past it, so it is
      // display-only (not fatal); only turn.failed/error end the run.
      return [{ kind: "error", text: asString(it.message) }];
    case "mcp_tool_call": {
      // A failed call to *any* MCP tool — most actionably, a call to our own
      // `submit_report`/`ask_orchestrator` server auto-cancelled by codex's
      // guardian approval gate, which has no TTY to answer in headless `exec`
      // (see docs/adr/0006-sandbox-workspace-network.md). Not fatal — the
      // agent may retry — but tagged so the engine can carry it through as a
      // greppable diagnostic instead of it getting lost in the raw stream.
      const err = asRecord(it.error);
      if (!err) return [];
      return [
        {
          kind: "error",
          text:
            `${VENDOR_DIAG_PREFIX} mcp_tool_call server=${asString(it.server)} ` +
            `tool=${asString(it.tool)} failed: ${asString(err.message)}`,
        },
      ];
    }
    default:
      // reasoning, web_search, todo_list, … pass through opaque.
      return [];
  }
}

export function createCodexAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  return {
    id: "codex",

    prepare(task, hub) {
      const plan: SpawnPlan = {
        argv: [CODEX_BIN, "exec", ...commonArgs(task, hub), task.prompt],
        env: authEnv(env),
        files: [],
        cwd: task.cwd,
      };
      return Promise.resolve(plan);
    },

    resume(task, hub) {
      // Spawn-per-turn resume (ADR-0004): `codex exec resume <session-id>` with
      // the orchestrator's answer as the follow-up prompt (`task.prompt`). Same
      // cwd as the original run, so codex's cwd-scoped session lookup resolves.
      const plan: SpawnPlan = {
        argv: [
          CODEX_BIN,
          "exec",
          "resume",
          task.sessionId ?? "",
          ...commonArgs(task, hub),
          task.prompt,
        ],
        env: authEnv(env),
        files: [],
        cwd: task.cwd,
      };
      return Promise.resolve(plan);
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
        case "thread.started":
          // Carries the resumable session id (research §6).
          return [
            {
              kind: "session_meta",
              session_id: typeof event.thread_id === "string" ? event.thread_id : undefined,
            },
          ];
        case "turn.completed": {
          const usageObj = asRecord(event.usage);
          const usage: Record<string, number> = {};
          if (usageObj) {
            for (const [key, value] of Object.entries(usageObj)) {
              if (typeof value === "number") usage[key] = value;
            }
          }
          return [{ kind: "session_meta", usage }];
        }
        case "turn.failed": {
          // Exit codes are 0/1 only — this is where the failure detail lives.
          // Run-terminal, so fatal: the engine surfaces it as task failure detail.
          const err = asRecord(event.error);
          return [{ kind: "error", text: err ? asString(err.message) : "", fatal: true }];
        }
        case "error":
          return [{ kind: "error", text: asString(event.message), fatal: true }];
        case "item.completed":
          // Normalize the terminal item state only; item.started/updated are the
          // same item mid-stream and would duplicate (opaque pass-through).
          return parseItem(event.item);
        default:
          return []; // turn.started, item.started/updated, unknown → opaque
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
      // `codex debug models` renders the raw catalog as JSON (research §2). A
      // debug subcommand with no stability promise, so parse defensively; the
      // catalog file remains hand-editable when this drifts.
      const stdout = await runProbe(CODEX_BIN, ["debug", "models"]);
      return { source: MODELS_SOURCE, models: parseCodexModels(stdout) };
    },
  };
}
