/**
 * Attention count for the header "needs orch" pill.
 * Rank order (DESIGN.md): awaiting_answer, stalled, failed, … + held gates.
 * State is never by hue alone — the pill pairs amber ink with the label.
 */
import type { RunSummary, TaskEnvelope } from "@useparley/core";

const ATTENTION_TASK_STATES = new Set(["awaiting_answer", "stalled", "failed"]);

export function countAttentionTasks(tasks: readonly TaskEnvelope[]): number {
  let n = 0;
  for (const t of tasks) {
    if (ATTENTION_TASK_STATES.has(t.state)) n += 1;
  }
  return n;
}

/** Gate-held runs need the orchestrator (block.reason === "gate"). */
export function countHeldGates(runs: readonly RunSummary[]): number {
  let n = 0;
  for (const r of runs) {
    if (r.state === "blocked" && r.block?.reason === "gate") n += 1;
  }
  return n;
}

export function countNeedsOrch(
  tasks: readonly TaskEnvelope[],
  runs: readonly RunSummary[] = [],
): number {
  return countAttentionTasks(tasks) + countHeldGates(runs);
}

/** Cycle order for n / ⇧N accelerators — attention-rank first, then age. */
const RANK: Record<string, number> = {
  awaiting_answer: 0,
  stalled: 1,
  failed: 2,
  running: 3,
  queued: 4,
  pending: 5,
  completed: 6,
  cancelled: 7,
};

export function attentionTaskIds(tasks: readonly TaskEnvelope[]): string[] {
  return tasks
    .filter((t) => ATTENTION_TASK_STATES.has(t.state))
    .slice()
    .sort((a, b) => {
      const ra = RANK[a.state] ?? 99;
      const rb = RANK[b.state] ?? 99;
      if (ra !== rb) return ra - rb;
      const aa = a.updated_at ?? "";
      const bb = b.updated_at ?? "";
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    })
    .map((t) => t.task_id);
}
