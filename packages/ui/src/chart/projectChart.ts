/**
 * Chart-space projection from {@link InspectorRun} (#253 / ADR-0021).
 *
 * Derives marks, legs, loop-backs and seal state inside the chart package —
 * never widens the inspector projection. One mark per (node, iteration);
 * fan-out width is written in a tally chip, never drawn as n marks.
 */

import type {
  InspectorRun,
  InspectorRunNode,
  InspectorRunReady,
} from "../hud/types.js";
import { inkForNode, type ChartGlyph, type ChartInk } from "./ink.js";

/** Normalized chart coordinate space (matches SVG viewBox). */
export const CHART_VB = { w: 1000, h: 560 } as const;

export type SealState = "held" | "broken";

export interface ChartMark {
  key: string;
  node: string;
  kind: "step" | "gate";
  iteration: number;
  ink: ChartInk;
  glyph: ChartGlyph;
  className: string;
  /** Operational label under the mark (Outfit). */
  name: string;
  /** Quiet mono meta under the name. */
  meta: string;
  /** Fan-out width for tally chip; null when single-task / gate. */
  fanoutWidth: number | null;
  /** Gate seal treatment; null for steps. */
  seal: SealState | null;
  x: number;
  y: number;
  live: boolean;
  onReject: string | null;
}

export interface ChartLeg {
  /** SVG path `d` in chart viewBox units. */
  d: string;
  /**
   * Pen weight only (Stroke-State Rule): strong for sailed structure,
   * soft for not-yet-reached structure. Never a state ink.
   */
  pen: "chart" | "soft";
}

export interface ChartLoopBack {
  d: string;
  fromKey: string;
  toKey: string;
}

export interface ChartReadyModel {
  status: "ready";
  id: string;
  workflow: string;
  shortId: string;
  stateLabel: string;
  heldGate: boolean;
  marks: ChartMark[];
  legs: ChartLeg[];
  loopBacks: ChartLoopBack[];
  destination: { x: number; y: number };
  /**
   * Sparse decoration when the route is tiny (single node / no gates) so
   * empty-quarter ornament does not sit on the trail.
   */
  decorations: "full" | "sparse";
  flavor: string;
}

export interface ChartPendingModel {
  status: "pending";
  id: string;
  shortId: string;
}

export type ChartModel = ChartReadyModel | ChartPendingModel;

