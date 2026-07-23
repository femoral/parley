/**
 * Task-state transition module (#206): one write path that owns state write +
 * notify pairing (seq bump, transition log, waiter wake, concurrency drain).
 *
 * Deliberately a dumb recorder — domain guards (legal from→to, report-wins,
 * cancel races) stay in the engine. This module only commits a decided state.
 */
import {
  isTerminalState,
  type TaskState,
} from "@useparley/core";
import {
  bumpTaskSeq,
  getTask,
  writeTaskState,
  type DatabaseHandle,
  type TaskDataPatch,
} from "./db.js";

/**
 * One recorded task-state transition (#34): the global `seq` it was assigned,
 * the task that changed, and the state it moved to.
 */
export interface Transition {
  seq: number;
  task_id: string;
  state: string;
}

/**
 * Why the state moved — free-string / narrow union for logs and tests.
 * Not an edge key; not validated as a closed enum in v1.
 */
export type TransitionCause =
  | "spawn"
  | "runner_claim"
  | "enqueue"
  | "ask"
  | "answer"
  | "submit_report_unawait"
  | "complete"
  | "fail"
  | "cancel"
  | "answer_timeout"
  | "bootstrap_sweep"
  | "dry_run_purge"
  | (string & {});

/** Co-fields frequently written with a state change (data patch, no state). */
export type TransitionFields = TaskDataPatch;

export interface TransitionHooks {
  /** Append-only log (engine.transitions today). */
  append(transition: Transition): void;
  /** Wake inbox / firehose / SSE waiters. */
  wake(): void;
  /**
   * Called when the new state frees a concurrency slot.
   * Today: terminal or stalled → drainConcurrencyQueue.
   */
  onSlotFreed?(taskId: string, state: TaskState): void;
  /** Dry-run terminal purge scheduling. */
  onTerminal?(taskId: string, state: TaskState): void;
}

export interface TaskTransitions {
  /**
   * Read current row, write `to` + fields, bump seq, append log, wake, hooks.
   * No-op (return null) if the task is missing.
   * Idempotent skip: if `row.state === to` and no fields / force, return null.
   */
  apply(
    taskId: string,
    to: TaskState,
    opts?: {
      cause?: TransitionCause;
      fields?: TransitionFields;
      force?: boolean;
    },
  ): Transition | null;

  /**
   * Startup sweep helper: tasks already bulk-updated to stalled in SQL.
   * Only bumps seq + append (if log is live) without re-writing state.
   * Used when the engine constructs after sweepInterruptedTasks.
   * Does not wake waiters (matches bootstrap policy in db.sweepInterruptedTasks).
   */
  recordExternal(
    taskId: string,
    state: TaskState,
    cause: TransitionCause,
  ): Transition | null;
}

/**
 * Documented observed edges; used by tests / development asserts only.
 * Not a production hard-fail table (#206 Q1).
 */
export const OBSERVED_EDGES: ReadonlyArray<readonly [TaskState, TaskState]> = [
  ["pending", "running"],
  ["pending", "queued"],
  ["pending", "cancelled"],
  ["pending", "stalled"],
  ["queued", "running"],
  ["queued", "cancelled"],
  ["queued", "stalled"],
  ["running", "awaiting_answer"],
  ["running", "completed"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["running", "stalled"],
  ["awaiting_answer", "running"],
  ["awaiting_answer", "stalled"],
  ["awaiting_answer", "completed"],
  ["awaiting_answer", "failed"],
  ["awaiting_answer", "cancelled"],
  ["stalled", "running"],
  ["stalled", "cancelled"],
];

export function createTaskTransitions(
  db: DatabaseHandle,
  hooks: TransitionHooks,
): TaskTransitions {
  return {
    apply(taskId, to, opts) {
      const row = getTask(db, taskId);
      if (!row) return null;
      const fields = opts?.fields;
      const hasFields = fields !== undefined && Object.keys(fields).length > 0;
      if (row.state === to && !opts?.force && !hasFields) {
        return null;
      }
      writeTaskState(db, taskId, to, fields);
      const seq = bumpTaskSeq(db, taskId);
      const transition: Transition = { seq, task_id: taskId, state: to };
      hooks.append(transition);
      hooks.wake();
      if (isTerminalState(to) || to === "stalled") {
        hooks.onSlotFreed?.(taskId, to);
      }
      if (isTerminalState(to)) {
        hooks.onTerminal?.(taskId, to);
      }
      return transition;
    },
    recordExternal(taskId, state, _cause) {
      const row = getTask(db, taskId);
      if (!row) return null;
      const seq = bumpTaskSeq(db, taskId);
      const transition: Transition = { seq, task_id: taskId, state };
      hooks.append(transition);
      // No wake on bootstrap — matches today's sweep (db.ts).
      return transition;
    },
  };
}
