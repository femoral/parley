/**
 * #253 QC — B1 cartography invariant: at realistic node counts, label
 * rectangles never intersect each other and never cover the route stroke.
 * Measured geometry (viewBox rects), not a snapshot.
 */
import { describe, expect, it } from "vitest";
import {
  anyKeyOverprint,
  anyMarginaliaOverprint,
  assertLabelClearance,
  destinationRect,
  keyZoneRect,
  loopArc,
  markLabelRects,
  markRingRects,
  marginaliaRect,
  placeMarginalia,
  placeMarks,
  projectChart,
  MARK_CLEAR_R,
  type ChartMark,
} from "../src/chart/projectChart.js";
import { inkForNode } from "../src/chart/ink.js";
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
    id: "r-layout01abcdef",
    workflow: "research",
    workflowVersion: 1,
    runState: "running",
    stateLabel: "running",
    branch: null,
    currentNode: nodes[nodes.length - 1]?.node ?? null,
    iteration: 1,
    duration: "12m 0s",
    tasksTotal: nodes.length,
    heldGate: false,
    deliverables: { status: "not_fetched" },
    block: null,
    nodes,
  };
}

function nodesForCount(n: number): InspectorRunNode[] {
  // Mix of long names (worst-case label width pressure) and short ones.
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
    return node({
      node: `${name}${i >= names.length ? `-${i}` : ""}`,
      kind: isGate ? "gate" : "step",
      iteration: 1,
      state: isLast ? "running" : i > n - 3 ? "pending" : "completed",
      stateLabel: isLast ? "running" : i > n - 3 ? "pending" : "completed",
      spineState: isLast ? "running" : i > n - 3 ? "pending" : "completed",
      live: isLast,
      age: isLast ? "9m" : i === 0 ? "1m" : null,
      fanoutWidth: name === "search" ? 40 : null,
      onReject: isGate ? "scope" : null,
    });
  });
}

/** Viewport widths the reviewer measured against. */
const VIEWPORTS = [1081, 1440, 1920] as const;
/** Node counts that must stay legible. */
const COUNTS = [1, 2, 3, 5, 8, 12] as const;

describe("B1 label clearance (serpentine + alternating labels)", () => {
  it.each(
    VIEWPORTS.flatMap((w) => COUNTS.map((n) => [w, n] as const)),
  )(
    "viewport %i × n=%i: zero label∩label and zero label∩route",
    (sheetWidthPx, n) => {
      const run = readyRun(nodesForCount(n));
      const model = projectChart(run);
      expect(model.status).toBe("ready");
      if (model.status !== "ready") return;

      expect(model.marks).toHaveLength(n);

      const { overlap, onRoute, rects } = assertLabelClearance(
        model.marks,
        model.legs,
        sheetWidthPx,
      );

      // Table-friendly diagnostics on failure.
      const summary = rects
        .map(
          (r) =>
            `${r.key}@[${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.w.toFixed(0)}×${r.h.toFixed(0)}]`,
        )
        .join("; ");

      expect(overlap, `label overlap at w=${sheetWidthPx} n=${n}: ${summary}`).toBe(
        false,
      );
      expect(
        onRoute,
        `label on route at w=${sheetWidthPx} n=${n}: ${summary}`,
      ).toBe(false);
    },
  );

  it("label width is pitch-derived, not a fixed 148px box", () => {
    const { positions: p5 } = placeMarks(5);
    const { positions: p12 } = placeMarks(12);
    // Wider pitch (fewer per row) → wider or equal labels; never a constant.
    expect(p5[0]!.labelWidth).toBeGreaterThan(0);
    expect(p12[0]!.labelWidth).toBeGreaterThan(0);
    // Adjacent same-side marks must have non-overlapping projected X ranges.
    const marks5 = projectChart(readyRun(nodesForCount(5)));
    if (marks5.status !== "ready") return;
    const rects = markLabelRects(marks5.marks);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const xOverlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x);
        const yOverlap = !(a.y + a.h <= b.y || b.y + b.h <= a.y);
        expect(xOverlap && yOverlap).toBe(false);
      }
    }
  });

  it("labels sit below the ring; legs end at the ring edge", () => {
    const { positions } = placeMarks(5);
    for (const p of positions) {
      expect(p.labelSide).toBe("below");
      expect(p.y).toBeGreaterThan(0);
    }
    const model = projectChart(readyRun(nodesForCount(5)));
    if (model.status !== "ready") return;
    // First leg should not start at the first mark centre.
    const first = model.marks[0]!;
    const leg0 = model.legs[0]!.d;
    expect(leg0.startsWith(`M${first.x.toFixed(1)},${first.y.toFixed(1)}`)).toBe(
      false,
    );
  });

  it("serpentine uses multiple rows once a single row would compress", () => {
    const { positions: p8 } = placeMarks(8);
    const rows = new Set(p8.map((p) => p.row));
    expect(rows.size).toBeGreaterThanOrEqual(2);
    const { positions: p3 } = placeMarks(3);
    expect(new Set(p3.map((p) => p.row)).size).toBe(1);
  });
});

