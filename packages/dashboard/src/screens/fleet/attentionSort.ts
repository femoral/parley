/**
 * Attention ranking for the fleet task table.
 *
 * Order (DESIGN.md + chrome/attention.ts):
 *   awaiting_answer → stalled → failed → running → queued → pending →
 *   completed → cancelled
 * Then by age ascending (oldest first within a rank — older asks surface
 * sooner). Fresh failures (failed within FRESH_FAILURE_MS) share the failed
 * rank; the table note marks them as "fresh failure".
 *
 * Attention items that need the orchestrator (questions / stalls / failures)
 * therefore always sort above calm progress.
 */
import type { TaskEnvelope } from "@useparley/core";

/** Rank map — lower sorts first. Unknown states sink to the bottom. */
export const ATTENTION_RANK: Record<string, number> = {
  awaiting_answer: 0,
  stalled: 1,
  failed: 2,
  running: 3,
  queued: 4,
  pending: 5,
  completed: 6,
  cancelled: 7,
};

/** Fresh-failure loud window (coverage audit: 5 min). */
export const FRESH_FAILURE_MS = 5 * 60 * 1000;

export function attentionRank(state: string): number {
  return ATTENTION_RANK[state] ?? 99;
}

export function isFreshFailure(
  task: Pick<TaskEnvelope, "state" | "completed_at" | "updated_at">,
  nowMs: number = Date.now(),
): boolean {
  if (task.state !== "failed") return false;
  const raw = task.completed_at ?? task.updated_at;
  if (raw == null || raw === "") return false;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return false;
  return nowMs - ms <= FRESH_FAILURE_MS;
}

/**
 * Sort tasks by attention rank, then age (oldest first within rank).
 * Returns a new array; does not mutate the input.
 */
export function sortTasksByAttention(
  tasks: readonly TaskEnvelope[],
): TaskEnvelope[] {
  return tasks.slice().sort((a, b) => {
    const ra = attentionRank(a.state);
    const rb = attentionRank(b.state);
    if (ra !== rb) return ra - rb;
    const aa = a.updated_at ?? a.created_at ?? "";
    const bb = b.updated_at ?? b.created_at ?? "";
    // Older first so long-standing asks/stalls outrank fresh ones of the same rank.
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    return (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0);
  });
}

/** Attention rank for runs (held gate rides the awaiting tier). */
export function runAttentionRank(summary: {
  state: string;
  block?: { reason?: string } | null;
}): number {
  if (summary.state === "blocked" && summary.block?.reason === "gate") {
    return ATTENTION_RANK.awaiting_answer ?? 0;
  }
  if (summary.state === "blocked") return ATTENTION_RANK.stalled ?? 1;
  if (summary.state === "running") return ATTENTION_RANK.running ?? 3;
  if (summary.state === "failed") return ATTENTION_RANK.failed ?? 2;
  if (summary.state === "cancelled") return ATTENTION_RANK.cancelled ?? 7;
  if (summary.state === "completed" || summary.state === "purged") {
    return ATTENTION_RANK.completed ?? 6;
  }
  return 50;
}

export function sortRunsByAttention<
  T extends { state: string; block?: { reason?: string } | null; updated_at?: string },
>(runs: readonly T[]): T[] {
  return runs.slice().sort((a, b) => {
    const ra = runAttentionRank(a);
    const rb = runAttentionRank(b);
    if (ra !== rb) return ra - rb;
    const aa = a.updated_at ?? "";
    const bb = b.updated_at ?? "";
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    return 0;
  });
}
