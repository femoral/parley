/**
 * Attention count for the header "needs orch" pill.
 * Rank order (DESIGN.md): awaiting_answer, stalled, failed, … + held gates.
 * State is never by hue alone — the pill pairs amber ink with the label.
 */
import type { RunSummary, TaskEnvelope } from "@useparley/core";
import {
  ATTENTION_TASK_STATES,
  attentionRank,
  isHeldGate,
  sortTasksByAttention,
} from "../data/attentionRank.js";

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
    if (isHeldGate(r)) n += 1;
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
export function attentionTaskIds(tasks: readonly TaskEnvelope[]): string[] {
  return sortTasksByAttention(tasks)
    .filter((t) => ATTENTION_TASK_STATES.has(t.state))
    .map((t) => t.task_id);
}

export { attentionRank, ATTENTION_TASK_STATES };
