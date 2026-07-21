/**
 * Layer 4 (hooks) — pure inspector projection (#68 / #166). Turns a task's full
 * detail (`useTaskDetail`'s envelope + row + durable `qa` + attempt chain) and
 * its live log tail (`useLogTail`) into the plain {@link InspectorTask} the
 * `Inspector` hud component renders — mirrors `roster.ts`/`inbox.ts`'s split
 * (pure, unit-testable, no React/SSE here).
 */
import type { AttemptLineageEntry, TaskDetailResponse } from "@useparley/core";
import { harnessColorFor, vendorEmblemFor } from "../../tokens/factions.js";
import { stateMetaFor } from "../../tokens/state-meta.js";
import type {
  AttemptLineageItem,
  BriefView,
  InspectorTask,
  LogsView,
  QaTurn,
  ReportView,
} from "../../hud/types.js";
import { formatScore, formatUptime, formatUsage } from "./format.js";

function projectBrief(detail: TaskDetailResponse): BriefView {
  const { task, row } = detail;
  return {
    goal: row.prompt,
    branch: task.branch,
    worktree: task.worktree,
    model: task.model,
    effort: task.effort,
    sandbox: task.posture.sandbox,
    network: task.posture.network,
    duration: task.duration_ms !== null ? formatUptime(task.duration_ms) : null,
    usage: formatUsage(task.usage),
  };
}

function projectReport(detail: TaskDetailResponse): ReportView | null {
  const { report } = detail.task;
  if (!report) return null;
  return {
    outcome: report.outcome,
    summary: report.summary,
    files: report.files_changed.map((path) => ({ path })),
  };
}

/**
 * Project the durable server history (#79) into the inspector's plain Q&A
 * turns. Floor shape is `{ id, question, answer, askedAt, answeredAt }` — `id`
 * is the wire `question_id` (stable React key); timestamps ride through so the
 * Q&A tab can render quiet absolute clocks for stall diagnosis.
 */
function projectQa(detail: TaskDetailResponse): QaTurn[] {
  return detail.qa.map((turn) => ({
    id: turn.question_id,
    question: turn.question,
    answer: turn.answer,
    askedAt: turn.asked_at,
    answeredAt: turn.answered_at,
  }));
}

/**
 * Format one attempt's score the way status does: `9/5`, `8 · legacy`, or null.
 */
export function formatAttemptScore(entry: AttemptLineageEntry): string | null {
  if (entry.eval_score === null || entry.eval_score === undefined) return null;
  const score = formatScore(entry.eval_score);
  if (entry.eval_legacy) return `${score} · legacy`;
  if (entry.eval_baseline !== null && entry.eval_baseline !== undefined) {
    return `${score}/${formatScore(entry.eval_baseline)}`;
  }
  return score;
}

/**
 * Project the attempt chain (root → latest) into timeline items for the
 * inspector (#166). Mirrors enriched `parley status` badges and scores.
 */
export function projectAttemptLineage(
  attempts: readonly AttemptLineageEntry[],
  currentTaskId: string,
): AttemptLineageItem[] {
  return attempts.map((a) => {
    const meta = stateMetaFor(a.state);
    let cacheBadge: AttemptLineageItem["cacheBadge"] = null;
    if (a.cache_hit === true) cacheBadge = "cache";
    else if (a.cache_hit === false) cacheBadge = "no-cache";
    return {
      id: a.id,
      attempt: a.attempt,
      state: a.state,
      stateLabel: meta.label,
      stateColor: meta.colorVar,
      resumed: a.resumed,
      cacheBadge,
      score: formatAttemptScore(a),
      scoreValue: a.eval_score,
      baselineValue: a.eval_baseline,
      legacy: a.eval_legacy,
      current: a.id === currentTaskId,
    };
  });
}

/**
 * Project a task's full detail into the inspector's plain view. Q&A history
 * comes from the server's detail response (`detail.qa`) — the daemon persists
 * every `ask_orchestrator` turn, so a fresh client rehydrates without having
 * observed the exchange live (#79). Attempt lineage rides the same detail
 * payload (#164 / #166).
 */
export function projectInspector(detail: TaskDetailResponse, logs: LogsView): InspectorTask {
  const { task, row } = detail;
  const vendor = vendorEmblemFor(task.vendor);
  const harness = harnessColorFor(row.orch_harness);

  return {
    id: task.task_id,
    name: task.name ?? task.task_id,
    coat: harness.coat,
    emblem: vendor.emblem,
    faction: `${vendor.label} via ${harness.label}`,
    state: task.state,
    queuePosition: task.queue_position ?? null,
    blockingCap: task.blocking_cap ?? null,
    error: task.error,
    evalScore: row.eval_score,
    evalFeedback: row.eval_feedback,
    brief: projectBrief(detail),
    logs,
    report: projectReport(detail),
    qa: projectQa(detail),
    attempts: projectAttemptLineage(detail.attempts, task.task_id),
  };
}
