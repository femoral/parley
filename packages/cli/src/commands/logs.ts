import path from "node:path";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonGet, ensureDaemon } from "../client.js";
import type { CliContext } from "../context.js";
import { UsageError } from "../errors.js";
import { sleep } from "@useparley/core";
import { TERMINAL_STATES, type TaskRow } from "@useparley/daemon/db.js";
import { readLogTail } from "@useparley/daemon/logtail.js";
import type { Envelope } from "@useparley/daemon/report.js";

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

/**
 * Event types that end a turn rather than continue one — grok's own `error`/
 * `fatal` events use the same `{type, data}` wire shape as its token-streamed
 * `thought`/`text` chunks (see the fallback in adapters/grok.ts's parseEvent).
 * Two such lines are two distinct messages, never a continuation of each
 * other: coalescing them would silently run two failures together into one
 * string, and during `--follow` would hold a complete error invisible in the
 * buffer until an unrelated later chunk happened to change the type. These
 * are cross-vendor semantic names (codex's own error/fatal shapes never match
 * the 2-key check below anyway), not a vendor-specific list.
 */
const TERMINAL_EVENT_TYPES = new Set(["error", "fatal"]);

/**
 * Whether a raw JSONL line is a token-streamed chunk: an object with exactly a
 * string `type` and a string `data` field, and nothing else, and not one of
 * `TERMINAL_EVENT_TYPES`. This is the shape generic across any vendor that
 * streams sub-message chunks (grok's `thought`/`text` events are the observed
 * case) — keyed on shape, not on any vendor's event names, so a line with
 * extra fields (already a complete message) is left alone rather than having
 * those fields silently dropped.
 */
function chunkShape(line: string): { type: string; data: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2 || typeof obj.type !== "string" || typeof obj.data !== "string") {
    return null;
  }
  if (TERMINAL_EVENT_TYPES.has(obj.type)) return null;
  return { type: obj.type, data: obj.data };
}

/**
 * Coalesces consecutive chunk-shaped lines of the same `type` into one
 * rendered line per group. Any non-chunk-shaped line (already a complete
 * message) is flushed and emitted unchanged. Line-buffered so a byte chunk
 * landing mid-line (e.g. across two `--follow` polls) doesn't get parsed
 * early.
 */
class Coalescer {
  private pendingType: string | null = null;
  private pendingData = "";
  private leftover = "";

  constructor(private readonly emit: (line: string) => void) {}

  /** Feed newly-read bytes; processes every complete (`\n`-terminated) line. */
  push(bytes: string): void {
    this.leftover += bytes;
    let idx: number;
    while ((idx = this.leftover.indexOf("\n")) !== -1) {
      const line = this.leftover.slice(0, idx);
      this.leftover = this.leftover.slice(idx + 1);
      this.consume(line);
    }
  }

  /**
   * Flush the buffered chunk group (not the leftover partial line). Call
   * after every incremental `--follow` read so live output stays current even
   * mid-message, rather than withholding it until the type changes or the
   * stream ends.
   */
  flushPending(): void {
    this.flush();
  }

  /** Flush any buffered group and trailing partial line at stream end. */
  finish(): void {
    this.flush();
    if (this.leftover.length > 0) this.emit(this.leftover);
    this.leftover = "";
  }

  private consume(line: string): void {
    const shape = chunkShape(line);
    if (shape === null) {
      this.flush();
      this.emit(line);
      return;
    }
    if (this.pendingType !== null && this.pendingType !== shape.type) this.flush();
    this.pendingType = shape.type;
    this.pendingData += shape.data;
  }

  private flush(): void {
    if (this.pendingType === null) return;
    this.emit(JSON.stringify({ type: this.pendingType, data: this.pendingData }));
    this.pendingType = null;
    this.pendingData = "";
  }
}

/**
 * Read any bytes appended to `file` since `offset`, handing them to `onBytes`.
 * Thin wrapper over the shared `readLogTail` (also used by the daemon's
 * `GET /tasks/:ref/logs` route) — the CLI reads the file straight off disk
 * (same machine, no need to round-trip through HTTP) but shares the same
 * offset-read implementation so the two never drift on edge cases (missing
 * file, a cursor past the current length).
 */
function drain(file: string, offset: number, onBytes: (bytes: string) => void): number {
  const { bytes, next } = readLogTail(file, offset);
  if (bytes.length > 0) onBytes(bytes);
  return next;
}

/**
 * `parley logs <task> [--follow] [--json]` — print the task's captured vendor
 * stream. By default, consecutive token-streamed chunks of the same type
 * (e.g. grok's `thought`/`text` events) are coalesced into one readable line
 * per group; `--json` prints the raw per-event JSONL untouched (today's
 * behavior, byte-for-byte). With `--follow`, a buffered group is flushed after
 * every poll rather than held open until the type changes — so live output
 * stays current instead of going silent for the length of a long same-type
 * run — which means chunks arriving slower than the poll interval render as
 * separate lines under `--follow` where a post-hoc read of the same completed
 * log would show them merged into one. Ends when the task reaches a terminal
 * state and the log stops growing.
 */
export async function runLogs(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--follow": { aliases: ["-f"] },
    "--json": {},
  });
  const ref = positionals[0];
  if (ref === undefined) throw new UsageError("usage: parley logs <task> [--follow] [--json]");

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

  const coalescer =
    flags["--json"] === true ? null : new Coalescer((line) => ctx.stdout(`${line}\n`));
  const onBytes = (bytes: string): void => {
    if (coalescer === null) ctx.stdout(bytes);
    else coalescer.push(bytes);
  };

  let offset = drain(logFile, 0, onBytes);
  if (flags["--follow"] !== true) {
    coalescer?.finish();
    return 0;
  }

  // `finally` guarantees the last buffered group/partial line reaches stdout
  // even if the daemon dies mid-poll or the process is otherwise interrupted
  // — the old raw passthrough never buffered anything, so it never had this
  // failure mode; buffering for coalescing must not trade it away.
  try {
    for (;;) {
      const { row } = await daemonGet<TaskResponse>(
        discovery,
        `/tasks/${encodeURIComponent(taskId)}`,
      );
      offset = drain(logFile, offset, onBytes);
      coalescer?.flushPending();
      if (TERMINAL_STATES.has(row.state)) break;
      await sleep(FOLLOW_POLL_MS);
    }

    // Terminal: drain until the log has stopped growing for a settle window.
    let quietSince = Date.now();
    for (;;) {
      await sleep(FOLLOW_POLL_MS);
      const next = drain(logFile, offset, onBytes);
      if (next > offset) {
        offset = next;
        quietSince = Date.now();
        coalescer?.flushPending();
      } else if (Date.now() - quietSince >= SETTLE_MS) {
        return 0;
      }
    }
  } finally {
    coalescer?.finish();
  }
}
