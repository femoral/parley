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
    meta: `${task.branch ?? "no branch"} · ${shortId(task.id)}`,
  };
}

/**
 * Project a flat task list into state groups (attention order, empty groups
 * dropped) and the distinct orchestrator sessions among them. The only
 * ordering authority is `@useparley/core`'s `attentionRank` — nothing here
 * re-derives the hierarchy.
 */
export function projectRoster(tasks: Iterable<RosterTaskInput>): RosterProjection {
  const byState = new Map<string, RosterTask[]>();
  const sessionCounts = new Map<string, number>();
  const durableSessions = new Set<string>();
  let totalTasks = 0;
  let activeTasks = 0;

  for (const task of tasks) {
    totalTasks += 1;
    if (!byState.has(task.state)) byState.set(task.state, []);
    byState.get(task.state)!.push(toRosterTask(task));
    if (task.orchestratorSession) {
      sessionCounts.set(task.orchestratorSession, (sessionCounts.get(task.orchestratorSession) ?? 0) + 1);
    }
    if (!isTerminalState(task.state)) {
      activeTasks += 1;
      if (task.orchestratorSession) durableSessions.add(task.orchestratorSession);
    }
  }

  const groups: RosterGroup[] = [...byState.entries()]
    .map(([state, rosterTasks]) => ({ state, tasks: rosterTasks }))
    .sort((a, b) => attentionRank(a.state) - attentionRank(b.state));

  const sessions: RosterSessionOption[] = [...sessionCounts.entries()]
    .map(([id, count]) => ({ id, label: shortId(id), count }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { groups, sessions, totalTasks, activeTasks, durableSessions: durableSessions.size };
}
