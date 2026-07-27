/**
 * Orchestrator inbox module (#207 / #240): level-triggered derived view over
 * task rows + run rows + acks (ADR-0007 / ADR-0019). Four verbs — peek · ack ·
 * waitFor · allDone — with priority order, supersession/collapse, and
 * session-finished all-done semantics.
 *
 * Does **not** own the transition log (edge-triggered firehose) or the wake
 * bus; those stay with the transition module (#206) / TaskEngine. The inbox
 * only re-derives on wake via an injected {@link WakeSource}.
 */
import {
  inboxRank,
  isActionableState,
  isTerminalState,
} from "@useparley/core";
import {
  getRun,
  getRunBlockReason,
  getRunIdBySeq,
  getRunSeq,
  getTask,
  getTaskBySeq,
  isEventAcked,
  isRunEventAcked,
  upsertEventAck,
  type DatabaseHandle,
  type RunRow,
  type TaskRow,
} from "./db.js";

/** Minimal task face the inbox needs (today: subset of TaskRow). */
export interface InboxTask {
  id: string;
  state: string;
  seq: number;
  /** Non-null when the task is owned by a workflow run (ADR-0019). */
  run_id?: string | null;
  node?: string | null;
  iteration?: number | null;
  slot?: string | null;
  orchestrator_session_id?: string | null;
}

/** Minimal run face the inbox needs. */
export interface InboxRun {
  id: string;
  state: string;
  seq: number;
  current_node: string | null;
  iteration: number;
  workflow: string;
  error: string | null;
  orchestrator_session_id: string | null;
  /**
   * Authoritative block reason from `run_seqs.block_reason` (`BlockReason`).
   * Only `"gate"` is unackable tier 1. Null / missing ⇒ not a gate (tier 2).
   * Never derived from free-text `error` in the inbox.
   */
  block_reason: string | null;
}

/**
 * One pending inbox event — a task or a run subject (ADR-0019).
 * `state` is the *tier key* used for ranking and exit codes:
 * - task: awaiting_answer | stalled | failed | completed
 * - run:  gate | blocked | failed | completed
 *   (gate folds into tier 1 with awaiting_answer; blocked into tier 2 with stalled)
 */
export interface InboxEvent {
  kind: "task" | "run";
  id: string;
  /** Tier key — see above. */
  state: string;
  seq: number;
  task?: InboxTask;
  run?: InboxRun;
}

/** Port: load current task rows. Prod = db wrappers; tests = Map. */
export interface TaskSnapshot<T extends InboxTask = InboxTask> {
  get(id: string): T | undefined;
  /** ADR-0007 event id lookup: task whose *current* seq === eventId. */
  getBySeq(eventId: number): T | undefined;
}

/** Port: load current run rows for the inbox. */
export interface RunSnapshot<R extends InboxRun = InboxRun> {
  get(id: string): R | undefined;
  getBySeq(eventId: number): R | undefined;
  /** Optional: expand a session id to run ids (session-scoped watch). */
  idsForSession?(sessionId: string): string[];
}

/** Port: per-(kind, id, state) acked seq. Prod = event_acks; tests = Map. */
export interface AckStore {
  isTaskAcked(task: InboxTask): boolean;
  isRunAcked(run: InboxRun, tierState: string): boolean;
  recordTaskAck(task: InboxTask): void;
  recordRunAck(run: InboxRun, tierState: string): void;
}

/**
 * Wake source for long-poll. Engine's eventWaiters today; transition module's
 * bus after #206. Not owned by the inbox.
 */
export interface WakeSource {
  /**
   * Park until a state-change wake or timeoutMs elapses.
   * Resolves true on wake, false on timeout.
   */
  park(timeoutMs: number): Promise<boolean>;
}

/** Watch set: task ids and/or run ids (ADR-0019 dual subject). */
export interface WatchSet {
  taskIds: readonly string[];
  runIds: readonly string[];
}

export interface Inbox {
  /** Ack by event id (transition seq). Superseded / gate / non-actionable → no-op. */
  ack(eventId: number): void;
  /** Highest-priority pending event among the watch set, or null. */
  peek(watch: WatchSet): InboxEvent | null;
  /**
   * Session finished (ADR-0019): every watched subject terminal and no pending
   * events. An empty watch set is never all-done (#256) — "nothing to watch" is
   * not "everything finished". Task-only sets match ADR-0007 observationally.
   */
  allDone(watch: WatchSet): boolean;
  /**
   * Level-triggered long-poll: pending event, all-done, or poll-window miss.
   * Requires a WakeSource; pure peeks do not.
   */
  waitFor(
    watch: WatchSet,
    timeoutMs: number,
    wake: WakeSource,
  ): Promise<{ event: InboxEvent } | { allDone: true } | null>;
}