describe("B4 loop-back arrowhead clearance", () => {
  it("arc endpoint is not the target mark centre", () => {
    const from = { x: 600, y: 300 };
    const to = { x: 200, y: 320 };
    const { d, end } = loopArc(from, to);
    expect(d).toMatch(/^M/);
    const dist = Math.hypot(end.x - to.x, end.y - to.y);
    expect(dist).toBeGreaterThanOrEqual(MARK_CLEAR_R);
    // Endpoint is between the arc approach and the centre — not past it.
    expect(dist).toBeLessThan(Math.hypot(from.x - to.x, from.y - to.y));
  });

  it("projectChart loop-backs expose end ≠ targetCentre", () => {
    const run = readyRun([
      node({
        node: "scope",
        kind: "step",
        iteration: 1,
        state: "completed",
        stateLabel: "completed",
        spineState: "completed",
      }),
      node({
        node: "search",
        kind: "step",
        iteration: 1,
        state: "completed",
        stateLabel: "completed",
        spineState: "completed",
      }),
      node({
        node: "accept-sources",
        kind: "gate",
        iteration: 1,
        state: "waiting",
        stateLabel: "gate · held",
        spineState: "awaiting_answer",
        live: true,
        onReject: "scope",
      }),
    ]);
    const model = projectChart(run);
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.loopBacks.length).toBeGreaterThanOrEqual(1);
    for (const lb of model.loopBacks) {
      const dist = Math.hypot(
        lb.end.x - lb.targetCentre.x,
        lb.end.y - lb.targetCentre.y,
      );
      expect(dist).toBeGreaterThanOrEqual(MARK_CLEAR_R);
    }
  });
});

describe("N1 ink mapping — pending/queued are ahead, not under way", () => {
  it("maps pending and queued to ghost + ?", () => {
    for (const state of ["pending", "queued"] as const) {
      const style = inkForNode(
        node({
          node: "ahead",
          kind: "step",
          iteration: 1,
          state,
          stateLabel: state,
          spineState: state,
        }),
      );
      expect(style.ink).toBe("ghost");
      expect(style.glyph).toBe("?");
    }
  });

  it("keeps running/stalled as live + ✦", () => {
    for (const state of ["running", "stalled", "awaiting_answer"] as const) {
      const style = inkForNode(
        node({
          node: "live",
          kind: "step",
          iteration: 1,
          state,
          stateLabel: state,
          spineState: state,
          live: true,
        }),
      );
      expect(style.ink).toBe("live");
      expect(style.glyph).toBe("✦");
    }
  });
});

describe("N4 flavor / meta split", () => {
  it("puts duration and pass in metaLine (Outfit), not flavor", () => {
    const model = projectChart(
      readyRun([
        node({
          node: "a",
          kind: "step",
          iteration: 1,
          state: "running",
          stateLabel: "running",
          spineState: "running",
          live: true,
        }),
      ]),
    );
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.metaLine).toMatch(/12m/);
    expect(model.metaLine).toMatch(/pass/);
    // Flavor may carry atmosphere only — no duration/pass digits.
    if (model.flavor) {
      expect(model.flavor).not.toMatch(/\d+m/);
      expect(model.flavor).not.toMatch(/pass \d/);
    }
  });
});

