/**
 * Layer 4 (hooks) — pure roster projection (#66). Groups a plain task list by
 * state in attention order and derives the distinct orchestrator sessions,
 * without touching React or the wire types directly: `useSnapshot` adapts the
 * SDK's envelopes/rows into {@link RosterTaskInput} and calls this. Kept pure
 * and side-effect free so it is unit-testable with hand-written fixtures
 * (component-system spec contract 6 — attention ordering comes from core
 * constants; this is the one place that reads them for the roster).
 */
import { attentionRank, isTerminalState } from "@useparley/core";
import { factionFor } from "../../tokens/factions.js";
import type { RosterGroup, RosterSessionOption, RosterTask } from "../../hud/types.js";

/**
 * How many most-recently-active session chips the roster shows before the
 * search affordance covers the rest (#88). Named so the cap is one place.
 */
export const RECENT_SESSION_CHIP_CAP = 5;

/** The plain per-task slice {@link projectRoster} groups and sorts. */
export interface RosterTaskInput {
  id: string;
  name: string;
  vendor: string | null;
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

function toRosterTask(task: RosterTaskInput): RosterTask {
  const faction = factionFor(task.vendor);
  return {
    id: task.id,
    name: task.name,
    coat: faction.coat,
    emblem: faction.emblem,
    faction: faction.label,
    meta: `${task.branch ?? "no branch"} · ${shortId(task.id)}`,
  };
}

/**
 * Project a flat task list into state groups (attention order, empty groups
 * dropped) and the distinct orchestrator sessions among them. The only
 * ordering authority is `@useparley/core`'s `attentionRank` — nothing here
 * re-derives the hierarchy.
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
    byState.get(task.state)!.push(toRosterTask(task));
    if (!isTerminalState(task.state)) activeTasks += 1;
  }

  const groups: RosterGroup[] = [...byState.entries()]
    .map(([state, rosterTasks]) => ({ state, tasks: rosterTasks }))
    .sort((a, b) => attentionRank(a.state) - attentionRank(b.state));

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
