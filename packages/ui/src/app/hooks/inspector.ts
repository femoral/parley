/**
 * Layer 4 (hooks) — pure inspector projection (#68). Turns a task's full
 * detail (`useTaskDetail`'s envelope + row), its live log tail
 * (`useLogTail`), and the session's remembered Q&A turns into the plain
 * {@link InspectorTask} the `Inspector` hud component renders — mirrors
 * `roster.ts`/`inbox.ts`'s split (pure, unit-testable, no React/SSE here).
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
 * Project a task's full detail into the inspector's plain view. `qaHistory`
 * is the session's remembered turns for this task (the daemon doesn't
 * persist a Q&A transcript — only the current outstanding question rides the
 * envelope/row — so `useCockpit` remembers each answered turn locally as it
 * happens); an outstanding, not-yet-answered question is appended live from
 * the task's current `question` field so it shows immediately, before any
 * answer exists.
 */
export function projectInspector(detail: TaskDetailResponse, logs: LogsView, qaHistory: QaTurn[]): InspectorTask {
  const { task, row } = detail;
  const faction = factionFor(task.vendor);
  // Don't re-append a question the history already ends on: right after an
  // answer is delivered, `detail` (a poll, not a push) can still carry the
  // just-answered question for one interval, which would render the same
  // turn twice — once answered, once "outstanding". Comparing against the
  // last remembered turn closes that window; the (rare) cost is that an
  // agent immediately re-asking the byte-identical question reads as one
  // turn until it asks anything else.
  const question = task.question;
  const qa: QaTurn[] =
    question !== null && question !== qaHistory[qaHistory.length - 1]?.question
      ? [...qaHistory, { question, answer: null }]
      : qaHistory;

  return {
    id: task.task_id,
    name: task.name ?? task.task_id,
    coat: faction.coat,
    emblem: faction.emblem,
    state: task.state,
    evalScore: row.eval_score,
    evalFeedback: row.eval_feedback,
    brief: projectBrief(detail),
    logs,
    report: projectReport(detail),
    qa,
  };
}
