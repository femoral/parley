import http from "node:http";
import type { HomePaths } from "../home.js";
import { createAdapterRegistry } from "./adapters/index.js";
import { openDatabase, sweepInterruptedTasks } from "./db.js";
import { DEFAULT_NETWORK, DEFAULT_SANDBOX, isSandboxMode } from "./adapters/types.js";
import type { ContextFile } from "./context.js";
import { DelegateError, TaskEngine } from "./engine.js";
import { handleMcpRequest } from "./mcp.js";
import { buildEnvelope } from "./report.js";

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
 * question event) without 25s waits.
 */
const LONG_POLL_WINDOW_MS = (() => {
  const parsed = Number(process.env.PARLEY_LONG_POLL_MS ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25_000;
})();

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
  const vendor = body.vendor;
  const cwd = body.cwd;
  const orchestratorSessionId = body.orchestrator_session_id;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    sendJson(res, 400, { error: "prompt is required" });
    return;
  }
  if (typeof vendor !== "string" || vendor === "") {
    sendJson(res, 400, { error: "vendor is required" });
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
  // Posture: the CLI validates too, but guard the wire — an unknown mode is a
  // client mistake (→ 400 → exit 2), not a 500. Absent fields take ADR-0006
  // defaults so a bare `POST /tasks` still gets a well-formed posture.
  const sandbox = body.sandbox === undefined ? DEFAULT_SANDBOX : body.sandbox;
  if (typeof sandbox !== "string" || !isSandboxMode(sandbox)) {
    sendJson(res, 400, { error: `unknown sandbox mode: ${String(body.sandbox)}` });
    return;
  }
  const network = body.network === undefined ? DEFAULT_NETWORK : body.network === true;
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
  try {
    const task = engine.delegate({
      prompt,
      vendor,
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
 * `GET /tasks/:ref/events?wait=true` — long-poll until the task reaches a
 * terminal state (or the poll window elapses; the CLI re-polls). Responds with
 * the event name and the task's report envelope.
 */
async function handleEvents(
  engine: TaskEngine,
  res: http.ServerResponse,
  ref: string,
  wait: boolean,
): Promise<void> {
  const task = engine.resolve(ref);
  if (!task) {
    sendJson(res, 404, { error: `no such task: ${ref}` });
    return;
  }
  const row = wait ? await engine.waitForEvent(task.id, LONG_POLL_WINDOW_MS) : task;
  if (!row) {
    sendJson(res, 404, { error: `no such task: ${ref}` });
    return;
  }
  sendJson(res, 200, {
    event: eventFor(row.state),
    task: buildEnvelope(row, engine.logDir(row.id)),
  });
}

/**
 * Map a task state to its CLI event name (spec §3), or null when the state is
 * not itself an event (the poll window elapsed while the task is still live —
 * the caller re-polls).
 */
function eventFor(state: string): string | null {
  if (state === "awaiting_answer") return "task.question";
  if (["completed", "failed", "cancelled", "stalled"].includes(state)) {
    return `task.${state}`;
  }
  return null;
}

/**
 * Map a transition's state to the `parley watch` event name (spec §3). Unlike
 * `eventFor` (single-task long-poll, which only wakes on event states), watch
 * surfaces every transition — including `running` as `task.started`.
 */
function watchEventFor(state: string): string {
  if (state === "running") return "task.started";
  if (state === "awaiting_answer") return "task.question";
  return `task.${state}`;
}

/**
 * `GET /tasks/events?ids=…&since=<seq>&wait=true` — the multi-task long-poll
 * (#34, spec §3). Returns the earliest transition of any watched task after
 * `since` (replaying immediately if one already happened, else blocking until
 * the next), or `{ event: null }` when the poll window elapses. Omitting `since`
 * means "start from now" — the current global seq, so nothing before connect is
 * replayed. An unknown task id is a client mistake (404 → the CLI exits 2).
 */
async function handleWatchEvents(
  engine: TaskEngine,
  res: http.ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const ids = (params.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (ids.length === 0) {
    sendJson(res, 400, { error: "ids is required" });
    return;
  }
  // Resolve every ref to its canonical id up front — a bad id must fail fast
  // (404 → exit 2), never silently hang the watcher.
  const resolved: string[] = [];
  for (const ref of ids) {
    const task = engine.resolve(ref);
    if (!task) {
      sendJson(res, 404, { error: `no such task: ${ref}` });
      return;
    }
    resolved.push(task.id);
  }
  const sinceRaw = params.get("since");
  const since = sinceRaw !== null ? Number(sinceRaw) : engine.currentSeq();
  if (!Number.isFinite(since) || since < 0) {
    sendJson(res, 400, { error: "since must be a non-negative number" });
    return;
  }
  const wait = params.get("wait") === "true";
  const transition = wait
    ? await engine.waitForEvents(resolved, since, LONG_POLL_WINDOW_MS)
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
 * `POST /tasks/:ref/eval` — record an orchestrator's quality score/feedback
 * against a task. The CLI validates `--score`/`--feedback` too, but guard the
 * wire — a malformed score is a client mistake (400 → exit 2), not a 500.
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
  const score = body.score;
  const feedback = body.feedback;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 10) {
    sendJson(res, 400, { error: "score must be an integer between 1 and 10" });
    return;
  }
  if (typeof feedback !== "string" || feedback === "") {
    sendJson(res, 400, { error: "feedback is required" });
    return;
  }
  try {
    const row = engine.evalTask(ref, score, feedback);
    sendJson(res, 200, { task_id: row.id, name: row.name, state: row.state, seq: row.seq });
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
 * Build the daemon's HTTP request handler: the CLI plane (REST, spec §3) plus
 * the MCP child channel on `/mcp` (spec §4).
 */
function createHandler(engine: TaskEngine): http.RequestListener {
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

      if (method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { status: "ok", pid: process.pid });
        return;
      }

      if (method === "POST" && url.pathname === "/clean") {
        handleClean(engine, res, await readBody(req));
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
        // `GET /tasks/events` (multi-task watch, #34) sits at the same depth as
        // `GET /tasks/:ref`, so it must be matched before the ref is resolved.
        if (method === "GET" && segments.length === 2 && segments[1] === "events") {
          await handleWatchEvents(engine, res, url.searchParams);
          return;
        }
        const ref = decodeURIComponent(segments[1] ?? "");
        if (method === "GET" && segments.length === 2) {
          const task = engine.resolve(ref);
          if (!task) sendJson(res, 404, { error: `no such task: ${ref}` });
          else sendJson(res, 200, { task: buildEnvelope(task, engine.logDir(task.id)), row: task });
          return;
        }
        if (method === "GET" && segments.length === 3 && segments[2] === "events") {
          await handleEvents(engine, res, ref, url.searchParams.get("wait") === "true");
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
 */
export function startServer(paths: HomePaths): Promise<DaemonServer> {
  const db = openDatabase(paths);
  // Crash sweep (spec §3): tasks recorded live by a previous daemon lost their
  // children with its process group — mark them stalled before taking requests.
  sweepInterruptedTasks(db);
  const engine = new TaskEngine(db, paths, createAdapterRegistry());
  const server = http.createServer(createHandler(engine));
  // Children must never outlive the daemon (no orphans): whatever path the
  // process exits through — graceful close below, crash, signal handler —
  // hard-stop any still-running vendor children on the way out.
  process.on("exit", () => {
    engine.killChildren();
  });

  return new Promise<DaemonServer>((resolve, reject) => {
    const failed = (err: Error): void => {
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
