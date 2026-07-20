import type {
  HubInfo,
  MaterializedFile,
  ModelEntry,
  ProbedModels,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
  VendorModels,
} from "./types.js";
import { VENDOR_DIAG_PREFIX } from "./types.js";
import { runProbe } from "./probe.js";
import { tomlString } from "./toml.js";

/**
 * The `grok` vendor adapter — real delegation to Grok Build (`grok` binary,
 * spec §9, ADR-0004/0006). Verified against grok 0.2.93 (2026-07-09); see
 * `docs/research/grok-build-cli-automation.md` for the surface and the
 * deviations noted below.
 *
 * Grok has no per-invocation MCP flag, so the hub is injected by materializing
 * `.grok/config.toml` into the task cwd via `SpawnPlan.files` (the daemon writes
 * it pre-spawn and git-excludes it from the worktree). Sandbox posture maps to
 * `GROK_SANDBOX` env profiles; approvals are force-disabled with
 * `--always-approve`; the Claude/Cursor config scanners are turned off per child
 * so the user's Claude setup never bleeds into the delegated task.
 *
 * The streaming-json event schema and exit codes are undocumented and the binary
 * auto-updates ~daily, so `--no-auto-update` pins the version and `parseEvent` is
 * deliberately tolerant: any unknown or changed line yields `[]` and the raw
 * JSONL log (the durable record) keeps it. Golden fixtures under
 * `tests/fixtures/grok/` pin the observed 0.2.93 shape.
 */

/** Default binary; override via `PARLEY_GROK_BIN` (smoke tests, custom installs). */
const DEFAULT_GROK_BIN = "grok";

/**
 * Claude-config scanners, all defaulting **on** in grok (verified in the 0.2.93
 * binary). Disabled per child so the orchestrator's own Claude Code config
 * (`~/.claude.json` MCP servers, `.claude/` rules/skills/agents/hooks) never
 * leaks into the delegated task. Parley's own canonical surface reaches grok via
 * the worktree's `AGENTS.md`/`.agents` (translated in worktree.ts), which grok
 * reads natively regardless of these flags.
 */
const CLAUDE_SCANNER_VARS = [
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
] as const;

/**
 * Disables grok's permission-rule import from the user's Claude settings
 * (`~/.claude/settings.json` and friends), which the scanner vars above do NOT
 * cover (#179): a user-scope `permissions.deny: ["NotebookEdit"]` maps onto
 * grok's `edit` tool class and denies every file mutation in the child —
 * deny > allow, so `--always-approve` cannot save it.
 *
 * This is an undocumented, underscore-private override (grok's
 * `permission/claude_settings` "first_gate"); the supported equivalent —
 * `[claude_compat] imported = true` — is only honoured in the user-scope
 * `~/.grok/config.toml`, which parley must not mutate. Verified against grok
 * 0.2.106. Re-verify on a grok bump with:
 * `_GROK_CLAUDE_MARKER_OVERRIDE=1 grok inspect` → Permissions "0 loaded"
 * (run in a cwd whose user-level Claude settings contain permission rules).
 */
const CLAUDE_PERMISSION_IMPORT_OVERRIDE = "_GROK_CLAUDE_MARKER_OVERRIDE";

/**
 * Upper bound on the preflight `grok inspect --json` permission probe (#186).
 * The probe is fail-open: a timeout, missing binary, or unparseable output
 * becomes a diagnostic line, never a spawn failure. Observed latency ~50ms.
 */
const INSPECT_PROBE_TIMEOUT_MS = 5000;

/**
 * Grok honours Claude's `MCP_TIMEOUT` (ms) env **before** its own
 * `GROK_MCP_STARTUP_TIMEOUT_SECS`, so a value the orchestrator exported for its
 * own Claude MCP setup would silently govern grok children's hub-connect
 * timeout. We pin it to a deterministic value (grok's own 30s startup default)
 * so the parent's value can never leak in — the engine spreads `SpawnPlan.env`
 * over `process.env`, so overriding is the only way to neutralize it (env values
 * are strings; there is no "unset").
 */
const MCP_STARTUP_TIMEOUT_MS = "30000";

/** The name of the custom no-network sandbox profile materialized per child. */
const NO_NETWORK_PROFILE = "parley-restricted";

