import http from "node:http";
import type { HomePaths } from "../home.js";
import { createAdapterRegistry } from "./adapters/index.js";
import { openDatabase, sweepInterruptedTasks } from "./db.js";
import { DEFAULT_NETWORK, DEFAULT_SANDBOX, isSandboxMode } from "./adapters/types.js";
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
  if (typeof prompt !== "string" || prompt.trim() === "") {
    sendJson(res, 400, { error: "prompt is required" });
    return;
  }
  if (typeof vendor !== "string" || vendor === "") {
    sendJson(res, 400, { error: "vendor is required" });
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
  try {
    const task = engine.delegate({
      prompt,
      vendor,
      cwd,
      model: optionalString(body.model),
      name: optionalString(body.name),
      // Absent/non-boolean defaults to bypass (old `--cwd`-only behaviour).
      useWorktree: body.use_worktree === true,
      baseRef: optionalString(body.base_ref),
      sandbox,
      network,
      answerTimeoutMs,
    });
    sendJson(res, 201, { task_id: task.id, name: task.name, state: task.state });
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
  sendJson(res, 200, { event: eventFor(row.state), task: buildEnvelope(row) });
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
    sendJson(res, 200, { task_id: row.id, name: row.name, state: row.state });
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
          sendJson(res, 200, { tasks: engine.list() });
          return;
        }
        if (method === "POST" && segments.length === 1) {
          handleDelegate(engine, res, await readBody(req));
          return;
        }
        const ref = decodeURIComponent(segments[1] ?? "");
        if (method === "GET" && segments.length === 2) {
          const task = engine.resolve(ref);
          if (!task) sendJson(res, 404, { error: `no such task: ${ref}` });
          else sendJson(res, 200, { task: buildEnvelope(task), row: task });
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
