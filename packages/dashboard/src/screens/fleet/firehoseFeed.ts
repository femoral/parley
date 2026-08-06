/**
 * Client-side firehose feed from snapshot + runs polls.
 *
 * useSnapshot does not expose raw SSE events; the fleet board diffs tasks and
 * runs and projects lines via {@link projectFirehoseLine}. Gate-VERB lines
 * are deferred (#360) — run.blocked surfaces as a hold, never approve/reject.
 */
import type { RunSummary, TaskEnvelope } from "@useparley/core";
import {
  projectFirehoseLine,
  workflowByRunId,
  type FirehoseInput,
} from "../../data/index.js";
import type { FirehoseLine } from "../../data/types.js";

export const FIREHOSE_CAP = 48;

export interface FirehoseCursor {
  /** task_id → last seen state+seq key */
  tasks: Map<string, string>;
  /** run_id → last seen state key */
  runs: Map<string, string>;
  lines: FirehoseLine[];
  seq: number;
}

export function emptyFirehoseCursor(): FirehoseCursor {
  return {
    tasks: new Map(),
    runs: new Map(),
    lines: [],
    seq: 0,
  };
}

function taskKey(t: TaskEnvelope): string {
  return `${t.state}|${t.seq ?? 0}|${t.updated_at ?? ""}`;
}

function runKey(r: RunSummary): string {
  const block = r.block?.reason ?? "";
  const node = r.current_node ?? "";
  return `${r.state}|${block}|${node}|${r.iteration}|${r.updated_at ?? ""}`;
}

function taskEventName(state: string): string {
  switch (state) {
    case "running":
      return "task.started";
    case "awaiting_answer":
      return "task.question";
    case "completed":
      return "task.completed";
    case "failed":
      return "task.failed";
    case "cancelled":
      return "task.cancelled";
    case "stalled":
      return "task.stalled";
    case "queued":
      return "task.queued";
    case "pending":
      return "task.pending";
    default:
      return `task.${state}`;
  }
}

function runEventName(r: RunSummary): string {
  if (r.state === "blocked") return "run.blocked";
  if (r.state === "running" && r.current_node) return "run.node_entered";
  if (r.state === "running") return "run.running";
  if (r.state === "completed") return "run.completed";
  if (r.state === "failed") return "run.failed";
  if (r.state === "cancelled") return "run.cancelled";
  return `run.${r.state}`;
}

/**
 * Diff tasks + runs against the previous cursor and append firehose lines.
 * First call seeds the cursor without flooding the well (bootstrap silence).
 */
export function advanceFirehose(
  cursor: FirehoseCursor,
  tasks: readonly TaskEnvelope[],
  runs: readonly RunSummary[],
  opts: { seed?: boolean; at?: string } = {},
): FirehoseCursor {
  const at = opts.at ?? new Date().toISOString();
  const workflows = workflowByRunId(runs);
  const nextTasks = new Map(cursor.tasks);
  const nextRuns = new Map(cursor.runs);
  const events: FirehoseInput[] = [];
  let seq = cursor.seq;

  for (const t of tasks) {
    const key = taskKey(t);
    const prev = nextTasks.get(t.task_id);
    if (prev === key) continue;
    nextTasks.set(t.task_id, key);
    if (!opts.seed && prev !== undefined) {
      seq += 1;
      events.push({
        subject: "task",
        event: taskEventName(t.state),
        seq,
        task: t,
        at,
      });
    } else if (!opts.seed && prev === undefined && cursor.tasks.size > 0) {
      // New task after bootstrap
      seq += 1;
      events.push({
        subject: "task",
        event: taskEventName(t.state),
        seq,
        task: t,
        at,
      });
    }
  }

  for (const r of runs) {
    const key = runKey(r);
    const prev = nextRuns.get(r.run_id);
    if (prev === key) continue;
    nextRuns.set(r.run_id, key);
    if (!opts.seed && (prev !== undefined || cursor.runs.size > 0)) {
      seq += 1;
      events.push({
        subject: "run",
        event: runEventName(r),
        seq,
        run: {
          run_id: r.run_id,
          state: r.state,
          current_node: r.current_node,
          iteration: r.iteration,
          seq: r.seq ?? seq,
        },
        at,
      });
    }
  }

  const projected = events.map((e) => projectFirehoseLine(e, workflows));
  const lines = [...cursor.lines, ...projected].slice(-FIREHOSE_CAP);

  return {
    tasks: nextTasks,
    runs: nextRuns,
    lines,
    seq,
  };
}

/** Color key for a firehose line from its state / event. */
export function firehoseTone(line: FirehoseLine): string {
  const s = line.state ?? "";
  if (s === "failed" || line.event.includes("failed")) return "failed";
  if (s === "awaiting_answer" || line.event.includes("question") || line.event.includes("blocked")) {
    return "awaiting";
  }
  if (s === "stalled") return "stalled";
  if (s === "running" || line.event.includes("started") || line.event.includes("running")) {
    return "running";
  }
  if (s === "completed") return "completed";
  if (s === "cancelled") return "cancelled";
  return "neutral";
}
