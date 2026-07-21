/**
 * Layer 4 (hooks) — pure roster projection (#66). Groups a plain task list by
 * state in attention order and derives the distinct orchestrator sessions,
 * without touching React or the wire types directly: `useSnapshot` adapts the
 * SDK's envelopes/rows into {@link RosterTaskInput} and calls this. Kept pure
 * and side-effect free so it is unit-testable with hand-written fixtures
 * (component-system spec contract 6 — attention ordering comes from core
 * constants; this is the one place that reads them for the roster).
 *
 * Failed-state freshness is a *display-layer* concern layered on top of core's
 * `attentionRank`: a fresh wreck arrives loud (undimmed, coral beacon, sorted
 * just under stalled) and decays to the archive treatment once selected or
 * after {@link FAILED_FRESHNESS_MS}. The kit band's legend stays pinned to
 * core's `ATTENTION_ORDER` — only the live roster list uses this window.
 */
import { attentionRank, isTerminalState } from "@useparley/core";
import { harnessColorFor, vendorEmblemFor } from "../../tokens/factions.js";
import type { RosterGroup, RosterSessionOption, RosterTask } from "../../hud/types.js";

/**
 * How many most-recently-active session chips the roster shows before the
 * search affordance covers the rest (#88). Named so the cap is one place.
 */
export const RECENT_SESSION_CHIP_CAP = 5;

/**
 * How long a failure stays "fresh" (loud) before decaying to the quiet archive
 * treatment, unless the operator acknowledges it sooner by selecting the task.
 * Five minutes — long enough to notice on an ambient second monitor, short
 * enough that yesterday's wrecks don't keep shouting.
 */
export const FAILED_FRESHNESS_MS = 5 * 60 * 1000;

/** The plain per-task slice {@link projectRoster} groups and sorts. */
export interface RosterTaskInput {
  id: string;
  name: string;
  vendor: string | null;
  /** Adapter running the orchestrator model; supplies task identity colour. */
  orchHarness?: string | null;
  state: string;
  branch: string | null;
  /** The orchestrator session this task belongs to (spec's "big ship"), or
   * null when unknown (e.g. a task first observed via an SSE envelope, which
   * does not carry this field — see `useSnapshot`'s merge comment). */
  orchestratorSession: string | null;
  /** The outstanding question text while `awaiting_answer` (else null) — the
   * `useSnapshot`-maintained map this feeds both the roster and inbox
   * projections (#67), so it lives on the shared input shape. */
  question: string | null;
  /**
   * ISO-8601 last-activity timestamp when known (from the task row's
   * `updated_at`, or the wall clock of an SSE transition). Used only to order
   * session chips by recency (#88); absent values sort last.
   */
  updatedAt?: string | null;
}

/**
 * Display-layer inputs for the failed-state freshness window. Tracked in the
 * roster/selection hook layer (`useCockpit`) — not wall-clock inside render
 * components. Absent / undefined = every failure is treated as archive (the
 * quiet terminal treatment), matching callers that only need core order.
 */
export interface FailedFreshness {
  /**
   * Epoch ms when each currently-failed task first entered `failed` for this
   * spell (cleared when the task leaves failed so a re-failure is loud again).
   */
  observedAt: ReadonlyMap<string, number>;
  /** Task ids the operator has selected at least once while failed. */
  acknowledged: ReadonlySet<string>;
  /** Clock used for timeout decay (cockpit one-second tick). */
  now: number;
}

/** The full roster projection a `RosterPanel` renders. */
export interface RosterProjection {
  groups: RosterGroup[];
  sessions: RosterSessionOption[];
  totalTasks: number;
  activeTasks: number;
  /** Distinct orchestrator sessions with at least one non-terminal task. */
  durableSessions: number;
}

/** Truncate a task id to its short display form (`branch · id` rows, session
 * chips). Exported so `inbox.ts`'s projection uses the same truncation rather
 * than re-declaring it. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * True when a failed task is still inside its freshness window: not
 * acknowledged by selection, and observed less than {@link FAILED_FRESHNESS_MS}
 * ago. Non-failed states are never fresh.
 */
export function isFreshFailure(
  taskId: string,
  state: string,
  freshness: FailedFreshness | null | undefined,
): boolean {
  if (state !== "failed" || !freshness) return false;
  if (freshness.acknowledged.has(taskId)) return false;
  const observedAt = freshness.observedAt.get(taskId);
  // Missing observation = just entered failed this frame; treat as fresh so
  // the first paint after a transition is already loud.
  if (observedAt === undefined) return true;
  return freshness.now - observedAt < FAILED_FRESHNESS_MS;
}

/**
 * Display attention rank for grouping/sorting. Mirrors core's
 * {@link attentionRank} except that a *fresh* failure slots just under
 * `stalled` (and above `running`) so a new wreck outranks calm work. Archive
 * failures keep core's quiet rank. The kit legend does not use this.
 */
export function displayAttentionRank(
  state: string,
  freshFailure: boolean,
): number {
  if (state === "failed" && freshFailure) {
    // stalled is 1, running is 2 — insert between them.
    return attentionRank("stalled") + 0.5;
  }
  return attentionRank(state);
}

/**
 * Advance the failed-observation map for the current task list. Pure: callers
 * (useCockpit) keep the previous map across renders so a failure's clock starts
 * once per spell, not on every re-project. Tasks that leave `failed` drop out;
 * re-entry gets a new `now` stamp.
 */
