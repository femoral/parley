import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  collectUnknownConfigKeys,
  DEFAULT_RUNNER_PRESENCE_GRACE_MS,
  DEFAULT_RUNNER_STALE_MS,
  deriveRunnerStatus,
  eventNameForState,
  getConfigPath,
  isMetricsGroupBy,
  isRunMetricsGroupBy,
  isTerminalState,
  METRICS_GROUP_BY,
  parseRunMetricsFilters,
  parseTaskMetricsFilters,
  resolveWorkflow,
  RUN_METRICS_GROUP_BY,
  isRunnerWirePhase,
  RUNNER_PROTOCOL_VERSION,
  runnerStaleWindowMs as runnerStaleWindowMsFromConfig,
  setConfigPath,
  TASK_HEADER,
  unsetConfigPath,
  validateConfig,
  writeConfig,
  type HomePaths,
  type ParleyConfig,
  readConfig,
  type RunnerCapabilities,
  type RunnerListEntry,
  type RunnerRecentTask,
  type RunnerRepoReachability,
  type RunnerShowResponse,
  type RunnerVendorCapability,
  type RunnerWirePhase,
  type TaskEnvelope,
  type WorkflowDefinition,
  isGitAuthFailureCode,
  isGitAuthOperation,
  type GitAuthFailCategoryWire,
} from "@useparley/core";
import { createAdapterRegistry } from "./adapters/index.js";
import type { VendorAdapter } from "./adapters/types.js";
import {
  extractAllowlist,
  parseModelsAllowlistKey,
  refreshFleetCatalog,
  setModelsAllowlistPath,
  unsetModelsAllowlistPath,
} from "./models-http.js";
import {
  countUnsettledTasks,
  deleteRunner,
  deleteStaleRunners,
  getDeliverable,
  getMeta,
  getRun,
  getRunner,
  latestNodeIteration,
  listDeliverablesForRun,
  listDeliverablesForRunNode,
  listRecentTasksForRunner,
  listRunners,
  listRunsFiltered,
  listTasksForRun,
  META_LAST_GC_AT,
  openDatabase,
  parseUnreachableRepos,
  resolveRun,
  setMeta,
  sweepInterruptedTasks,
  touchRunnerLastSeen,
  upsertRunner,
  type DatabaseHandle,
  type RunnerRow,
  type RunRow,
} from "./db.js";
import {
  collectFanOutDeliverable,
  deliverableRowToQuery,
  looksLikeDeliverableId,
  parseDeliverableAddress,
  projectNodeDetail,
  projectRunDetail,
  projectRunSummary,
  resolveDeliverableValue,
  taskRowToQuery,
} from "./run-query.js";
import { runBranchName, runCheckoutPath, runScratchPath } from "./run-workspace.js";
import type { DaemonIdentity } from "./identity.js";
import { isSandboxMode, type SandboxMode } from "./adapters/types.js";
import { readGlobalConfigLayer, type ContextFile } from "./context.js";
import { DelegateError, TaskEngine } from "./engine.js";
import {
  CODE_UNKNOWN_SESSION,
  unknownSessionMessage,
} from "./session-binding.js";
import { readLogTail } from "./logtail.js";
import { handleChildAsk, handleChildReport, handleChildTask } from "./child.js";
import {
  aggregateMetrics,
  aggregateRunMetrics,
  indexTasksByRunId,
  taskMatchesFilters,
} from "./metrics.js";
import { handleMcpRequest } from "./mcp.js";
import { buildEnvelope } from "./report.js";
import {
  buildAttemptChain,
  buildEvalDetail,
  buildSessionProvenance,
} from "./task-detail.js";
import { discoverUiBundle, isReservedPath, serveUiRequest } from "./ui.js";
import { DAEMON_VERSION } from "./version.js";
import { handleXaiProxyRequest, parseXaiProxyPath } from "./xai-proxy.js";
import { buildInfo } from "./info.js";

/** Default scheduled retention sweep interval (#153): 24 hours. */
const DEFAULT_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Scheduled gc interval. `PARLEY_GC_INTERVAL_MS` overrides for tests; `0`
 * disables auto-sweep entirely. Unset/blank → 24h.
 */
function gcIntervalMs(): number {
  const raw = process.env.PARLEY_GC_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GC_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_GC_INTERVAL_MS;
}

/** Append a line to the daemon-home `diag.log` (best-effort). */
function appendDaemonDiag(paths: HomePaths, line: string): void {
  const logPath = path.join(paths.home, "diag.log");
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* never let logging take down the daemon */
  }
}

/**
 * Self-schedule retention sweeps every 24h (#153). Persists `last_gc_at` so a
 * restart never resweeps early: on startup, run only when due (or never run
 * before); otherwise wait until `last_gc_at + interval`. Returns a stop fn.
 */
function scheduleRetentionGc(
  engine: TaskEngine,
  db: DatabaseHandle,
  paths: HomePaths,
): () => void {
  const intervalMs = gcIntervalMs();
  if (intervalMs === 0) return () => {};

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const runSweep = (): void => {
    if (stopped) return;
    try {
      const result = engine.gc({ dryRun: false });
      setMeta(db, META_LAST_GC_AT, new Date().toISOString());
      appendDaemonDiag(
        paths,
        `gc: removed ${result.removed} task(s), freed ${result.freed_bytes} byte(s)` +
          (result.failed.length > 0 ? `, ${result.failed.length} failure(s)` : ""),
      );
      for (const f of result.failed) {
        const who = f.task_id ?? f.run_id ?? "?";
        appendDaemonDiag(paths, `gc: ${who} failed: ${f.error}`);
      }
    } catch (err) {
      appendDaemonDiag(paths, `gc: sweep error: ${String(err)}`);
    }
    if (!stopped) {
      timer = setTimeout(runSweep, intervalMs);
      timer.unref();
    }
  };

  const last = getMeta(db, META_LAST_GC_AT);
  let delay = 0;
  if (last !== null) {
    const lastMs = Date.parse(last);
    if (Number.isFinite(lastMs)) {
      delay = Math.max(0, lastMs + intervalMs - Date.now());
    }
  }
  timer = setTimeout(runSweep, delay);
  timer.unref();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export interface DaemonServer {
  /** The port the server is listening on. */
  port: number;
  /**
   * Address the server bound to (`daemon.bind`, default `127.0.0.1`).
   * See #323 / ADR-0030.
   */
  bind: string;
  /** Close the server and its database. */
  close: () => Promise<void>;
}

/**
 * How long one `/events?wait=true` long-poll blocks before the CLI re-polls.
 * `PARLEY_LONG_POLL_MS` overrides it — tests shrink the window to exercise
 * re-poll behavior (e.g. a waiter observing a stall after missing the
 * question event) without 25s waits. Read per call so tests can set the env
 * after the module loads. Unset/empty/non-positive → 25s default.
 */
function longPollWindowMs(): number {
  const raw = process.env.PARLEY_LONG_POLL_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 25_000;
}

/**
 * Online grace after last contact. Unset/empty →
 * `max(DEFAULT_RUNNER_PRESENCE_GRACE_MS, 2× long-poll)` so production stays
 * ~2× the default 25s poll (50s floor). Explicit `0` is honored as "no grace"
 * (tests that need offline immediately after last_seen). Non-finite values
 * fall through to the default.
 */
function runnerPresenceGraceMs(): number {
  const raw = process.env.PARLEY_RUNNER_PRESENCE_GRACE_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    // Explicit 0 = no grace (test seam). Positive values override the default.
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  // Floor at DEFAULT (50s). The 2× term only raises grace when long-poll is
  // longer than 25s; shrinking PARLEY_LONG_POLL_MS for tests does not lower
  // the floor — use PARLEY_RUNNER_PRESENCE_GRACE_MS for that.
  return Math.max(DEFAULT_RUNNER_PRESENCE_GRACE_MS, longPollWindowMs() * 2);
}

/**
 * Stale threshold (#320): env `PARLEY_RUNNER_STALE_MS` wins (test override),
 * else `runnerSettings.staleWindowMs` from config, else DEFAULT_RUNNER_STALE_MS
 * (14 days). Used for status derivation and lazy row auto-delete.
 */
function runnerStaleMs(config?: ParleyConfig): number {
  const raw = process.env.PARLEY_RUNNER_STALE_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (config !== undefined) return runnerStaleWindowMsFromConfig(config);
  return DEFAULT_RUNNER_STALE_MS;
}

/**
 * Lazy stale auto-cleanup (#320): delete registration rows whose last_seen is
 * older than the stale window, skipping runners with an open lease poll.
 * Runs on list / show / register — no background timer. Does not touch
 * `runners.<name>` config tokens (re-registration remains allowed).
 *
 * Single implementation: SQL cutoff via {@link deleteStaleRunners}, with
 * open-poll names excluded (in-process presence is not in SQLite).
 */
function sweepStaleRunners(db: DatabaseHandle, config?: ParleyConfig): void {
  const staleMs = runnerStaleMs(config);
  // `now - last > staleMs` ≡ `last < now - staleMs` (strict). ISO cutoff matches.
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  // openRunnerPolls only holds entries with count > 0.
  deleteStaleRunners(db, cutoff, new Set(openRunnerPolls.keys()));
}

/** In-process open lease-poll counts per runner name (presence signal). */
const openRunnerPolls = new Map<string, number>();

function beginRunnerPoll(name: string): void {
  openRunnerPolls.set(name, (openRunnerPolls.get(name) ?? 0) + 1);
}

function endRunnerPoll(name: string): void {
  const n = (openRunnerPolls.get(name) ?? 1) - 1;
  if (n <= 0) openRunnerPolls.delete(name);
  else openRunnerPolls.set(name, n);
}

function runnerHasOpenPoll(name: string): boolean {
  return (openRunnerPolls.get(name) ?? 0) > 0;
}

function parseCapabilitiesJson(raw: string): RunnerCapabilities {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { vendors?: unknown }).vendors)
    ) {
      return parsed as RunnerCapabilities;
    }
  } catch {
    /* fall through */
  }
  return { vendors: [] };
}

function projectRunnerListEntry(
  row: RunnerRow,
  config?: ParleyConfig,
): RunnerListEntry {
  const caps = parseCapabilitiesJson(row.capabilities);
  return {
    name: row.name,
    status: deriveRunnerStatus({
      hasOpenPoll: runnerHasOpenPoll(row.name),
      lastSeenIso: row.last_seen,
      graceMs: runnerPresenceGraceMs(),
      staleMs: runnerStaleMs(config),
    }),
    vendors: caps.vendors.map((v) => v.id),
    last_seen: row.last_seen,
    registered_at: row.registered_at,
    protocol_version: row.protocol_version,
    build_version: row.build_version,
  };
}

/**
 * Extract optional repo-reachability from a capabilities payload.
 * Current wire (#314) may omit it; mirrors work may add later. Accepts:
 * - `repo_reachability: Record<string, boolean>`
 * - `repo_reachability: Array<{ repo_key|key|repo, reachable|ok }>`
 * - `repos: Array<{ ... }>` (alias)
 * Returns null when absent or unparseable ("not advertised").
 */
