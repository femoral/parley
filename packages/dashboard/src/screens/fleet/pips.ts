/**
 * Run pip tracks for the fleet board.
 *
 * Priority (mirrors wire #262 / roster list projection):
 * 1. `summary.track` + `track_bound` when present
 * 2. `buildListPipTrack` fallback from summary fields alone
 *
 * Defect classes under test:
 * - fail pip must not be overwritten by a following loop iteration paint
 * - pending slots stay empty (not live)
 * - severity-preserving aggregation when bound > PIP_VISIBLE_CAP
 */
import type { RunBlock, RunSummary, RunTrackNode } from "@useparley/core";

export type PipKind = "done" | "live" | "gate" | "fail" | "empty";

export interface Pip {
  kind: PipKind;
}

/** Sighted cap before severity-preserving aggregation (DESIGN.md / audit). */
export const PIP_VISIBLE_CAP = 20;

const PIP_SEVERITY: Record<PipKind, number> = {
  fail: 4,
  gate: 3,
  live: 2,
  done: 1,
  empty: 0,
};

const PIP_KIND_LABEL: Record<PipKind, string> = {
  done: "done",
  live: "live",
  gate: "gate",
  fail: "failed",
  empty: "pending",
};

export function isHeldGate(block: RunBlock | null | undefined): boolean {
  return block != null && block.reason === "gate";
}

/** Map a track node STATE onto a pip kind. */
export function pipKindForNode(
  node: Pick<RunTrackNode, "kind" | "state" | "tasks_settled" | "tasks_total">,
): PipKind {
  if (node.kind === "gate") {
    if (node.state === "waiting") return "gate";
    return "done";
  }
  if (node.state === "failed") return "fail";
  if (
    node.state === "completed" ||
    node.state === "inherited" ||
    node.state === "purged" ||
    node.state === "cancelled"
  ) {
    return "done";
  }
  if (
    node.state === "running" ||
    node.state === "awaiting_answer" ||
    node.state === "stalled" ||
    node.state === "queued" ||
    node.state === "pending"
  ) {
    return "live";
  }
  if (node.tasks_total > 0 && node.tasks_settled < node.tasks_total) return "live";
  if (node.tasks_total > 0 && node.tasks_settled >= node.tasks_total) return "done";
  return "empty";
}

/**
 * Static-length track from entered nodes. Length is `track_bound`
 * (nodes × loop.max) when known; unfilled slots stay empty (pending).
 */
export function buildPipTrack(
  nodes: readonly RunTrackNode[],
  trackBound: number | null | undefined,
): Pip[] {
  const bound =
    typeof trackBound === "number" && Number.isFinite(trackBound) && trackBound > 0
      ? Math.floor(trackBound)
      : Math.max(nodes.length, 1);
  const pips: Pip[] = [];
  for (let i = 0; i < bound; i++) {
    const node = nodes[i];
    pips.push({ kind: node ? pipKindForNode(node) : "empty" });
  }
  return pips;
}

/**
 * Fallback when the list envelope has no `track` slice.
 * Fail/cancel mark sits at min(len-1, tasks_settled); prior slots are done —
 * never paint the mark index done (prior defect: fail pip overwritten).
 */
export function buildListPipTrack(summary: RunSummary): Pip[] {
  const bound =
    typeof summary.track_bound === "number" &&
    Number.isFinite(summary.track_bound) &&
    summary.track_bound > 0
      ? Math.floor(summary.track_bound)
      : 1;
  const pips: Pip[] = Array.from({ length: Math.max(bound, 1) }, () => ({
    kind: "empty" as const,
  }));

  if (summary.state === "completed" || summary.state === "purged") {
    return pips.map(() => ({ kind: "done" as const }));
  }

  if (summary.state === "failed" || summary.state === "cancelled") {
    const markIdx = Math.min(pips.length - 1, Math.max(0, summary.tasks_settled));
    for (let i = 0; i < markIdx; i++) {
      pips[i] = { kind: "done" };
    }
    pips[markIdx] = {
      kind: summary.state === "failed" ? "fail" : "done",
    };
    return pips;
  }

  if (summary.state === "blocked" && isHeldGate(summary.block)) {
    const idx = Math.min(pips.length - 1, Math.max(0, summary.iteration - 1));
    for (let i = 0; i < idx; i++) pips[i] = { kind: "done" };
    pips[idx] = { kind: "gate" };
    return pips;
  }

  if (summary.state === "blocked") {
    const idx = Math.min(pips.length - 1, Math.max(0, summary.iteration - 1));
    for (let i = 0; i < idx; i++) pips[i] = { kind: "done" };
    pips[idx] = { kind: "live" };
    return pips;
  }

  // running / other non-terminal
  const idx = Math.min(pips.length - 1, Math.max(0, summary.iteration - 1));
  for (let i = 0; i < idx; i++) pips[i] = { kind: "done" };
  pips[idx] = { kind: "live" };
  return pips;
}

/** Prefer list `track` when present; else list fallback. */
export function pipsForRun(summary: RunSummary): Pip[] {
  if (summary.track != null) {
    return buildPipTrack(summary.track, summary.track_bound);
  }
  return buildListPipTrack(summary);
}

/**
 * Cap visible pips with severity-preserving aggregation so fail/gate/live
 * cannot vanish when the bound exceeds {@link PIP_VISIBLE_CAP}.
 */
export function visiblePipTrack(
  pips: readonly Pip[],
  cap: number = PIP_VISIBLE_CAP,
): Pip[] {
  if (pips.length <= cap) return [...pips];
  const out: Pip[] = [];
  for (let i = 0; i < cap; i++) {
    const start = Math.floor((i * pips.length) / cap);
    const end = Math.floor(((i + 1) * pips.length) / cap);
    let worst: PipKind = "empty";
    for (let j = start; j < end; j++) {
      const kind = pips[j]!.kind;
      if (PIP_SEVERITY[kind] > PIP_SEVERITY[worst]) worst = kind;
    }
    out.push({ kind: worst });
  }
  return out;
}

/** Accessible summary of the full-bound track. */
export function describePipTrack(pips: readonly Pip[]): string {
  const counts: Record<PipKind, number> = {
    done: 0,
    live: 0,
    gate: 0,
    fail: 0,
    empty: 0,
  };
  for (const pip of pips) counts[pip.kind] += 1;
  const parts: string[] = [];
  for (const kind of ["done", "live", "gate", "fail", "empty"] as const) {
    const n = counts[kind];
    if (n > 0) parts.push(`${n} ${PIP_KIND_LABEL[kind]}`);
  }
  const bound = pips.length;
  const body = parts.length === 0 ? "none" : parts.join(", ");
  if (bound > PIP_VISIBLE_CAP) {
    return `Progress of ${bound}: ${body}; showing ${PIP_VISIBLE_CAP} segments`;
  }
  return `Progress of ${bound}: ${body}`;
}
