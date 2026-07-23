/**
 * Orchestrator inbox module (#207): level-triggered derived view over task
 * rows + acks (ADR-0007). Four verbs — peek · ack · waitFor · allDone — with
 * priority order, supersession/collapse, and all-done semantics.
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
  getTask,
  getTaskBySeq,
  isEventAcked,
  upsertEventAck,
  type DatabaseHandle,
  type TaskRow,
} from "./db.js";

/** Minimal task face the inbox needs (today: subset of TaskRow). */
export interface InboxTask {
  id: string;
  state: string;
  seq: number;
}

/** Port: load current task rows. Prod = db wrappers; tests = Map. */
export interface TaskSnapshot<T extends InboxTask = InboxTask> {
  get(id: string): T | undefined;
  /** ADR-0007 event id lookup: task whose *current* seq === eventId. */
  getBySeq(eventId: number): T | undefined;
}

/** Port: per-(task_id, state) acked seq. Prod = event_acks; tests = Map. */
export interface AckStore<T extends InboxTask = InboxTask> {
  /** True when current (id, state) has acked_seq === task.seq. */
  isAcked(task: T): boolean;
  /** Record ack for (task.id, task.state) at task.seq. */
  recordAck(task: T): void;
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

export interface Inbox<T extends InboxTask = InboxTask> {
  /** Ack by event id (transition seq). Superseded / non-actionable → no-op. */
  ack(eventId: number): void;
  /** Highest-priority pending event among ids, or null. */
  peek(ids: readonly string[]): T | null;
  /** Every watched task terminal and no pending events (empty set → true). */
  allDone(ids: readonly string[]): boolean;
  /**
   * Level-triggered long-poll: pending event, all-done, or poll-window miss.
   * Requires a WakeSource; pure peeks do not.
   */
  waitFor(
    ids: readonly string[],
    timeoutMs: number,
    wake: WakeSource,
  ): Promise<{ task: T } | { allDone: true } | null>;
}

export function createInbox<T extends InboxTask>(
  tasks: TaskSnapshot<T>,
  acks: AckStore<T>,
): Inbox<T> {
  function peek(ids: readonly string[]): T | null {
    const pending: T[] = [];
    for (const id of new Set(ids)) {
      const task = tasks.get(id);
      if (!task) continue;
      if (!isActionableState(task.state)) continue;
      if (acks.isAcked(task)) continue;
      pending.push(task);
    }
    if (pending.length === 0) return null;
    pending.sort((a, b) => {
      const rank = inboxRank(a.state) - inboxRank(b.state);
      return rank !== 0 ? rank : a.seq - b.seq;
    });
    return pending[0] ?? null;
  }

  function allDone(ids: readonly string[]): boolean {
    if (peek(ids) !== null) return false;
    for (const id of ids) {
      const task = tasks.get(id);
      if (!task) continue;
      if (!isTerminalState(task.state)) return false;
    }
    return true;
  }

  function ack(eventId: number): void {
    if (!Number.isInteger(eventId) || eventId < 1) return;
    const task = tasks.getBySeq(eventId);
    if (!task) return; // superseded or unknown
    if (!isActionableState(task.state)) return;
    if (task.seq !== eventId) return; // belt-and-suspenders with getBySeq
    acks.recordAck(task);
  }

  async function waitFor(
    ids: readonly string[],
    timeoutMs: number,
    wake: WakeSource,
  ): Promise<{ task: T } | { allDone: true } | null> {
    for (;;) {
      const pending = peek(ids);
      if (pending) return { task: pending };
      if (allDone(ids)) return { allDone: true };
      const woke = await wake.park(timeoutMs);
      if (!woke) {
        // Window elapsed — re-check once more in case a transition landed in
        // the gap between the last peek and the timer firing.
        const late = peek(ids);
        if (late) return { task: late };
        if (allDone(ids)) return { allDone: true };
        return null;
      }
    }
  }

  return { ack, peek, allDone, waitFor };
}

/** Sqlite-backed task snapshot — wraps existing db.ts helpers, no new SQL. */
export function sqliteTaskSnapshot(db: DatabaseHandle): TaskSnapshot<TaskRow> {
  return {
    get: (id) => getTask(db, id),
    getBySeq: (eventId) => getTaskBySeq(db, eventId),
  };
}

/** Sqlite-backed ack store — wraps existing event_acks helpers. */
export function sqliteAckStore(db: DatabaseHandle): AckStore<TaskRow> {
  return {
    isAcked: (task) => isEventAcked(db, task),
    recordAck: (task) => upsertEventAck(db, task.id, task.state, task.seq),
  };
}

/**
 * In-memory adapters for unit tests — no sqlite, TaskEngine, or vendor child.
 * Mutate `tasks` to simulate transitions; acks track per-(id, state) seq.
 */
export function memoryInboxDeps(seed: InboxTask[] = []): {
  tasks: Map<string, InboxTask>;
  snapshot: TaskSnapshot<InboxTask>;
  acks: AckStore<InboxTask>;
} {
  const tasks = new Map(seed.map((t) => [t.id, { ...t }]));
  const ackMap = new Map<string, number>(); // key = `${id}\0${state}` → acked_seq

  const snapshot: TaskSnapshot<InboxTask> = {
    get: (id) => tasks.get(id),
    getBySeq: (eventId) =>
      [...tasks.values()].find((t) => t.seq === eventId),
  };
  const acks: AckStore<InboxTask> = {
    isAcked: (task) => ackMap.get(`${task.id}\0${task.state}`) === task.seq,
    recordAck: (task) => {
      ackMap.set(`${task.id}\0${task.state}`, task.seq);
    },
  };
  return { tasks, snapshot, acks };
}