function projectRepoReachability(
  caps: RunnerCapabilities & Record<string, unknown>,
): RunnerRepoReachability[] | null {
  const raw =
    caps.repo_reachability !== undefined
      ? caps.repo_reachability
      : caps.repos !== undefined
        ? caps.repos
        : undefined;
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    const out: RunnerRepoReachability[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const key =
        typeof rec.repo_key === "string"
          ? rec.repo_key
          : typeof rec.key === "string"
            ? rec.key
            : typeof rec.repo === "string"
              ? rec.repo
              : null;
      if (key === null || key === "") continue;
      const reachable =
        typeof rec.reachable === "boolean"
          ? rec.reachable
          : typeof rec.ok === "boolean"
            ? rec.ok
            : null;
      if (reachable === null) continue;
      out.push({ repo_key: key, reachable });
    }
    return out.length > 0 ? out : null;
  }
  if (typeof raw === "object") {
    const out: RunnerRepoReachability[] = [];
    for (const [repo_key, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "boolean") out.push({ repo_key, reachable: v });
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

/**
 * GET /runners/:name payload (#320 + #329). Extends the core show shape with
 * advertisement freshness so CLI can distinguish contact age from catalog age.
 */
export type RunnerShowPayload = RunnerShowResponse & {
  /**
   * ISO-8601 of last successful registration upsert. Null for pre-migration
   * rows (CLI renders as unknown).
   */
  capabilities_updated_at: string | null;
  /**
   * Milliseconds since `capabilities_updated_at`. Null when the timestamp is
   * null so operators never see epoch-age for pre-migration rows.
   */
  advertisement_age_ms: number | null;
};

function projectRunnerShow(
  row: RunnerRow,
  db: DatabaseHandle,
  config?: ParleyConfig,
): RunnerShowPayload {
  const caps = parseCapabilitiesJson(row.capabilities) as RunnerCapabilities &
    Record<string, unknown>;
  const lastMs = Date.parse(row.last_seen);
  // last_seen is refreshed on every poll/heartbeat/event — presence age only.
  // Advertisement age is capabilities_updated_at (#329).
  const last_contact_age_ms = Number.isFinite(lastMs)
    ? Math.max(0, Date.now() - lastMs)
    : 0;
  const capsAt = row.capabilities_updated_at;
  const capsMs = capsAt !== null && capsAt !== "" ? Date.parse(capsAt) : NaN;
  const advertisement_age_ms = Number.isFinite(capsMs)
    ? Math.max(0, Date.now() - capsMs)
    : null;
  const vendors: RunnerVendorCapability[] = caps.vendors.map((v) => ({
    id: v.id,
    models: Array.isArray(v.models) ? v.models : [],
  }));
  const recent_tasks: RunnerRecentTask[] = listRecentTasksForRunner(db, row.name).map(
    (t) => ({
      id: t.id,
      name: t.name,
      state: t.state,
      vendor: t.vendor,
      model: t.model,
      created_at: t.created_at,
      updated_at: t.updated_at,
      completed_at: t.completed_at,
    }),
  );
  const unreachableMap = parseUnreachableRepos(row.unreachable_repos);
  const unreachable_repos = Object.entries(unreachableMap)
    .map(([repo_key, entry]) => ({
      repo_key,
      code: entry.code,
      at: entry.at,
      ...(entry.operation !== undefined ? { operation: entry.operation } : {}),
    }))
    .sort((a, b) => a.repo_key.localeCompare(b.repo_key));
  return {
    name: row.name,
    status: deriveRunnerStatus({
      hasOpenPoll: runnerHasOpenPoll(row.name),
      lastSeenIso: row.last_seen,
      graceMs: runnerPresenceGraceMs(),
      staleMs: runnerStaleMs(config),
    }),
    last_seen: row.last_seen,
    registered_at: row.registered_at,
    protocol_version: row.protocol_version,
    build_version: row.build_version,
    last_contact_age_ms,
    capabilities_updated_at: capsAt,
    advertisement_age_ms,
    vendors,
    repo_reachability: projectRepoReachability(caps),
    unreachable_repos,
    recent_tasks,
  };
}

/** Max entries accepted in `held_mirrors` on register (#318 review HIGH-3 / MEDIUM-5). */
const HELD_MIRRORS_MAX = 256;
/** Max chars per held-mirror repo key on the wire. */
const HELD_MIRROR_KEY_MAX = 512;

/** Wire rule text for held_mirrors 400s (#318 LOW-D). */
const HELD_MIRRORS_RULE =
  `held_mirrors must be an array of strings (≤${HELD_MIRROR_KEY_MAX} chars each, ≤${HELD_MIRRORS_MAX} entries)`;

/**
 * Validate runner capabilities. Returns null when valid; otherwise a distinct
 * error message (held_mirrors rejections name the actual rule — #318 LOW-D).
 */
function capabilitiesValidationError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "capabilities is required ({ vendors: [{ id, models }] })";
  }
  const vendors = (value as { vendors?: unknown }).vendors;
  if (!Array.isArray(vendors)) {
    return "capabilities is required ({ vendors: [{ id, models }] })";
  }
  for (const v of vendors) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return "capabilities is required ({ vendors: [{ id, models }] })";
    }
    if (typeof (v as { id?: unknown }).id !== "string" || (v as { id: string }).id === "") {
      return "capabilities is required ({ vendors: [{ id, models }] })";
    }
    if (!Array.isArray((v as { models?: unknown }).models)) {
      return "capabilities is required ({ vendors: [{ id, models }] })";
    }
  }
  // held_mirrors is optional; when present must be string[] (bounded).
  // A non-array blob would 500 every /runner/lease via `.includes` (#318 HIGH-3).
  if (Object.prototype.hasOwnProperty.call(value, "held_mirrors")) {
    const held = (value as { held_mirrors?: unknown }).held_mirrors;
    if (!Array.isArray(held)) return HELD_MIRRORS_RULE;
    if (held.length > HELD_MIRRORS_MAX) return HELD_MIRRORS_RULE;
    for (const k of held) {
      if (typeof k !== "string" || k.length > HELD_MIRROR_KEY_MAX) {
        return HELD_MIRRORS_RULE;
      }
    }
  }
  return null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** A client mistake at the HTTP layer, reported as its status (not a 500). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Optional structured fail category (#317).
 *
 * - Absent / non-object / non-`git_auth` → `{ ok: true, category: null }`
 *   (plain message-only fail).
 * - `kind: "git_auth"` with invalid `operation`/`code` (not in the closed
 *   enums, or non-strings) → `{ ok: false }` → HTTP 400. Hostile free-form
 *   strings (ANSI, garbage) never reach storage.
 * - Valid enums only — `repo_key` and `runner` on the wire are ignored;
 *   the engine fills them from the task row + authenticated runner name.
 */
function parseFailCategory(
  value: unknown,
):
  | { ok: true; category: Pick<GitAuthFailCategoryWire, "kind" | "operation" | "code"> | null }
  | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, category: null };
  }
  if (!isRecord(value)) {
    return { ok: true, category: null };
  }
  if (value.kind !== "git_auth") {
    // Unknown kind: treat as plain fail (forward-compat), not 400.
    return { ok: true, category: null };
  }
  if (typeof value.operation !== "string" || !isGitAuthOperation(value.operation)) {
    return {
      ok: false,
      error:
        'category.operation must be one of "clone", "fetch", "push" when kind is "git_auth"',
    };
  }
  if (typeof value.code !== "string" || !isGitAuthFailureCode(value.code)) {
    return {
      ok: false,
      error:
        "category.code must be a known GitAuthFailureCode when kind is \"git_auth\"",
    };
  }
  return {
    ok: true,
    category: {
      kind: "git_auth",
      operation: value.operation,
      code: value.code,
    },
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Parse an optional `ancestry_chain` body field (#162). Returns `[]` when
 * absent/null; `undefined` when present but malformed (caller → 400).
 */
function parseAncestryChain(
  value: unknown,
): import("./db.js").ProcessAnchor[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  const out: import("./db.js").ProcessAnchor[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.machine_id !== "string" || entry.machine_id === "") return undefined;
    if (typeof entry.pid !== "number" || !Number.isFinite(entry.pid)) return undefined;
    if (typeof entry.start_time !== "string" || entry.start_time === "") return undefined;
    out.push({
      machine_id: entry.machine_id,
      pid: entry.pid,
      start_time: entry.start_time,
    });
  }
  return out;
}

/** Parse a single process anchor object (#162). */
function parseAnchor(value: unknown): import("./db.js").ProcessAnchor | null {
  if (!isRecord(value)) return null;
  if (typeof value.machine_id !== "string" || value.machine_id === "") return null;
  if (typeof value.pid !== "number" || !Number.isFinite(value.pid)) return null;
  if (typeof value.start_time !== "string" || value.start_time === "") return null;
  return {
    machine_id: value.machine_id,
    pid: value.pid,
    start_time: value.start_time,
  };
}

/** `POST /tasks` — the delegate endpoint. */
function handleDelegate(engine: TaskEngine, res: http.ServerResponse, body: unknown): void {
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  const prompt = body.prompt;
  const cwd = body.cwd;
  const orchestratorSessionId = body.orchestrator_session_id;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    sendJson(res, 400, { error: "prompt is required" });
    return;
  }
  // Vendor/profile optional when defaults are configured (#175); engine
  // resolves flags > defaults.profile > defaults.vendor and rejects when still
  // unresolved or stale.
  const vendor = optionalString(body.vendor);
  const profile = optionalString(body.profile);
  // Session id is optional on the wire (#162): daemon binds via ancestry /
  // single-live fallback, and gates with session_required only when evals on.
  const orchSession =
    typeof orchestratorSessionId === "string" && orchestratorSessionId !== ""
      ? orchestratorSessionId
      : null;
  if (typeof cwd !== "string" || cwd === "") {
    sendJson(res, 400, { error: "cwd is required" });
    return;
  }
  const ancestryChain = parseAncestryChain(body.ancestry_chain);
  if (ancestryChain === undefined) {
    sendJson(res, 400, {
      error: "ancestry_chain must be an array of { machine_id, pid, start_time }",
    });
    return;
  }
  const workspaceRoot = optionalString(body.workspace_root);
  // Posture: null means "not specified" so the engine can apply profile then
  // ADR-0006 defaults. An unknown mode is a client mistake (→ 400 → exit 2).
  let sandbox: SandboxMode | null = null;
  if (body.sandbox !== undefined && body.sandbox !== null) {
    if (typeof body.sandbox !== "string" || !isSandboxMode(body.sandbox)) {
      sendJson(res, 400, { error: `unknown sandbox mode: ${String(body.sandbox)}` });
      return;
    }
    sandbox = body.sandbox;
  }
  let network: boolean | null = null;
  if (body.network !== undefined && body.network !== null) {
    if (typeof body.network !== "boolean") {
      sendJson(res, 400, { error: "network must be a boolean" });
      return;
    }
    network = body.network;
  }
  const timeoutRaw = body.answer_timeout_ms;
  let answerTimeoutMs: number | null = null;
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    if (typeof timeoutRaw !== "number" || !Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
      sendJson(res, 400, { error: "answer_timeout_ms must be a positive number" });
      return;
    }
    answerTimeoutMs = Math.round(timeoutRaw);
  }
  // `--context` files arrive by value (name + contents); the CLI already
  // rejected an unreadable file. Guard the wire shape — a malformed entry is a
  // client mistake (→ 400 → exit 2), not a 500.
  const contexts: ContextFile[] = [];
  const contextsRaw = body.contexts;
  if (contextsRaw !== undefined && contextsRaw !== null) {
    if (!Array.isArray(contextsRaw)) {
      sendJson(res, 400, { error: "contexts must be an array" });
      return;
    }
    for (const entry of contextsRaw) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.contents !== "string") {
        sendJson(res, 400, { error: "each context must be { name, contents }" });
        return;
      }
      contexts.push({ name: entry.name, contents: entry.contents });
    }
  }
  // Classification (#118 / #161): optional size/difficulty strings; project-set
  // validation is engine-side (hot-read of classification.json at the repo).
  let size: string | null = null;
  if (body.size !== undefined && body.size !== null) {
    if (typeof body.size !== "string" || body.size === "") {
      sendJson(res, 400, { error: "size must be a non-empty string" });
      return;
    }
    size = body.size;
  }
  let difficulty: string | null = null;
  if (body.difficulty !== undefined && body.difficulty !== null) {
    if (typeof body.difficulty !== "string" || body.difficulty === "") {
      sendJson(res, 400, { error: "difficulty must be a non-empty string" });
      return;
    }
    difficulty = body.difficulty;
  }
  // Work-domain type (#151): optional string; null/absent → engine stores
  // `other`. Project-set validation is daemon-side (hot-read at repo).
  let type: string | null = null;
  if (body.type !== undefined && body.type !== null) {
    if (typeof body.type !== "string" || body.type === "") {
      sendJson(res, 400, { error: "type must be a non-empty string" });
      return;
    }
    type = body.type;
  }
  const dryRun = body.dry_run === true;
  // Client-resolved identity for remote-daemon mirror path (#318). Optional;
  // when cwd exists on this host the engine re-resolves from the checkout.
  const repoKey = optionalString(body.repo_key);
  const repoFetchUrl = optionalString(body.repo_fetch_url);
  const baseSha = optionalString(body.base_sha);
  try {
    const task = engine.delegate({
      prompt,
      vendor,
      profile,
      cwd,
      orchestratorSessionId: orchSession,
      ancestryChain,
      workspaceRoot,
      model: optionalString(body.model),
      effort: optionalString(body.effort),
      name: optionalString(body.name),
      // Absent/non-boolean defaults to bypass (old `--cwd`-only behaviour).
      useWorktree: body.use_worktree === true,
      baseRef: optionalString(body.base_ref),
      sandbox,
      network,
      answerTimeoutMs,
      // Forwarded as-is: a `null`/absent value uses the default schema; anything
      // else (object, boolean, or a malformed non-schema) is validated by the
      // engine, which rejects non-schemas before the task is created.
      reportSchema: body.report_schema ?? null,
      contexts,
      runner: optionalString(body.runner),
      size,
      difficulty,
      type,
      dryRun,
      repoKey,
      repoFetchUrl,
      baseSha,
    });
    // Multi-live fallback warning (#280) — CLI prints to stderr, not stdout JSON.
    const bindingWarning = engine.takeSessionBindingWarning();
    sendJson(res, 201, {
      task_id: task.id,
      name: task.name,
      state: task.state,
      seq: task.seq,
      // Bound session is observable from the ack alone (#256).
      orchestrator_session_id: task.orchestrator_session_id,
      ...(bindingWarning !== null ? { warning: bindingWarning } : {}),
    });
  } catch (err) {
    if (err instanceof DelegateError) {
      sendJson(res, 400, {
        error: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
      });
      return;
    }
    throw err;
  }
}

/**
 * Extract `Authorization: Bearer <token>`, or null when absent/malformed.
 */
export function extractBearerToken(authorization: string | undefined): string | null {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

/**
 * Constant-time token comparison via fixed-length digests (#323 F7).
 * Never short-circuits on length of the presented secret.
 */
export function tokensEqual(presented: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(presented, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * True when the peer address is loopback (IPv4 127.0.0.0/8 or IPv6 ::1,
 * including IPv4-mapped forms Node reports). Auth enforcement keys off the
 * peer address, not bind config alone (#323 / ADR-0030).
 *
 * `undefined` / empty peer fails closed (not loopback) so a missing
 * remoteAddress never bypasses the gate.
 */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (addr === undefined || addr === null || addr === "") return false;
  if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") {
    return true;
  }
  // 127.0.0.0/8 and IPv4-mapped 127.x.x.x
  if (addr.startsWith("127.")) return true;
  if (addr.startsWith("::ffff:127.")) return true;
  return false;
}

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
}

/**
 * Match a presented bearer to a configured runner name. Returns the runner
 * name, or null when auth fails. When `expectedName` is set, the token must
 * belong to that exact runner.
 */
export function matchRunnerToken(
  token: string,
  config: ParleyConfig,
  expectedName?: string,
): string | null {
  const runners = config.runners ?? {};
  if (expectedName !== undefined) {
    const entry = runners[expectedName];
    if (entry === undefined || !tokensEqual(token, entry.token)) return null;
    return expectedName;
  }
  for (const [name, entry] of Object.entries(runners)) {
    if (tokensEqual(token, entry.token)) return name;
  }
  return null;
}

/**
 * Match a presented bearer to a configured client name (`clients.<name>.token`).
 */
export function matchClientToken(token: string, config: ParleyConfig): string | null {
  const clients = config.clients ?? {};
  for (const [name, entry] of Object.entries(clients)) {
    if (tokensEqual(token, entry.token)) return name;
  }
  return null;
}

/**
 * Extract bearer from the request and match a runner. Thin wrapper for
 * handlers that still take the IncomingMessage.
 */
function authenticateRunner(
  req: http.IncomingMessage,
  config: ParleyConfig,
  expectedName?: string,
): string | null {
  const token = extractBearerToken(
    typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
  );
  if (token === null) return null;
  return matchRunnerToken(token, config, expectedName);
}

/** Re-read config for runner/client auth (hot, same posture as profiles). */
function readAuthConfig(paths: HomePaths): ParleyConfig {
  try {
    return readConfig(paths.config);
  } catch {
    return {};
  }
}

/**
 * Default listen address: loopback-only (#323). Non-loopback bind is opt-in
 * via `daemon.bind` (e.g. `0.0.0.0`). Cold — read once at server start.
 */
export const DEFAULT_DAEMON_BIND = "127.0.0.1";

/**
 * Resolve the daemon listen address from config. Missing/corrupt/empty →
 * {@link DEFAULT_DAEMON_BIND}.
 */
export function resolveDaemonBind(config: ParleyConfig): string {
  const bind = config.daemon?.bind;
  if (typeof bind === "string" && bind !== "") return bind;
  return DEFAULT_DAEMON_BIND;
}

/** Route class for the non-loopback auth gate (#323). */
export type AuthRouteClass = "runner" | "child" | "client" | "config-admin";

/**
 * Classify a request for the auth gate. Config write verbs are a separate
 * class so they can be rejected off-loopback regardless of any valid token.
 *
 * `/models` read and edit routes are intentionally **client** (not
 * config-admin): allowlist edits are the dedicated #322 remote surface,
 * scoped to `vendors.*.models` only so they cannot smuggle arbitrary config
 * keys. Do not reclassify them as config-admin.
 */
export function classifyAuthRoute(method: string, pathname: string): AuthRouteClass {
  const segments = pathname.split("/").filter((s) => s !== "");
  if (segments[0] === "runner") return "runner";
  // Child channel + grok xAI usage proxy (#327): same lease-binding semantics.
  // Task id for `/xai/*` is path-embedded; gateRequest resolves it from the
  // path rather than the correlation header used by `/child/*` and `/mcp`.
  if (segments[0] === "child" || pathname === "/mcp" || segments[0] === "xai") {
    return "child";
  }
  if (
    (method === "PUT" && pathname === "/config") ||
    (method === "POST" &&
      (pathname === "/config/set" || pathname === "/config/unset")) ||
    // DELETE /runners/:name mutates runners.* config — loopback-only (#320).
    (method === "DELETE" &&
      segments[0] === "runners" &&
      segments.length === 2) ||
    // POST /clones/prune removes disk mirrors — loopback / config-admin (#318).
    (method === "POST" && pathname === "/clones/prune")
  ) {
    return "config-admin";
  }
  return "client";
}

// Re-export for tests / external classification of allowlist key scope (#322).
export { isModelsAllowlistKey } from "./models-http.js";

/** Pure-function inputs for the auth gate (unit-testable without sockets). */
export interface AuthGateInput {
  remoteAddress: string | undefined | null;
  method: string;
  pathname: string;
  /**
   * `Authorization` header. For `/child/*` + `/mcp` + runner/client routes
   * this is the gate credential. For `/xai/*` it is the child's xAI API key
   * and must not be treated as a runner token (#327).
   */
  authorization: string | undefined;
  /**
   * `Proxy-Authorization` header. For `/xai/*` off-loopback this is the runner
   * credential the hub proxy attaches; the gate reads it for lease binding
   * and the xAI reverse proxy strips it as hop-by-hop before api.x.ai (#327).
   */
  proxyAuthorization?: string | undefined;
  config: ParleyConfig;
  /**
   * For child routes off-loopback: the task's `runner` field (submit-time
   * affinity; not a live lease by itself), or `null` when the task exists but
   * has no runner affinity. Omit when the task id is missing or the task is
   * unknown. Task id comes from the correlation header for `/child/*` +
   * `/mcp`, or from the path segment for `/xai/<taskId>/…` (#327).
   */
  taskRunner?: string | null;
  /**
   * For child routes: whether a task was resolved (from the correlation
   * header, or from the `/xai/<taskId>` path segment).
   */
  taskFound?: boolean;
  /**
   * For child routes off-loopback: the task's current lifecycle state. Used
   * with the affinity name match so only an *actively executing* task grants
   * child-channel access (pending/queued/terminal are rejected).
   */
  taskState?: string | null;
}

export interface AuthGateAllow {
  ok: true;
  loopback: boolean;
  routeClass: AuthRouteClass;
  /** Authenticated runner name when a runner token was presented and matched. */
  runnerName: string | null;
  /** Authenticated client name when a client token was presented and matched. */
  clientName: string | null;
}

export interface AuthGateDeny {
  ok: false;
  status: 401 | 403;
  error: string;
  routeClass: AuthRouteClass;
  /** Peer address string for diag (never a token). */
  peer: string;
}

/**
 * Pure auth gate (#323 / ADR-0030). Deterministic and socket-free so tests
 * can fake `remoteAddress` without a live dial.
 *
 * Loopback peers: always allow (runner routes still self-auth in handlers).
 * Non-loopback:
 * - `config-admin` → 403 always (host-shell / loopback only)
 * - `runner` → valid runner token
 * - `child` → valid runner token whose name matches the task's affinity
 *   **and** the task is actively executing (not pending/queued/terminal)
 * - `client` → valid client token (never a runner token)
 */
export function authorizeRequest(input: AuthGateInput): AuthGateAllow | AuthGateDeny {
  const routeClass = classifyAuthRoute(input.method, input.pathname);
  const peer =
    input.remoteAddress === undefined || input.remoteAddress === null || input.remoteAddress === ""
      ? "(unknown)"
      : input.remoteAddress;
  const loopback = isLoopbackAddress(input.remoteAddress);

  if (loopback) {
    // Loopback: no gate. Handlers for /runner/* still require runner tokens.
    return {
      ok: true,
      loopback: true,
      routeClass,
      runnerName: null,
      clientName: null,
    };
  }

  // F1: config administration is a loopback/host-shell operation only.
  if (routeClass === "config-admin") {
    return {
      ok: false,
      status: 403,
      error: "config administration is only allowed from loopback",
      routeClass,
      peer,
    };
  }

  // Credential source: `/xai/*` uses Proxy-Authorization for the runner token
  // so Authorization can remain the child's xAI API key (#327). All other
  // routes still gate on Authorization alone.
  const segments = input.pathname.split("/").filter((s) => s !== "");
  const isXaiRoute = routeClass === "child" && segments[0] === "xai";
  const credentialHeader = isXaiRoute
    ? input.proxyAuthorization
    : input.authorization;
  const token = extractBearerToken(credentialHeader);
  if (token === null) {
    return {
      ok: false,
      status: 401,
      error: isXaiRoute
        ? "unauthorized: child channel requires a runner token"
        : "unauthorized",
      routeClass,
      peer,
    };
  }

  if (routeClass === "runner") {
    const runnerName = matchRunnerToken(token, input.config);
    if (runnerName === null) {
      return {
        ok: false,
        status: 401,
        error: "unauthorized",
        routeClass,
        peer,
      };
    }
    return {
      ok: true,
      loopback: false,
      routeClass,
      runnerName,
      clientName: null,
    };
  }

  if (routeClass === "child") {
    // F2: child channel is runner-only and bound to the *active* lease holder
    // (affinity name match + non-pending/non-queued/non-terminal state).
    // Client tokens are never admitted here. `task.runner` alone is submit-time
    // affinity and is not sufficient — a pending or terminal task must not
    // grant child-channel access to the affine runner.
    //
    // For `/xai/*`, `token` was taken from Proxy-Authorization (see above);
    // Authorization is intentionally not consulted for the runner match.
    const runnerName = matchRunnerToken(token, input.config);
    if (runnerName === null) {
      // Presenter was not a runner (missing/wrong/client token).
      return {
        ok: false,
        status: 401,
        error: "unauthorized: child channel requires a runner token",
        routeClass,
        peer,
      };
    }
    if (input.taskFound !== true) {
      return {
        ok: false,
        status: 403,
        error:
          "forbidden: child channel requires a task leased to this runner " +
          `(missing or unknown ${TASK_HEADER})`,
        routeClass,
        peer,
      };
    }
    if (input.taskRunner === null || input.taskRunner === undefined) {
      return {
        ok: false,
        status: 403,
        error: "forbidden: task is not leased to a runner",
        routeClass,
        peer,
      };
    }
    if (input.taskRunner !== runnerName) {
      return {
        ok: false,
        status: 403,
        error: `forbidden: runner "${runnerName}" does not hold the lease for this task`,
        routeClass,
        peer,
      };
    }
    // State guard: affinity is set at submit time for the task's whole life.
    // Only an actively executing (claimed) task may use the child channel.
    // Mirrors engine runner-surface checks (affinity + not terminal) and also
    // rejects pre-claim states where no lease exists yet.
    const taskState = input.taskState;
    if (
      taskState === "pending" ||
      taskState === "queued" ||
      (typeof taskState === "string" && isTerminalState(taskState))
    ) {
      return {
        ok: false,
        status: 403,
        error:
          taskState === "pending" || taskState === "queued"
            ? `forbidden: task is not actively leased (state is ${taskState})`
            : `forbidden: task is already ${taskState}`,
        routeClass,
        peer,
      };
    }
    return {
      ok: true,
      loopback: false,
      routeClass,
      runnerName,
      clientName: null,
    };
  }

  // Client-facing routes: client tokens only (runner tokens rejected).
  const clientName = matchClientToken(token, input.config);
  if (clientName === null) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      routeClass,
      peer,
    };
  }
  return {
    ok: true,
    loopback: false,
    routeClass,
    runnerName: null,
    clientName,
  };
}

