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

/**
 * The `gemini` vendor adapter — real delegation to Google's Gemini CLI
 * (`gemini` binary from `@google/gemini-cli`, ADR-0004/0006, #99). Verified
 * against `@google/gemini-cli@0.50.0` (2026-07-16); see
 * `docs/research/gemini-cli-cli-automation.md` for the surface.
 *
 * Gemini has **no** per-invocation MCP flag, so the hub is injected by
 * materializing project `.gemini/settings.json` into the task cwd via
 * `SpawnPlan.files` (same files shape as grok). Headless runs always pass
 * `--skip-trust` so project MCP is loaded (folder trust is load-bearing —
 * without it project MCP is silently disabled). Approvals use
 * `--approval-mode=yolo` (or `plan` for read-only). There is no Codex-style
 * sandbox triad; posture maps to approval mode + optional `-s` / seatbelt
 * env (research §5).
 *
 * Session resume is `gemini -r <session_id> -p <follow-up>` (research §4).
 * Without a session id resume rejects (same as grok). Sessions live under
 * `~/.gemini/tmp/<project_hash>/chats/` — same HOME/cwd required across
 * prepare and resume.
 *
 * Effort: 0.50.0 has **no** `--effort` / `--reasoning-effort` flag (research
 * §6). `task.effort` is intentionally not emitted; a `// UNKNOWN(research)`
 * documents the gap until a verified `modelConfigs`/`thinkingConfig` mapping
 * exists. Model ids pass through `-m` opaquely. There is no `gemini models`
 * enumeration command (research §7), so `listModels` is omitted.
 */

/** Default binary; override via `PARLEY_GEMINI_BIN` (smoke tests, custom installs). */
const DEFAULT_GEMINI_BIN = "gemini";

const MCP_SERVER_NAME = "parley";

/**
 * Headroom (ms) added to the answer timeout when raising Gemini MCP server
 * `timeout` (research §3; units are **milliseconds**, default 600_000). A
 * blocking `ask_orchestrator` must not be killed before the orchestrator
 * answers — same load-bearing gotcha as codex's `tool_timeout_sec`.
 */
const MCP_TIMEOUT_HEADROOM_MS = 60_000;

/**
 * Auth env keys named in research §6. Only forwarded when set in the parent
 * env (grok's `XAI_API_KEY` pattern). Primary headless path is `GEMINI_API_KEY`;
 * Vertex / GCA vars are optional passthrough for CI-provisioned hosts.
 */
const AUTH_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_GCA",
] as const;

function mcpTimeoutMs(answerTimeoutMs: number): number {
  return answerTimeoutMs + MCP_TIMEOUT_HEADROOM_MS;
}

/**
 * Project `.gemini/settings.json` injected into the task cwd (research §3).
 * Streamable-HTTP hub via `httpUrl` + correlation `headers` + raised
 * `timeout` (ms) + `trust: true` so MCP tools skip per-tool confirmation.
 * Always pair with `--skip-trust` on argv or project MCP stays disabled.
 */
