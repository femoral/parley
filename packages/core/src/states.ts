/**
 * Task state machine constants (spec §2/§3) — the canonical vocabulary the
 * daemon, CLI, and any UI share. UIs import these rather than re-deriving the
 * lifecycle or the attention ordering (docs/spec/ui-interface-contract.md).
 */

/** Every task lifecycle state, in lifecycle (not attention) order. */
export const TASK_STATES = [
  "pending",
  "running",
  "awaiting_answer",
  "completed",
  "failed",
  "cancelled",
  "stalled",
] as const;

/** One of parley's task lifecycle states. */
export type TaskState = (typeof TASK_STATES)[number];

/** States a task never moves out of again (the child is gone for good). */
export const TERMINAL_STATES = ["completed", "failed", "cancelled"] as const;

/**
 * States that need the orchestrator/operator to act before the task can make
 * progress: a pending question (`awaiting_answer`) or a dropped child that only
 * a resume revives (`stalled`).
 */
export const ATTENTION_STATES = ["awaiting_answer", "stalled"] as const;

/**
 * States that contribute a pending event to the orchestrator-session inbox
 * (ADR-0007): demand action or review. Not actionable: `pending`/`running`
 * (nothing to do) and `cancelled` (orchestrator-caused).
 */
export const ACTIONABLE_STATES = [
  "awaiting_answer",
  "stalled",
  "failed",
  "completed",
] as const;

/**
 * Inbox delivery priority (ADR-0007): questions before stalls before failures
 * before completed reviews. FIFO by transition seq within a tier. Distinct from
 * {@link ATTENTION_ORDER}, which is the UI roster ranking.
 */
export const INBOX_PRIORITY: readonly (typeof ACTIONABLE_STATES)[number][] = [
  "awaiting_answer",
  "stalled",
  "failed",
  "completed",
];

/**
 * Attention hierarchy order (the brief, via docs/spec/ui-v1-scope.md):
 * `awaiting_answer` > `stalled` > `running` > terminal. A UI groups/sorts its
 * roster by this ranking so the most urgent work floats to the top; `pending`
 * sits between the live `running` state and the quiet terminal states. Exported
 * so no layer re-derives it (docs/spec/ui-component-system.md §6).
 */
export const ATTENTION_ORDER: readonly TaskState[] = [
  "awaiting_answer",
  "stalled",
  "running",
  "pending",
  "completed",
  "failed",
  "cancelled",
];

/** Rank of a state in the attention hierarchy — lower sorts first (more urgent). */
export function attentionRank(state: string): number {
  const index = ATTENTION_ORDER.indexOf(state as TaskState);
  // Unknown states sort last, after every known state.
  return index === -1 ? ATTENTION_ORDER.length : index;
}

/**
 * Rank of a state in the inbox priority order (ADR-0007) — lower sorts first
 * (delivered sooner). Non-actionable states sort last.
 */
export function inboxRank(state: string): number {
  const index = INBOX_PRIORITY.indexOf(
    state as (typeof ACTIONABLE_STATES)[number],
  );
  return index === -1 ? INBOX_PRIORITY.length : index;
}

/** True when a task in `state` contributes a pending inbox event until acked. */
export function isActionableState(state: string): boolean {
  return (ACTIONABLE_STATES as readonly string[]).includes(state);
}

/** True when a task in `state` will never transition again. */
export function isTerminalState(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** True when a task in `state` is waiting on the orchestrator/operator. */
export function isAttentionState(state: string): boolean {
  return (ATTENTION_STATES as readonly string[]).includes(state);
}

/**
 * The watch/SSE event names (spec §3) — one per transition a stream surfaces.
 * `task.started` reuses the `running` transition; `task.question` the
 * `awaiting_answer` one; the rest map name-for-name.
 */
export const TASK_EVENT_NAMES = [
  "task.started",
  "task.question",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.stalled",
  "task.pending",
] as const;

/** One of the watch/SSE event names. */
export type TaskEventName = (typeof TASK_EVENT_NAMES)[number];

/**
 * The watch/SSE event name for a transition into `state` (spec §3). Mirrors the
 * daemon's `watchEventFor`: `running` → `task.started`, `awaiting_answer` →
 * `task.question`, everything else `task.<state>`.
 */
export function eventNameForState(state: string): TaskEventName {
  if (state === "running") return "task.started";
  if (state === "awaiting_answer") return "task.question";
  return `task.${state}` as TaskEventName;
}