function shortRef(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function sealForGate(node: InspectorRunNode): SealState {
  return node.state === "waiting" ? "held" : "broken";
}

function markMeta(node: InspectorRunNode): string {
  if (node.kind === "gate") {
    if (node.state === "waiting") {
      return node.age ? `held ${node.age}` : "held";
    }
    return node.stateLabel;
  }
  const parts: string[] = [];
  if (node.iteration > 1) parts.push(`pass ${node.iteration}`);
  parts.push(node.stateLabel);
  if (node.age) parts.push(node.age);
  return parts.join(" · ");
}

/**
 * Place marks along a gentle treasure-trail curve. Positions are a pure
 * function of (index, count) — addressed by (node, iteration) order, never
 * by task id (the scene's scatter is a different key).
 */
function placeMark(index: number, count: number): { x: number; y: number } {
  if (count <= 0) return { x: CHART_VB.w * 0.2, y: CHART_VB.h * 0.55 };
  if (count === 1) {
    // Single mark: left-of-centre so the destination and sparse ornament
    // can sit clear of the route (acceptance: no empty-quarter overlap).
    return { x: CHART_VB.w * 0.32, y: CHART_VB.h * 0.52 };
  }
  const t = index / (count - 1);
  // Slight hand-drawn wander — deterministic from index, not task id.
  const wander = Math.sin(index * 1.7) * 18;
  const x = CHART_VB.w * (0.12 + t * 0.62) + wander * 0.15;
  const y = CHART_VB.h * (0.68 - t * 0.28 - Math.sin(t * Math.PI) * 0.08) + wander * 0.35;
  return { x, y };
}

function cubicLeg(
  a: { x: number; y: number },
  b: { x: number; y: number },
  lift = 0.18,
): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Lift perpendicular to the segment so the trail bows the way a hand draws.
  const cx1 = a.x + dx * 0.35 - dy * lift * 0.4;
  const cy1 = a.y + dy * 0.35 + dx * lift * 0.15;
  const cx2 = a.x + dx * 0.65 - dy * lift * 0.4;
  const cy2 = a.y + dy * 0.65 + dx * lift * 0.15;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${cx1.toFixed(1)},${cy1.toFixed(1)} ${cx2.toFixed(1)},${cy2.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

function loopArc(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const mx = (from.x + to.x) / 2;
  const top = Math.min(from.y, to.y) - 90;
  return `M${from.x.toFixed(1)},${from.y.toFixed(1)} C${(from.x * 0.7 + mx * 0.3).toFixed(1)},${top.toFixed(1)} ${(to.x * 0.7 + mx * 0.3).toFixed(1)},${top.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
}

function projectReady(run: InspectorRunReady): ChartReadyModel {
  const nodes = run.nodes;
  const marks: ChartMark[] = nodes.map((node, i) => {
    const style = inkForNode(node);
    const pos = placeMark(i, nodes.length);
    const seal = node.kind === "gate" ? sealForGate(node) : null;
    return {
      key: node.key,
      node: node.node,
      kind: node.kind,
      iteration: node.iteration,
      ink: style.ink,
      glyph: style.glyph,
      className: style.className,
      name: node.node,
      meta: markMeta(node),
      fanoutWidth: node.fanoutWidth,
      seal,
      x: pos.x,
      y: pos.y,
      live: node.live,
      onReject: node.onReject,
    };
  });

  // Legs: structural pen only. Soft pen for legs that leave a not-yet /
  // ghost mark or arrive at one; strong pen otherwise. Never state ink.
  const legs: ChartLeg[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i]!;
    const b = marks[i + 1]!;
    const soft = a.ink === "ghost" || b.ink === "ghost";
    legs.push({
      d: cubicLeg(a, b),
      pen: soft ? "soft" : "chart",
    });
  }

  // Destination X after the last mark (or alone when the table is empty).
  const destination =
    marks.length === 0
      ? { x: CHART_VB.w * 0.72, y: CHART_VB.h * 0.52 }
      : (() => {
          const last = marks[marks.length - 1]!;
          return {
            x: Math.min(CHART_VB.w * 0.9, last.x + CHART_VB.w * 0.14),
            y: Math.max(CHART_VB.h * 0.28, last.y - 20),
          };
        })();

  if (marks.length > 0) {
    const last = marks[marks.length - 1]!;
    // Final leg to the destination spot — soft when the last mark is ahead.
    legs.push({
      d: cubicLeg(last, destination, 0.12),
      pen: last.ink === "ghost" ? "soft" : "chart",
    });
  }

  // Loop-backs: gate on_reject → earlier mark of that node name (any pass).
  const loopBacks: ChartLoopBack[] = [];
  for (const mark of marks) {
    if (mark.kind !== "gate" || !mark.onReject) continue;
    const target = marks.find(
      (m) => m.node === mark.onReject && m.key !== mark.key,
    );
    if (!target) continue;
    // Only arc "back" (target earlier in sequence).
    const fromIdx = marks.indexOf(mark);
    const toIdx = marks.indexOf(target);
    if (toIdx >= fromIdx) continue;
    loopBacks.push({
      d: loopArc(mark, target),
      fromKey: mark.key,
      toKey: target.key,
    });
  }

  // Also arc iteration re-entries: mark at iteration N back to same node at N-1
  // when the sequence has already moved past (covers multi-pass loops without
  // an on_reject gate). Only when no gate loop already covers the pair.
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    if (m.iteration <= 1) continue;
    const prev = marks.find(
      (p) => p.node === m.node && p.iteration === m.iteration - 1,
    );
    if (!prev) continue;
    // Draw from the mark immediately before this re-entry back to the prior pass
    // when that predecessor is a different node (the route just looped).
    if (i === 0) continue;
    const predecessor = marks[i - 1]!;
    if (predecessor.node === m.node) continue;
    const already = loopBacks.some(
      (lb) => lb.fromKey === predecessor.key && lb.toKey === prev.key,
    );
    if (already) continue;
    // Prefer gate on_reject arcs; only add structural loop when iteration jumps.
    if (predecessor.iteration === m.iteration) continue;
    loopBacks.push({
      d: loopArc(predecessor, prev),
      fromKey: predecessor.key,
      toKey: prev.key,
    });
  }

  const hasGate = marks.some((m) => m.kind === "gate");
  const decorations: "full" | "sparse" =
    marks.length <= 1 && !hasGate ? "sparse" : "full";

  const flavorParts: string[] = [];
  if (run.duration) flavorParts.push(run.duration);
  if (run.iteration > 0) flavorParts.push(`pass ${run.iteration}`);
  if (run.heldGate) flavorParts.push("one seal still unbroken");
  else if (run.runState === "completed") flavorParts.push("the run is charted");
  else if (run.runState === "running") flavorParts.push("the route is still wet");
  const flavor =
    flavorParts.length > 0
      ? flavorParts.join(" · ")
      : "a route inked on aged paper";

  return {
    status: "ready",
    id: run.id,
    workflow: run.workflow,
    shortId: shortRef(run.id),
    stateLabel: run.stateLabel,
    heldGate: run.heldGate,
    marks,
    legs,
    loopBacks,
    destination,
    decorations,
    flavor,
  };
}

/**
 * Project the inspector run view into chart geometry. Pending stays honest —
 * no invented node counts, states, or versions.
 */
export function projectChart(run: InspectorRun): ChartModel {
  if (run.status === "pending") {
    return {
      status: "pending",
      id: run.id,
      shortId: shortRef(run.id),
    };
  }
  return projectReady(run);
}

/** Mark count equals the (node, iteration) count — load-bearing invariant. */
export function chartMarkCount(model: ChartModel): number {
  return model.status === "ready" ? model.marks.length : 0;
}