describe("chart mark captions calm casing (#261 QC)", () => {
  it("lowercases pre-capped inspector labels at the chart boundary", () => {
    // Inspector STATE uses CSS text-transform:uppercase; chart meta does not.
    // Labels may arrive pre-capped from stateMetaFor — chart must calm them.
    const model = projectChart(
      readyRun([
        node({
          node: "scope",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "COMPLETED",
          spineState: "completed",
          age: "18m",
        }),
        node({
          node: "search",
          kind: "step",
          iteration: 1,
          state: "running",
          stateLabel: "RUNNING",
          spineState: "running",
          live: true,
        }),
        node({
          node: "ask",
          kind: "step",
          iteration: 1,
          state: "awaiting_answer",
          stateLabel: "AWAITING",
          spineState: "awaiting_answer",
          age: "5m",
          live: true,
        }),
        node({
          node: "carry",
          kind: "step",
          iteration: 0,
          state: "inherited",
          stateLabel: "INHERITED",
          spineState: "cancelled",
        }),
        node({
          node: "approve",
          kind: "gate",
          iteration: 1,
          state: "skipped",
          stateLabel: "SKIPPED",
          spineState: "cancelled",
        }),
        node({
          node: "accept",
          kind: "gate",
          iteration: 1,
          state: "waiting",
          stateLabel: "gate · held",
          spineState: "awaiting_answer",
          age: "<1m",
          live: true,
        }),
        node({
          node: "settle",
          kind: "step",
          iteration: 2,
          state: "purged",
          stateLabel: "PURGED",
          spineState: "cancelled",
          age: "1h",
        }),
        node({
          node: "fanout",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "2 of 3",
          spineState: "running",
          age: "3m",
          fanoutWidth: 3,
        }),
      ]),
    );
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;

    const byName = Object.fromEntries(model.marks.map((m) => [m.node, m.meta]));
    expect(byName.scope).toBe("completed · 18m");
    expect(byName.search).toBe("running");
    expect(byName.ask).toBe("awaiting · 5m");
    expect(byName.carry).toBe("inherited");
    expect(byName.approve).toBe("skipped");
    expect(byName.accept).toBe("held <1m");
    expect(byName.settle).toBe("pass 2 · purged · 1h");
    expect(byName.fanout).toBe("2 of 3 · 3m");

    // No all-caps lifecycle shout in any caption (legend chrome owns caps).
    for (const mark of model.marks) {
      expect(mark.meta).not.toMatch(
        /\b(COMPLETED|RUNNING|AWAITING|INHERITED|SKIPPED|PURGED|PENDING)\b/,
      );
    }

    // ChartModel.stateLabel normalised the same way (latent dead-field trap).
    const mixedHeader = projectChart({
      ...readyRun([]),
      stateLabel: "RUNNING",
    });
    expect(mixedHeader.status).toBe("ready");
    if (mixedHeader.status !== "ready") return;
    expect(mixedHeader.stateLabel).toBe("running");

    const blockedHeader = projectChart({
      ...readyRun([]),
      stateLabel: "blocked · loop 2/2",
    });
    expect(blockedHeader.status).toBe("ready");
    if (blockedHeader.status !== "ready") return;
    expect(blockedHeader.stateLabel).toBe("blocked · loop 2/2");
  });
});

describe("BL-2 key zone clearance (geometry)", () => {
  it.each(
    VIEWPORTS.flatMap((w) =>
      COUNTS.flatMap((n) =>
        ([false, true] as const).map((held) => [w, n, held] as const),
      ),
    ),
  )(
    "viewport %i × n=%i held=%s: key zone clear of marks, seals, destination",
    (_sheetWidthPx, n, held) => {
      const run = readyRun(nodesForCount(n));
      run.heldGate = held;
      if (held && n > 0) {
        // Ensure a held gate exists so the model carries heldGate truthfully.
        const last = run.nodes[run.nodes.length - 1]!;
        last.kind = "gate";
        last.state = "waiting";
        last.stateLabel = "gate · held";
        last.spineState = "awaiting_answer";
        last.live = true;
      }
      const model = projectChart(run);
      expect(model.status).toBe("ready");
      if (model.status !== "ready") return;

      const key = keyZoneRect(model.vbH, model.heldGate);
      const obstacles = [
        ...markRingRects(model.marks),
        ...markLabelRects(model.marks),
        destinationRect(model.destination),
      ];
      expect(
        anyKeyOverprint(key, obstacles),
        `key overprint n=${n} held=${held} key@[${key.x},${key.y} ${key.w}×${key.h}]`,
      ).toBe(false);
    },
  );
});

/**
 * #268 — marginalia anchors come from the projector in viewBox units.
 * Structural box-intersection (not a rendered sample): every placed line
 * clears mark rings, label boxes, legs, seals, destination, and the key band.
 */
