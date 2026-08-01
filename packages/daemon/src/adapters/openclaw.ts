import fs from "node:fs";
import path from "node:path";
import { displayVendorPath, resolveOperatorVendorHome } from "@useparley/core";
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
  VendorModels,
} from "./types.js";
import { VENDOR_DIAG_PREFIX, withPostureDiagnostics } from "./types.js";
import { runProbe } from "./probe.js";

/** OpenClaw: docker sandbox when mode=all; default workspace is host-local (#279). */
const OPENCLAW_ENFORCEMENT: AdapterEnforcement = {
  "read-only": {
    level: "enforced",
    via: "docker mode=all workspaceAccess=ro (fail-closed if image missing)",
  },
  workspace: {
    level: "approximate",
    via: "mode=off when network on (host tools); mode=all docker when network off",
  },
  full: { level: "enforced", via: "mode=off" },
  "network:false": {
    level: "enforced",
    via: "docker network=none under sandboxed postures",
  },
};

/**
 * The `openclaw` vendor adapter — real delegation to OpenClaw (`openclaw`
 * binary, formerly Clawdbot/Moltbot). Verified against openclaw@2026.7.1
 * (docs/research/openclaw-cli-automation.md).
 *
 * OpenClaw is gateway/daemon-shaped, not a pure one-shot coding CLI. The
 * Parley path is spawn-per-turn embedded agent:
 *   `openclaw agent --local --agent parley --message … --json`
 *
 * Unlike codex (flags-only), there are **no** per-invocation MCP / sandbox /
 * cwd flags on `openclaw agent`. Closest sibling is **grok**: materialize a
 * per-task config + approvals into `SpawnPlan.files`, isolate state via
 * `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` so the user's `~/.openclaw`
 * never bleeds in, and map posture in that config (research §3, §5, §9).
 *
 * **No streaming JSONL** — `--json` emits one document at turn end (often
 * pretty-printed via `JSON.stringify(value, null, 2)` in openclaw@2026.7.1).
 * There is no compact-JSON CLI flag. Because the adapter registry is a
 * **shared singleton**, we must not buffer multi-line JSON across parseEvent
 * calls (cross-task interleaving). Instead `prepare`/`resume` wrap the binary
 * in a small Node script that rewrites stdout to one compact JSON line so
 * line-oriented `parseEvent` sees the full envelope (#107 critical).
 *
 * Auth failures land on stderr (`ProviderAuthError` / `missing-provider-auth`);
 * the engine dual-feeds stderr into parseEvent (#107). Mid-run tool events are
 * not available on stdout (research §2, §9 risk #1).
 */

/** Default binary; override via `PARLEY_OPENCLAW_BIN` (smoke tests, custom installs). */
const DEFAULT_OPENCLAW_BIN = "openclaw";

/** Agent id used for session scoping (`--agent` / `agents.list[].id`). */
const AGENT_ID = "parley";

/** MCP server name registered in the materialized openclaw.json. */
const MCP_SERVER_NAME = "parley";

/**
 * Headroom added when raising OpenClaw's per-server MCP `timeout` (seconds)
 * above the task's answer timeout so a blocking `ask_orchestrator` is not
 * killed early (research §3; same role as codex `tool_timeout_sec`).
 */
const TOOL_TIMEOUT_HEADROOM_SEC = 60;

/**
 * Advisory `--thinking` vocabulary (research §6 / §7). `models list` does not
 * expose per-model efforts; listModels uses this when the existing catalog has
 * no efforts for an id.
 */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
] as const;

/**
 * Provider auth env keys named in research §6. Forward only when set on the
 * parent — same pattern as grok's `XAI_API_KEY`.
 */
const AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEYS",
  "ANTHROPIC_API_KEY_1",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCLAW_GATEWAY_TOKEN",
] as const;

/** Relative paths under `task.cwd` for task-isolated OpenClaw state (research §9). */
const STATE_DIR_REL = ".openclaw-state";
const CONFIG_REL = `${STATE_DIR_REL}/openclaw.json`;
const APPROVALS_REL = `${STATE_DIR_REL}/exec-approvals.json`;
/**
 * Stdout compacting wrapper — openclaw --json is pretty-printed multi-line;
 * engine is line-oriented (#107). Materialized under the task state dir.
 */
