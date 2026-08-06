/**
 * Run "at" column + block-reason vocabulary (coverage audit §2A #10).
 * Gate verbs are deferred (#360) — we only surface the hold, not approve/reject.
 */
import type { RunBlock, RunSummary } from "@useparley/core";
import { isHeldGate } from "./pips.js";

const BLOCK_REASON_LABEL: Record<string, string> = {
  gate: "gate waiting",
  loop_exhausted: "loop exhausted",
  success_policy: "success policy",
  spawn_error: "spawn error",
  unfilled_inputs: "unfilled inputs",
  unknown: "blocked",
};

export function blockReasonLabel(block: RunBlock | null | undefined): string | null {
  if (!block) return null;
  if (block.detail && block.detail.trim() !== "") return block.detail;
  return BLOCK_REASON_LABEL[block.reason] ?? block.reason;
}

/** Human "at" line for a run row. */
export function runAtLine(summary: RunSummary): { text: string; held: boolean } {
  if (summary.state === "blocked" && summary.block) {
    const node = summary.block.node ?? summary.current_node;
    const reason = blockReasonLabel(summary.block);
    if (isHeldGate(summary.block)) {
      const base = node
        ? `${node}${summary.block.iteration != null ? `.${summary.block.iteration}` : ""}`
        : "gate";
      return { text: `${base} — gate waiting`, held: true };
    }
    if (node && reason) return { text: `${node} — ${reason}`, held: false };
    if (reason) return { text: reason, held: false };
    return { text: "blocked", held: false };
  }
  if (summary.current_node) {
    const fan =
      summary.tasks_total > 1
        ? ` — ${summary.tasks_settled} of ${summary.tasks_total}`
        : "";
    return {
      text: `${summary.current_node}.${summary.iteration}${fan}`,
      held: false,
    };
  }
  if (summary.state === "completed" || summary.state === "purged") {
    return { text: "run outputs sealed", held: false };
  }
  return { text: summary.workflow, held: false };
}

export function runStateLabel(summary: RunSummary): string {
  if (summary.state === "blocked" && isHeldGate(summary.block)) return "GATE HELD";
  if (summary.state === "blocked") {
    const r = summary.block?.reason;
    if (r && r !== "unknown") return `BLOCKED · ${r.replace(/_/g, " ").toUpperCase()}`;
    return "BLOCKED";
  }
  return summary.state.replace(/_/g, " ").toUpperCase();
}

/** CSS state key for chip color (maps run lifecycle onto task-state palette). */
export function runChipState(summary: RunSummary): string {
  if (summary.state === "blocked" && isHeldGate(summary.block)) return "awaiting_answer";
  if (summary.state === "blocked") return "stalled";
  if (summary.state === "purged") return "cancelled";
  return summary.state;
}