describe("marginalia free-region placement (#268)", () => {
  const NODE_SWEEP = Array.from({ length: 20 }, (_, i) => i + 1);

  it.each(NODE_SWEEP)(
    "n=%i: every marginalia box clears marks, labels, legs, seals, key",
    (n) => {
      const run = readyRun(nodesForCount(n));
      // Ensure at least one gate for mid counts so seals appear in the sweep.
      if (n >= 4) {
        const gate = run.nodes[Math.min(3, n - 1)]!;
        gate.kind = "gate";
        gate.state = "completed";
        gate.stateLabel = "passed";
        gate.spineState = "completed";
        gate.onReject = run.nodes[0]!.node;
      }
      const model = projectChart(run);
      expect(model.status).toBe("ready");
      if (model.status !== "ready") return;

      // Sparse route: projector omits marginalia (same rule as the serpent).
      if (model.decorations === "sparse") {
        expect(model.marginalia).toEqual([]);
        return;
      }

      const key = keyZoneRect(model.vbH, model.heldGate);
      const solidObstacles = [
        ...markRingRects(model.marks),
        ...markLabelRects(model.marks),
        destinationRect(model.destination),
        key,
      ];
      const strokes = [...model.legs, ...model.loopBacks];

      for (const line of model.marginalia) {
        // Anchors are viewBox centres, not CSS sheet-height percentages.
        expect(line.x).toBeGreaterThan(0);
        expect(line.x).toBeLessThan(1000);
        expect(line.y).toBeGreaterThan(0);
        expect(line.y).toBeLessThan(model.vbH);

        const box = marginaliaRect(line);
        expect(
          anyMarginaliaOverprint(box, solidObstacles, strokes),
          `marginalia ${line.key} overprint at n=${n}: centre=(${line.x.toFixed(1)},${line.y.toFixed(1)}) box=[${box.x.toFixed(0)},${box.y.toFixed(0)} ${box.w}×${box.h}]`,
        ).toBe(false);

        // Key band explicit (BL-2 / #268): zero intersection with reserved key.
        expect(
          anyKeyOverprint(key, [box]),
          `marginalia ${line.key} enters key zone at n=${n}`,
        ).toBe(false);
      }

      // Placed lines do not overlap each other.
      const boxes = model.marginalia.map(marginaliaRect);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(
            anyMarginaliaOverprint(boxes[i]!, [boxes[j]!], []),
            `marginalia pair overlap n=${n}`,
          ).toBe(false);
        }
      }
    },
  );

  it("sparse decoration omits marginalia (reconciled with sparse-route rule)", () => {
    const model = projectChart(readyRun(nodesForCount(1)));
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.decorations).toBe("sparse");
    expect(model.marginalia).toEqual([]);
  });

  it("omits marginalia when no free region large enough exists", () => {
    // Tile the sheet with mark rings + labels so no catalog box can land.
    const marks: ChartMark[] = [];
    let k = 0;
    for (let y = 40; y <= 520; y += 36) {
      for (let x = 40; x <= 960; x += 48) {
        marks.push({
          key: `tile-${k++}`,
          node: `t${k}`,
          kind: "step",
          iteration: 1,
          ink: "done",
          glyph: "✓",
          className: "pc-chart-mark--done",
          name: "tile",
          meta: "done",
          fanoutWidth: null,
          seal: null,
          x,
          y,
          labelSide: "below",
          labelWidth: 44,
          live: false,
          onReject: null,
        });
      }
    }
    const placed = placeMarginalia({
      decorations: "full",
      marks,
      legs: [],
      loopBacks: [],
      destination: { x: 500, y: 280 },
      vbH: 560,
      heldGate: false,
    });
    expect(placed).toEqual([]);
  });

  it("anchors are produced in layout units (not fixed CSS % of sheet height)", () => {
    const a = projectChart(readyRun(nodesForCount(5)));
    const b = projectChart(readyRun(nodesForCount(16)));
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    if (a.status !== "ready" || b.status !== "ready") return;
    expect(a.marginalia.length).toBeGreaterThan(0);
    expect(b.marginalia.length).toBeGreaterThan(0);
    // Different node counts → different free paper → centres move (not a
    // fixed 14%/22% of sheet height for every chart).
    const ay = a.marginalia.map((m) => m.y / a.vbH);
    const by = b.marginalia.map((m) => m.y / b.vbH);
    const sameFrac =
      ay.length === by.length &&
      ay.every((f, i) => Math.abs(f - by[i]!) < 0.005);
    expect(sameFrac).toBe(false);
  });
});
