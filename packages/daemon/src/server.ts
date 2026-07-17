import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  collectUnknownConfigKeys,
  getConfigPath,
  isMetricsGroupBy,
  isTaskDifficulty,
  isTaskSize,
  METRICS_GROUP_BY,
  setConfigPath,
  TASK_DIFFICULTIES,
  TASK_SIZES,
  unsetConfigPath,
  validateConfig,
  writeConfig,
  type HomePaths,
  type ParleyConfig,
  readConfig,
} from "@useparley/core";
import { createAdapterRegistry } from "./adapters/index.js";
import {
  countUnsettledTasks,
  getMeta,
  META_LAST_GC_AT,
  openDatabase,
  setMeta,
  sweepInterruptedTasks,
  TERMINAL_STATES,
  type DatabaseHandle,
} from "./db.js";
import type { DaemonIdentity } from "./identity.js";
import { isSandboxMode, type SandboxMode } from "./adapters/types.js";
import type { ContextFile } from "./context.js";
import { DelegateError, TaskEngine } from "./engine.js";
import { readLogTail } from "./logtail.js";
import { handleChildAsk, handleChildReport, handleChildTask } from "./child.js";
import { aggregateMetrics } from "./metrics.js";
import { handleMcpRequest } from "./mcp.js";
import { buildEnvelope } from "./report.js";
import { discoverUiBundle, isReservedPath, serveUiRequest } from "./ui.js";
import { DAEMON_VERSION } from "./version.js";
import { handleXaiProxyRequest } from "./xai-proxy.js";

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
        appendDaemonDiag(paths, `gc: ${f.task_id} failed: ${f.error}`);
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
  /** Close the server and its database. */
  close: () => Promise<void>;
}

/**
 * How long one `/events?wait=true` long-poll blocks before the CLI re-polls.
 * `PARLEY_LONG_POLL_MS` overrides it — tests shrink the window to exercise
 * re-poll behavior (e.g. a waiter observing a stall after missing the
 * question event) without 25s waits. Read per call so tests can set the env
 * after the module loads.
 */
