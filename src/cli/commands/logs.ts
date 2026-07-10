import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonGet, ensureDaemon } from "../client.js";
import type { CliContext } from "../context.js";
import { UsageError } from "../errors.js";
import { sleep } from "../../util/time.js";
import { TERMINAL_STATES, type TaskRow } from "../../daemon/db.js";
import type { Envelope } from "../../daemon/report.js";

const FOLLOW_POLL_MS = 100;
/**
 * A task turns terminal at `submit_report` time, while the vendor child may
 * still be flushing its last stream lines (e.g. the tool-call echo). After the
 * terminal state, keep draining until the log stops growing for this long.
 */
const SETTLE_MS = 500;

interface TaskResponse {
  task: Envelope;
  row: TaskRow;
}

/** Print any bytes appended to `file` since `offset`; returns the new offset. */
function drain(ctx: CliContext, file: string, offset: number): number {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return offset; // log not created yet
  }
  if (stat.size <= offset) return offset;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(stat.size - offset);
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
    ctx.stdout(buffer.toString("utf8", 0, read));
    return offset + read;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `parley logs <task> [--follow]` — print the task's raw captured vendor
 * stream (per-task JSONL, stored untouched). With `--follow`, keep streaming
 * until the task reaches a terminal state and the log is drained.
 */
export async function runLogs(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--follow": { aliases: ["-f"] },
    "--json": {},
  });
  const ref = positionals[0];
  if (ref === undefined) throw new UsageError("usage: parley logs <task> [--follow]");

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let task: TaskResponse;
  try {
    task = await daemonGet<TaskResponse>(discovery, `/tasks/${encodeURIComponent(ref)}`);
  } catch (err) {
    if (err instanceof DaemonRequestError && err.status === 404) {
      throw new UsageError(`logs: ${err.message}`);
    }
    throw err;
  }
  const taskId = task.row.id;
  const logFile = path.join(ctx.paths.tasks, taskId, "vendor.jsonl");

  let offset = drain(ctx, logFile, 0);
  if (flags["--follow"] !== true) return 0;

  for (;;) {
    const { row } = await daemonGet<TaskResponse>(
      discovery,
      `/tasks/${encodeURIComponent(taskId)}`,
    );
    offset = drain(ctx, logFile, offset);
    if (TERMINAL_STATES.has(row.state)) break;
    await sleep(FOLLOW_POLL_MS);
  }

  // Terminal: drain until the log has stopped growing for a settle window.
  let quietSince = Date.now();
  for (;;) {
    await sleep(FOLLOW_POLL_MS);
    const next = drain(ctx, logFile, offset);
    if (next > offset) {
      offset = next;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= SETTLE_MS) {
      return 0;
    }
  }
}