/**
 * True when a run-owned task may contribute to the inbox (ADR-0019):
 * questions pierce the run's shell; outcomes do not.
 * Only `awaiting_answer` and `stalled` surface against the **task** id.
 */
export function isRunOwnedTaskActionable(state: string): boolean {
  return state === "awaiting_answer" || state === "stalled";
}

/**
 * Map a run to its inbox tier key, or null when the run contributes no pending
 * event (`running` / `cancelled`).
 *
 * - blocked + `block_reason === "gate"` → tier 1 (`gate`, never acked)
 * - any other blocked (incl. missing reason) → tier 2 (`blocked`, ackable)
 * - failed → tier 3
 * - completed → tier 4
 *
 * Gate-ness comes **only** from the stored {@link InboxRun.block_reason}
 * (written where the workflow definition was known). A missing reason is
 * deliberately *not* a gate: a false gate blackholes the session; a missed
 * gate surfaces as an ordinary block the orchestrator can still act on.
 */
export function runInboxTierState(run: {
  state: string;
  block_reason?: string | null;
}): string | null {
  if (run.state === "failed" || run.state === "completed") return run.state;
  if (run.state === "blocked") {
    return run.block_reason === "gate" ? "gate" : "blocked";
  }
  return null;
}

/**
 * Rank for inbox priority (ADR-0019): gate shares tier 1 with awaiting_answer;
 * blocked shares tier 2 with stalled. Lower sorts first.
 */
export function inboxEventRank(state: string): number {
  if (state === "gate") return 0;
  if (state === "blocked") return 1;
  return inboxRank(state);
}

/**
 * Exit-code tier state: maps run tier keys onto the four ADR-0007 codes.
 * gate → awaiting_answer (3), blocked → stalled (4).
 */
export function exitTierState(state: string): string {
  if (state === "gate") return "awaiting_answer";
  if (state === "blocked") return "stalled";
  return state;
}

export function createInbox(
  tasks: TaskSnapshot,
  acks: AckStore,
  runs: RunSnapshot = emptyRunSnapshot(),
): Inbox {
  function collectPending(watch: WatchSet): InboxEvent[] {
    const pending: InboxEvent[] = [];

    for (const id of new Set(watch.taskIds)) {
      const task = tasks.get(id);
      if (!task) continue;
      const runOwned = task.run_id != null && task.run_id !== "";
      if (runOwned) {
        if (!isRunOwnedTaskActionable(task.state)) continue;
      } else {
        if (!isActionableState(task.state)) continue;
      }
      if (acks.isTaskAcked(task)) continue;
      pending.push({
        kind: "task",
        id: task.id,
        state: task.state,
        seq: task.seq,
        task,
      });
    }

    for (const id of new Set(watch.runIds)) {
      const run = runs.get(id);
      if (!run) continue;
      const tier = runInboxTierState(run);
      if (tier === null) continue;
      // Gates are never acked — always pending while the run sits on them.
      if (tier !== "gate" && acks.isRunAcked(run, tier)) continue;
      pending.push({
        kind: "run",
        id: run.id,
        state: tier,
        seq: run.seq,
        run,
      });
    }

    return pending;
  }

  function peek(watch: WatchSet): InboxEvent | null {
    const pending = collectPending(watch);
    if (pending.length === 0) return null;
    pending.sort((a, b) => {
      const rank = inboxEventRank(a.state) - inboxEventRank(b.state);
      // Stall-and-block collision (and every cross-kind tie) resolves on seq alone.
      return rank !== 0 ? rank : a.seq - b.seq;
    });
    return pending[0] ?? null;
  }

  function allDone(watch: WatchSet): boolean {
    // Empty set is never finished (#256): vacuous truth abandoned live work
    // when a session filter matched nothing (typo, stale id, or env/flag split).
    if (watch.taskIds.length === 0 && watch.runIds.length === 0) return false;
    if (peek(watch) !== null) return false;
    for (const id of watch.taskIds) {
      const task = tasks.get(id);
      if (!task) continue;
      if (!isTerminalState(task.state)) return false;
    }
    for (const id of watch.runIds) {
      const run = runs.get(id);
      if (!run) continue;
      // Runs: completed / failed / cancelled are terminal. cancelled is not
      // actionable (orchestrator-caused), same spirit as task cancelled.
      if (run.state === "running" || run.state === "blocked") return false;
    }
    return true;
  }

  function ack(eventId: number): void {
    if (!Number.isInteger(eventId) || eventId < 1) return;

    // Prefer task lookup; then run. Event ids are unique across both (shared counter).
    const task = tasks.getBySeq(eventId);
    if (task) {
      if (task.seq !== eventId) return;
      const runOwned = task.run_id != null && task.run_id !== "";
      if (runOwned) {
        if (!isRunOwnedTaskActionable(task.state)) return;
      } else {
        if (!isActionableState(task.state)) return;
      }
      acks.recordTaskAck(task);
      return;
    }

    const run = runs.getBySeq(eventId);
    if (!run) return;
    if (run.seq !== eventId) return;
    const tier = runInboxTierState(run);
    if (tier === null) return;
    // A gate is never acked, only actioned (ADR-0019) — deliberate no-op.
    if (tier === "gate") return;
    acks.recordRunAck(run, tier);
  }

  async function waitFor(
    watch: WatchSet,
    timeoutMs: number,
    wake: WakeSource,
  ): Promise<{ event: InboxEvent } | { allDone: true } | null> {
    for (;;) {
      const pending = peek(watch);
      if (pending) return { event: pending };
      if (allDone(watch)) return { allDone: true };
      const woke = await wake.park(timeoutMs);
      if (!woke) {
        const late = peek(watch);
        if (late) return { event: late };
        if (allDone(watch)) return { allDone: true };
        return null;
      }
    }
  }

  return { ack, peek, allDone, waitFor };
}