/**
 * Apply {@link authorizeRequest} to a live HTTP request: read config once,
 * resolve child task lease when needed, write 401/403 + diag on deny.
 * Returns the allow result (with config) or null when the response was written.
 */
function gateRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  paths: HomePaths,
  engine: TaskEngine,
  method: string,
  pathname: string,
): (AuthGateAllow & { config: ParleyConfig }) | null {
  const config = readAuthConfig(paths);
  const routeClass = classifyAuthRoute(method, pathname);

  let taskRunner: string | null | undefined;
  let taskFound: boolean | undefined;
  let taskState: string | null | undefined;
  if (routeClass === "child" && !isLoopbackRequest(req)) {
    // `/xai/<taskId>/v1/...` embeds the task id in the path; `/child/*` and
    // `/mcp` use the correlation header. Unknown or malformed ids deny.
    let taskId: string | undefined;
    const segments = pathname.split("/").filter((s) => s !== "");
    if (segments[0] === "xai") {
      const parsed = parseXaiProxyPath(pathname);
      taskId = parsed?.taskId;
    } else {
      const header = req.headers[TASK_HEADER];
      const fromHeader = Array.isArray(header) ? header[0] : header;
      taskId = typeof fromHeader === "string" ? fromHeader : undefined;
    }
    if (typeof taskId === "string" && taskId !== "") {
      const task = engine.get(taskId);
      if (task !== undefined) {
        taskFound = true;
        taskRunner = task.runner;
        taskState = task.state;
      } else {
        taskFound = false;
        taskRunner = null;
        taskState = null;
      }
    } else {
      taskFound = false;
      taskRunner = null;
      taskState = null;
    }
  }

  const decision = authorizeRequest({
    remoteAddress: req.socket.remoteAddress,
    method,
    pathname,
    authorization:
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : undefined,
    // #327: hub proxy puts the runner credential here for `/xai/*` so the
    // child's xAI Authorization can pass through to api.x.ai untouched.
    proxyAuthorization:
      typeof req.headers["proxy-authorization"] === "string"
        ? req.headers["proxy-authorization"]
        : undefined,
    config,
    taskRunner,
    taskFound,
    taskState,
  });

  if (!decision.ok) {
    // F8: log failed off-loopback auth without ever writing the presented token.
    appendDaemonDiag(
      paths,
      `auth: denied ${decision.status} peer=${decision.peer} class=${decision.routeClass} path=${pathname}`,
    );
    sendJson(res, decision.status, { error: decision.error });
    return null;
  }

  return { ...decision, config };
}

/**
 * Redact secret token fields from a config object for non-loopback GET /config
 * responses (#323 F1). Loopback responses stay unredacted.
 */
export function redactConfigSecrets(config: ParleyConfig): ParleyConfig {
  const out: ParleyConfig = { ...config };
  if (config.clients !== undefined) {
    const clients: NonNullable<ParleyConfig["clients"]> = {};
    for (const [name, entry] of Object.entries(config.clients)) {
      clients[name] = { ...entry, token: "<redacted>" };
    }
    out.clients = clients;
  }
  if (config.runners !== undefined) {
    const runners: NonNullable<ParleyConfig["runners"]> = {};
    for (const [name, entry] of Object.entries(config.runners)) {
      runners[name] = { ...entry, token: "<redacted>" };
    }
    out.runners = runners;
  }
  return out;
}

/**
 * Redact a single config key lookup result when the path points at a secret.
 */
export function redactConfigKeyValue(key: string, value: unknown): unknown {
  if (/^(clients|runners)\.[^.]+\.token$/.test(key)) return "<redacted>";
  if (
    /^(clients|runners)\.[^.]+$/.test(key) &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "token" in value
  ) {
    return { ...(value as Record<string, unknown>), token: "<redacted>" };
  }
  if (
    (key === "clients" || key === "runners") &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const map = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(map)) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        "token" in entry
      ) {
        out[name] = { ...(entry as Record<string, unknown>), token: "<redacted>" };
      } else {
        out[name] = entry;
      }
    }
    return out;
  }
  return value;
}

/**
 * Load the daemon's current config for the admin surface (#156). A missing file
 * is `{}` (same as `readConfig`); a corrupt/invalid file is a 500 so the
 * operator knows the on-disk state needs repair before further edits.
 */
function loadAdminConfig(paths: HomePaths): ParleyConfig {
  return readConfig(paths.config);
}

/** Persist a fully-validated config; hot readers re-open the file on next use. */
function persistAdminConfig(paths: HomePaths, config: ParleyConfig): void {
  writeConfig(paths.config, config);
}

/**
 * `GET /config` — full effective config (show/pull). Optional `?key=` returns a
 * single dotted path (`{ key, value }`).
 */
/**
 * Config view for show/pull (#156 / #178): admin `parley.json` plus the global
 * project-settings layer (`config.json` overlay) so CLI merge sees the same
 * globals the daemon hot-readers use.
 */
function loadConfigForPull(paths: HomePaths): ParleyConfig {
  const admin = loadAdminConfig(paths);
  const globalProject = readGlobalConfigLayer(paths);
  const out: ParleyConfig = { ...admin };
  if (globalProject.eval !== undefined) out.eval = globalProject.eval;
  if (globalProject.resume !== undefined) out.resume = globalProject.resume;
  if (globalProject.retry !== undefined) out.retry = globalProject.retry;
  if (globalProject.taskTypes !== undefined) {
    out.taskTypes = globalProject.taskTypes as ParleyConfig["taskTypes"];
  }
  return out;
}

/**
 * `GET /config` — full effective config (show/pull). Optional `?key=` returns a
 * single dotted path (`{ key, value }`). Off-loopback responses redact
 * `clients.*.token` and `runners.*.token` (#323 F1); loopback is unredacted.
 */