/**
 * Map the normalized posture (spec §8, ADR-0006 matrix) to grok's `GROK_SANDBOX`
 * mechanism. `full` maps to `off` (danger-full-access) and is inherently
 * network-on. For the other modes, `network:false` is enforced with a custom
 * profile (materialized as `.grok/sandbox.toml`) that extends the base built-in
 * and sets `restrict_network` — the only lever grok exposes for network
 * isolation. A custom profile is fail-closed: on a host whose kernel can't apply
 * the sandbox (e.g. no bwrap on Linux) grok refuses to start rather than run
 * unsandboxed, which is the correct posture when isolation was explicitly asked
 * for. Built-in profiles fail open (warn and continue), so the default
 * workspace+network path keeps working everywhere.
 */
function sandboxEnv(task: TaskSpec): {
  env: Record<string, string>;
  /** The built-in profile a custom no-network profile should extend, if any. */
  base: string | null;
} {
  switch (task.sandbox) {
    case "read-only":
      // Read-only worktree; `GROK_WRITE_FILE=0` is belt-and-braces on top of the
      // sandbox profile.
      return { env: { GROK_SANDBOX: "read-only", GROK_WRITE_FILE: "0" }, base: "read-only" };
    case "full":
      // Full access — no sandbox. Network is unrestricted; `network:false` does
      // not apply to `full` (matches the spec §8 matrix, which maps full → off).
      return { env: { GROK_SANDBOX: "off" }, base: null };
    case "workspace":
    default:
      // Write to the worktree, read elsewhere; skip the in-sandbox bash approval
      // prompt (approvals are already force-disabled).
      return {
        env: { GROK_SANDBOX: "workspace", GROK_SANDBOX_AUTO_ALLOW_BASH: "1" },
        base: "workspace",
      };
  }
}

/**
 * The `.grok/config.toml` injected into the task cwd (project scope allows
 * `[mcp_servers]`, `[plugins]`, `[permission]`). Carries the daemon's MCP hub as
 * an HTTP server with the correlation header(s), disables grok's own worktree
 * creation (parley owns the worktree), and pins the approval posture (the CLI
 * `--always-approve` is authoritative; this is belt-and-braces).
 */