export function advanceFailedObservations(
  tasks: Iterable<RosterTaskInput>,
  prev: ReadonlyMap<string, number>,
  now: number,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const task of tasks) {
    if (task.state !== "failed") continue;
    next.set(task.id, prev.get(task.id) ?? now);
  }
  return next;
}

function toRosterTask(
  task: RosterTaskInput,
  freshness: FailedFreshness | null | undefined,
): RosterTask {
  const vendor = vendorEmblemFor(task.vendor);
  const harness = harnessColorFor(task.orchHarness);
  const freshFailure = isFreshFailure(task.id, task.state, freshness);
  return {
    id: task.id,
    name: task.name,
    coat: harness.coat,
    emblem: vendor.emblem,
    faction: `${vendor.label} via ${harness.label}`,
    meta: `${task.branch ?? "no branch"} · ${shortId(task.id)}`,
    // Only meaningful for failed rows; the panel treats undefined as archive
    // defaults from STATE_META.
    freshFailure: task.state === "failed" ? freshFailure : undefined,
  };
}

/**
 * Project a flat task list into state groups (attention order, empty groups
 * dropped) and the distinct orchestrator sessions among them. The only
 * *core* ordering authority is `@useparley/core`'s `attentionRank`; the optional
 * {@link FailedFreshness} window may lift fresh failures just under stalled
 * (display-layer only — legend / core order stay put).
 *
 * When `selectedSessionId` is set, groups/totals include only that session's
 * tasks (tasks with no session id appear only under "All hands" / null).
 * Session chips always reflect the full unfiltered fleet so the selector and
 * the future scene camera cue stay in sync with every known session (#76) —
 * but only the {@link RECENT_SESSION_CHIP_CAP} most-recently-active ones are
 * returned; older sessions are reached via search (#88). A selected session
 * that falls outside the cap is pinned onto the chip list so the active state
 * stays visible.
 */
export function projectRoster(
  tasks: Iterable<RosterTaskInput>,
  selectedSessionId: string | null = null,
  freshness: FailedFreshness | null = null,
): RosterProjection {
  const all = [...tasks];
  const sessionCounts = new Map<string, number>();
  const sessionLastActivity = new Map<string, string>();
  const durableSessions = new Set<string>();

  // Session chips + durable count always come from the full fleet so selecting
  // a chip never collapses the selector to a single option.
  for (const task of all) {
    if (task.orchestratorSession) {
      sessionCounts.set(task.orchestratorSession, (sessionCounts.get(task.orchestratorSession) ?? 0) + 1);
      const at = task.updatedAt ?? "";
      const prev = sessionLastActivity.get(task.orchestratorSession) ?? "";
      if (at > prev) sessionLastActivity.set(task.orchestratorSession, at);
      if (!isTerminalState(task.state)) durableSessions.add(task.orchestratorSession);
    }
  }

  const visible =
    selectedSessionId === null
      ? all
      : all.filter((task) => task.orchestratorSession === selectedSessionId);

  const byState = new Map<string, RosterTask[]>();
  let totalTasks = 0;
  let activeTasks = 0;

  for (const task of visible) {
    totalTasks += 1;
    if (!byState.has(task.state)) byState.set(task.state, []);
    byState.get(task.state)!.push(toRosterTask(task, freshness));
    if (!isTerminalState(task.state)) activeTasks += 1;
  }

  // Within a failed group, fresh wrecks float above archived ones so the eye
  // hits the loud row first when both share a header.
  for (const [state, rosterTasks] of byState) {
    if (state !== "failed") continue;
    rosterTasks.sort((a, b) => {
      const aFresh = a.freshFailure ? 1 : 0;
      const bFresh = b.freshFailure ? 1 : 0;
      if (aFresh !== bFresh) return bFresh - aFresh;
      return a.id.localeCompare(b.id);
    });
  }

  const groups: RosterGroup[] = [...byState.entries()]
    .map(([state, rosterTasks]) => ({ state, tasks: rosterTasks }))
    .sort((a, b) => {
      const aFresh = a.state === "failed" && a.tasks.some((t) => t.freshFailure);
      const bFresh = b.state === "failed" && b.tasks.some((t) => t.freshFailure);
      const rankDiff = displayAttentionRank(a.state, aFresh) - displayAttentionRank(b.state, bFresh);
      if (rankDiff !== 0) return rankDiff;
      return a.state.localeCompare(b.state);
    });

  // Most-recently-active first; id tie-break for stable ordering.
  const allSessions: RosterSessionOption[] = [...sessionCounts.entries()]
    .map(([id, count]) => ({ id, label: shortId(id), count }))
    .sort((a, b) => {
      const aAt = sessionLastActivity.get(a.id) ?? "";
      const bAt = sessionLastActivity.get(b.id) ?? "";
      if (aAt !== bAt) return bAt.localeCompare(aAt);
      return a.id.localeCompare(b.id);
    });

  let sessions = allSessions.slice(0, RECENT_SESSION_CHIP_CAP);
  // Pin a selected session that fell outside the recent cap (search pick, or
  // an older chip the user still has active) so the active state stays visible.
  // Only pin when the session still has tasks in the fleet — a gone selection
  // is cleared by useCockpit, not kept as a ghost chip.
  if (selectedSessionId !== null && !sessions.some((s) => s.id === selectedSessionId)) {
    const fromFleet = allSessions.find((s) => s.id === selectedSessionId);
    if (fromFleet) sessions = [...sessions, fromFleet];
  }

  return { groups, sessions, totalTasks, activeTasks, durableSessions: durableSessions.size };
}