function settingsJson(task: TaskSpec, hub: HubInfo): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            httpUrl: hub.url,
            headers: hub.headers,
            timeout: mcpTimeoutMs(task.answerTimeoutMs),
            trust: true,
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Sandbox / approval posture (research §5, adapter-validation-a / #107).
 * Gemini has no `read-only|workspace-write|danger-full-access` triad:
 *  - `read-only` → `--approval-mode=plan` (documented read-only tool policy).
 *    Network is not an independent switch.
 *  - `workspace` + network on → yolo, no process sandbox (default path).
 *  - `workspace` + network off → yolo + `-s` + `SEATBELT_PROFILE=permissive-proxied`
 *    on **macOS only**. On Linux, seatbelt env is a no-op and `-s` without
 *    Docker/gVisor does **not** implement network-off — prepare rejects so we
 *    never silently claim a weaker isolation than `network:false`.
 *  - `full` → yolo, sandbox off. `network:false` is refused (no natural mode).
 *
 * gitDir / gitCommonDir: passed via `--include-directories` when set so sandbox
 * / workspace root expansion can see worktree git objects outside cwd.
 */

/** Platforms where Gemini's SEATBELT_PROFILE can enforce network-off. */
function seatbeltSupportsNetworkOff(platform: string = process.platform): boolean {
  return platform === "darwin";
}

/**
 * Loud capability gap: refuse postures that would silently under-isolate.
 * Call before building argv so the task fails with a clear error (#107).
 *
 * Only `workspace` + macOS seatbelt is treated as a real network-off path;
 * everywhere else `network:false` would be a no-op (Linux seatbelt, full
 * posture, plan mode) — refuse rather than claim isolation we cannot provide.
 */
export function assertGeminiNetworkPosture(
  task: TaskSpec,
  platform: string = process.platform,
): void {
  if (task.network) return;
  if (task.sandbox === "workspace" && seatbeltSupportsNetworkOff(platform)) {
    return; // SEATBELT_PROFILE=permissive-proxied + `-s`
  }
  throw new Error(
    `gemini: network:false is not enforced for sandbox=${task.sandbox} on ` +
      `${platform} (SEATBELT_PROFILE/-s only isolates on macOS workspace; ` +
      `Linux/Docker-less and full/read-only paths are no-ops). Refuse rather ` +
      `than under-isolate (#107). Use network:true, sandbox=workspace on macOS, ` +
      `or wrap the child in a real netns/container.`,
  );
}

function postureArgs(task: TaskSpec): {
  approvalMode: string;
  sandboxFlag: boolean;
  env: Record<string, string>;
} {
  const env: Record<string, string> = {};
  switch (task.sandbox) {
    case "read-only":
      // Plan mode is the documented read-only tool policy (research §5).
      // network:false already refused by assertGeminiNetworkPosture off-macOS.
      return { approvalMode: "plan", sandboxFlag: false, env };
    case "full":
      // Full host access — no sandbox. network:false refused above.
      return { approvalMode: "yolo", sandboxFlag: false, env };
    case "workspace":
    default:
      if (!task.network) {
        // macOS only (asserted): enable sandbox + proxied seatbelt profile.
        env.SEATBELT_PROFILE = "permissive-proxied";
        return { approvalMode: "yolo", sandboxFlag: true, env };
      }
      return { approvalMode: "yolo", sandboxFlag: false, env };
  }
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
 * Pick numeric usage fields from `result.stats` (research §8). Emits harness
 * field names as-is plus canonical `input_tokens` / `output_tokens` /
 * `cached_tokens` when derivable (`cached` → `cached_tokens`). Nested
 * `models` is ignored (per-model breakdown is optional display noise).
 */
function usageFromStats(stats: unknown): Record<string, number> | undefined {
  const obj = asRecord(stats);
  if (!obj) return undefined;
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "models") continue; // nested per-model map — skip
    if (typeof value === "number") usage[key] = value;
  }
  // Gemini names the cache counter `cached`; also expose canonical `cached_tokens`.
  if (typeof obj.cached === "number") {
    usage.cached_tokens = obj.cached;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** True when an error string implicates Parley's MCP hub tools. */
function looksLikeParleyMcp(text: string): boolean {
  return /mcp_parley|submit_report|ask_orchestrator|\bparley\b/i.test(text);
}

const GEMINI_ENFORCEMENT: AdapterEnforcement = {
  "read-only": { level: "approximate", via: "approval-mode=plan" },
  workspace: { level: "none", via: "yolo; no process sandbox when network on" },
  full: { level: "enforced", via: "yolo, sandbox off" },
  "network:false": {
    level: "refused",
    via: "prepare refuses except macOS workspace seatbelt (#107)",
  },
};

export function createGeminiAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_GEMINI_BIN ?? DEFAULT_GEMINI_BIN;

  /** Auth + posture env shared by prepare and resume. */
  function baseEnv(task: TaskSpec): Record<string, string> {
    const { env: postureEnv } = postureArgs(task);
    const result: Record<string, string> = {
      ...postureEnv,
      // Belt-and-braces with `--skip-trust` so project MCP always loads
      // (research §3 folder trust).
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    };
    for (const key of AUTH_ENV_KEYS) {
      const value = env[key];
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
    return [{ path: ".gemini/settings.json", contents: settingsJson(task, hub) }];
  }

  /**
   * Flags shared by fresh runs and resumes (research §2 / §9). Prompt is always
   * `-p` (positional prompts force interactive mode — never use for Parley).
   * extraArgs land in the flags region after known flags so they are never
   * ambiguous with the `-p` value (TaskSpec contract / ADR-0009).
   *
   * // UNKNOWN(research): task.effort has no verified CLI/settings mapping on
   * 0.50.0 — deliberately omitted rather than inventing modelConfigs.
   */
  function commonArgv(task: TaskSpec): string[] {
    const { approvalMode, sandboxFlag } = postureArgs(task);
    const argv = [
      "--output-format",
      "stream-json",
      `--approval-mode=${approvalMode}`,
      "--skip-trust",
    ];
    if (sandboxFlag) argv.push("-s");
    // Extra project roots for worktree gitdirs when sandbox/workspace expands
    // beyond cwd (0.50.0 `--include-directories`, comma-separated — #107).
    const includeDirs: string[] = [];
    if (task.gitDir !== undefined) includeDirs.push(task.gitDir);
    if (
      task.gitCommonDir !== undefined &&
      task.gitCommonDir !== task.gitDir
    ) {
      includeDirs.push(task.gitCommonDir);
    }
    if (includeDirs.length > 0) {
      argv.push("--include-directories", includeDirs.join(","));
    }
    if (task.model !== null) argv.push("-m", task.model);
    // extraArgs in the flags region (prompt is a separate -p value).
    argv.push(...task.extraArgs);
    return argv;
  }

  return withPostureDiagnostics({
    id: "gemini",
    childChannel: "mcp",
    enforcement: GEMINI_ENFORCEMENT,

    prepare(task, hub): Promise<SpawnPlan> {
      // Fresh headless one-shot (research §2 / §9):
      //   gemini -p <prompt> --output-format stream-json --approval-mode=… --skip-trust
      try {
        assertGeminiNetworkPosture(task);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.resolve({
        argv: [bin, "-p", task.prompt, ...commonArgv(task)],
        env: baseEnv(task),
        files: files(task, hub),
        cwd: task.cwd,
      });
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (research §4): `-r <session_id>` + `-p <follow-up>`.
      // Re-materialize settings so hub/headers/timeout remain present.
      if (task.sessionId === undefined) {
        // Without `-r` gemini would start a brand-new session. Fail loudly —
        // the engine reruns session-less stalled tasks via prepare().
        return Promise.reject(new Error(`gemini resume for task ${task.id} has no session id`));
      }
      try {
        assertGeminiNetworkPosture(task);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.resolve({
        argv: [bin, "-p", task.prompt, "-r", task.sessionId, ...commonArgv(task)],
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
        return []; // opaque non-JSON (stderr noise never lands here — stdout only)
      }
      const event = asRecord(parsed);
      if (!event) return [];

      switch (event.type) {
        case "init":
          // Primary session id source (research §4 / §9).
          return [
            {
              kind: "session_meta",
              session_id: typeof event.session_id === "string" ? event.session_id : undefined,
            },
          ];

        case "message": {
          // Assistant chunks (may stream with delta:true); user is usually the
          // prompt echo — drop it. research §9.
          if (event.role === "assistant") {
            return [{ kind: "message", text: asString(event.content) }];
          }
          return [];
        }

        case "tool_use": {
          // Thin display: tool name + parameters JSON (research §9).
          const name = asString(event.tool_name);
          const params = event.parameters;
          const text =
            params !== undefined
              ? `${name} ${JSON.stringify(params)}`
              : name;
          return name !== "" ? [{ kind: "command", text }] : [];
        }

        case "tool_result": {
          // Mid-run tool failure — non-fatal (agent may recover). Tag
          // PARLEY-DIAG when the payload implicates our hub tools.
          if (event.status !== "error") return [];
          const err = asRecord(event.error);
          const msg =
            err !== undefined
              ? asString(err.message)
              : asString(event.output);
          const text =
            looksLikeParleyMcp(msg) || looksLikeParleyMcp(asString(event.output))
              ? `${VENDOR_DIAG_PREFIX} tool_result failed: ${msg}`
              : msg;
          return [{ kind: "error", text }];
        }

        case "error":
          // Mid-stream non-fatal (severity warning|error). Distinct from
          // terminal result status:error (research §2 / §9).
          return [{ kind: "error", text: asString(event.message) }];

        case "result": {
          const usage = usageFromStats(event.stats);
          if (event.status === "error") {
            // Run-terminal — prefer this over unreliable exit codes
            // (research §2: HTTP 400 → exit 144).
            const err = asRecord(event.error);
            const events: VendorEvent[] = [
              {
                kind: "error",
                text: err ? asString(err.message) : "",
                fatal: true,
              },
            ];
            if (usage !== undefined) {
              events.push({ kind: "session_meta", usage });
            }
            return events;
          }
          // success — usage only (session id already from init).
          if (usage !== undefined) {
            return [{ kind: "session_meta", usage }];
          }
          return [];
        }

        default:
          // Unknown/changed shapes must never fail the task.
          return [];
      }
    },

    sessionId(events: VendorEvent[]): string | undefined {
      // Last session_meta with a session_id (codex/grok pattern; research §9).
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.kind === "session_meta" && event.session_id !== undefined) {
          return event.session_id;
        }
      }
      return undefined;
    },

    // listModels omitted — no `gemini models` (or equivalent) enumeration
    // command on 0.50.0 (research §7). Catalog stays hand-maintained.
  });
}