const COMPACT_WRAP_REL = `${STATE_DIR_REL}/parley-compact-stdout.mjs`;

const MODELS_SOURCE = "openclaw models list --all --json";

/** Operator config (auth profiles + credentials) under the openclaw home (#282). */
const OPERATOR_CONFIG_FILE = "openclaw.json";
/** Per-plugin catalog filename under agents/…/agent/plugins/… (#282). */
const CATALOG_FILE = "catalog.json";

/**
 * Cap on openclaw.json — co-locates gateway tokens and auth; never unbounded.
 */
export const OPENCLAW_CONFIG_MAX_BYTES = 2 * 1024 * 1024;
/** Cap on a single plugin catalog.json (large universes are still MBs-scale). */
export const OPENCLAW_CATALOG_MAX_BYTES = 8 * 1024 * 1024;

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

/**
 * Providers the operator is authenticated for, from `auth.profiles` in
 * openclaw.json (#282). Project only the `provider` string — never tokens,
 * api keys, or profile ids into returned data / errors.
 */
export function parseOpenclawAuthProviders(json: string): {
  providers: Set<string>;
  error: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { providers: new Set(), error: "malformed openclaw.json" };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { providers: new Set(), error: "unexpected openclaw.json shape" };
  }
  const auth = asRecord(root.auth);
  // Missing auth block = no authenticated providers (empty intersection), not an error.
  if (!auth) {
    return { providers: new Set(), error: null };
  }
  const profiles = asRecord(auth.profiles);
  if (!profiles) {
    return { providers: new Set(), error: null };
  }
  const providers = new Set<string>();
  for (const raw of Object.values(profiles)) {
    const p = asRecord(raw);
    if (!p) continue;
    const provider = asString(p.provider);
    if (provider !== "") providers.add(provider);
  }
  return { providers, error: null };
}

/**
 * Parse a per-plugin `catalog.json` (#282). Shape (verified):
 * `{ generatedBy, providers: { [provider]: { models: [ { id, name, … } ] } } }`.
 * Model ids become `provider/id` (same form as probe `key`). No efforts on
 * disk — empty arrays; probe/merge may enrich. Never returns credential fields.
 */