function emptyRunSnapshot(): RunSnapshot {
  return {
    get: () => undefined,
    getBySeq: () => undefined,
  };
}

/** Sqlite-backed task snapshot — wraps existing db.ts helpers, no new SQL. */
export function sqliteTaskSnapshot(db: DatabaseHandle): TaskSnapshot<TaskRow> {
  return {
    get: (id) => getTask(db, id),
    getBySeq: (eventId) => getTaskBySeq(db, eventId),
  };
}

/** Sqlite-backed run snapshot — run_seqs side table for event ids + block reason. */
export function sqliteRunSnapshot(db: DatabaseHandle): RunSnapshot<InboxRun> {
  function toInboxRun(row: RunRow): InboxRun {
    return {
      id: row.id,
      state: row.state,
      seq: getRunSeq(db, row.id),
      current_node: row.current_node,
      iteration: row.iteration,
      workflow: row.workflow,
      error: row.error,
      orchestrator_session_id: row.orchestrator_session_id,
      block_reason: getRunBlockReason(db, row.id),
    };
  }
  return {
    get: (id) => {
      const row = getRun(db, id);
      return row === undefined ? undefined : toInboxRun(row);
    },
    getBySeq: (eventId) => {
      const runId = getRunIdBySeq(db, eventId);
      if (runId === undefined) return undefined;
      const row = getRun(db, runId);
      return row === undefined ? undefined : toInboxRun(row);
    },
  };
}

/** Sqlite-backed ack store — wraps generalized event_acks helpers. */
export function sqliteAckStore(db: DatabaseHandle): AckStore {
  return {
    isTaskAcked: (task) => isEventAcked(db, task as TaskRow),
    isRunAcked: (run, tierState) => isRunEventAcked(db, run.id, tierState, run.seq),
    recordTaskAck: (task) => upsertEventAck(db, task.id, task.state, task.seq, "task"),
    recordRunAck: (run, tierState) =>
      upsertEventAck(db, run.id, tierState, run.seq, "run"),
  };
}

/**
 * In-memory adapters for unit tests — no sqlite, TaskEngine, or vendor child.
 * Mutate `tasks` / `runs` to simulate transitions; acks track per-(kind,id,state).
 */
export function memoryInboxDeps(
  seedTasks: InboxTask[] = [],
  seedRuns: InboxRun[] = [],
): {
  tasks: Map<string, InboxTask>;
  runs: Map<string, InboxRun>;
  snapshot: TaskSnapshot<InboxTask>;
  runSnapshot: RunSnapshot<InboxRun>;
  acks: AckStore;
} {
  const tasks = new Map(seedTasks.map((t) => [t.id, { ...t }]));
  const runs = new Map(seedRuns.map((r) => [r.id, { ...r }]));
  const ackMap = new Map<string, number>(); // key = `${kind}\0${id}\0${state}` → acked_seq

  const snapshot: TaskSnapshot<InboxTask> = {
    get: (id) => tasks.get(id),
    getBySeq: (eventId) => [...tasks.values()].find((t) => t.seq === eventId),
  };
  const runSnapshot: RunSnapshot<InboxRun> = {
    get: (id) => runs.get(id),
    getBySeq: (eventId) => [...runs.values()].find((r) => r.seq === eventId),
  };
  const acks: AckStore = {
    isTaskAcked: (task) =>
      ackMap.get(`task\0${task.id}\0${task.state}`) === task.seq,
    isRunAcked: (run, tierState) =>
      ackMap.get(`run\0${run.id}\0${tierState}`) === run.seq,
    recordTaskAck: (task) => {
      ackMap.set(`task\0${task.id}\0${task.state}`, task.seq);
    },
    recordRunAck: (run, tierState) => {
      ackMap.set(`run\0${run.id}\0${tierState}`, run.seq);
    },
  };
  return { tasks, runs, snapshot, runSnapshot, acks };
}
