/**
 * Task-state transition module (#206 / #240): one write path that owns state
 * write + notify pairing (seq bump, transition log, waiter wake, concurrency
 * drain). Extended for the `run.*` firehose family (ADR-0019).
 *
 * Deliberately a dumb recorder — domain guards (legal from→to, report-wins,
 * cancel races) stay in the engine. This module only commits a decided state.
 */
import {
  isTerminalState,
  type RunBlockVerb,
  type TaskState,
} from "@useparley/core";
import {
  bumpRunSeq,
  bumpTaskSeq,
  getTask,
  writeTaskState,
  type DatabaseHandle,
  type TaskDataPatch,
} from "./db.js";

/**
 * One recorded transition (#34 / #240): the global `seq` it was assigned and
 * either a task state change or a run.* firehose event.
 *
 * Task transitions always carry `task_id` + `state`. When the task is
 * run-owned, `run_id` / `node` / `iteration` / `slot` are filled from the row
 * so `watch --follow` can attribute events without a second lookup.
 *
 * Run transitions set `kind: "run"` and an explicit `event` name (`run.blocked`,
 * `run.node_entered`, `run.verb`, …). A gate is otherwise invisible on the stream
 * except via these run.* events (it spawns no tasks).
 */
export interface Transition {
  seq: number;
  /** `"task"` (default) or `"run"` (ADR-0019 firehose family). */
  kind?: "task" | "run";
  /** Present on task transitions. */
  task_id?: string;
  /** Task lifecycle state, or run lifecycle state for run.* events. */
  state: string;
  /**
   * Explicit wire event name. Task transitions leave this unset and the wire
   * layer maps `state` via `eventNameForState`. Run transitions set it
   * (`run.node_entered`, `run.blocked`, `run.verb`, …).
   */
  event?: string;
  /** Owning / subject run id when known. */
  run_id?: string | null;
  node?: string | null;
  iteration?: number | null;
  slot?: string | null;
  /**
   * Gate verb on `run.verb` events (#360). Absent on all other transitions.
   */
  verb?: RunBlockVerb;
  /**
   * Orchestrator session bound to the run at verb time (#360). Present on
   * `run.verb`; other run transitions leave this unset (wire layer may still
   * join from the row).
   */
  orchestrator_session_id?: string | null;
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
  | "run_advance"
  | "run_gate"
  | (string & {});

/** Co-fields frequently written with a state change (data patch, no state). */
export type TransitionFields = TaskDataPatch;

export interface TransitionHooks {
  /** Append-only log (engine.transitions today). */
  append(transition: Transition): void;
  /** Wake inbox / firehose / SSE waiters. */
  wake(): void;
  /**
   * Called when the new state frees a concurrency slot (terminal or stalled).
   * Invoked synchronously inside {@link TaskTransitions.apply}, so callers
   * that drain runs from this hook must have already made durable anything
   * advance needs to observe for that task — in particular, run deliverables
   * for a completing run-owned task (#264 / ADR-0017).
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
 * Run firehose recorder (ADR-0019). Allocates seq via {@link bumpRunSeq},
 * appends a `run.*` transition, and wakes waiters. Does not mutate run state
 * rows — the run-engine owns those via updateRun.
 */
export interface RunTransitions {
  /**
   * Record a run.* event. Bumps the run's event-id seq. Returns the transition
   * (always — run events are edge-logged even when the row did not change
   * between two identical observations, because the caller only invokes this
   * on real edges).
   */
  record(
    runId: string,
    opts: {
      /** Wire event name, e.g. `run.node_entered`, `run.blocked`, `run.verb`. */
      event: string;
      /** Run lifecycle state at the edge (`running` / `blocked` / …). */
      state: string;
      node?: string | null;
      iteration?: number | null;
      cause?: TransitionCause;
      /** Gate verb for `run.verb` events (#360). */
      verb?: RunBlockVerb;
      /** Orchestrator session at verb time (#360). */
      orchestrator_session_id?: string | null;
    },
  ): Transition;
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
      // Re-read so run address fields reflect any co-written patch.
      const after = getTask(db, taskId) ?? row;
      const transition: Transition = {
        seq,
        kind: "task",
        task_id: taskId,
        state: to,
        run_id: after.run_id,
        node: after.node,
        iteration: after.iteration,
        slot: after.slot,
      };
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
      const transition: Transition = {
        seq,
        kind: "task",
        task_id: taskId,
        state,
        run_id: row.run_id,
        node: row.node,
        iteration: row.iteration,
        slot: row.slot,
      };
      hooks.append(transition);
      // No wake on bootstrap — matches today's sweep (db.ts).
      return transition;
    },
  };
}

/**
 * Create a run transition recorder. Shares the same append/wake hooks as task
 * transitions so one firehose carries both families.
 */
export function createRunTransitions(
  db: DatabaseHandle,
  hooks: Pick<TransitionHooks, "append" | "wake">,
): RunTransitions {
  return {
    record(runId, opts) {
      const seq = bumpRunSeq(db, runId);
      const transition: Transition = {
        seq,
        kind: "run",
        state: opts.state,
        event: opts.event,
        run_id: runId,
        node: opts.node ?? null,
        iteration: opts.iteration ?? null,
        slot: null,
        ...(opts.verb !== undefined ? { verb: opts.verb } : {}),
        ...(opts.orchestrator_session_id !== undefined
          ? { orchestrator_session_id: opts.orchestrator_session_id }
          : {}),
      };
      hooks.append(transition);
      hooks.wake();
      return transition;
    },
  };
}

/**
 * Wire event name for a transition (ADR-0019): run transitions use their
 * explicit `event`; task transitions map via the caller-supplied mapper
 * (usually `eventNameForState` from core).
 */
export function transitionEventName(
  transition: Transition,
  taskEventName: (state: string) => string,
): string {
  if (transition.kind === "run" && transition.event) return transition.event;
  if (transition.event) return transition.event;
  return taskEventName(transition.state);
}