function handleConfigGet(
  paths: HomePaths,
  res: http.ServerResponse,
  key: string | null,
  loopback: boolean,
): void {
  let config: ParleyConfig;
  try {
    // Pull merges global project-settings so remote/local CLI share one path.
    config = loadConfigForPull(paths);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (key === null || key === "") {
    sendJson(res, 200, {
      config: loopback ? config : redactConfigSecrets(config),
    });
    return;
  }
  try {
    const hit = getConfigPath(config, key);
    if (!hit.found) {
      sendJson(res, 404, { error: `no such config key: ${key}` });
      return;
    }
    const value = loopback ? hit.value : redactConfigKeyValue(key, hit.value);
    sendJson(res, 200, { key, value });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `PUT /config` — wholesale replace (push). Validates the entire body first;
 * on failure nothing is written. Unknown keys are preserved and listed in
 * `warnings` so the CLI can surface them without rejecting the push.
 *
 * Loopback-only (#323 F1): client tokens are not admin credentials.
 */
function handleConfigPut(
  req: http.IncomingMessage,
  paths: HomePaths,
  res: http.ServerResponse,
  body: unknown,
): void {
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { error: "config administration is only allowed from loopback" });
    return;
  }
  let config: ParleyConfig;
  try {
    config = validateConfig(paths.config, body);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const warnings = collectUnknownConfigKeys(config as Record<string, unknown>).map(
    (k) => `unknown config key preserved: ${k}`,
  );
  try {
    persistAdminConfig(paths, config);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  sendJson(res, 200, { config, warnings });
}

/**
 * `POST /config/set` — set a dotted key. Validates the resulting whole config
 * before write so an invalid value is rejected wholesale with the field named.
 *
 * Loopback-only (#323 F1): client tokens are not admin credentials.
 */
function handleConfigSet(
  req: http.IncomingMessage,
  paths: HomePaths,
  res: http.ServerResponse,
  body: unknown,
): void {
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { error: "config administration is only allowed from loopback" });
    return;
  }
  if (!isRecord(body) || typeof body.key !== "string") {
    sendJson(res, 400, { error: "key is required" });
    return;
  }
  if (!("value" in body)) {
    sendJson(res, 400, { error: "value is required" });
    return;
  }
  const key = body.key;
  let current: ParleyConfig;
  try {
    current = loadAdminConfig(paths);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let next: Record<string, unknown>;
  try {
    next = setConfigPath(current as Record<string, unknown>, key, body.value);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let validated: ParleyConfig;
  try {
    validated = validateConfig(paths.config, next);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    persistAdminConfig(paths, validated);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  sendJson(res, 200, { config: validated, key, value: body.value });
}

/**
 * `POST /config/unset` — remove a dotted key. Absent keys are 404; the write
 * is skipped until the key is confirmed present.
 *
 * Loopback-only (#323 F1): client tokens are not admin credentials.
 */
function handleConfigUnset(
  req: http.IncomingMessage,
  paths: HomePaths,
  res: http.ServerResponse,
  body: unknown,
): void {
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { error: "config administration is only allowed from loopback" });
    return;
  }
  if (!isRecord(body) || typeof body.key !== "string") {
    sendJson(res, 400, { error: "key is required" });
    return;
  }
  const key = body.key;
  let current: ParleyConfig;
  try {
    current = loadAdminConfig(paths);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let next: Record<string, unknown>;
  try {
    next = unsetConfigPath(current as Record<string, unknown>, key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("no such config key:")) {
      sendJson(res, 404, { error: message });
      return;
    }
    sendJson(res, 400, { error: message });
    return;
  }
  let validated: ParleyConfig;
  try {
    // Unset can leave a required nested field missing (e.g. profiles.x.vendor);
    // reject wholesale so the on-disk file never goes invalid.
    validated = validateConfig(paths.config, next);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    persistAdminConfig(paths, validated);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  sendJson(res, 200, { config: validated, key });
}

/**
 * `GET /models` — daemon-wide vendor model allowlist (policy, ADR-0014).
 * Hot: re-reads parley.json per call so hand-edits on the daemon host apply
 * without restart. Optional `?vendor=<id>` filters to one vendor.
 *
 * CLIENT-class route (#322 / #323): readable off-loopback with a client token.
 */
function handleModelsGet(
  paths: HomePaths,
  res: http.ServerResponse,
  vendor: string | null,
): void {
  let config: ParleyConfig;
  try {
    config = loadAdminConfig(paths);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const allowlist = extractAllowlist(
    config,
    vendor === null || vendor === "" ? undefined : vendor,
  );
  sendJson(res, 200, { allowlist });
}

/**
 * `POST /models/set` — set a dotted key under `vendors.<id>.models` only.
 *
 * CLIENT-class (#322): remote clients with a valid token may edit the
 * allowlist. Keys outside the models subtree are rejected (400) so this
 * cannot smuggle config-admin writes (bind, tokens, bin/args/env, …).
 */
function handleModelsSet(
  paths: HomePaths,
  res: http.ServerResponse,
  body: unknown,
): void {
  if (!isRecord(body) || typeof body.key !== "string") {
    sendJson(res, 400, { error: "key is required" });
    return;
  }
  if (!("value" in body)) {
    sendJson(res, 400, { error: "value is required" });
    return;
  }
  const key = body.key;
  // Subtree scope + dotted model ids: parseModelsAllowlistKey (not setConfigPath).
  const parsed = parseModelsAllowlistKey(key);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  let current: ParleyConfig;
  try {
    current = loadAdminConfig(paths);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let next: Record<string, unknown>;
  try {
    next = setModelsAllowlistPath(current as Record<string, unknown>, key, body.value);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let validated: ParleyConfig;
  try {
    validated = validateConfig(paths.config, next);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    persistAdminConfig(paths, validated);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  sendJson(res, 200, {
    key,
    value: body.value,
    allowlist: extractAllowlist(validated),
  });
}

/**
 * `POST /models/unset` — remove a dotted key under `vendors.<id>.models` only.
 * Same CLIENT-class + subtree scoping as {@link handleModelsSet}.
 */
function handleModelsUnset(
  paths: HomePaths,
  res: http.ServerResponse,
  body: unknown,
): void {
  if (!isRecord(body) || typeof body.key !== "string") {
    sendJson(res, 400, { error: "key is required" });
    return;
  }
  const key = body.key;
  const parsed = parseModelsAllowlistKey(key);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  let current: ParleyConfig;
  try {
    current = loadAdminConfig(paths);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let next: Record<string, unknown>;
  try {
    next = unsetModelsAllowlistPath(current as Record<string, unknown>, key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("no such config key:")) {
      sendJson(res, 404, { error: message });
      return;
    }
    sendJson(res, 400, { error: message });
    return;
  }
  let validated: ParleyConfig;
  try {
    validated = validateConfig(paths.config, next);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    persistAdminConfig(paths, validated);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  sendJson(res, 200, { key, allowlist: extractAllowlist(validated) });
}

/**
 * `POST /models/refresh` — re-fingerprint this daemon host now and return the
 * fleet aggregate: daemon catalog (with discovery warnings, #299) plus each
 * runner's last-advertised catalog flagged with advertisement age. No runner
 * round-trip; probes never run on a CLI host (#322 / #307).
 *
 * Optional body `{ vendor?: string }` limits the probe/view to one vendor.
 * CLIENT-class route.
 */
async function handleModelsRefresh(
  paths: HomePaths,
  res: http.ServerResponse,
  db: DatabaseHandle,
  adapters: Map<string, VendorAdapter>,
  body: unknown,
): Promise<void> {
  let vendor: string | undefined;
  if (body !== undefined && body !== null) {
    if (!isRecord(body)) {
      sendJson(res, 400, { error: "body must be an object" });
      return;
    }
    if (body.vendor !== undefined) {
      if (typeof body.vendor !== "string" || body.vendor === "") {
        sendJson(res, 400, { error: "vendor must be a non-empty string when set" });
        return;
      }
      vendor = body.vendor;
    }
  }
  try {
    const result = await refreshFleetCatalog({
      paths,
      adapters,
      runners: listRunners(db),
      vendor,
    });
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `GET /info?project=<abs>` — effective configuration as prose + the structured
 * config it was rendered from (#163 / #321). Project root is required so remote
 * daemons resolve the caller's workspace (never the daemon's cwd). Executor
 * availability is daemon-sourced: local host fingerprint + registered runners
 * (same status derivation as GET /runners).
 */
function handleInfo(
  res: http.ServerResponse,
  params: URLSearchParams,
  paths: HomePaths,
  adapters: Map<string, VendorAdapter>,
  db: DatabaseHandle,
  config?: ParleyConfig,
): void {
  const project = params.get("project");
  if (project === null || project.trim() === "") {
    sendJson(res, 400, { error: "project is required (absolute path of the workspace root)" });
    return;
  }
  try {
    const runners = listRunners(db).map((row) =>
      projectRunnerListEntry(row, config),
    );
    sendJson(
      res,
      200,
      buildInfo({
        projectDir: project,
        paths,
        adapters,
        env: process.env,
        runners: runners.map((r) => ({
          name: r.name,
          status: r.status,
          vendors: r.vendors,
        })),
      }),
    );
  } catch (err) {
    // Bad project config (classification/taskTypes/rubrics) is a caller mistake.
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `GET /prompt?project=<abs>&vendor=<id>&profile=<name>&orchestrator=1` —
 * render the composed prompt a child (or orchestrator) would receive from
 * `project` (#159). Child mode needs vendor or profile; orchestrator mode
 * compounds home→project orchestrator PROMPT.md only.
 */
function handlePrompt(
  engine: TaskEngine,
  res: http.ServerResponse,
  params: URLSearchParams,
): void {
  const project = params.get("project");
  if (project === null || project.trim() === "") {
    sendJson(res, 400, { error: "project is required (absolute path of the workspace root)" });
    return;
  }
  // Presence of `orchestrator` (any value other than explicit false/0) selects
  // orchestrator-only composition — no child preamble.
  const orchRaw = params.get("orchestrator");
  const orchestrator =
    params.has("orchestrator") && orchRaw !== "0" && orchRaw !== "false";

  const vendor = params.get("vendor");
  const profile = params.get("profile");
  try {
    const prompt = engine.previewPrompt({
      projectDir: project,
      vendor: vendor !== null && vendor !== "" ? vendor : null,
      profile: profile !== null && profile !== "" ? profile : null,
      orchestrator,
    });
    sendJson(res, 200, { prompt });
  } catch (err) {
    if (err instanceof DelegateError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `GET /metrics?session=<id|all>&group_by=<…>&…filters`
 * — per-group task/eval/token/duration aggregates (#118 / #164). Defaults:
 * session=all, group_by=vendor. Filters mirror list filters (type, provenance,
 * rubric, first_attempt, below_baseline, …).
 */
function handleMetrics(
  engine: TaskEngine,
  res: http.ServerResponse,
  params: URLSearchParams,
): void {
  const session = params.get("session") ?? "all";
  if (session === "") {
    sendJson(res, 400, { error: "session must be a non-empty id or 'all'" });
    return;
  }
  const groupByRaw = params.get("group_by") ?? "vendor";
  if (!isMetricsGroupBy(groupByRaw)) {
    sendJson(res, 400, {
      error: `invalid group_by: ${groupByRaw} (expected ${METRICS_GROUP_BY.join("|")})`,
    });
    return;
  }
  // Reject invalid rubric_version early (parse silently drops non-integers).
  const rvRaw = params.get("rubric_version");
  if (rvRaw !== null && rvRaw !== "") {
    const n = Number(rvRaw);
    if (!Number.isInteger(n) || n < 1) {
      sendJson(res, 400, { error: "rubric_version must be a positive integer" });
      return;
    }
  }
  const filters = parseTaskMetricsFilters(params);
  // Default session=all when the query omits it; parse leaves it undefined.
  if (filters.session === undefined) filters.session = session;
  sendJson(res, 200, aggregateMetrics(engine.list(), { ...filters, groupBy: groupByRaw }));
}

/**
 * `GET /run-metrics?session=<id|all>&group_by=<…>&…filters`
 * — per-group run aggregates (#243 / ADR-0020). Separate population from
 * {@link handleMetrics}; never joined. Defaults: session=all, group_by=workflow.
 */
function handleRunMetrics(
  engine: TaskEngine,
  res: http.ServerResponse,
  params: URLSearchParams,
): void {
  const session = params.get("session") ?? "all";
  if (session === "") {
    sendJson(res, 400, { error: "session must be a non-empty id or 'all'" });
    return;
  }
  const groupByRaw = params.get("group_by") ?? "workflow";
  if (!isRunMetricsGroupBy(groupByRaw)) {
    sendJson(res, 400, {
      error: `invalid group_by: ${groupByRaw} (expected ${RUN_METRICS_GROUP_BY.join("|")})`,
    });
    return;
  }
  for (const key of ["rubric_version", "workflow_version"] as const) {
    const raw = params.get(key);
    if (raw !== null && raw !== "") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        sendJson(res, 400, { error: `${key} must be a positive integer` });
        return;
      }
    }
  }
  const filters = parseRunMetricsFilters(params);
  if (filters.session === undefined) filters.session = session;
  const tasksByRun = indexTasksByRunId(engine.list());
  sendJson(
    res,
    200,
    aggregateRunMetrics(engine.listAllRuns(), tasksByRun, {
      ...filters,
      groupBy: groupByRaw,
    }),
  );
}

/**
 * `POST /runs/:ref/eval` — structured whole-run rubric evaluation (#243).
 * Body: `{ answers, feedback, type?, orchestrator_session_id?, ancestry_chain?,
 * workspace_root? }`. Terminal runs only.
 */
function handleRunEval(
  engine: TaskEngine,
  res: http.ServerResponse,
  ref: string,
  body: unknown,
): void {
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  const answers = body.answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    sendJson(res, 400, {
      error: "answers is required (object mapping criterion ids to booleans)",
    });
    return;
  }
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof value !== "boolean") {
      sendJson(res, 400, {
        error: `answers.${id} must be a boolean, got: ${typeof value}`,
      });
      return;
    }
  }
  const feedback = body.feedback;
  if (typeof feedback !== "string" || feedback === "") {
    sendJson(res, 400, { error: "feedback is required" });
    return;
  }
  const typeOverride =
    typeof body.type === "string" && body.type !== "" ? body.type : null;
  const ancestryChain = parseAncestryChain(body.ancestry_chain);
  if (ancestryChain === undefined) {
    sendJson(res, 400, {
      error: "ancestry_chain must be an array of { machine_id, pid, start_time }",
    });
    return;
  }
  try {
    const row = engine.evalRun(ref, answers as Record<string, boolean>, feedback, {
      type: typeOverride,
      explicitSessionId: optionalString(body.orchestrator_session_id),
      ancestryChain,
      workspaceRoot: optionalString(body.workspace_root),
    });
    const bindingWarning = engine.takeSessionBindingWarning();
    sendJson(res, 200, {
      run_id: row.id,
      state: row.state,
      workflow: row.workflow,
      version: row.version,
      type: row.type,
      eval_score: row.eval_score,
      eval_baseline: row.eval_baseline,
      eval_rubric: row.eval_rubric,
      eval_rubric_version: row.eval_rubric_version,
      eval_session_id: row.eval_session_id,
      eval_harness: row.eval_harness,
      eval_model: row.eval_model,
      eval_effort: row.eval_effort,
      ...(bindingWarning !== null ? { warning: bindingWarning } : {}),
    });
  } catch (err) {
    if (err instanceof DelegateError) {
      const status = err.message.startsWith("no such run:") ? 404 : 400;
      sendJson(res, status, {
        error: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
      });
      return;
    }
    throw err;
  }
}

/**
 * `POST /clean` — remove worktrees. `{ task }` cleans one terminal task
 * (refusing a running one); `{ all_terminal: true }` sweeps every terminal task.
 * Branches are always kept — parley never merges.
 */
function handleClean(engine: TaskEngine, res: http.ServerResponse, body: unknown): void {
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  try {
    if (body.all_terminal === true) {
      sendJson(res, 200, engine.cleanAllTerminal());
      return;
    }
    const ref = body.task;
    if (typeof ref !== "string" || ref === "") {
      sendJson(res, 400, { error: "clean requires a task ref or all_terminal: true" });
      return;
    }
    sendJson(res, 200, engine.clean(ref));
  } catch (err) {
    if (err instanceof DelegateError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
}

/**
 * `POST /gc` — retention sweep (#153). Optional `{ dry_run: true }` lists
 * expired tasks without deleting. Always returns the sweep summary.
 */
function handleGc(engine: TaskEngine, res: http.ServerResponse, body: unknown): void {
  // Empty / missing body is fine — defaults to a real sweep.
  if (body !== undefined && body !== null && !isRecord(body)) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  const dryRun = isRecord(body) && body.dry_run === true;
  sendJson(res, 200, engine.gc({ dryRun }));
}

/**
 * `GET /tasks/:ref/logs?since=<offset>` — a tail chunk of the task's raw vendor
 * log (spec §"New: per-task logs"). Offset-cursor contract: `{ chunk, next,
 * eof }`, where `next` is the byte offset the follow-up call passes back as
 * `since`. `eof` is true only once the task is in one of `db.js`'s
 * terminal states (`completed`/`failed`/`cancelled`) *and* its child has
 * actually exited — `stalled` is deliberately excluded (a `parley answer`
 * resume can append more to the same file later), and a `completed` row with
 * a still-open child (the post-report fallback can complete before the child
 * exits, #72) must not report final either. While not there yet, `eof` is
 * false even with an empty `chunk`, so a UI keeps polling. An unknown task ref
 * is a client error (404), matching the other `/tasks/:ref/*` routes.
 */
function handleLogs(
  engine: TaskEngine,
  res: http.ServerResponse,
  ref: string,
  params: URLSearchParams,
): void {
  const task = engine.resolve(ref);
  if (!task) {
    sendJson(res, 404, { error: `no such task: ${ref}` });
    return;
  }
  const sinceRaw = params.get("since");
  const since = sinceRaw !== null ? Number(sinceRaw) : 0;
  if (!Number.isInteger(since) || since < 0) {
    sendJson(res, 400, { error: "since must be a non-negative integer" });
    return;
  }
  const eof = isTerminalState(task.state) && !engine.hasLiveChild(task.id);
  const logPath = path.join(engine.logDir(task.id), "vendor.jsonl");
  const { bytes: chunk, next } = readLogTail(logPath, since);
  sendJson(res, 200, { chunk, next, eof });
}

/** Build a task envelope with concurrency-queue observability (#171 / #208). */
function envelopeFor(
  engine: TaskEngine,
  row: import("./db.js").TaskRow,
): TaskEnvelope {
  const enriched = engine.withQueueInfo(row);
  const env = buildEnvelope(enriched, engine.logDir(row.id), {
    position: enriched.queue_position,
    blockingCap: enriched.blocking_cap,
  });
  // ADR-0019 / #240: run address on every task.* (and list) envelope.
  env.run_id = row.run_id;
  env.node = row.node;
  env.iteration = row.iteration;
  env.slot = row.slot;
  return env;
}

/**
 * Resolve `ids` query param to canonical task/run ids. Empty is allowed
 * (vacuous all-done / empty firehose, or session-only expansion). A bad ref
 * is 404 → CLI exit 2. Explicit task refs stay task ids; bare run ids pass
 * through so the inbox can watch a run without tasks.
 */
function resolveWatchIds(
  engine: TaskEngine,
  params: URLSearchParams,
): string[] | { error: string; status: number } {
  const ids = (params.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const resolved: string[] = [];
  for (const ref of ids) {
    const task = engine.resolve(ref);
    if (task) {
      resolved.push(task.id);
      continue;
    }
    // Accept run ids so gate-first workflows (no tasks yet) are watchable.
    // resolveWatchSet looks up both tables; a miss on both is a hard 404.
    const probe = engine.resolveWatchSet([ref]);
    if (probe.runIds.includes(ref)) {
      resolved.push(ref);
      continue;
    }
    return { error: `no such task: ${ref}`, status: 404 };
  }
  return [...new Set(resolved)];
}

/**
 * `GET /tasks/inbox?ids=…&session=…&ack=<seq>&wait=true` — the acked attention
 * inbox (ADR-0007 / ADR-0019 / #91 / #240). Dual-subject: tasks and runs.
 * Optionally acks a prior event id, then returns the next pending event
 * (level-triggered), `{ all_done: true }` when the session is finished, or
 * `{ event: null, all_done: false }` when the poll window elapses with live
 * work still outstanding.
 */
async function handleInbox(
  engine: TaskEngine,
  res: http.ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const resolved = resolveWatchIds(engine, params);
  if (!Array.isArray(resolved)) {
    sendJson(res, resolved.status, { error: resolved.error });
    return;
  }

  const sessionParam = params.get("session");
  const session =
    sessionParam !== null && sessionParam !== "" ? sessionParam : null;
  // Unknown session is a usage error, not vacuous all-done (#256) — but only
  // when the session is the scope (no explicit task/run ids). Ambient env
  // session noise must not 400 a positional `watch t1` against a known task.
  // Known means a sessions row *or* any task/run stamped with the id.
  if (
    session !== null &&
    resolved.length === 0 &&
    !engine.isKnownSession(session)
  ) {
    sendJson(res, 400, {
      error: unknownSessionMessage(session),
      code: CODE_UNKNOWN_SESSION,
    });
    return;
  }
  const watch = engine.resolveWatchSet(resolved, session);

  const ackRaw = params.get("ack");
  if (ackRaw !== null && ackRaw !== "") {
    const ackSeq = Number(ackRaw);
    if (!Number.isInteger(ackSeq) || ackSeq < 0) {
      sendJson(res, 400, { error: "ack must be a non-negative integer" });
      return;
    }
    engine.ackEvent(ackSeq);
  }

  const wait = params.get("wait") === "true";
  const result = wait
    ? await engine.waitForInbox(watch, longPollWindowMs())
    : (() => {
        const pending = engine.peekInboxDelivering(watch);
        if (pending) return { event: pending } as const;
        if (engine.isInboxAllDone(watch)) return { allDone: true } as const;
        return null;
      })();

  if (result === null) {
    sendJson(res, 200, {
      event: null,
      seq: engine.currentSeq(),
      subject: null,
      task: null,
      run: null,
      all_done: false,
    });
    return;
  }
  if ("allDone" in result) {
    sendJson(res, 200, {
      event: null,
      seq: engine.currentSeq(),
      subject: null,
      task: null,
      run: null,
      all_done: true,
    });
    return;
  }
  const ev = result.event;
  if (ev.kind === "task") {
    const row = engine.get(ev.id);
    if (!row) {
      sendJson(res, 200, {
        event: null,
        seq: engine.currentSeq(),
        subject: null,
        task: null,
        run: null,
        all_done: false,
      });
      return;
    }
    sendJson(res, 200, {
      event: eventNameForState(ev.state),
      seq: ev.seq,
      subject: "task",
      task: envelopeFor(engine, row),
      run: null,
      all_done: false,
    });
    return;
  }
  // Run subject — exit tier folds gate→awaiting_answer, blocked→stalled.
  sendJson(res, 200, {
    event: runEventName(ev.state),
    seq: ev.seq,
    subject: "run",
    task: null,
    run: {
      run_id: ev.id,
      workflow: ev.run?.workflow ?? "",
      state: ev.run?.state ?? ev.state,
      tier: ev.state,
      current_node: ev.run?.current_node ?? null,
      iteration: ev.run?.iteration ?? 0,
      error: ev.run?.error ?? null,
      orchestrator_session_id: ev.run?.orchestrator_session_id ?? null,
      seq: ev.seq,
    },
    all_done: false,
  });
}

/** Wire event name for a run inbox tier key (ADR-0019). */
function runEventName(tier: string): string {
  if (tier === "gate") return "run.gate";
  if (tier === "blocked") return "run.blocked";
  if (tier === "failed") return "run.failed";
  if (tier === "completed") return "run.completed";
  return `run.${tier}`;
}

/**
 * `GET /tasks/events?ids=…&session=…&since=<seq>&wait=true` — the multi-subject
 * transition firehose (#34 / #240). Used by `watch --follow` (no ack). Returns
 * the earliest transition of any watched task or run after `since`, or
 * `{ event: null }` when the poll window elapses. Omitting `since` means
 * "start from now".
 */
async function handleWatchEvents(
  engine: TaskEngine,
  res: http.ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const resolved = resolveWatchIds(engine, params);
  if (!Array.isArray(resolved)) {
    sendJson(res, resolved.status, { error: resolved.error });
    return;
  }
  const sessionParam = params.get("session");
  const session =
    sessionParam !== null && sessionParam !== "" ? sessionParam : null;
  const watch = engine.resolveWatchSet(resolved, session);
  const followIds = [...watch.taskIds, ...watch.runIds];
  if (followIds.length === 0) {
    sendJson(res, 400, { error: "ids is required" });
    return;
  }
  const sinceRaw = params.get("since");
  const since = sinceRaw !== null ? Number(sinceRaw) : engine.currentSeq();
  if (!Number.isFinite(since) || since < 0) {
    sendJson(res, 400, { error: "since must be a non-negative number" });
    return;
  }
  const wait = params.get("wait") === "true";
  const transition = wait
    ? await engine.waitForEvents(followIds, since, longPollWindowMs())
    : engine.peekEvent(followIds, since);
  if (!transition) {
    sendJson(res, 200, {
      event: null,
      seq: since,
      subject: null,
      task: null,
      run: null,
    });
    return;
  }
  if (transition.kind === "run") {
    sendJson(res, 200, {
      event: transition.event ?? `run.${transition.state}`,
      seq: transition.seq,
      subject: "run",
      task: null,
      run: {
        run_id: transition.run_id ?? "",
        workflow: "",
        state: transition.state,
        current_node: transition.node ?? null,
        iteration: transition.iteration ?? 0,
        error: null,
        orchestrator_session_id: null,
        seq: transition.seq,
      },
    });
    return;
  }
  const taskId = transition.task_id;
  if (taskId === undefined) {
    sendJson(res, 200, {
      event: null,
      seq: transition.seq,
      subject: null,
      task: null,
      run: null,
    });
    return;
  }
  const row = engine.get(taskId);
  if (!row) {
    sendJson(res, 200, {
      event: null,
      seq: transition.seq,
      subject: null,
      task: null,
      run: null,
    });
    return;
  }
  // The envelope carries the current row for detail, but its `state`/`seq` are
  // pinned to the transition so the event name and the CLI's exit code agree
  // even if the row has since moved on (a superseded non-terminal transition).
  // `updated_at` stays on the row's last write — do not pin it backwards.
  const task = envelopeFor(engine, row);
  task.state = transition.state;
  task.seq = transition.seq;
  // Prefer transition-pinned address when present (should match the row).
  if (transition.run_id !== undefined) task.run_id = transition.run_id;
  if (transition.node !== undefined) task.node = transition.node;
  if (transition.iteration !== undefined) task.iteration = transition.iteration;
  if (transition.slot !== undefined) task.slot = transition.slot;
  sendJson(res, 200, {
    event: eventNameForState(transition.state),
    seq: transition.seq,
    subject: "task",
    task,
    run: null,
  });
}

/**
 * Serialize one transition as an SSE message (spec §"New: SSE event stream"):
 * `id:` is the transition seq (the `Last-Event-ID` a reconnect resumes from),
 * `event:` is the watch event name, `data:` is the task envelope pinned to the
 * transition — same pinning rule as the long-poll, so a superseded non-terminal
 * transition still reports the state/seq it fired at. Returns null when the
 * transition's row has vanished (never expected in practice).
 */
function sseMessageFor(
  engine: TaskEngine,
  transition: {
    seq: number;
    task_id?: string;
    state: string;
    kind?: "task" | "run";
    event?: string;
    run_id?: string | null;
    node?: string | null;
    iteration?: number | null;
    slot?: string | null;
  },
): string | null {
  if (transition.kind === "run") {
    const data = JSON.stringify({
      run_id: transition.run_id,
      state: transition.state,
      current_node: transition.node ?? null,
      iteration: transition.iteration ?? 0,
      seq: transition.seq,
    });
    const event = transition.event ?? `run.${transition.state}`;
    return `id: ${transition.seq}\nevent: ${event}\ndata: ${data}\n\n`;
  }
  const taskId = transition.task_id;
  if (taskId === undefined) return null;
  const row = engine.get(taskId);
  if (!row) return null;
  const task = envelopeFor(engine, row);
  task.state = transition.state;
  task.seq = transition.seq;
  if (transition.run_id !== undefined) task.run_id = transition.run_id;
  if (transition.node !== undefined) task.node = transition.node;
  if (transition.iteration !== undefined) task.iteration = transition.iteration;
  if (transition.slot !== undefined) task.slot = transition.slot;
  const data = JSON.stringify(task);
  return `id: ${transition.seq}\nevent: ${eventNameForState(transition.state)}\ndata: ${data}\n\n`;
}

/**
 * `GET /events/stream` — Server-Sent Events over the same transition feed the
 * long-poll reads (spec §"New: SSE event stream"). Streams every task's
 * transitions live; a browser's native `EventSource` consumes it and
 * auto-reconnects. Resume point: the `Last-Event-ID` header (sent automatically
 * on reconnect) or a `since` query param (the bootstrap seq from `GET /tasks`),
 * header winning; absent, the stream starts from the current seq (future
 * transitions only). Everything after that seq replays in order, nothing before.
 */
async function handleEventStream(
  engine: TaskEngine,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  // Reconnect resumes from Last-Event-ID; a fresh bootstrap passes `?since=`.
  const lastEventId = typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : null;
  // An empty header/param is "no resume point" (a proxy may forward an empty
  // Last-Event-ID) — not seq 0, which would replay the whole log. Fall through
  // to the current seq (future transitions only), the "start from now" default.
  const resumeRaw = (lastEventId ?? params.get("since") ?? "").trim();
  let since = resumeRaw !== "" ? Number(resumeRaw) : engine.currentSeq();
  if (!Number.isFinite(since) || since < 0) {
    sendJson(res, 400, { error: "Last-Event-ID / since must be a non-negative number" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // No proxy sits in front of a localhost daemon, but be explicit for any that does.
    "x-accel-buffering": "no",
  });
  // An opening comment flushes headers so the client's `open` fires promptly.
  res.write(": connected\n\n");

  let open = true;
  const stop = (): void => {
    open = false;
  };
  res.on("close", stop);

  // Drain everything already recorded after `since`, then block for the next —
  // repeating until the client disconnects. Each delivered seq advances `since`
  // so a reconnect (or the next block) never replays it.
  while (open) {
    const transition = engine.peekAnyEvent(since);
    if (transition) {
      since = transition.seq;
      const message = sseMessageFor(engine, transition);
      if (message !== null && !res.write(message)) {
        // Backpressure: wait for the socket to drain before queuing more — but
        // resolve on `close` too, or a client that disconnects mid-write leaves
        // this await pending forever ('drain' never fires on a dead socket).
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      }
      continue;
    }
    const next = await engine.waitForAnyEvent(since, longPollWindowMs());
    if (!open) break;
    // On timeout (`next === null`) the loop re-blocks, keeping the stream open;
    // otherwise the next peek picks the transition up and delivers it in order.
    if (next === null) res.write(": keep-alive\n\n");
  }
  res.end();
}

/** `POST /tasks/:ref/answer` — deliver an answer to a task's pending question. */
function handleAnswer(
  engine: TaskEngine,
  res: http.ServerResponse,
  ref: string,
  body: unknown,
): void {
  if (!isRecord(body) || typeof body.text !== "string") {
    sendJson(res, 400, { error: "answer text is required" });
    return;
  }
  try {
    const row = engine.answer(ref, body.text);
    sendJson(res, 200, { task_id: row.id, name: row.name, state: row.state, seq: row.seq });
  } catch (err) {
    if (err instanceof DelegateError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
}

/**
 * `POST /tasks/:ref/eval` — structured rubric evaluation (#157). Body:
 * `{ answers: Record<criterionId, boolean>, feedback: string }`. Free `score`
 * is rejected with a teaching message; the daemon computes score + baseline.
 */
function handleEval(
  engine: TaskEngine,
  res: http.ServerResponse,
  ref: string,
  body: unknown,
): void {
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  if ("score" in body && body.score !== undefined) {
    sendJson(res, 400, {
      error:
        "score is no longer accepted; use answers (criterion id → boolean) so the daemon can compute the score from the rubric",
    });
    return;
  }
  const answers = body.answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    sendJson(res, 400, {
      error: "answers is required (object mapping criterion ids to booleans)",
    });
    return;
  }
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof value !== "boolean") {
      sendJson(res, 400, {
        error: `answers.${id} must be a boolean, got: ${typeof value}`,
      });
      return;
    }
  }
  const feedback = body.feedback;
  if (typeof feedback !== "string" || feedback === "") {
    sendJson(res, 400, { error: "feedback is required" });
    return;
  }
  const ancestryChain = parseAncestryChain(body.ancestry_chain);
  if (ancestryChain === undefined) {
    sendJson(res, 400, {
      error: "ancestry_chain must be an array of { machine_id, pid, start_time }",
    });
    return;
  }
  try {
    const row = engine.evalTask(ref, answers as Record<string, boolean>, feedback, {
      explicitSessionId: optionalString(body.orchestrator_session_id),
      ancestryChain,
      workspaceRoot: optionalString(body.workspace_root),
    });
    const bindingWarning = engine.takeSessionBindingWarning();
    sendJson(res, 200, {
      task_id: row.id,
      name: row.name,
      state: row.state,
      seq: row.seq,
      eval_score: row.eval_score,
      eval_baseline: row.eval_baseline,
      eval_rubric: row.eval_rubric,
      eval_rubric_version: row.eval_rubric_version,
      eval_session_id: row.eval_session_id,
      eval_harness: row.eval_harness,
      eval_model: row.eval_model,
      eval_effort: row.eval_effort,
      ...(bindingWarning !== null ? { warning: bindingWarning } : {}),
    });
  } catch (err) {
    if (err instanceof DelegateError) {
      sendJson(res, 400, {
        error: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
      });
      return;
    }
    throw err;
  }
}

/** `POST /tasks/:ref/cancel` — terminate the child and end the task `cancelled`. */
function handleCancel(engine: TaskEngine, res: http.ServerResponse, ref: string): void {
  try {
    const row = engine.cancel(ref);
    sendJson(res, 200, { task_id: row.id, name: row.name, state: row.state, seq: row.seq });
  } catch (err) {
    if (err instanceof DelegateError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
}

const RUN_GATE_VERBS = new Set(["approve", "reject", "redirect", "finish"]);
const RUN_REENTRY_VERBS = new Set(["fork", "cancel"]);

/**
 * `POST /runs/:id/{approve|reject|redirect|finish|fork|cancel}` — gate verbs
 * on a blocked run (#238), or re-entry verbs (#242): fork a terminal run /
 * cancel a live one. Body: `{ to?: string, note?: string }` (`to` required
 * for redirect; optional for fork with definition `reentry` default).
 */
function handleRunVerb(
  engine: TaskEngine,
  res: http.ServerResponse,
  runId: string,
  verb: string,
  body: unknown,
): void {
  if (RUN_REENTRY_VERBS.has(verb)) {
    handleRunReentryVerb(engine, res, runId, verb, body);
    return;
  }
  if (!RUN_GATE_VERBS.has(verb)) {
    sendJson(res, 404, { error: `unknown run verb: ${verb}` });
    return;
  }
  const record = isRecord(body) ? body : {};
  const to = typeof record.to === "string" ? record.to : null;
  const note = typeof record.note === "string" ? record.note : null;
  try {
    const { run, decision } = engine.actionRun(runId, {
      verb: verb as "approve" | "reject" | "redirect" | "finish",
      to,
      note,
    });
    sendJson(res, 200, {
      run_id: run.id,
      state: run.state,
      current_node: run.current_node,
      iteration: run.iteration,
      decision,
      error: run.error,
    });
  } catch (err) {
    if (err instanceof DelegateError) {
      // Unknown run → 404; illegal verb / state → 400.
      const status = err.message.startsWith("no such run:") ? 404 : 400;
      sendJson(res, status, { error: err.message });
      return;
    }
    throw err;
  }
}

/**
 * `POST /runs` — create and enter a run (ADR-0022 / #249).
 * Body: `{ workflow, inputs?, input_flags?, base_ref?, cwd, orchestrator_session_id? }`.
 * `inputs` is the `--inputs <file>` object; `input_flags` is the repeatable
 * `--input name=value` list. Flag wins on name collision (daemon merges).
 */
function handleRunStart(
  engine: TaskEngine,
  res: http.ServerResponse,
  body: unknown,
): void {
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  const workflow = body.workflow;
  if (typeof workflow !== "string" || workflow.trim() === "") {
    sendJson(res, 400, { error: "workflow is required" });
    return;
  }
  const cwd = body.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    sendJson(res, 400, { error: "cwd is required" });
    return;
  }

  let fileInputs: Record<string, unknown> | null = null;
  if (body.inputs !== undefined && body.inputs !== null) {
    if (typeof body.inputs !== "object" || Array.isArray(body.inputs)) {
      sendJson(res, 400, { error: "inputs must be a JSON object keyed by port name" });
      return;
    }
    fileInputs = body.inputs as Record<string, unknown>;
  }

  const flagInputs: { name: string; value: string }[] = [];
  if (body.input_flags !== undefined && body.input_flags !== null) {
    if (!Array.isArray(body.input_flags)) {
      sendJson(res, 400, { error: "input_flags must be an array of { name, value }" });
      return;
    }
    for (const entry of body.input_flags) {
      if (
        !isRecord(entry) ||
        typeof entry.name !== "string" ||
        typeof entry.value !== "string"
      ) {
        sendJson(res, 400, { error: "each input_flags entry must be { name, value }" });
        return;
      }
      flagInputs.push({ name: entry.name, value: entry.value });
    }
  }

  const baseRef = optionalString(body.base_ref);
  const orchSession = optionalString(body.orchestrator_session_id);

  try {
    const result = engine.startRun({
      workflow: workflow.trim(),
      fileInputs,
      flagInputs,
      baseRef,
      cwd,
      orchestratorSessionId: orchSession,
    });
    if (result.kind === "usage") {
      sendJson(res, 400, { error: result.message });
      return;
    }
    if (result.kind === "error") {
      // Phase-2 failure: still 500-ish? Prefer 400 with the failed run id so
      // the CLI can surface it. A failed run row is useful; treat as 200 with
      // state=failed so the client sees the id (return posture is "committed").
      if (result.run !== undefined) {
        sendJson(res, 201, {
          run_id: result.run.id,
          state: result.run.state,
          current_node: result.run.current_node,
          iteration: result.run.iteration,
          workflow: result.run.workflow,
          workspace: result.run.workspace,
          base_ref: result.run.base_ref,
          base_commit: result.run.base_commit,
          error: result.run.error ?? result.message,
        });
        return;
      }
      sendJson(res, 500, { error: result.message });
      return;
    }
    sendJson(res, 201, {
      run_id: result.run.id,
      state: result.run.state,
      current_node: result.run.current_node,
      iteration: result.run.iteration,
      workflow: result.run.workflow,
      workspace: result.run.workspace,
      base_ref: result.run.base_ref,
      base_commit: result.run.base_commit,
      error: result.run.error,
    });
  } catch (err) {
    if (err instanceof DelegateError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
}

/**
 * `POST /runs/:id/fork` and `POST /runs/:id/cancel` (ADR-0017 / #242).
 * Fork never accepts input overrides — only `to` / `note`.
 */
function handleRunReentryVerb(
  engine: TaskEngine,
  res: http.ServerResponse,
  runId: string,
  verb: string,
  body: unknown,
): void {
  try {
    if (verb === "cancel") {
      const run = engine.cancelRun(runId);
      sendJson(res, 200, {
        run_id: run.id,
        state: run.state,
        current_node: run.current_node,
        iteration: run.iteration,
        decision: { kind: "cancelled" },
        error: run.error,
      });
      return;
    }
    // fork
    const record = isRecord(body) ? body : {};
    const to = typeof record.to === "string" ? record.to : null;
    const note = typeof record.note === "string" ? record.note : null;
    // Inputs are frozen — reject any attempt to pass them on the wire.
    if (record.inputs !== undefined || record.input !== undefined) {
      sendJson(res, 400, {
        error:
          "fork does not accept input overrides; inputs are frozen from the parent run",
      });
      return;
    }
    const { run, plan } = engine.forkRun({
      parentRunId: runId,
      to,
      note,
    });
    sendJson(res, 200, {
      run_id: run.id,
      parent_run_id: run.parent_run_id,
      attempt: run.attempt,
      state: run.state,
      current_node: run.current_node,
      iteration: run.iteration,
      decision: {
        kind: "fork",
        entry: plan.entryNode,
        attempt: plan.attempt,
        note: plan.note,
      },
      error: run.error,
    });
  } catch (err) {
    if (err instanceof DelegateError) {
      const status = err.message.startsWith("no such run:") ? 404 : 400;
      sendJson(res, status, { error: err.message });
      return;
    }
    throw err;
  }
}

/**
 * `POST /tasks/:ref/fix` — create a linked attempt that inherits the parent's
 * classification/workspace and optionally resumes its vendor session
 * (#152 / #158). Body: `{ prompt, fresh?: boolean }`.
 */
function handleFix(
  engine: TaskEngine,
  res: http.ServerResponse,
  ref: string,
  body: unknown,
): void {
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  const prompt = body.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    sendJson(res, 400, { error: "prompt is required" });
    return;
  }
  if (body.fresh !== undefined && typeof body.fresh !== "boolean") {
    sendJson(res, 400, { error: "fresh must be a boolean" });
    return;
  }
  const ancestryChain = parseAncestryChain(body.ancestry_chain);
  if (ancestryChain === undefined) {
    sendJson(res, 400, {
      error: "ancestry_chain must be an array of { machine_id, pid, start_time }",
    });
    return;
  }
  const orchSession = optionalString(body.orchestrator_session_id);
  const workspaceRoot = optionalString(body.workspace_root);
  try {
    const task = engine.fix({
      parentRef: ref,
      prompt,
      fresh: body.fresh === true,
      orchestratorSessionId: orchSession,
      ancestryChain,
      workspaceRoot,
    });
    const bindingWarning = engine.takeSessionBindingWarning();
    sendJson(res, 201, {
      task_id: task.id,
      name: task.name,
      state: task.state,
      seq: task.seq,
      parent_task_id: task.parent_task_id,
      attempt: task.attempt,
      resumed: task.resumed === 1,
      ...(bindingWarning !== null ? { warning: bindingWarning } : {}),
    });
  } catch (err) {
    if (err instanceof DelegateError) {
      // Include stable `code` when present so the CLI can map retry gates
      // (#158) and session_required (#162) without parsing message prose.
      sendJson(res, 400, {
        error: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
      });
      return;
    }
    throw err;
  }
}

/**
 * `POST /sessions` — register or re-anchor an orchestrator session
 * (#162 / #190 / #196). Body: `{ harness?, model?, effort?, workspace_root,
 * anchor, session_id?, create_if_missing? }`. Provenance optional (null/omit
 * → unknown). Fresh id when session_id omitted; known id re-anchors; unknown
 * id with create_if_missing inserts; otherwise 400.
 */
function handleRegisterSession(
  engine: TaskEngine,
  res: http.ServerResponse,
  body: unknown,
): void {
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  // null / omit / empty string all mean unknown provenance (#190).
  const harness = optionalString(body.harness);
  const model = optionalString(body.model);
  const effort = optionalString(body.effort);
  const workspaceRoot = optionalString(body.workspace_root);
  if (workspaceRoot === null) {
    sendJson(res, 400, { error: "workspace_root is required" });
    return;
  }
  const anchor = parseAnchor(body.anchor);
  if (anchor === null) {
    sendJson(res, 400, {
      error: "anchor is required ({ machine_id, pid, start_time })",
    });
    return;
  }
  const createIfMissing = body.create_if_missing === true;
  const clearPanic = body.clear_panic === true;
  try {
    const session = engine.registerSession({
      harness,
      model,
      effort,
      workspaceRoot,
      anchor,
      sessionId: optionalString(body.session_id),
      createIfMissing,
      clearPanic,
    });
    sendJson(res, 201, {
      session_id: session.id,
      harness: session.harness,
      model: session.model,
      effort: session.effort,
      workspace_root: session.workspace_root,
      created_at: session.created_at,
      updated_at: session.updated_at,
      panicked: session.panicked === 1,
    });
  } catch (err) {
    if (err instanceof DelegateError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
}

/**
 * Build the daemon's HTTP request handler: the CLI plane (REST, spec §3), the
 * MCP child channel on `/mcp` (spec §4), the grok xAI usage proxy on
 * `/xai/<taskId>/v1/...` (#95), and — when `uiBundleDir` is non-null
 * (UI discovery, spec §"Serving convention") — the UI's static bundle at `/`
 * with SPA fallback. `uiBundleDir` is resolved once at server start; API
 * routes are matched first and always win, so the UI can never shadow them.
 */
function createHandler(
  engine: TaskEngine,
  uiBundleDir: string | null,
  paths: HomePaths,
  identity: DaemonIdentity | undefined,
  db: DatabaseHandle,
  adapters: Map<string, VendorAdapter>,
): http.RequestListener {
  return (req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const segments = url.pathname.split("/").filter((s) => s !== "");

      // Off-loopback: bearer auth on every route (#323 / ADR-0030).
      // Loopback keeps tokenless trust; runner routes still self-auth.
      // Config is read once here and reused by runner handlers (F8).
      const auth = gateRequest(req, res, paths, engine, method, url.pathname);
      if (auth === null) return;
      const { config, loopback } = auth;

      if (url.pathname === "/mcp") {
        const body = method === "POST" ? await readBody(req) : undefined;
        await handleMcpRequest(engine, req, res, body);
        return;
      }

      // Grok xAI reverse proxy (#95): path-correlated usage capture. Reads the
      // raw body itself (must not go through JSON readBody) and streams the
      // upstream response back verbatim.
      if (segments[0] === "xai") {
        await handleXaiProxyRequest(engine, req, res);
        return;
      }

      // Child REST surface (ADR-0011): same correlation header as MCP, thin
      // front-end over engine.submitReport / askOrchestrator / the envelope.
      // Off-loopback: gate already bound the presenter to the task's runner.
      if (segments[0] === "child") {
        if (method === "POST" && segments.length === 2 && segments[1] === "report") {
          handleChildReport(engine, req, res, await readBody(req));
          return;
        }
        if (method === "POST" && segments.length === 2 && segments[1] === "ask") {
          await handleChildAsk(engine, req, res, await readBody(req));
          return;
        }
        if (method === "GET" && segments.length === 2 && segments[1] === "task") {
          handleChildTask(engine, req, res);
          return;
        }
      }

      // Remote runner surface (#111 / ADR-0012 / ADR-0029): bearer-token auth;
      // not localhost trust. Registration is required before lease.
      // Config already loaded by the gate — do not re-read (F8).
      if (segments[0] === "runner") {
        // `config` from gateRequest above.
        if (method === "POST" && segments.length === 2 && segments[1] === "register") {
          const body = await readBody(req);
          if (!isRecord(body) || typeof body.runner !== "string" || body.runner === "") {
            sendJson(res, 400, { error: "runner is required" });
            return;
          }
          const runnerName = authenticateRunner(req, config, body.runner);
          if (runnerName === null) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          if (typeof body.protocol_version !== "number" || !Number.isInteger(body.protocol_version)) {
            sendJson(res, 400, { error: "protocol_version is required (integer)" });
            return;
          }
          if (body.protocol_version !== RUNNER_PROTOCOL_VERSION) {
            sendJson(res, 400, {
              error:
                `incompatible runner protocol version: runner sent ${body.protocol_version}, ` +
                `daemon requires ${RUNNER_PROTOCOL_VERSION}`,
              code: "protocol_version_mismatch",
              runner_protocol_version: body.protocol_version,
              daemon_protocol_version: RUNNER_PROTOCOL_VERSION,
            });
            return;
          }
          if (typeof body.build_version !== "string" || body.build_version === "") {
            sendJson(res, 400, { error: "build_version is required" });
            return;
          }
          {
            const capsErr = capabilitiesValidationError(body.capabilities);
            if (capsErr !== null) {
              sendJson(res, 400, { error: capsErr });
              return;
            }
          }
          // #315 F2: `local` is reserved for the daemon's in-process executor.
          if (runnerName === "local" || body.runner === "local") {
            sendJson(res, 400, {
              error:
                'runner name "local" is reserved for the daemon in-process executor',
              code: "reserved_runner_name",
            });
            return;
          }
          // Lazy stale auto-cleanup on registration (#320).
          sweepStaleRunners(db, config);
          const row = upsertRunner(db, {
            name: runnerName,
            capabilities: JSON.stringify(body.capabilities),
            protocol_version: body.protocol_version,
            build_version: body.build_version,
          });
          // #315: a newly capable online runner may unblock routing-wait tasks.
          engine.redispatchRoutingWaits();
          sendJson(res, 200, {
            ok: true as const,
            name: row.name,
            registered_at: row.registered_at,
            last_seen: row.last_seen,
          });
          return;
        }
        if (method === "POST" && segments.length === 2 && segments[1] === "lease") {
          const body = await readBody(req);
          if (!isRecord(body) || typeof body.runner !== "string" || body.runner === "") {
            sendJson(res, 400, { error: "runner is required" });
            return;
          }
          const runnerName = authenticateRunner(req, config, body.runner);
          if (runnerName === null) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          // Registration-gated: lease requires a prior successful register.
          if (getRunner(db, runnerName) === undefined) {
            sendJson(res, 403, {
              error:
                `runner "${runnerName}" is not registered; call POST /runner/register ` +
                `before leasing`,
              code: "runner_not_registered",
            });
            return;
          }
          // Disable socket idle timeouts for the long-poll window.
          req.setTimeout(0);
          res.setTimeout(0);
          // Open poll is the presence signal; last_seen refreshes on enter/exit.
          touchRunnerLastSeen(db, runnerName);
          beginRunnerPoll(runnerName);
          // #315: online presence may unblock capable-but-offline waits.
          engine.redispatchRoutingWaits();
          try {
            const leased = await engine.leaseRunnerTask(runnerName, longPollWindowMs());
            touchRunnerLastSeen(db, runnerName);
            if (leased === null) {
              res.writeHead(204);
              res.end();
              return;
            }
            sendJson(res, 200, leased);
          } finally {
            endRunnerPoll(runnerName);
          }
          return;
        }
        if (
          method === "POST" &&
          segments.length === 4 &&
          segments[1] === "tasks" &&
          segments[3] === "heartbeat"
        ) {
          const taskId = decodeURIComponent(segments[2] ?? "");
          const runnerName = authenticateRunner(req, config);
          if (runnerName === null) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          // Optional body: { phase?: "worktree_created" } only (#319 F3).
          // Empty / missing body remains valid (timer refresh only).
          // Daemon-derived phases (leased/events_streamed/branch_pushed) → 400.
          const rawBody = await readBody(req);
          let phase: RunnerWirePhase | undefined;
          if (rawBody !== undefined && rawBody !== null && rawBody !== "") {
            if (!isRecord(rawBody)) {
              sendJson(res, 400, { error: "heartbeat body must be an object" });
              return;
            }
            if (rawBody.phase !== undefined) {
              if (!isRunnerWirePhase(rawBody.phase)) {
                sendJson(res, 400, {
                  error:
                    "phase must be worktree_created (leased/events_streamed/branch_pushed are daemon-derived)",
                });
                return;
              }
              phase = rawBody.phase;
            }
          }
          try {
            engine.runnerHeartbeat(taskId, runnerName, phase !== undefined ? { phase } : {});
            // Task traffic refreshes presence while the runner is mid-execute
            // (no open lease poll during execute; see ADR-0029).
            touchRunnerLastSeen(db, runnerName);
            sendJson(res, 200, { ok: true });
          } catch (err) {
            if (err instanceof DelegateError) {
              sendJson(res, 400, { error: err.message });
              return;
            }
            throw err;
          }
          return;
        }
        if (
          method === "POST" &&
          segments.length === 4 &&
          segments[1] === "tasks" &&
          segments[3] === "events"
        ) {
          const taskId = decodeURIComponent(segments[2] ?? "");
          const runnerName = authenticateRunner(req, config);
          if (runnerName === null) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          const body = await readBody(req);
          if (!isRecord(body) || !Array.isArray(body.lines)) {
            sendJson(res, 400, { error: "lines must be an array of strings" });
            return;
          }
          const lines: string[] = [];
          for (const line of body.lines) {
            if (typeof line !== "string") {
              sendJson(res, 400, { error: "lines must be an array of strings" });
              return;
            }
            lines.push(line);
          }
          try {
            engine.processRunnerEvents(taskId, runnerName, lines);
            touchRunnerLastSeen(db, runnerName);
            sendJson(res, 200, { ok: true });
          } catch (err) {
            if (err instanceof DelegateError) {
              sendJson(res, 400, { error: err.message });
              return;
            }
            throw err;
          }
          return;
        }
        if (
          method === "POST" &&
          segments.length === 4 &&
          segments[1] === "tasks" &&
          segments[3] === "branch"
        ) {
          const taskId = decodeURIComponent(segments[2] ?? "");
          const runnerName = authenticateRunner(req, config);
          if (runnerName === null) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          const body = await readBody(req);
          if (!isRecord(body) || typeof body.branch !== "string") {
            sendJson(res, 400, { error: "branch is required" });
            return;
          }
          try {
            const row = engine.recordRunnerBranch(taskId, runnerName, body.branch);
            touchRunnerLastSeen(db, runnerName);
            sendJson(res, 200, {
              task_id: row.id,
              name: row.name,
              state: row.state,
              branch: row.branch,
              seq: row.seq,
            });
          } catch (err) {
            if (err instanceof DelegateError) {
              sendJson(res, 400, { error: err.message });
              return;
            }
            throw err;
          }
          return;
        }
        if (
          method === "POST" &&
          segments.length === 4 &&
          segments[1] === "tasks" &&
          segments[3] === "fail"
        ) {
          const taskId = decodeURIComponent(segments[2] ?? "");
          const runnerName = authenticateRunner(req, config);
          if (runnerName === null) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          const body = await readBody(req);
          if (!isRecord(body) || typeof body.error !== "string" || body.error === "") {
            sendJson(res, 400, { error: "error is required" });
            return;
          }
          // Optional structured category (#317): invalid git_auth enums → 400;
          // absent/unknown kind → plain fail. Wire repo_key/runner are ignored.
          const parsed = parseFailCategory(body.category);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          try {
            const row = engine.failRunnerTask(
              taskId,
              runnerName,
              body.error,
              parsed.category,
            );
            touchRunnerLastSeen(db, runnerName);
            sendJson(res, 200, {
              task_id: row.id,
              name: row.name,
              state: row.state,
              seq: row.seq,
            });
          } catch (err) {
            if (err instanceof DelegateError) {
              sendJson(res, 400, { error: err.message });
              return;
            }
            throw err;
          }
          return;
        }
      }

      if (method === "GET" && url.pathname === "/health") {
        // `version` (daemon package version) lets a UI detect a contract
        // mismatch against the @useparley/core SDK it was built for;
        // `started_at` feeds the cockpit's live uptime readout (#65). Identity
        // fields (#130) make a version-skewed or foreign hub visible at a
        // glance: instance id, served home, dist-vs-source provenance, entry.
        const startedAt =
          identity?.started_at ??
          new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
        sendJson(res, 200, {
          status: "ok",
          pid: process.pid,
          version: DAEMON_VERSION,
          started_at: startedAt,
          ui_available: uiBundleDir !== null,
          ...(identity !== undefined
            ? {
                instance_id: identity.instance_id,
                home: identity.home,
                provenance: identity.provenance,
                entry: identity.entry,
                ...(identity.daemon_id !== undefined ? { daemon_id: identity.daemon_id } : {}),
              }
            : {}),
        });
        return;
      }

      // `GET /runners` — fleet table for `parley runners list` (ADR-0029 / #314).
      // Status is derived from open lease polls + last_seen grace/stale windows.
      // Lazy stale auto-cleanup runs on read (#320).
      if (method === "GET" && url.pathname === "/runners") {
        sweepStaleRunners(db, config);
        const runners = listRunners(db).map((row) =>
          projectRunnerListEntry(row, config),
        );
        sendJson(res, 200, { runners });
        return;
      }

      // `GET /clones` — list managed mirrors with sizes + used flags (#318).
      // Client class: readable off-loopback with a client token.
      if (method === "GET" && url.pathname === "/clones") {
        const clones = engine.listClones();
        sendJson(res, 200, {
          clones: clones.map((c) => ({
            name: c.name,
            path: c.path,
            repo_key: c.repo_key,
            fetch_url: c.fetch_url,
            size_bytes: c.size_bytes,
            used: c.used,
          })),
        });
        return;
      }

      // `POST /clones/prune` — remove unused mirrors only (#318). Config-admin /
      // loopback (classifyAuthRoute). Never auto-called.
      if (method === "POST" && url.pathname === "/clones/prune") {
        if (!loopback) {
          sendJson(res, 403, {
            error: "clones prune is only allowed from loopback",
          });
          return;
        }
        const result = engine.pruneClones();
        sendJson(res, 200, {
          removed: result.removed.map((c) => ({
            name: c.name,
            path: c.path,
            repo_key: c.repo_key,
            fetch_url: c.fetch_url,
            size_bytes: c.size_bytes,
          })),
          kept: result.kept.map((c) => ({
            name: c.name,
            path: c.path,
            repo_key: c.repo_key,
            fetch_url: c.fetch_url,
            size_bytes: c.size_bytes,
            used: c.used,
          })),
        });
        return;
      }

      // `GET /runners/:name` — full advertisement for `parley runners show` (#320).
      // Client class (default fallthrough). Lazy stale sweep first.
      if (
        method === "GET" &&
        segments[0] === "runners" &&
        segments.length === 2 &&
        segments[1] !== undefined
      ) {
        const name = decodeURIComponent(segments[1]);
        sweepStaleRunners(db, config);
        const row = getRunner(db, name);
        if (row === undefined) {
          sendJson(res, 404, { error: `runner "${name}" is not registered` });
          return;
        }
        sendJson(res, 200, projectRunnerShow(row, db, config));
        return;
      }

      // `DELETE /runners/:name` — operator remove (#320): drop the SQLite row and
      // the `runners.<name>` config entry. Config-admin (loopback-only) because
      // it mutates credentials. Re-registration then fails as unknown (401).
      //
      // Atomic order: persist the next config FIRST, then delete the row. A
      // config-write failure must leave the registration row intact so the
      // runner does not vanish from list while still holding a live credential.
      // Config keys are removed by object key (not dotted-path) so names that
      // contain dots (e.g. `gpu.west`) work.
      if (
        method === "DELETE" &&
        segments[0] === "runners" &&
        segments.length === 2 &&
        segments[1] !== undefined
      ) {
        // Defense in depth: classifyAuthRoute already gates non-loopback to
        // config-admin (403), but handlers for config writes also self-check.
        if (!loopback) {
          sendJson(res, 403, {
            error: "runner remove is only allowed from loopback",
          });
          return;
        }
        const name = decodeURIComponent(segments[1]);
        let current: ParleyConfig;
        try {
          current = loadAdminConfig(paths);
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        const had_row = getRunner(db, name) !== undefined;
        const had_config =
          current.runners !== undefined &&
          Object.prototype.hasOwnProperty.call(current.runners, name);
        if (!had_row && !had_config) {
          sendJson(res, 404, {
            error: `runner "${name}" not found (no registration row or config entry)`,
          });
          return;
        }
        let deleted_config = false;
        if (had_config) {
          try {
            // Direct key delete — do not use unsetConfigPath (splits on `.`).
            const next = structuredClone(current) as ParleyConfig &
              Record<string, unknown>;
            const runners = { ...(next.runners as Record<string, unknown>) };
            delete runners[name];
            if (Object.keys(runners).length === 0) {
              delete next.runners;
            } else {
              next.runners = runners as NonNullable<ParleyConfig["runners"]>;
            }
            const validated = validateConfig(paths.config, next);
            persistAdminConfig(paths, validated);
            deleted_config = true;
          } catch (err) {
            // Config write failed — leave the SQLite row untouched.
            sendJson(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }
        const deleted_row = had_row ? deleteRunner(db, name) : false;
        sendJson(res, 200, {
          ok: true as const,
          name,
          deleted_row,
          deleted_config,
        });
        return;
      }

      // `GET /sessions` — historical orchestrator sessions for the roster
      // selector (#88). Optional `?q=` filters by id substring.
      // `POST /sessions` — register / re-anchor a live orchestrator session (#162).
      if (url.pathname === "/sessions") {
        if (method === "GET") {
          const q = url.searchParams.get("q");
          sendJson(res, 200, { sessions: engine.listSessions(q ?? undefined) });
          return;
        }
        if (method === "POST") {
          handleRegisterSession(engine, res, await readBody(req));
          return;
        }
      }

      // `GET /metrics` — task/eval/token/duration aggregates (#118).
      if (method === "GET" && url.pathname === "/metrics") {
        handleMetrics(engine, res, url.searchParams);
        return;
      }

      // `GET /info` — effective config as prose + structured twin (#163 / #321).
      if (method === "GET" && url.pathname === "/info") {
        handleInfo(res, url.searchParams, paths, adapters, db, config);
        return;
      }

      // `GET /prompt` — composed PROMPT.md preview for current project (#159).
      if (method === "GET" && url.pathname === "/prompt") {
        handlePrompt(engine, res, url.searchParams);
        return;
      }

      // Config admin surface (#156): daemon's own parley.json via endpoints so
      // local and remote daemons share the same CLI path (never touch the file).
      // Writes are loopback-only (#323 F1); GET redacts tokens off-loopback.
      if (segments[0] === "config") {
        if (method === "GET" && segments.length === 1) {
          handleConfigGet(paths, res, url.searchParams.get("key"), loopback);
          return;
        }
        if (method === "PUT" && segments.length === 1) {
          handleConfigPut(req, paths, res, await readBody(req));
          return;
        }
        if (method === "POST" && segments.length === 2 && segments[1] === "set") {
          handleConfigSet(req, paths, res, await readBody(req));
          return;
        }
        if (method === "POST" && segments.length === 2 && segments[1] === "unset") {
          handleConfigUnset(req, paths, res, await readBody(req));
          return;
        }
      }

      // Model catalog + allowlist surface (#322 / #307):
      // - GET /models — daemon-wide allowlist (policy), hot-read from parley.json
      // - POST /models/set|unset — CLIENT-class edits scoped to vendors.*.models
      // - POST /models/refresh — re-fingerprint this host + runner catalog ages
      // All CLIENT-class (token off-loopback); not config-admin.
      if (segments[0] === "models") {
        if (method === "GET" && segments.length === 1) {
          handleModelsGet(paths, res, url.searchParams.get("vendor"));
          return;
        }
        if (method === "POST" && segments.length === 2 && segments[1] === "set") {
          handleModelsSet(paths, res, await readBody(req));
          return;
        }
        if (method === "POST" && segments.length === 2 && segments[1] === "unset") {
          handleModelsUnset(paths, res, await readBody(req));
          return;
        }
        if (method === "POST" && segments.length === 2 && segments[1] === "refresh") {
          await handleModelsRefresh(paths, res, db, adapters, await readBody(req));
          return;
        }
      }

      if (method === "GET" && url.pathname === "/events/stream") {
        await handleEventStream(engine, req, res, url.searchParams);
        return;
      }

      if (method === "POST" && url.pathname === "/clean") {
        handleClean(engine, res, await readBody(req));
        return;
      }

      if (method === "POST" && url.pathname === "/gc") {
        handleGc(engine, res, await readBody(req));
        return;
      }

      // `POST /runs` — create a run (#249 / ADR-0022).
      if (segments[0] === "runs" && method === "POST" && segments.length === 1) {
        handleRunStart(engine, res, await readBody(req));
        return;
      }

      // `POST /runs/:id/{approve|reject|redirect|finish}` (#238),
      // `{fork|cancel}` (#242), and `eval` (#243) — all dispatched here so the
      // request body is consumed once (the stream cannot be re-read later).
      if (segments[0] === "runs" && method === "POST" && segments.length === 3) {
        const runId = decodeURIComponent(segments[1] ?? "");
        const verb = decodeURIComponent(segments[2] ?? "");
        const body = await readBody(req);
        if (verb === "eval") {
          handleRunEval(engine, res, runId, body);
          return;
        }
        handleRunVerb(engine, res, runId, verb, body);
        return;
      }

      if (segments[0] === "tasks") {
        if (method === "GET" && segments.length === 1) {
          // The current global seq rides along so `parley watch` can capture a
          // "start from now" baseline atomically with the task snapshot (#34).
          // Optional filters (#164) narrow the list the same way as /metrics.
          // #208: list ships envelopes, not storage rows.
          const filters = parseTaskMetricsFilters(url.searchParams);
          // List default: no session filter (return everything) — only apply
          // when the client explicitly passes session=.
          const all = engine.list();
          const rows =
            Object.keys(filters).length === 0
              ? all
              : all.filter((t) => taskMatchesFilters(t, filters));
          const tasks = rows.map((row) => envelopeFor(engine, row));
          sendJson(res, 200, { tasks, seq: engine.currentSeq() });
          return;
        }
        if (method === "POST" && segments.length === 1) {
          handleDelegate(engine, res, await readBody(req));
          return;
        }
        // Fixed subpaths under /tasks sit at the same depth as `GET /tasks/:ref`,
        // so they must be matched before the ref is resolved.
        if (method === "GET" && segments.length === 2 && segments[1] === "inbox") {
          await handleInbox(engine, res, url.searchParams);
          return;
        }
        if (method === "GET" && segments.length === 2 && segments[1] === "events") {
          await handleWatchEvents(engine, res, url.searchParams);
          return;
        }
        const ref = decodeURIComponent(segments[1] ?? "");
        if (method === "GET" && segments.length === 2) {
          const task = engine.resolve(ref);
          if (!task) sendJson(res, 404, { error: `no such task: ${ref}` });
          else {
            // Detail-only Q&A history (#79) — list envelopes omit it deliberately.
            // #164: attempt lineage + session + eval detail for status / Cove.
            const all = engine.list();
            sendJson(res, 200, {
              task: envelopeFor(engine, task),
              row: task,
              qa: engine.listQa(task.id),
              attempts: buildAttemptChain(task, all),
              session: buildSessionProvenance(task),
              eval_detail: buildEvalDetail(task),
            });
          }
          return;
        }
        if (method === "GET" && segments.length === 3 && segments[2] === "logs") {
          handleLogs(engine, res, ref, url.searchParams);
          return;
        }
        if (method === "POST" && segments.length === 3 && segments[2] === "answer") {
          handleAnswer(engine, res, ref, await readBody(req));
          return;
        }
        if (method === "POST" && segments.length === 3 && segments[2] === "eval") {
          handleEval(engine, res, ref, await readBody(req));
          return;
        }
        if (method === "POST" && segments.length === 3 && segments[2] === "cancel") {
          handleCancel(engine, res, ref);
          return;
        }
        if (method === "POST" && segments.length === 3 && segments[2] === "fix") {
          handleFix(engine, res, ref, await readBody(req));
          return;
        }
      }

      // ── #241 run query surface ──────────────────────────────────────────
      // New GET routes only. POST /runs/:id/{verb} stays above unchanged.
      if (db !== undefined && method === "GET") {
        // GET /runs
        if (segments[0] === "runs" && segments.length === 1) {
          handleRunsList(engine, db, paths, res, url.searchParams);
          return;
        }
        // GET /runs/:ref
        if (segments[0] === "runs" && segments.length === 2) {
          const ref = decodeURIComponent(segments[1] ?? "");
          handleRunDetail(engine, db, paths, res, ref);
          return;
        }
        // GET /runs/:ref/nodes/:node
        if (
          segments[0] === "runs" &&
          segments.length === 4 &&
          segments[2] === "nodes"
        ) {
          const ref = decodeURIComponent(segments[1] ?? "");
          const node = decodeURIComponent(segments[3] ?? "");
          handleRunNodeDetail(engine, db, paths, res, ref, node, url.searchParams);
          return;
        }
        // GET /deliverables/:id  (opaque id)
        // GET /deliverables?run=&address=  (collected fan-out / address form)
        if (segments[0] === "deliverables" && segments.length === 1) {
          handleDeliverableByQuery(db, paths, res, url.searchParams);
          return;
        }
        if (segments[0] === "deliverables" && segments.length === 2) {
          const idOrAddr = decodeURIComponent(segments[1] ?? "");
          handleDeliverableGet(db, paths, res, idOrAddr, url.searchParams);
          return;
        }
      }
      // ── end #241 ──

      // ── #243 run metrics (ADR-0020) ─────────────────────────────────────
      // Separate population from GET /metrics; never joined.
      // POST /runs/:id/eval is routed with the other run POST verbs above
      // (body stream can only be read once) but uses handleRunEval here.
      if (method === "GET" && url.pathname === "/run-metrics") {
        handleRunMetrics(engine, res, url.searchParams);
        return;
      }
      // ── end #243 ──

      // UI fallback (spec §"Routes"): only for GET requests outside the
      // reserved API prefixes, and only when a bundle was discovered at
      // startup — otherwise the daemon behaves exactly as it does today.
      if (method === "GET" && uiBundleDir !== null && !isReservedPath(segments[0])) {
        serveUiRequest(uiBundleDir, res, url.pathname);
        return;
      }

      sendJson(res, 404, { error: "not_found", route: `${method} ${url.pathname}` });
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof HttpError ? err.message : String(err);
        sendJson(res, status, { error: message });
      } else {
        res.end();
      }
    });
  };
}

// ── #241 run query handlers ─────────────────────────────────────────────────

function loadDefinitionForRun(
  paths: HomePaths,
  run: RunRow,
): WorkflowDefinition | null {
  try {
    const cwd = run.repo ?? process.cwd();
    const resolved = resolveWorkflow(run.workflow, {
      cwd,
      home: paths.home,
    });
    return resolved?.definition ?? null;
  } catch {
    return null;
  }
}

function workspaceForRun(paths: HomePaths, run: RunRow): {
  worktree: string | null;
  branch: string | null;
} {
  if (run.workspace === "scratch") {
    return {
      worktree: runScratchPath(paths.runs, run.id),
      branch: null,
    };
  }
  if (run.repo) {
    return {
      worktree: runCheckoutPath(paths.worktrees, run.repo, run.id),
      branch: runBranchName(run.id, run.workflow),
    };
  }
  return { worktree: null, branch: null };
}

function handleRunsList(
  engine: TaskEngine,
  db: DatabaseHandle,
  paths: HomePaths,
  res: http.ServerResponse,
  params: URLSearchParams,
): void {
  const session = params.get("session");
  const workflow = params.get("workflow");
  const state = params.get("state");
  const blocked = params.get("blocked");
  const filters = {
    session: session && session !== "all" ? session : null,
    workflow: workflow || null,
    state: blocked === "true" || blocked === "1" ? "blocked" : state || null,
  };
  const rows = listRunsFiltered(db, filters);
  const runs = rows.map((run) => {
    const tasks = listTasksForRun(db, run.id).map(taskRowToQuery);
    const definition = loadDefinitionForRun(paths, run);
    const ws = workspaceForRun(paths, run);
    return projectRunSummary({
      run,
      tasks,
      definition,
      branch: ws.branch,
      worktree: ws.worktree,
      seq: engine.currentSeq(),
    });
  });
  sendJson(res, 200, { runs, seq: engine.currentSeq() });
}

function handleRunDetail(
  engine: TaskEngine,
  db: DatabaseHandle,
  paths: HomePaths,
  res: http.ServerResponse,
  ref: string,
): void {
  const run = resolveRun(db, ref);
  if (!run) {
    sendJson(res, 404, { error: `no such run: ${ref}` });
    return;
  }
  const tasks = listTasksForRun(db, run.id).map(taskRowToQuery);
  const deliverables = listDeliverablesForRun(db, run.id).map(deliverableRowToQuery);
  const definition = loadDefinitionForRun(paths, run);
  const ws = workspaceForRun(paths, run);
  const detail = projectRunDetail({
    run,
    tasks,
    deliverables,
    definition,
    branch: ws.branch,
    worktree: ws.worktree,
    seq: engine.currentSeq(),
  });
  sendJson(res, 200, detail);
}

function handleRunNodeDetail(
  engine: TaskEngine,
  db: DatabaseHandle,
  paths: HomePaths,
  res: http.ServerResponse,
  ref: string,
  node: string,
  params: URLSearchParams,
): void {
  const run = resolveRun(db, ref);
  if (!run) {
    sendJson(res, 404, { error: `no such run: ${ref}` });
    return;
  }
  const definition = loadDefinitionForRun(paths, run);
  const iterRaw = params.get("iteration");
  let iteration: number;
  if (iterRaw !== null && iterRaw !== "") {
    iteration = Number(iterRaw);
    if (!Number.isInteger(iteration) || iteration < 0) {
      sendJson(res, 400, { error: "iteration must be a non-negative integer" });
      return;
    }
  } else {
    const latest = latestNodeIteration(db, run.id, node);
    iteration =
      latest ??
      (run.current_node === node ? run.iteration : 1);
  }
  const slot = params.get("slot");
  const tasks = listTasksForRun(db, run.id).map(taskRowToQuery);
  const deliverables = listDeliverablesForRun(db, run.id).map(deliverableRowToQuery);

  let gateState: string | null = null;
  const defNode = definition?.nodes.find((n) => n.id === node);
  if (defNode?.kind === "gate") {
    if (
      run.state === "blocked" &&
      run.current_node === node &&
      run.iteration === iteration
    ) {
      gateState = "waiting";
    } else if (iteration === 0) {
      gateState = "skipped";
    } else {
      // No decision log yet — honest unknown, not a fabricated verb.
      gateState = "actioned";
    }
  }

  const detail = projectNodeDetail({
    runId: run.id,
    nodeId: node,
    iteration,
    tasks,
    deliverables,
    definition,
    gateState,
    slotFilter: slot,
  });
  // Silence unused engine warning — reserved for seq if needed later.
  void engine;
  sendJson(res, 200, detail);
}

function handleDeliverableGet(
  db: DatabaseHandle,
  paths: HomePaths,
  res: http.ServerResponse,
  idOrAddr: string,
  params: URLSearchParams,
): void {
  if (looksLikeDeliverableId(idOrAddr)) {
    const row = getDeliverable(db, idOrAddr);
    if (!row) {
      sendJson(res, 404, { error: `no such deliverable: ${idOrAddr}` });
      return;
    }
    const run = getRun(db, row.run_id);
    const definition = run ? loadDefinitionForRun(paths, run) : null;
    const portType = lookupPortType(definition, row.node, row.port);
    const ws = run ? workspaceForRun(paths, run) : { worktree: null, branch: null };
    const value = resolveDeliverableValue({
      deliverable: deliverableRowToQuery(row),
      portType,
      workspaceRoot: ws.worktree,
    });
    sendJson(res, 200, value);
    return;
  }

  // Address form: /deliverables/<runId>%2F<node>%2F<port>… or plain address
  // Prefer query params when provided.
  const runParam = params.get("run");
  const parsed = parseDeliverableAddress(idOrAddr);
  if (!parsed) {
    sendJson(res, 400, {
      error: `unrecognised deliverable ref: ${idOrAddr} (expected dN id or node/port/iteration[/slot])`,
    });
    return;
  }
  const runId = runParam ?? parsed.runId;
  if (!runId) {
    sendJson(res, 400, {
      error: "address form requires a run id (prefix runId/… or ?run=)",
    });
    return;
  }
  respondDeliverableAddress(db, paths, res, runId, parsed.node, parsed.port, {
    iteration: parsed.iteration ?? (params.get("iteration") ? Number(params.get("iteration")) : null),
    slot: parsed.slot ?? params.get("slot"),
  });
}

function handleDeliverableByQuery(
  db: DatabaseHandle,
  paths: HomePaths,
  res: http.ServerResponse,
  params: URLSearchParams,
): void {
  const runId = params.get("run");
  const address = params.get("address");
  if (!runId || !address) {
    sendJson(res, 400, {
      error: "GET /deliverables requires ?run=&address= or /deliverables/:id",
    });
    return;
  }
  const parsed = parseDeliverableAddress(address);
  if (!parsed) {
    sendJson(res, 400, { error: `unrecognised address: ${address}` });
    return;
  }
  respondDeliverableAddress(db, paths, res, runId, parsed.node, parsed.port, {
    iteration:
      parsed.iteration ??
      (params.get("iteration") ? Number(params.get("iteration")) : null),
    slot: parsed.slot ?? params.get("slot"),
  });
}

function respondDeliverableAddress(
  db: DatabaseHandle,
  paths: HomePaths,
  res: http.ServerResponse,
  runId: string,
  node: string,
  port: string,
  opts: { iteration: number | null; slot: string | null },
): void {
  const run = getRun(db, runId);
  if (!run) {
    sendJson(res, 404, { error: `no such run: ${runId}` });
    return;
  }
  let iteration = opts.iteration;
  if (iteration === null || !Number.isFinite(iteration)) {
    iteration = latestNodeIteration(db, runId, node) ?? run.iteration;
  }
  const definition = loadDefinitionForRun(paths, run);
  const portType = lookupPortType(definition, node, port);
  const step = definition?.nodes.find((n) => n.id === node);
  const isFanOut =
    step?.kind === "step" &&
    (step.over !== undefined ||
      (step.slots !== undefined && Object.keys(step.slots).length > 0));

  // Slot specified → one sibling row.
  if (opts.slot !== null && opts.slot !== undefined && opts.slot !== "") {
    const rows = listDeliverablesForRunNode(db, runId, node, iteration, port, opts.slot);
    const row = rows[0];
    if (!row) {
      sendJson(res, 404, {
        error: `no deliverable at ${runId}/${node}/${port}/${iteration}/${opts.slot}`,
      });
      return;
    }
    const ws = workspaceForRun(paths, run);
    sendJson(
      res,
      200,
      resolveDeliverableValue({
        deliverable: deliverableRowToQuery(row),
        portType,
        workspaceRoot: ws.worktree,
      }),
    );
    return;
  }

  // No slot: single-task port → the one row; fan-out → collected view.
  const siblings = listDeliverablesForRunNode(db, runId, node, iteration, port);
  if (siblings.length === 0) {
    sendJson(res, 404, {
      error: `no deliverable at ${runId}/${node}/${port}/${iteration}`,
    });
    return;
  }
  if (!isFanOut && siblings.length === 1) {
    const ws = workspaceForRun(paths, run);
    sendJson(
      res,
      200,
      resolveDeliverableValue({
        deliverable: deliverableRowToQuery(siblings[0]!),
        portType,
        workspaceRoot: ws.worktree,
      }),
    );
    return;
  }

  // Collected fan-out — only an address can name this (no single deliverable row).
  const fanOutKind: "array" | "dict" =
    step?.kind === "step" && step.over !== undefined
      ? // Data fan-out: collection form follows the over port's container; we
        // default to dict when slots are named, array otherwise. Without the
        // upstream value, prefer dict when any sibling has a slot key.
        siblings.some((s) => s.slot !== null)
        ? "dict"
        : "array"
      : "dict";
  const baseType = portType ?? { kind: "text" as const };
  sendJson(
    res,
    200,
    collectFanOutDeliverable({
      runId,
      node,
      port,
      iteration,
      siblings: siblings.map(deliverableRowToQuery),
      portType: baseType,
      fanOut: fanOutKind,
    }),
  );
}

function lookupPortType(
  definition: WorkflowDefinition | null,
  nodeId: string,
  port: string,
): import("@useparley/core").PortType | null {
  if (!definition) return null;
  const node = definition.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== "step") return null;
  return node.out[port]?.type ?? null;
}

// ── end #241 handlers ──

/**
 * Start the daemon HTTP server on an ephemeral port, open the task-state
 * database, and wire up the task engine. Bind address comes from
 * `daemon.bind` (default `127.0.0.1` — loopback-only; #323 / ADR-0030). Does
 * not touch the discovery file — the daemon entry point publishes discovery
 * once the port is known.
 *
 * Plugin adapters (`vendors.<id>.plugin`) load here at startup only — adding a
 * plugin requires a daemon restart. Vendor args/env/profiles re-read per task.
 * `daemon.bind` is also cold (listen-time).
 */
/** Optional lifecycle wiring for `startServer` (#130); tests may omit it all. */
export interface StartServerOptions {
  /** This process's identity, advertised on `/health`. */
  identity?: DaemonIdentity;
  /**
   * Idle auto-shutdown: after `idleTimeoutMs` with zero open connections, zero
   * unsettled tasks, and no request activity, `onIdle` fires once. `0` (or an
   * omitted callback) disables monitoring entirely.
   */
  idleTimeoutMs?: number;
  onIdle?: () => void;
  /**
   * Override listen address for tests. When omitted, reads `daemon.bind` from
   * config (default {@link DEFAULT_DAEMON_BIND}).
   */
  bind?: string;
}

export async function startServer(
  paths: HomePaths,
  options: StartServerOptions = {},
): Promise<DaemonServer> {
  const db = openDatabase(paths);
  // Crash sweep (spec §3): tasks recorded live by a previous daemon lost their
  // children with its process group — mark them stalled before taking requests.
  sweepInterruptedTasks(db);
  // Config for plugins only: a corrupt file must not brick the daemon at
  // startup (UI discovery already degrades). Plugin load failures are logged
  // inside createAdapterRegistry; missing config is fine (built-ins only).
  let startupConfig: ParleyConfig = {};
  try {
    startupConfig = readConfig(paths.config);
  } catch (err) {
    process.stderr.write(
      `parley daemon: config unreadable at startup, loading built-in adapters only: ${String(err)}\n`,
    );
  }
  const bind = options.bind ?? resolveDaemonBind(startupConfig);
  const adapters = await createAdapterRegistry(process.env, {
    config: startupConfig,
    parleyHome: paths.home,
  });
  const engine = new TaskEngine(db, paths, adapters);
  // #315: presence for capability-matched routing (open poll + last_seen grace).
  engine.setRunnerOnlineProbe((name) => {
    if (runnerHasOpenPoll(name)) return true;
    const row = getRunner(db, name);
    if (row === undefined) return false;
    const last = Date.parse(row.last_seen);
    if (!Number.isFinite(last)) return false;
    return Date.now() - last <= runnerPresenceGraceMs();
  });
  // Dead-orchestrator session reap on start (#280) — do not wait for the
  // scheduled retention sweep (may be delayed by last_gc_at).
  try {
    const reaped = engine.reapDeadSessions();
    if (reaped.length > 0) {
      appendDaemonDiag(paths, `session-reap: startup removed ${reaped.length} dead session(s)`);
    }
  } catch (err) {
    appendDaemonDiag(paths, `session-reap: startup error: ${String(err)}`);
  }
  // UI discovery must never take the daemon down: it's spawned detached with
  // stdio ignored, so an exception here (e.g. a corrupt parley.json) would
  // brick every CLI command with no visible cause. Degrade to "no UI" and
  // best-effort report the reason instead.
  let uiBundleDir: string | null = null;
  try {
    uiBundleDir = discoverUiBundle(paths);
  } catch (err) {
    process.stderr.write(`parley daemon: UI discovery failed, serving no UI: ${String(err)}\n`);
  }
  const server = http.createServer(
    createHandler(engine, uiBundleDir, paths, options.identity, db, adapters),
  );
  // Children must never outlive the daemon (no orphans): whatever path the
  // process exits through — graceful close below, crash, signal handler —
  // hard-stop any still-running vendor children on the way out.
  process.on("exit", () => {
    engine.killChildren();
  });

  // Idle auto-shutdown (#130). Open connections count as activity by
  // construction: an SSE stream, a blocked long-poll, or a child's MCP call is
  // an in-flight request until its socket closes, so `inFlight === 0` means no
  // watcher, no poller, no child is attached. Unsettled tasks are checked last
  // (cheap COUNT) so a quiet daemon with running work never exits.
  let inFlight = 0;
  let lastActivity = Date.now();
  server.on("request", (req, res) => {
    inFlight += 1;
    lastActivity = Date.now();
    res.on("close", () => {
      inFlight -= 1;
      lastActivity = Date.now();
    });
  });
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  let idleTimer: NodeJS.Timeout | undefined;
  if (idleTimeoutMs > 0 && options.onIdle !== undefined) {
    const onIdle = options.onIdle;
    const pollMs = Math.max(250, Math.min(15_000, Math.floor(idleTimeoutMs / 4)));
    idleTimer = setInterval(() => {
      if (inFlight !== 0) return;
      if (Date.now() - lastActivity < idleTimeoutMs) return;
      if (countUnsettledTasks(db) !== 0) return;
      clearInterval(idleTimer);
      onIdle();
    }, pollMs);
    // unref: the idle watchdog must never be what keeps the process alive.
    idleTimer.unref();
  }

  // Retention sweep schedule (#153): respects last_gc_at across restarts.
  const stopGc = scheduleRetentionGc(engine, db, paths);

  return new Promise<DaemonServer>((resolve, reject) => {
    const failed = (err: Error): void => {
      stopGc();
      db.close();
      reject(err);
    };
    server.once("error", failed);
    server.listen(0, bind, () => {
      server.removeListener("error", failed);
      const address = server.address();
      if (address === null || typeof address === "string") {
        failed(new Error("daemon server did not bind a TCP port"));
        return;
      }
      const port = address.port;
      engine.setHubPort(port);
      const close = () =>
        new Promise<void>((resolveClose, rejectClose) => {
          stopGc();
          if (idleTimer !== undefined) clearInterval(idleTimer);
          // Stop children first: a live child holds an open MCP connection
          // (a blocked ask_orchestrator) that would keep the server from
          // closing; killing it releases the socket.
          engine.killChildren();
          server.close((err) => {
            db.close();
            if (err) rejectClose(err);
            else resolveClose();
          });
          // Sever lingering CLI long-polls too — shutdown must not wait out
          // a 25s poll window.
          server.closeAllConnections();
        });
      resolve({ port, bind, close });
    });
  });
}
