/**
 * Project the right-rail attention queue from tasks + held gates.
 * Ordered by canonical attention rank, then age (oldest first).
 */
import type { RunSummary, TaskEnvelope } from "@useparley/core";
import {
  ATTENTION_TASK_STATES,
  attentionRank,
  isFreshFailure,
  isHeldGate,
  sortRunsByAttention,
  sortTasksByAttention,
} from "../data/attentionRank.js";

export type AttentionItemKind = "task" | "gate";

export interface AttentionItem {
  kind: AttentionItemKind;
  /** task_id or run_id */
  id: string;
  state: string;
  title: string;
  reason: string;
  meta: string;
  ageAt: string;
  rank: number;
  /** Optional badge override (e.g. GATE HELD). */
  badgeLabel?: string;
}

function shortId(id: string, n = 8): string {
  return id.length <= n ? id : id.slice(0, n);
}

function taskReason(t: TaskEnvelope, nowMs: number): string {
  if (t.state === "awaiting_answer") {
    return t.question?.trim() || "Waiting for orchestrator answer";
  }
  if (t.state === "stalled") {
    return t.error?.trim() || "Task stalled";
  }
  if (t.state === "failed") {
    const fresh = isFreshFailure(t, nowMs) ? "fresh failure · " : "";
    return `${fresh}${t.error?.trim() || "Task failed"}`.trim();
  }
  return t.error?.trim() || t.state.replace(/_/g, " ");
}

function taskMeta(t: TaskEnvelope): string {
  const parts: string[] = [];
  if (t.branch) parts.push(t.branch);
  const harness = t.orch_harness ?? t.vendor;
  const model = t.orch_model ?? t.model;
  if (harness || model) {
    parts.push([harness, model].filter(Boolean).join(" · "));
  }
  if (t.orchestrator_session_id) {
    parts.push(`sess ${shortId(t.orchestrator_session_id, 6)}`);
  }
  return parts.join(" · ") || shortId(t.task_id);
}

function gateReason(r: RunSummary): string {
  const node = r.block?.node ?? r.current_node ?? "gate";
  const iter = r.block?.iteration ?? r.iteration;
  const verbs = r.block?.verbs?.length ? r.block.verbs.join(" · ") : "approve · reject";
  return `Gate held at ${node}${iter != null ? ` · pass ${iter}` : ""} · ${verbs}`;
}

function gateMeta(r: RunSummary): string {
  const parts = [`run ${shortId(r.run_id)}`];
  if (r.branch) parts.push(r.branch);
  if (r.orchestrator_session_id) {
    parts.push(`sess ${shortId(r.orchestrator_session_id, 6)}`);
  }
  return parts.join(" · ");
}

/**
 * Build attention-queue items: needs-orch tasks + held gates, rank then age.
 */
export function projectAttentionItems(
  tasks: readonly TaskEnvelope[],
  runs: readonly RunSummary[],
  opts: {
    nowMs?: number;
    /** Filter by orchestrator session id; "all" or empty = no filter. */
    sessionId?: string;
    /** Filter by state key (awaiting_answer|stalled|failed|gate) or "all". */
    stateFilter?: string;
  } = {},
): AttentionItem[] {
  const nowMs = opts.nowMs ?? Date.now();
  const session =
    opts.sessionId && opts.sessionId !== "all" ? opts.sessionId : null;
  const stateFilter =
    opts.stateFilter && opts.stateFilter !== "all" ? opts.stateFilter : null;

  const taskItems: AttentionItem[] = sortTasksByAttention(tasks)
    .filter((t) => ATTENTION_TASK_STATES.has(t.state))
    .filter((t) => {
      if (!session) return true;
      return t.orchestrator_session_id === session;
    })
    .map((t) => ({
      kind: "task" as const,
      id: t.task_id,
      state: t.state,
      title: t.name?.trim() || t.task_id,
      reason: taskReason(t, nowMs),
      meta: taskMeta(t),
      ageAt: t.updated_at ?? t.created_at ?? "",
      rank: attentionRank(t.state),
    }));

  const gateItems: AttentionItem[] = sortRunsByAttention(runs)
    .filter((r) => isHeldGate(r))
    .filter((r) => {
      if (!session) return true;
      return r.orchestrator_session_id === session;
    })
    .map((r) => ({
      kind: "gate" as const,
      id: r.run_id,
      state: "awaiting_answer",
      title: r.workflow || r.run_id,
      reason: gateReason(r),
      meta: gateMeta(r),
      ageAt: r.updated_at ?? r.created_at ?? "",
      rank: attentionRank("awaiting_answer"),
      badgeLabel: "GATE HELD",
    }));

  const merged = [...taskItems, ...gateItems].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.ageAt < b.ageAt) return -1;
    if (a.ageAt > b.ageAt) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (!stateFilter) return merged;
  if (stateFilter === "gate") {
    return merged.filter((i) => i.kind === "gate");
  }
  return merged.filter((i) => i.kind === "task" && i.state === stateFilter);
}
