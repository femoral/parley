/**
 * Retry budget, reattempt window, and fresh-fix context composition (#158).
 *
 * Pure helpers so unit tests can pin chain counting and prompt layout without
 * standing up the full engine.
 */
import { formatDuration } from "@useparley/core";
import type { TaskRow } from "./db.js";

/** Stable daemon error code when a resume would exceed `retry.max`. */
export const CODE_RETRY_LIMIT_EXCEEDED = "retry_limit_exceeded";

/** Stable daemon error code when the parent has been terminal too long to resume. */
export const CODE_REATTEMPT_WINDOW_EXPIRED = "reattempt_window_expired";

/** Default cap on *resumed* fixes per chain (`retry.max`). */
export const DEFAULT_RETRY_MAX = 1;

/** Default reattempt window when unset (`retry.window` / global default). */
export const DEFAULT_RETRY_WINDOW_MS = 30 * 60 * 1000;

/**
 * Collect every task in the attempt chain that contains `memberId`: walk up to
 * the root via `parent_task_id`, then gather all descendants of that root.
 * Ordered by attempt, then id (stable for history rendering).
 */
export function collectAttemptChain(tasks: TaskRow[], memberId: string): TaskRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let cur = byId.get(memberId);
  if (cur === undefined) return [];
  while (cur.parent_task_id !== null) {
    const parent = byId.get(cur.parent_task_id);
    if (parent === undefined) break;
    cur = parent;
  }
  const rootId = cur.id;
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (t.parent_task_id !== null && ids.has(t.parent_task_id) && !ids.has(t.id)) {
        ids.add(t.id);
        grew = true;
      }
    }
  }
  return tasks
    .filter((t) => ids.has(t.id))
    .sort((a, b) => a.attempt - b.attempt || a.id.localeCompare(b.id));
}

/** Count attempts in the chain with `resumed = true` (budget accounting). */
export function countResumedAttempts(tasks: TaskRow[], memberId: string): number {
  return collectAttemptChain(tasks, memberId).filter((t) => t.resumed === 1).length;
}

/** Milliseconds since the parent became terminal (`completed_at`, else `updated_at`). */
export function parentTerminalAgeMs(parent: TaskRow, nowMs = Date.now()): number {
  const iso = parent.completed_at ?? parent.updated_at;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, nowMs - at);
}

/** Short gist of a stored report JSON for attempt-history sections. */
export function reportGist(reportJson: string | null): string {
  if (reportJson === null || reportJson === "") return "(no report)";
  try {
    const body = JSON.parse(reportJson) as { summary?: unknown; outcome?: unknown };
    const summary = typeof body.summary === "string" && body.summary !== ""
      ? body.summary
      : "(no summary)";
    const outcome = typeof body.outcome === "string" ? body.outcome : "unknown";
    return `${summary} (outcome: ${outcome})`;
  } catch {
    return "(unparseable report)";
  }
}

/**
 * Three-section body for a fresh fix (#158 / grilling #139), without the
 * protocol preamble (caller re-prepends via {@link buildProtocolPreamble}).
 *
 * ```
 * ## Original brief
 * ## Attempt history   (per prior attempt: brief + report gist)
 * ## Fix request
 * ```
 */
export function composeFreshFixBody(chain: TaskRow[], fixBrief: string): string {
  const root = chain.find((t) => t.parent_task_id === null) ?? chain[0];
  const original = root?.prompt ?? "";
  const lines: string[] = ["## Original brief", "", original, "", "## Attempt history", ""];
  for (const attempt of chain) {
    lines.push(
      `### Attempt ${attempt.attempt} (${attempt.id})`,
      "",
      `Brief: ${attempt.prompt ?? ""}`,
      "",
      `Report: ${reportGist(attempt.report)}`,
      "",
    );
  }
  lines.push("## Fix request", "", fixBrief);
  return lines.join("\n");
}

/** User-facing message for `retry_limit_exceeded` (never coaches raising the limit). */
export function retryLimitMessage(resumedCount: number, max: number): string {
  return (
    `retry limit exceeded: this chain already has ${resumedCount} resumed attempt` +
    `${resumedCount === 1 ? "" : "s"} (retry.max=${max}). ` +
    "Use `parley fix --fresh` or start a new delegate."
  );
}

/** User-facing message for `reattempt_window_expired` (never coaches raising the window). */
export function reattemptWindowMessage(ageMs: number, windowMs: number): string {
  return (
    `reattempt window expired: parent has been terminal for ${formatDuration(ageMs)} ` +
    `(window is ${formatDuration(windowMs)}). ` +
    "Use `parley fix --fresh` or start a new delegate."
  );
}
