/**
 * Layer 4 (hooks) — pure inspector projection (#68). Turns a task's full
 * detail (`useTaskDetail`'s envelope + row + durable `qa`) and its live log
 * tail (`useLogTail`) into the plain {@link InspectorTask} the `Inspector`
 * hud component renders — mirrors `roster.ts`/`inbox.ts`'s split (pure,
 * unit-testable, no React/SSE here).
 */
import type { TaskDetailResponse } from "@useparley/core";
import { factionFor } from "../../tokens/factions.js";
import type { BriefView, InspectorTask, LogsView, QaTurn, ReportView } from "../../hud/types.js";
import { formatUptime, formatUsage } from "./format.js";

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
 * Project a task's full detail into the inspector's plain view. Q&A history
 * comes from the server's detail response (`detail.qa`) — the daemon persists
 * every `ask_orchestrator` turn, so a fresh client rehydrates without having
 * observed the exchange live (#79).
 */
export function projectInspector(detail: TaskDetailResponse, logs: LogsView): InspectorTask {
  const { task, row } = detail;
  const faction = factionFor(task.vendor);

  return {
    id: task.task_id,
    name: task.name ?? task.task_id,
    coat: faction.coat,
    emblem: faction.emblem,
    faction: faction.label,
    state: task.state,
    error: task.error,
    evalScore: row.eval_score,
    evalFeedback: row.eval_feedback,
    brief: projectBrief(detail),
    logs,
    report: projectReport(detail),
    qa: projectQa(detail),
  };
}
