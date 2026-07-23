/**
 * Pure projection: roster groups → quiet resting LOGBOOK fleet digest.
 * Hud-layer only — no SDK, no React. Cockpit threads the result into Inspector
 * as plain props so the empty plate can earn its acreage without a second
 * data path.
 */
import { formatRelativeAge } from "./formatRelativeAge.js";
import type { LogbookDigest, LogbookDigestItem, RosterGroup, RosterTask } from "./types.js";

/** Cap for "last reports in" — a handful, not a second roster. */
export const LOGBOOK_DIGEST_COMPLETION_CAP = 4;

function toItem(task: RosterTask, nowMs: number): LogbookDigestItem {
  return {
    id: task.id,
    name: task.name,
    coat: task.coat,
    emblem: task.emblem,
    faction: task.faction,
    age: formatRelativeAge(task.updatedAt, nowMs),
  };
}

/** Sort newest-first by `updatedAt`; missing clocks sort last. */
function byRecency(a: RosterTask, b: RosterTask): number {
  const aAt = a.updatedAt ?? "";
  const bAt = b.updatedAt ?? "";
  if (aAt === bAt) return a.id.localeCompare(b.id);
  // ISO-8601 strings sort chronologically; empty string is oldest.
  return aAt < bAt ? 1 : -1;
}

/**
 * Project a quiet fleet digest from the cockpit's already-grouped roster.
 * Empty groups / empty fleet → {@link LogbookDigest.hasFleet} false so the
 * empty plate keeps its hint-centric resting state.
 */
export function projectLogbookDigest(
  groups: readonly RosterGroup[],
  nowMs: number,
  completionCap: number = LOGBOOK_DIGEST_COMPLETION_CAP,
): LogbookDigest {
  let completed = 0;
  let failed = 0;
  let running = 0;
  let total = 0;
  let completedTasks: RosterTask[] = [];
  let failedTasks: RosterTask[] = [];

  for (const group of groups) {
    total += group.tasks.length;
    if (group.state === "completed") {
      completed = group.tasks.length;
      completedTasks = group.tasks;
    } else if (group.state === "failed") {
      failed = group.tasks.length;
      failedTasks = group.tasks;
    } else if (group.state === "running") {
      running = group.tasks.length;
    }
  }

  if (total === 0) {
    return {
      hasFleet: false,
      completed: 0,
      failed: 0,
      running: 0,
      recentCompletions: [],
      latestFailure: null,
    };
  }

  const recentCompletions = [...completedTasks]
    .sort(byRecency)
    .slice(0, Math.max(0, completionCap))
    .map((task) => toItem(task, nowMs));

  const newestFailure = [...failedTasks].sort(byRecency)[0];
  const latestFailure = newestFailure ? toItem(newestFailure, nowMs) : null;

  return {
    hasFleet: true,
    completed,
    failed,
    running,
    recentCompletions,
    latestFailure,
  };
}
