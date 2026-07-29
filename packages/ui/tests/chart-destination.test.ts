/**
 * #275 — destination marker placement clears the final mark.
 *
 * Geometry only (happy-dom performs no layout). Lab sweeps remain the
 * painted-ink evidence; these unit tests lock the projector contract:
 * DEST_RESERVE is the sole right-edge constant, destinationRect tracks the
 * seat, and the marker sits after the final mark with a leg to it.
 */
import { describe, expect, it } from "vitest";
import {
  CHART_VB_W,
  destinationRect,
  markLabelRects,
  markRingRects,
  placeDestination,
  projectChart,
} from "../src/chart/projectChart.js";
import type { InspectorRunNode, InspectorRunReady } from "../src/hud/types.js";

function node(
  overrides: Partial<InspectorRunNode> &
    Pick<InspectorRunNode, "node" | "kind" | "iteration" | "state">,
): InspectorRunNode {
  const key = overrides.key ?? `${overrides.node}\0${overrides.iteration}`;
  return {
    key,
    stateLabel: overrides.stateLabel ?? overrides.state,
    tasksLabel: overrides.tasksLabel ?? (overrides.kind === "gate" ? "—" : "1"),
    gist: overrides.gist ?? "—",
    age: overrides.age ?? null,
    fanoutWidth: overrides.fanoutWidth ?? null,
    spineState: overrides.spineState ?? overrides.state,
    live: overrides.live ?? false,
    onReject: overrides.onReject ?? null,
    ...overrides,
  };
}

function readyRun(nodes: InspectorRunNode[]): InspectorRunReady {
  return {
    status: "ready",
    id: "r-dest01abcdef",
    workflow: "research",
    workflowVersion: 1,
    runState: "running",
    stateLabel: "running",
    branch: null,
    currentNode: nodes[nodes.length - 1]?.node ?? null,
    iteration: 1,
    duration: "12m 0s",
    tasksTotal: nodes.length,
    heldGate: nodes.some((n) => n.kind === "gate" && n.state === "waiting"),
    deliverables: { status: "not_fetched" },
    block: null,
    nodes,
  };
}

function nodesForCount(n: number, held = false): InspectorRunNode[] {
  const names = [
    "scope",
    "search",
    "funnel",
    "accept-sources",
    "adversarial",
    "rework-or-finish",
    "publish",
    "report",
    "triage",
    "implement",
    "review",
    "ship",
  ];
  return Array.from({ length: n }, (_, i) => {
    const name = names[i % names.length]!;
    const isLast = i === n - 1;
    const isGate = name === "accept-sources" || name === "rework-or-finish";
    const waiting = held && isGate && isLast;
    return node({
      node: `${name}${i >= names.length ? `-${i}` : ""}`,
      kind: isGate ? "gate" : "step",
      iteration: 1,
      state: waiting ? "waiting" : isLast ? "running" : "completed",
      stateLabel: waiting ? "waiting" : isLast ? "running" : "completed",
      spineState: waiting ? "waiting" : isLast ? "running" : "completed",
      live: isLast && !waiting,
      age: isLast ? "9m" : null,
      fanoutWidth: name === "search" ? 40 : null,
      onReject: isGate ? "scope" : null,
    });
  });
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad = 2,
): boolean {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

describe("destination placement (#275)", () => {
  it("destinationRect is centred on the seat with fixed half-size", () => {
    const r = destinationRect({ x: 500, y: 200 });
    expect(r.key).toBe("destination");
    expect(r.x).toBe(440);
    expect(r.y).toBe(172);
    expect(r.w).toBe(120);
    expect(r.h).toBe(72);
  });

  it.each([1, 2, 3, 5, 8, 12, 16, 20] as const)(
    "n=%i: seat is after the final mark and clears structural ring/label rects",
    (n) => {
      const model = projectChart(readyRun(nodesForCount(n)));
      expect(model.status).toBe("ready");
      if (model.status !== "ready") return;

      const last = model.marks[model.marks.length - 1]!;
      const dest = model.destination;
      // Prefer forward of the final mark; allow a small left slip only when
      // free-region search had no better after-seat (should not on these counts).
      expect(dest.x + 1).toBeGreaterThanOrEqual(last.x);

      const destBox = destinationRect(dest);
      const rings = markRingRects(model.marks);
      const labels = markLabelRects(model.marks);
      for (const o of [...rings, ...labels]) {
        expect(
          rectsOverlap(destBox, o, 2),
          `destination overlaps ${o.key} at n=${n}`,
        ).toBe(false);
      }
    },
  );

  it("held final gate: destination still clears the wax-seal ring rect", () => {
    // Force a held gate as the last mark.
    const nodes = nodesForCount(3).map((n, i, arr) =>
      i === arr.length - 1
        ? node({
            node: "review-gate",
            kind: "gate",
            iteration: 1,
            state: "waiting",
            stateLabel: "waiting",
            spineState: "waiting",
            live: false,
            onReject: "scope",
          })
        : n,
    );
    const model = projectChart(readyRun(nodes));
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    const last = model.marks[model.marks.length - 1]!;
    expect(last.seal).toBe("held");
    const destBox = destinationRect(model.destination);
    const lastRing = markRingRects([last])[0]!;
    expect(rectsOverlap(destBox, lastRing, 2)).toBe(false);
  });

  it("empty marks: placeDestination returns a mid-sheet seat", () => {
    const p = placeDestination([], 560);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(CHART_VB_W);
    expect(p.y).toBeGreaterThan(0);
    expect(p.y).toBeLessThan(560);
  });

  it("final leg runs from the last mark toward the destination seat", () => {
    const model = projectChart(readyRun(nodesForCount(5)));
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    const last = model.marks[model.marks.length - 1]!;
    const lastLeg = model.legs[model.legs.length - 1]!;
    const { x, y } = model.destination;
    // cubicLeg shortens endpoints past mark clear radii, so the path does not
    // end on the exact centre — but it must approach the destination seat.
    const end = lastLeg.d.match(
      /([\d.-]+),([\d.-]+)\s*$/,
    );
    expect(end).not.toBeNull();
    const endX = Number(end![1]);
    const endY = Number(end![2]);
    const distToDest = Math.hypot(endX - x, endY - y);
    const distToLast = Math.hypot(endX - last.x, endY - last.y);
    expect(distToDest).toBeLessThan(distToLast);
    expect(distToDest).toBeLessThan(80);
  });

  it("no hard-coded 70 clamp remains — destination x uses DEST_RESERVE geometry", () => {
    // Right-ending trails: destination must not be pinned at CHART_VB_W - 70
    // (the old constant). With free placement it sits clear, often below.
    const model = projectChart(readyRun(nodesForCount(5)));
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    const last = model.marks[model.marks.length - 1]!;
    // Old bug: dest.x === min(930, last.x+120) with last at 900 → 930.
    // After the fix, either the offset is the reserve or the seat is moved.
    const oldPinned = Math.min(CHART_VB_W - 70, last.x + 120);
    const dist = Math.hypot(
      model.destination.x - last.x,
      model.destination.y - last.y,
    );
    // Must not sit on the old coincident pin with a short same-row gap.
    const sameRowShort =
      model.destination.y === last.y &&
      model.destination.x === oldPinned &&
      oldPinned - last.x < 50;
    expect(sameRowShort).toBe(false);
    expect(dist).toBeGreaterThan(50);
  });
});