function configToml(hub: HubInfo): string {
  const lines = [
    "# Generated by parley — do not edit; regenerated on every (re)spawn.",
    'new_session_worktree_mode = "never"',
    'permission_mode = "always-approve"',
    "",
    "[mcp_servers.parley]",
    'type = "http"',
    `url = ${tomlString(hub.url)}`,
  ];
  const headers = Object.entries(hub.headers);
  if (headers.length > 0) {
    lines.push("", "[mcp_servers.parley.headers]");
    for (const [key, value] of headers) {
      lines.push(`${tomlString(key)} = ${tomlString(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * A custom sandbox profile that adds `restrict_network` on top of a built-in
 * base — materialized only when the posture demands network isolation.
 */
function sandboxToml(base: string): string {
  return [
    "# Generated by parley — no-network posture (spec §8).",
    `[profiles.${NO_NETWORK_PROFILE}]`,
    `extends = ${tomlString(base)}`,
    "restrict_network = true",
    "",
  ].join("\n");
}

/** The probe command recorded as the catalog entry's `source` on refresh. */
const MODELS_SOURCE = "grok models";

/**
 * Parse `grok models` plain-text output into normalized model entries (#29,
 * research §3). The listing is default + bullet ids, no `--json` and no
 * per-model efforts, so efforts are carried forward from the existing catalog
 * entry (a hand-patch survives a refresh) and default empty for new ids. Format
 * is unpinned, so match defensively; throws when no ids parse, so the refresh
 * path keeps the existing entry rather than replacing it with nothing.
 *
 * Observed 0.2.93 shape:
 *   Available models:
 *     * grok-4.5 (default)
 *     - grok-composer-2.5-fast
 */
export function parseGrokModels(text: string, existing: VendorModels | undefined): ModelEntry[] {
  const priorEfforts = new Map(
    (existing?.models ?? []).map((m) => [m.id, m] as const),
  );
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^\s*[-*]\s+(\S+)/.exec(line);
    if (!match) continue; // headers ("Default model:", "Available models:") skipped
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const prior = priorEfforts.get(id);
    entries.push({
      id,
      efforts: prior?.efforts ?? [],
      default_effort: prior?.default_effort ?? null,
    });
  }
  if (entries.length === 0) {
    throw new Error("grok models: no model ids parsed from output");
  }
  return entries;
}

export function createGrokAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_GROK_BIN ?? DEFAULT_GROK_BIN;

  /**
   * The env shared by fresh runs and resumes: auth, sandbox, scanner posture,
   * and the daemon-local xAI usage proxy base URL (#95).
   *
   * `GROK_XAI_API_BASE_URL` precedence (highest last at the child process):
   * 1. Parent process env — when set, we omit the key from `plan.env` so the
   *    engine's `{...process.env, ...plan.env}` spawn keeps the parent value
   *    (explicit user override / debugging; never clobber).
   * 2. This adapter's proxy URL (`http://127.0.0.1:<hubPort>/xai/<taskId>/v1`)
   *    when the parent did not set the var — same port as the MCP hub.
   * 3. `vendors.grok.env` / `profiles.<name>.env` via `applyVendorConfig`
   *    (`plan.env < vendors.env < profile.env`) still override (2) after prepare.
   *
   * Caveat (`restrict_network`): when `task.network` is false the custom bwrap
   * profile may block loopback to the proxy. Capture is fail-open — the child
   * either reaches the real API without attribution or fails to talk to the
   * model; sandbox exemption (research proposal #2) is NOT implemented.
   */
  function baseEnv(task: TaskSpec, hub: HubInfo): Record<string, string> {
    const { env: sandbox } = sandboxEnv(task);
    const result: Record<string, string> = {
      ...sandbox,
      // Pin the MCP startup timeout so a Claude-oriented parent value can't leak.
      MCP_TIMEOUT: MCP_STARTUP_TIMEOUT_MS,
    };
    // If the no-network posture applies, point GROK_SANDBOX at the custom profile
    // (whose sandbox.toml `files()` materializes).
    if (!task.network && task.sandbox !== "full") {
      result.GROK_SANDBOX = NO_NETWORK_PROFILE;
    }
    // Turn off every Claude-config scanner (they default on).
    for (const key of CLAUDE_SCANNER_VARS) result[key] = "0";
    // Gate the Claude-settings permission import the scanners don't cover (#179).
    result[CLAUDE_PERMISSION_IMPORT_OVERRIDE] = "1";
    // Auth passes through opaquely (per-token billing); only when the parent set it.
    if (env.XAI_API_KEY !== undefined) result.XAI_API_KEY = env.XAI_API_KEY;
    // Route built-in-model API-key traffic through the daemon proxy for usage
    // capture (#95). Hub URL already carries the shared ephemeral port.
    if (env.GROK_XAI_API_BASE_URL === undefined) {
      try {
        const origin = new URL(hub.url).origin;
        result.GROK_XAI_API_BASE_URL = `${origin}/xai/${task.id}/v1`;
      } catch {
        // Malformed hub URL — skip proxy injection rather than fail prepare.
      }
    }
    return result;
  }

  /** Files materialized pre-spawn: the MCP config, plus a no-network profile. */
  function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
    const materialized: MaterializedFile[] = [
      { path: ".grok/config.toml", contents: configToml(hub) },
    ];
    if (!task.network && task.sandbox !== "full") {
      const { base } = sandboxEnv(task);
      if (base !== null) {
        materialized.push({ path: ".grok/sandbox.toml", contents: sandboxToml(base) });
      }
    }
    return materialized;
  }

  /**
   * Preflight permission probe (#186): run `grok inspect --json` with the
   * child's exact cwd and env posture and report any Claude-settings permission
   * rules that would load. With the `_GROK_CLAUDE_MARKER_OVERRIDE` gate (#179)
   * the expected count is 0, so a hit means either the gate stopped working
   * (grok version drift) or another rule source reached the child — the #179
   * failure class (deny-all-edits) that is otherwise invisible: grok's
   * streaming JSON has no structured tool/denial events, denials only appear
   * as words inside streamed thought tokens.
   *
   * Fail-open: every failure mode (missing binary, non-zero exit, timeout,
   * unrecognized JSON shape) becomes a tagged diagnostic, never a spawn error.
   */
  async function permissionProbe(task: TaskSpec, childEnv: Record<string, string>): Promise<string[]> {
    try {
      const stdout = await runProbe(bin, ["inspect", "--json"], {
        cwd: task.cwd,
        // Mirror the engine's spawn env exactly ({...process.env, ...plan.env})
        // so the probe sees the child's posture, not the daemon's.
        env: { ...process.env, ...childEnv },
        timeoutMs: INSPECT_PROBE_TIMEOUT_MS,
      });
      const parsed = JSON.parse(stdout) as {
        permissions?: { loaded?: unknown; sources?: unknown };
      };
      const loaded = parsed.permissions?.loaded;
      if (typeof loaded !== "number") {
        // Shape drift would silently disarm the tripwire — surface it instead.
        throw new Error("unrecognized `grok inspect --json` permissions shape");
      }
      if (loaded === 0) return [];
      const sources = Array.isArray(parsed.permissions?.sources)
        ? parsed.permissions.sources.filter((s): s is string => typeof s === "string").join(", ")
        : "?";
      return [
        `${VENDOR_DIAG_PREFIX} claude_permission_import loaded=${loaded} ` +
          `sources=[${sources}] — imported permission rules reached the child ` +
          `despite the #179 gate; edits may be denied`,
      ];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [`${VENDOR_DIAG_PREFIX} permission_probe failed: ${message}`];
    }
  }

  /** Flags shared by fresh runs and resumes (headless streaming JSONL, pinned). */
  function commonArgv(task: TaskSpec): string[] {
    const argv = [
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--always-approve",
      "--cwd",
      task.cwd,
    ];
    if (task.model !== null) argv.push("-m", task.model);
    // Reasoning effort (#28, spec §9) — opaque string passed through unchanged;
    // `--reasoning-effort` (alias `--effort`), verified in grok 0.2.93.
    // Omitted flag means the vendor's own default; no flag emitted.
    if (task.effort !== null) argv.push("--reasoning-effort", task.effort);
    // extraArgs land in the flags region (before/with other flags; the prompt
    // is a separate -p value) so they are never ambiguous (TaskSpec contract).
    argv.push(...task.extraArgs);
    return argv;
  }

  return {
    id: "grok",
    childChannel: "mcp",

    async prepare(task, hub): Promise<SpawnPlan> {
      // Fresh single-turn run: `grok -p <prompt> …`. The session id is captured
      // from the terminal `end` event and persisted for resume.
      const env = baseEnv(task, hub);
      return {
        argv: [bin, "-p", task.prompt, ...commonArgv(task)],
        env,
        files: files(task, hub),
        cwd: task.cwd,
        diagnostics: await permissionProbe(task, env),
      };
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (ADR-0004): `-r <session-id>` resumes the persisted
      // grok session; `task.prompt` is the orchestrator's answer, delivered as
      // the conversation's continuation. The config is re-materialized so the hub
      // and posture are present on the respawn too.
      //
      // NB: verified against grok 0.2.93 — resume is `-r/--resume`, NOT `-s`
      // (which now *creates* a new session with a fixed UUID). The spec §9 table
      // and research doc (written against ~0.2.73) say `-s`; the installed binary
      // is authoritative.
      if (task.sessionId === undefined) {
        // Without `-r` grok would start a brand-new session, silently delivering
        // the answer to an agent with no conversation context. Fail loudly
        // instead — the engine reruns session-less stalled tasks via prepare().
        return Promise.reject(new Error(`grok resume for task ${task.id} has no session id`));
      }
      const env = baseEnv(task, hub);
      return Promise.resolve(permissionProbe(task, env)).then((diagnostics) => ({
        argv: [bin, "-p", task.prompt, "-r", task.sessionId!, ...commonArgv(task)],
        env,
        files: files(task, hub),
        cwd: task.cwd,
        diagnostics,
      }));
    },

    parseEvent(line: string): VendorEvent[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return []; // opaque non-JSON vendor noise — the raw log keeps it
      }
      if (typeof parsed !== "object" || parsed === null) return [];
      const event = parsed as Record<string, unknown>;
      switch (event.type) {
        case "text":
          // The assistant's visible output, streamed token-by-token.
          return typeof event.data === "string" ? [{ kind: "message", text: event.data }] : [];
        case "thought":
          // Reasoning chunks — opaque for display; the raw log retains them.
          return [];
        case "end":
          // Terminal event: carries `sessionId` (camelCase), used for resume.
          return [
            {
              kind: "session_meta",
              session_id: typeof event.sessionId === "string" ? event.sessionId : undefined,
            },
          ];
        case "error":
        case "fatal": {
          // Tagged with VENDOR_DIAG_PREFIX so vendor-surfaced errors land in
          // diag.log (#186) — grok's stream has no other anomaly channel.
          // `fatal` marks the run-terminal variant so the engine can carry it
          // into the failure detail (`lastError`).
          const message =
            typeof event.message === "string"
              ? event.message
              : typeof event.data === "string"
                ? event.data
                : "";
          return [
            {
              kind: "error",
              fatal: event.type === "fatal",
              text: `${VENDOR_DIAG_PREFIX} ${event.type}: ${message}`,
            },
          ];
        }
        default:
          // Unknown/changed shapes must never fail the task (schema is
          // undocumented and drifts across releases).
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

    async listModels(existing): Promise<ProbedModels> {
      // `grok models` prints the default + available ids as plain text (research
      // §3); efforts ride the existing catalog entry (grok exposes none here).
      const stdout = await runProbe(bin, ["models"]);
      return { source: MODELS_SOURCE, models: parseGrokModels(stdout, existing) };
    },
  };
}
