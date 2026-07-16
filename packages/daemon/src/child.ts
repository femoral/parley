import type http from "node:http";
import { TASK_HEADER, type TaskEngine } from "./engine.js";
import { buildEnvelope } from "./report.js";

/**
 * Child REST surface (ADR-0011 / #109): thin HTTP front-end over the same
 * engine methods MCP uses, correlated by the same `x-parley-task` header.
 * Fallback for harnesses that cannot speak MCP.
 */

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Resolve the task-correlation header; 400 when missing or unknown. */
function resolveTaskId(
  engine: TaskEngine,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): string | null {
  const header = req.headers[TASK_HEADER];
  const taskId = Array.isArray(header) ? header[0] : header;
  if (!taskId || !engine.get(taskId)) {
    sendJson(res, 400, {
      error: `missing or unknown ${TASK_HEADER} header — child requests must be task-correlated`,
    });
    return null;
  }
  return taskId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * `POST /child/report` — body is the report object. Same validation path as
 * MCP `submit_report`: 200 `{accepted:true}` or 400 `{errors:[…]}`.
 */
export function handleChildReport(
  engine: TaskEngine,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown,
): void {
  const taskId = resolveTaskId(engine, req, res);
  if (taskId === null) return;

  const errors = engine.submitReport(taskId, body ?? {});
  if (errors !== null) {
    sendJson(res, 400, { errors });
    return;
  }
  sendJson(res, 200, { accepted: true });
}

/**
 * `POST /child/ask` — body `{question}`; long-polls on `engine.askOrchestrator`
 * until answered (200 `{answer}`) or the engine stalls on answer-timeout
 * (504 `{error}`). No HTTP-layer timer — the engine owns answer timing.
 */
export async function handleChildAsk(
  engine: TaskEngine,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown,
): Promise<void> {
  const taskId = resolveTaskId(engine, req, res);
  if (taskId === null) return;

  if (!isRecord(body) || typeof body.question !== "string" || body.question.trim() === "") {
    sendJson(res, 400, { error: "ask requires a non-empty 'question' string" });
    return;
  }

  // Disable socket idle timeouts for this long-poll. The request body is small
  // (so server.requestTimeout does not apply once headers/body are in), but a
  // socket timeout would still kill a multi-minute wait. Engine owns the stall
  // timer — no HTTP-layer answer deadline here.
  req.setTimeout(0);
  res.setTimeout(0);

  const result = await engine.askOrchestrator(taskId, body.question);
  if ("error" in result) {
    // Stall/timeout is 504 so the child may exit; the task is resumable.
    // Other engine rejections (settled task, already pending, …) are 400.
    const status = result.error.startsWith("answer timeout") ? 504 : 400;
    sendJson(res, status, { error: result.error });
    return;
  }
  sendJson(res, 200, { answer: result.answer });
}

/**
 * `GET /child/task` — the child's own task envelope (self-inspection).
 */
export function handleChildTask(
  engine: TaskEngine,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const taskId = resolveTaskId(engine, req, res);
  if (taskId === null) return;

  const task = engine.get(taskId);
  if (!task) {
    // Race: task vanished between resolve and get — treat as unknown header.
    sendJson(res, 400, {
      error: `missing or unknown ${TASK_HEADER} header — child requests must be task-correlated`,
    });
    return;
  }
  sendJson(res, 200, buildEnvelope(task, engine.logDir(task.id)));
}