function longPollWindowMs(): number {
  const parsed = Number(process.env.PARLEY_LONG_POLL_MS ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25_000;
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
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
  // Vendor optional when profile is set; engine resolves precedence (#113).
  const vendor = optionalString(body.vendor);
  const profile = optionalString(body.profile);
  if (vendor === null && profile === null) {
    sendJson(res, 400, { error: "vendor or profile is required" });
    return;
  }
  if (typeof orchestratorSessionId !== "string" || orchestratorSessionId === "") {
    sendJson(res, 400, { error: "orchestrator_session_id is required" });
    return;
  }
  if (typeof cwd !== "string" || cwd === "") {
    sendJson(res, 400, { error: "cwd is required" });
    return;
  }
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
  // Classification (#118): optional size/difficulty; reject unknown enum values.
  let size: string | null = null;
  if (body.size !== undefined && body.size !== null) {
    if (typeof body.size !== "string" || !isTaskSize(body.size)) {
      sendJson(res, 400, {
        error: `invalid size: ${String(body.size)} (expected ${TASK_SIZES.join("|")})`,
      });
      return;
    }
    size = body.size;
  }
  let difficulty: string | null = null;
  if (body.difficulty !== undefined && body.difficulty !== null) {
    if (typeof body.difficulty !== "string" || !isTaskDifficulty(body.difficulty)) {
      sendJson(res, 400, {
        error: `invalid difficulty: ${String(body.difficulty)} (expected ${TASK_DIFFICULTIES.join("|")})`,
      });
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
  try {
    const task = engine.delegate({
      prompt,
      vendor,
      profile,
      cwd,
      orchestratorSessionId,
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
    });
    sendJson(res, 201, { task_id: task.id, name: task.name, state: task.state, seq: task.seq });
  } catch (err) {
    if (err instanceof DelegateError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
}

/**
 * Extract `Authorization: Bearer <token>` and match it to a configured runner
 * name. Returns the runner name, or null when auth fails (caller sends 401).
 * When `expectedName` is set, the token must belong to that exact runner.
 */
function authenticateRunner(
  req: http.IncomingMessage,
  config: ParleyConfig,
  expectedName?: string,
): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (token === "") return null;
  const runners = config.runners ?? {};
  if (expectedName !== undefined) {
    const entry = runners[expectedName];
    if (entry === undefined || entry.token !== token) return null;
    return expectedName;
  }
  for (const [name, entry] of Object.entries(runners)) {
    if (entry.token === token) return name;
  }
  return null;
}

/** Re-read config for runner auth (hot, same posture as profiles). */
function readRunnerConfig(paths: HomePaths): ParleyConfig {
  try {
    return readConfig(paths.config);
  } catch {
    return {};
  }
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
function handleConfigGet(paths: HomePaths, res: http.ServerResponse, key: string | null): void {
  let config: ParleyConfig;
  try {
    config = loadAdminConfig(paths);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (key === null || key === "") {
    sendJson(res, 200, { config });
    return;
  }
  try {
    const hit = getConfigPath(config, key);
    if (!hit.found) {
      sendJson(res, 404, { error: `no such config key: ${key}` });
      return;
    }
    sendJson(res, 200, { key, value: hit.value });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `PUT /config` — wholesale replace (push). Validates the entire body first;
 * on failure nothing is written. Unknown keys are preserved and listed in
 * `warnings` so the CLI can surface them without rejecting the push.
 */
function handleConfigPut(paths: HomePaths, res: http.ServerResponse, body: unknown): void {
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
 */
function handleConfigSet(paths: HomePaths, res: http.ServerResponse, body: unknown): void {
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
 */
function handleConfigUnset(paths: HomePaths, res: http.ServerResponse, body: unknown): void {
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
 * `GET /metrics?session=<id|all>&group_by=<vendor|model|profile|size|difficulty|type>`
 * — per-group task/eval/token/duration aggregates (#118). Defaults: session=all,
 * group_by=vendor.
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
  sendJson(res, 200, aggregateMetrics(engine.list(), { session, groupBy: groupByRaw }));
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
 * `TERMINAL_STATES` (`completed`/`failed`/`cancelled`) *and* its child has
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
  const eof = TERMINAL_STATES.has(task.state) && !engine.hasLiveChild(task.id);
  const logPath = path.join(engine.logDir(task.id), "vendor.jsonl");
  const { bytes: chunk, next } = readLogTail(logPath, since);
  sendJson(res, 200, { chunk, next, eof });
}

/**
 * Map a transition's state to the `parley watch` event name (spec §3). Watch
 * surfaces every transition — including `running` as `task.started`.
 */
function watchEventFor(state: string): string {
  if (state === "running") return "task.started";
  if (state === "awaiting_answer") return "task.question";
  return `task.${state}`;
}

/**
 * Resolve `ids` query param to canonical task ids. Empty is allowed (vacuous
 * all-done / empty firehose). A bad ref is 404 → CLI exit 2.
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
    if (!task) {
      return { error: `no such task: ${ref}`, status: 404 };
    }
    resolved.push(task.id);
  }
  return [...new Set(resolved)];
}

/**
 * `GET /tasks/inbox?ids=…&ack=<seq>&wait=true` — the acked attention inbox
 * (ADR-0007 / #91). Optionally acks a prior event id, then returns the next
 * pending event (level-triggered: immediate if already pending), `{ all_done:
 * true }` when every watched task is terminal and every event is acked, or
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
    ? await engine.waitForInbox(resolved, longPollWindowMs())
    : (() => {
        const pending = engine.peekInbox(resolved);
        if (pending) return { task: pending } as const;
        if (engine.isInboxAllDone(resolved)) return { allDone: true } as const;
        return null;
      })();

  if (result === null) {
    sendJson(res, 200, {
      event: null,
      seq: engine.currentSeq(),
      task: null,
      all_done: false,
    });
    return;
  }
  if ("allDone" in result) {
    sendJson(res, 200, {
      event: null,
      seq: engine.currentSeq(),
      task: null,
      all_done: true,
    });
    return;
  }
  const row = result.task;
  const task = buildEnvelope(row, engine.logDir(row.id));
  sendJson(res, 200, {
    event: watchEventFor(row.state),
    seq: row.seq,
    task,
    all_done: false,
  });
}

/**
 * `GET /tasks/events?ids=…&since=<seq>&wait=true` — the multi-task transition
 * firehose (#34). Used by `watch --follow` (no ack). Returns the earliest
 * transition of any watched task after `since` (replaying immediately if one
 * already happened, else blocking until the next), or `{ event: null }` when
 * the poll window elapses. Omitting `since` means "start from now".
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
  if (resolved.length === 0) {
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
    ? await engine.waitForEvents(resolved, since, longPollWindowMs())
    : engine.peekEvent(resolved, since);
  if (!transition) {
    sendJson(res, 200, { event: null, seq: since, task: null });
    return;
  }
  const row = engine.get(transition.task_id);
  if (!row) {
    sendJson(res, 200, { event: null, seq: transition.seq, task: null });
    return;
  }
  // The envelope carries the current row for detail, but its `state`/`seq` are
  // pinned to the transition so the event name and the CLI's exit code agree
  // even if the row has since moved on (a superseded non-terminal transition).
  const task = buildEnvelope(row, engine.logDir(row.id));
  task.state = transition.state;
  task.seq = transition.seq;
  sendJson(res, 200, { event: watchEventFor(transition.state), seq: transition.seq, task });
}

/**
 * Serialize one transition as an SSE message (spec §"New: SSE event stream"):
 * `id:` is the transition seq (the `Last-Event-ID` a reconnect resumes from),
 * `event:` is the watch event name, `data:` is the task envelope pinned to the
 * transition — same pinning rule as the long-poll, so a superseded non-terminal
 * transition still reports the state/seq it fired at. Returns null when the
 * transition's row has vanished (never expected in practice).
 */
function sseMessageFor(engine: TaskEngine, transition: { seq: number; task_id: string; state: string }): string | null {
  const row = engine.get(transition.task_id);
  if (!row) return null;
  const task = buildEnvelope(row, engine.logDir(row.id));
  task.state = transition.state;
  task.seq = transition.seq;
  const data = JSON.stringify(task);
  return `id: ${transition.seq}\nevent: ${watchEventFor(transition.state)}\ndata: ${data}\n\n`;
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
  try {
    const row = engine.evalTask(ref, answers as Record<string, boolean>, feedback);
    sendJson(res, 200, {
      task_id: row.id,
      name: row.name,
      state: row.state,
      seq: row.seq,
      eval_score: row.eval_score,
      eval_baseline: row.eval_baseline,
      eval_rubric: row.eval_rubric,
      eval_rubric_version: row.eval_rubric_version,
    });
  } catch (err) {
    if (err instanceof DelegateError) {
      sendJson(res, 400, { error: err.message });
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

/**
 * `POST /tasks/:ref/fix` — create a linked attempt that inherits the parent's
 * classification/workspace and optionally resumes its vendor session (#152).
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
  try {
    const task = engine.fix({ parentRef: ref, prompt });
    sendJson(res, 201, {
      task_id: task.id,
      name: task.name,
      state: task.state,
      seq: task.seq,
      parent_task_id: task.parent_task_id,
      attempt: task.attempt,
      resumed: task.resumed === 1,
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
  identity?: DaemonIdentity,
): http.RequestListener {
  return (req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const segments = url.pathname.split("/").filter((s) => s !== "");

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

      // Remote runner surface (#111 / ADR-0012): bearer-token auth; not localhost trust.
      if (segments[0] === "runner") {
        const config = readRunnerConfig(paths);
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
          // Disable socket idle timeouts for the long-poll window.
          req.setTimeout(0);
          res.setTimeout(0);
          const leased = await engine.leaseRunnerTask(runnerName, longPollWindowMs());
          if (leased === null) {
            res.writeHead(204);
            res.end();
            return;
          }
          sendJson(res, 200, leased);
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
          try {
            engine.runnerHeartbeat(taskId, runnerName);
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
          try {
            const row = engine.failRunnerTask(taskId, runnerName, body.error);
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

      // `GET /sessions` — historical orchestrator sessions for the roster
      // selector (#88). Optional `?q=` filters by id substring.
      if (method === "GET" && url.pathname === "/sessions") {
        const q = url.searchParams.get("q");
        sendJson(res, 200, { sessions: engine.listSessions(q ?? undefined) });
        return;
      }

      // `GET /metrics` — task/eval/token/duration aggregates (#118).
      if (method === "GET" && url.pathname === "/metrics") {
        handleMetrics(engine, res, url.searchParams);
        return;
      }

      // `GET /prompt` — composed PROMPT.md preview for current project (#159).
      if (method === "GET" && url.pathname === "/prompt") {
        handlePrompt(engine, res, url.searchParams);
        return;
      }

      // Config admin surface (#156): daemon's own parley.json via endpoints so
      // local and remote daemons share the same CLI path (never touch the file).
      if (segments[0] === "config") {
        if (method === "GET" && segments.length === 1) {
          handleConfigGet(paths, res, url.searchParams.get("key"));
          return;
        }
        if (method === "PUT" && segments.length === 1) {
          handleConfigPut(paths, res, await readBody(req));
          return;
        }
        if (method === "POST" && segments.length === 2 && segments[1] === "set") {
          handleConfigSet(paths, res, await readBody(req));
          return;
        }
        if (method === "POST" && segments.length === 2 && segments[1] === "unset") {
          handleConfigUnset(paths, res, await readBody(req));
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

      if (segments[0] === "tasks") {
        if (method === "GET" && segments.length === 1) {
          // The current global seq rides along so `parley watch` can capture a
          // "start from now" baseline atomically with the task snapshot (#34).
          sendJson(res, 200, { tasks: engine.list(), seq: engine.currentSeq() });
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
            sendJson(res, 200, {
              task: buildEnvelope(task, engine.logDir(task.id)),
              row: task,
              qa: engine.listQa(task.id),
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

/**
 * Start the daemon HTTP server bound to `127.0.0.1:0` (ephemeral port), open
 * the task-state database, and wire up the task engine. Does not touch the
 * discovery file — the daemon entry point publishes discovery once the port is
 * known.
 *
 * Plugin adapters (`vendors.<id>.plugin`) load here at startup only — adding a
 * plugin requires a daemon restart. Vendor args/env/profiles re-read per task.
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
  let startupConfig = {};
  try {
    startupConfig = readConfig(paths.config);
  } catch (err) {
    process.stderr.write(
      `parley daemon: config unreadable at startup, loading built-in adapters only: ${String(err)}\n`,
    );
  }
  const adapters = await createAdapterRegistry(process.env, {
    config: startupConfig,
    parleyHome: paths.home,
  });
  const engine = new TaskEngine(db, paths, adapters);
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
  const server = http.createServer(createHandler(engine, uiBundleDir, paths, options.identity));
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
    server.listen(0, "127.0.0.1", () => {
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
      resolve({ port, close });
    });
  });
}