export function parseOpenclawCatalog(json: string): {
  models: ModelEntry[];
  error: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { models: [], error: "malformed catalog.json" };
  }
  const root = asRecord(parsed);
  if (!root || Array.isArray(parsed)) {
    return { models: [], error: "unexpected catalog.json shape" };
  }
  const providers = asRecord(root.providers);
  if (!providers) {
    // Valid empty-ish catalog (no providers yet).
    return { models: [], error: null };
  }
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const [provider, blob] of Object.entries(providers)) {
    if (provider === "") continue;
    const group = asRecord(blob);
    if (!group) continue;
    const models = group.models;
    if (!Array.isArray(models)) continue;
    for (const raw of models) {
      const m = asRecord(raw);
      if (!m) continue;
      const modelId = asString(m.id);
      if (modelId === "") continue;
      const id = `${provider}/${modelId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const label = typeof m.name === "string" && m.name !== "" ? m.name : undefined;
      entries.push({
        id,
        efforts: [],
        default_effort: null,
        ...(label === undefined ? {} : { label }),
      });
    }
  }
  return { models: entries, error: null };
}

/**
 * Keep only models whose provider segment is in `authedProviders` (#282).
 * Load-bearing: the raw catalog universe is large (100+ entries / many
 * providers); without intersection "discovered" becomes "wrong".
 */
export function filterOpenclawModelsByAuthedProviders(
  models: ModelEntry[],
  authedProviders: Set<string>,
): ModelEntry[] {
  if (authedProviders.size === 0) return [];
  return models.filter((m) => {
    const slash = m.id.indexOf("/");
    if (slash <= 0) return false;
    const provider = m.id.slice(0, slash);
    return authedProviders.has(provider);
  });
}

/**
 * Discover plugin catalog.json paths under an operator openclaw home.
 * Layout: `agents/<agentId>/agent/plugins/<plugin>/catalog.json`.
 */
export function listOpenclawCatalogPaths(home: string): string[] {
  const agentsDir = path.join(home, "agents");
  let agentIds: string[];
  try {
    agentIds = fs.readdirSync(agentsDir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err instanceof Error ? err : new Error(String(err));
  }
  const paths: string[] = [];
  for (const agentId of agentIds) {
    const pluginsDir = path.join(agentsDir, agentId, "agent", "plugins");
    let pluginIds: string[];
    try {
      pluginIds = fs.readdirSync(pluginsDir);
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err instanceof Error ? err : new Error(String(err));
    }
    for (const pluginId of pluginIds) {
      paths.push(path.join(pluginsDir, pluginId, CATALOG_FILE));
    }
  }
  return paths;
}

function readRegularFileText(
  filePath: string,
  fileLabel: string,
  maxBytes: number,
): { text: string | null; error: string | null } {
  try {
    const stat = fs.statSync(filePath);
    // #288: refuse non-files (FIFO, dir, device).
    if (!stat.isFile()) {
      return { text: null, error: `${fileLabel} is not a regular file` };
    }
    if (stat.size > maxBytes) {
      return {
        text: null,
        error: `${fileLabel} exceeds size cap (${maxBytes} bytes)`,
      };
    }
    return { text: fs.readFileSync(filePath, "utf8"), error: null };
  } catch (err) {
    if (isEnoent(err)) return { text: null, error: null };
    return {
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Catalog source string (tilde-collapsed path(s); never credential material). */
export function openclawDiskModelsSource(
  configPath: string,
  catalogCount: number,
): string {
  if (catalogCount <= 0) return configPath;
  if (catalogCount === 1) return `${configPath} + catalog.json`;
  return `${configPath} + ${catalogCount} catalog.json`;
}

/**
 * Node wrap script: run openclaw, buffer stdout, re-emit as one compact JSON
 * line (or raw text on parse failure). stderr is passed through unchanged so
 * auth diagnostics still reach parseEvent via the engine's dual-feed.
 */
function compactStdoutWrapScript(): string {
  return `// Generated by parley openclaw adapter — compact pretty --json stdout (#107).
import { spawn } from "node:child_process";

const [bin, ...args] = process.argv.slice(2);
if (!bin) {
  console.error("parley-compact-stdout: missing openclaw binary argv");
  process.exit(1);
}

const child = spawn(bin, args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});
let out = "";
child.stdout.on("data", (chunk) => {
  out += chunk;
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});
child.on("error", (err) => {
  console.error(String(err));
  process.exit(1);
});
child.on("close", (code) => {
  const trimmed = out.trim();
  if (trimmed !== "") {
    try {
      process.stdout.write(JSON.stringify(JSON.parse(trimmed)) + "\\n");
    } catch {
      // Non-JSON stdout (unexpected): pass through so raw logs stay useful.
      process.stdout.write(out.endsWith("\\n") ? out : out + "\\n");
    }
  }
  process.exit(code === null ? 1 : code);
});
`;
}

function toolTimeoutSec(answerTimeoutMs: number): number {
  return Math.ceil(answerTimeoutMs / 1000) + TOOL_TIMEOUT_HEADROOM_SEC;
}

/** Stable session key for spawn-per-turn isolation (research §4 / §9). */
function sessionKey(taskId: string): string {
  return `agent:${AGENT_ID}:${taskId}`;
}

/**
 * Map Parley sandbox × network → OpenClaw `agents.defaults.sandbox` (research §5).
 *
 * Gaps (documented, not silent):
 * - Docker sandbox (`mode: all`) needs image `openclaw-sandbox:bookworm-slim` on
 *   the host; fails closed if missing when mode ≠ off.
 * - // UNKNOWN(research): gitDir / gitCommonDir extra writable roots via
 *   `sandbox.docker.binds` are not mapped yet — worktree private gitdirs may
 *   fail under Docker sandbox until designed and tested (research §5, §9 #3).
 * - `sandbox=workspace` + `network=true` prefers `mode: off` (host tools +
 *   configured workspace) to avoid requiring Docker for the default posture.
 */
function sandboxConfig(
  sandbox: SandboxMode,
  network: boolean,
): Record<string, unknown> {
  switch (sandbox) {
    case "read-only":
      // Research §5: mode=all, workspaceAccess=ro; docker network stays default none.
      // network is ignored for read-only (matches ADR-0006 matrix elsewhere).
      return {
        mode: "all",
        workspaceAccess: "ro",
        docker: { network: "none" },
      };
    case "full":
      // Full host access — dangerous; exec ask off is set separately.
      return { mode: "off" };
    case "workspace":
    default:
      if (!network) {
        // mode=all + rw workspace + docker network none (research §5).
        return {
          mode: "all",
          workspaceAccess: "rw",
          docker: { network: "none" },
        };
      }
      // Default posture: no process sandbox; file tools rooted at workspace.
      // Closest safe host-local mapping when Docker is not required.
      return { mode: "off" };
  }
}

/**
 * Headless YOLO exec-approvals (research §5). Written into the task-isolated
 * state dir so interactive approval gates never hang a headless child.
 */
function execApprovalsJson(): string {
  return (
    JSON.stringify(
      {
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "full" },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Per-task `openclaw.json`: workspace = task.cwd, MCP hub, sandbox posture,
 * and headless exec policy (research §3, §5, §9).
 */
function openclawConfigJson(task: TaskSpec, hub: HubInfo): string {
  const mcpTimeoutSec = toolTimeoutSec(task.answerTimeoutMs);
  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        workspace: task.cwd,
        sandbox: sandboxConfig(task.sandbox, task.network),
      },
      list: [
        {
          id: AGENT_ID,
          workspace: task.cwd,
        },
      ],
    },
    tools: {
      // Avoid tools.profile "minimal" which hides MCP (research §3).
      // coding/messaging expose bundle MCP tools; leave profile unset so the
      // product default applies, and only force exec headless.
      exec: { host: "gateway", security: "full", ask: "off" },
    },
    mcp: {
      servers: {
        [MCP_SERVER_NAME]: {
          url: hub.url,
          transport: "streamable-http",
          // Seconds — raise above answer timeout (research §3).
          timeout: mcpTimeoutSec,
          headers: { ...hub.headers },
        },
      },
    },
  };
  return JSON.stringify(config, null, 2) + "\n";
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

/**
 * Parse `openclaw models list --all --json` into catalog entries (research §7).
 * Uses `models[].key` as id; efforts come from the existing catalog entry or
 * the advisory `--thinking` vocabulary (probe exposes no efforts).
 */
export function parseOpenclawModels(
  json: string,
  existing: VendorModels | undefined,
): ModelEntry[] {
  const root = asRecord(JSON.parse(json));
  const models = root?.models;
  if (!Array.isArray(models)) {
    throw new Error("openclaw models list: missing 'models' array");
  }
  const prior = new Map((existing?.models ?? []).map((m) => [m.id, m] as const));
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const m = asRecord(raw);
    if (!m) continue;
    const id = asString(m.key);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    const prev = prior.get(id);
    entries.push({
      id,
      efforts: prev?.efforts?.length ? prev.efforts : [...THINKING_LEVELS],
      default_effort: prev?.default_effort ?? null,
    });
  }
  if (entries.length === 0) {
    throw new Error("openclaw models list: no model ids parsed from output");
  }
  return entries;
}

/**
 * Normalize OpenClaw `meta.agentMeta.usage` into a usage bag: harness field
 * names plus canonical `input_tokens` / `output_tokens` / `cached_tokens`
 * when derivable (research §8 / §9).
 */
function usageFromAgentMeta(usageObj: Record<string, unknown>): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(usageObj)) {
    const n = asNumber(value);
    if (n !== undefined) usage[key] = n;
  }
  const input = asNumber(usageObj.input);
  const output = asNumber(usageObj.output);
  const cacheRead = asNumber(usageObj.cacheRead);
  if (input !== undefined) usage.input_tokens = input;
  if (output !== undefined) usage.output_tokens = output;
  if (cacheRead !== undefined) usage.cached_tokens = cacheRead;
  return usage;
}

/** True when `obj` looks like an OpenClaw agent `--json` result envelope. */
function isResultEnvelope(obj: Record<string, unknown>): boolean {
  return "payloads" in obj || "meta" in obj || "deliveryStatus" in obj;
}

/**
 * Map a parsed agent `--json` result to VendorEvents (research §9 event table).
 */
function eventsFromResult(obj: Record<string, unknown>): VendorEvent[] {
  const events: VendorEvent[] = [];

  const payloads = Array.isArray(obj.payloads) ? obj.payloads : [];
  const texts: string[] = [];
  let sawPayloadError = false;
  for (const raw of payloads) {
    const p = asRecord(raw);
    if (!p) continue;
    if (p.isError === true) {
      sawPayloadError = true;
      const errText = asString(p.text) || asString(p.message) || "payload error";
      events.push({ kind: "error", text: errText });
    } else if (typeof p.text === "string" && p.text.length > 0) {
      texts.push(p.text);
    }
  }
  if (texts.length > 0) {
    events.push({ kind: "message", text: texts.join("\n") });
  }

  const meta = asRecord(obj.meta);
  const agentMeta = asRecord(meta?.agentMeta);
  if (agentMeta) {
    const sessionId =
      typeof agentMeta.sessionId === "string" ? agentMeta.sessionId : undefined;
    const usageRaw = asRecord(agentMeta.usage);
    const usage = usageRaw ? usageFromAgentMeta(usageRaw) : undefined;
    if (sessionId !== undefined || (usage !== undefined && Object.keys(usage).length > 0)) {
      events.push({
        kind: "session_meta",
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        ...(usage !== undefined && Object.keys(usage).length > 0 ? { usage } : {}),
      });
    }
  }

  // Error-like top-level shapes (defensive; success path is payloads + meta).
  if (typeof obj.error === "string" && obj.error.length > 0) {
    events.push({ kind: "error", text: obj.error, fatal: true });
  } else if (asRecord(obj.error)) {
    const err = asRecord(obj.error)!;
    events.push({
      kind: "error",
      text: asString(err.message) || asString(err.error) || JSON.stringify(obj.error),
      fatal: true,
    });
  }

  // payload.isError alone is mid-run-ish / non-fatal (research §9 fatal TBD).
  void sawPayloadError;

  return events;
}

/**
 * Detect actionable auth/gateway failures on stderr (engine dual-feeds stderr
 * into parseEvent — #107). Also works when tests pass a multi-line blob.
 */
function eventsFromDiagnosticText(line: string): VendorEvent[] {
  if (
    /ProviderAuthError|FailoverError|GatewayCredentialsRequiredError|missing-provider-auth/i.test(
      line,
    )
  ) {
    return [{ kind: "error", text: line.trim(), fatal: true }];
  }
  // Approval / guardian style cancellation of our MCP tools (headless, no TTY).
  if (/cancelled|denied|approval|ask.*mcp|mcp.*ask/i.test(line) && /mcp|parley|tool/i.test(line)) {
    return [
      {
        kind: "error",
        text: `${VENDOR_DIAG_PREFIX} openclaw approval/tool gate: ${line.trim()}`,
      },
    ];
  }
  return [];
}

export function createOpenclawAdapter(env: NodeJS.ProcessEnv = process.env): VendorAdapter {
  const bin = env.PARLEY_OPENCLAW_BIN ?? DEFAULT_OPENCLAW_BIN;

  function statePaths(task: TaskSpec): { stateDir: string; configPath: string } {
    const stateDir = path.join(task.cwd, STATE_DIR_REL);
    return { stateDir, configPath: path.join(stateDir, "openclaw.json") };
  }

  /** Auth + isolation env shared by prepare and resume (research §6, §9). */
  function baseEnv(task: TaskSpec): Record<string, string> {
    const { stateDir, configPath } = statePaths(task);
    const result: Record<string, string> = {
      // Isolate from the user's ~/.openclaw (research §1, §9).
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
    };
    for (const key of AUTH_ENV_KEYS) {
      const value = env[key];
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  function files(task: TaskSpec, hub: HubInfo): MaterializedFile[] {
    return [
      { path: CONFIG_REL, contents: openclawConfigJson(task, hub) },
      { path: APPROVALS_REL, contents: execApprovalsJson() },
      { path: COMPACT_WRAP_REL, contents: compactStdoutWrapScript() },
    ];
  }

  /**
   * Flags shared by prepare/resume. Prompt is always `--message` (not a bare
   * positional), so extraArgs splice safely after other flags (TaskSpec contract).
   */
  function commonArgv(task: TaskSpec): string[] {
    const timeoutSec = toolTimeoutSec(task.answerTimeoutMs);
    const argv: string[] = [
      "agent",
      "--local",
      "--agent",
      AGENT_ID,
      "--message",
      task.prompt,
      "--json",
      "--timeout",
      String(timeoutSec),
    ];
    // Model / thinking pass through opaquely (research §6).
    if (task.model !== null) argv.push("--model", task.model);
    if (task.effort !== null) argv.push("--thinking", task.effort);
    // extraArgs in the flags region — never after a bare positional prompt.
    argv.push(...task.extraArgs);
    return argv;
  }

  /**
   * Wrap openclaw so pretty-printed --json becomes one compact stdout line
   * before the engine's line reader (#107). Uses process.execPath (no PATH node).
   */
  function wrappedArgv(task: TaskSpec, sessionArgs: string[]): string[] {
    const wrapAbs = path.resolve(task.cwd, COMPACT_WRAP_REL);
    return [process.execPath, wrapAbs, bin, ...commonArgv(task), ...sessionArgs];
  }

  return withPostureDiagnostics({
    id: "openclaw",
    childChannel: "mcp",
    enforcement: OPENCLAW_ENFORCEMENT,

    prepare(task, hub): Promise<SpawnPlan> {
      // Fresh headless one-shot (research §2, §9): embedded agent, stable
      // session key for later resume, task-local config + approvals + compact wrap.
      return Promise.resolve({
        argv: wrappedArgv(task, ["--session-key", sessionKey(task.id)]),
        env: baseEnv(task),
        files: files(task, hub),
        cwd: task.cwd,
      });
    },

    resume(task, hub): Promise<SpawnPlan> {
      // Spawn-per-turn resume (research §4): prefer UUID --session-id when the
      // engine persisted one from a prior session_meta; otherwise the stable
      // --session-key still targets the same agent session store under the
      // task-local OPENCLAW_STATE_DIR. Re-materialize config so hub headers /
      // timeouts stay current.
      //
      // OpenClaw can resume via session-key alone (unlike grok, which needs -r).
      // We only reject when even that cannot be formed (no task id — should not
      // happen in practice).
      if (!task.id) {
        return Promise.reject(
          new Error(`openclaw resume for task has no session id or task id for session-key`),
        );
      }

      const sessionArgs =
        task.sessionId !== undefined && task.sessionId !== ""
          ? ["--session-id", task.sessionId]
          : ["--session-key", sessionKey(task.id)];

      return Promise.resolve({
        argv: wrappedArgv(task, sessionArgs),
        env: baseEnv(task),
        files: files(task, hub),
        cwd: task.cwd,
      });
    },

    parseEvent(line: string): VendorEvent[] {
      // Complete JSON document (compact one-liner after wrap, or multi-line blob
      // in tests). Intermediate pretty-print fragments still → [] (research §9).
      // If pretty-print slips past the wrap (misconfigured spawn), emit a
      // greppable diag so the residual is visible in diag.log.
      const trimmed = line.trim();
      if (trimmed === "") return [];

      // Detect multi-line pretty-print fragments (line starts with indent or is
      // a lone brace/bracket) that are not valid JSON alone.
      if (
        (/^\s+(?:"|\{|\[)/.test(line) ||
          trimmed === "{" ||
          trimmed === "}" ||
          trimmed === "[" ||
          trimmed === "]") &&
        !trimmed.startsWith("{") &&
        !trimmed.startsWith("[")
      ) {
        return [
          {
            kind: "error",
            text:
              `${VENDOR_DIAG_PREFIX} openclaw: pretty-printed --json line fragment ` +
              `reached parseEvent; compact-stdout wrap may be missing. Fragment ignored.`,
            fatal: false,
          },
        ];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Non-JSON: only map known run-terminal diagnostic phrases (stderr auth).
        return eventsFromDiagnosticText(line);
      }

      const obj = asRecord(parsed);
      if (!obj) return [];

      if (isResultEnvelope(obj)) {
        return eventsFromResult(obj);
      }

      // Defensive: sessions --json shaped blobs are not the agent result path.
      return [];
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
      // research §7: full catalog via --all --json; no per-model efforts.
      const stdout = await runProbe(bin, ["models", "list", "--all", "--json"]);
      return { source: MODELS_SOURCE, models: parseOpenclawModels(stdout, existing) };
    },

    async readModels(): Promise<ProbedModels> {
      // Operator home via resolveOperatorVendorHome (refuses .openclaw-state
      // isolation markers). Prefer per-plugin catalog.json (no sqlite) and
      // intersect with auth.profiles providers from openclaw.json (#282).
      // openclaw.json co-locates credentials — never log file body, never
      // re-serialize profiles; errors/warnings must not contain secrets.
      const home = resolveOperatorVendorHome("openclaw", env);
      if (home === null) return { source: OPERATOR_CONFIG_FILE, models: [] };

      const configPath = path.join(home, OPERATOR_CONFIG_FILE);
      const configSource = displayVendorPath(configPath, env);

      const configRead = readRegularFileText(
        configPath,
        OPERATOR_CONFIG_FILE,
        OPENCLAW_CONFIG_MAX_BYTES,
      );
      if (configRead.error !== null) {
        throw new Error(configRead.error);
      }
      let authedProviders = new Set<string>();
      if (configRead.text !== null) {
        // Secret hygiene: parse → project provider strings only.
        const auth = parseOpenclawAuthProviders(configRead.text);
        if (auth.error !== null) throw new Error(auth.error);
        authedProviders = auth.providers;
      }

      // No auth profiles → empty disk catalog (intersection with empty set).
      // Missing config is quiet empty (fresh home), same as no providers.
      if (authedProviders.size === 0) {
        return {
          source: openclawDiskModelsSource(configSource, 0),
          models: [],
        };
      }

      let catalogPaths: string[];
      try {
        catalogPaths = listOpenclawCatalogPaths(home);
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }

      const allModels: ModelEntry[] = [];
      const seen = new Set<string>();
      let catalogsRead = 0;
      for (const catalogPath of catalogPaths) {
        const read = readRegularFileText(
          catalogPath,
          CATALOG_FILE,
          OPENCLAW_CATALOG_MAX_BYTES,
        );
        if (read.error !== null) {
          throw new Error(read.error);
        }
        if (read.text === null) continue; // path listed but file missing — skip
        const parsed = parseOpenclawCatalog(read.text);
        if (parsed.error !== null) throw new Error(parsed.error);
        catalogsRead += 1;
        for (const m of parsed.models) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          allModels.push(m);
        }
      }

      const models = filterOpenclawModelsByAuthedProviders(allModels, authedProviders);
      return {
        source: openclawDiskModelsSource(configSource, catalogsRead),
        models,
      };
    },
  });
}

/** Exported for tests that assert the compact-stdout wrap path. */
export const OPENCLAW_COMPACT_WRAP_REL = COMPACT_WRAP_REL;
export const OPENCLAW_STATE_DIR_REL = STATE_DIR_REL;
