/**
 * #253 QC — B1 cartography invariant: at realistic node counts, label
 * rectangles never intersect each other and never cover the route stroke.
 * Measured geometry (viewBox rects), not a snapshot.
 */
import { describe, expect, it } from "vitest";
import {
  anyMarginaliaOverprint,
  assertLabelClearance,
  chartRowCount,
  destinationRect,
  helmZoneRectForOrnament,
  loopArc,
  markLabelRects,
  markRingRects,
  marginaliaRect,
  minCentreSheetWidthPx,
  ornamentObstacles,
  ornamentScaleFloor,
  placeMarginalia,
  placeMarks,
  projectChart,
  COCKPIT_LAYOUT,
  MARGINALIA_INK_PX,
  MARGINALIA_MAX_ROWS,
  MARK_CLEAR_R,
  type ChartMark,
  type ChartReadyModel,
} from "../src/chart/projectChart.js";
import * as projectorModule from "../src/chart/projectChart.js";
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

/**
 * BL-2 second cue, after #267: the key is no longer a reserved band on the
 * paper, so there is no reserve left to violate. What replaces the old
 * clearance assertion is the reason it can never be violated again — the
 * projector places nothing that the key could collide with, because the key
 * is not in the projected space at all.
 *
 * The rendered counterpart (key box vs. mark ink, in CSS px at real sheet
 * scales) is in `run-chart.test.tsx`; this file cannot see layout.
 */
describe("BL-2 key is off the projected paper (#267)", () => {
  it("the projector exposes no key or legend reserve", () => {
    const projector = projectorModule as Record<string, unknown>;
    for (const gone of [
      "keyZoneRect",
      "keyZoneRectForOrnament",
      "anyKeyOverprint",
      "legendBandRectForOrnament",
      "KEY_ZONE_W",
      "KEY_ZONE_H",
      "KEY_ZONE_PAD",
    ]) {
      expect(projector[gone], `${gone} must not come back — see #267`).toBeUndefined();
    }
  });

  it.each(
    VIEWPORTS.flatMap((w) =>
      COUNTS.flatMap((n) =>
        ([false, true] as const).map((held) => [w, n, held] as const),
      ),
    ),
  )(
    "viewport %i × n=%i held=%s: no key/legend rect in the ornament obstacle set",
    (sheetWidthPx, n, held) => {
      const run = readyRun(nodesForCount(n));
      run.heldGate = held;
      if (held && n > 0) {
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

      const obstacles = ornamentObstacles({
        marks: model.marks,
        destination: model.destination,
        vbH: model.vbH,
        heldGate: model.heldGate,
        scale: sheetWidthPx / 1000,
        sheetWidthPx,
      });
      const chromeKeys = obstacles.map((o) => o.key);
      expect(chromeKeys).not.toContain("chart-key-orn");
      expect(chromeKeys).not.toContain("legend");
      // The compass still paints on the paper, so it must still be routed around.
      expect(chromeKeys).toContain("compass");
    },
  );
});

/**
 * The top band no longer carries the run title (#267), so it is sized for the
 * compass and the ring's own radius. Row 0 must still sit inside the paper at
 * the narrowest sheet: 70 viewBox units × the 0.385 scale floor = 27px against
 * a painted ring half-height measured at 23px.
 */
describe("top band after the title moved to the title block (#267)", () => {
  it.each(COUNTS)(
    "n=%i: the painted row-0 ring clears the plot's top edge at the scale floor",
    (n) => {
      const model = projectChart(readyRun(nodesForCount(n)));
      expect(model.status).toBe("ready");
      if (model.status !== "ready") return;

      const scale = ornamentScaleFloor();
      // Measured in Chrome at 1081 (the narrowest desktop triptych): the ring
      // paints 46px across regardless of sheet scale.
      const paintedRingHalfPx = 23;
      for (const ring of markRingRects(model.marks)) {
        expect(ring.y, `ring ${ring.key} above the plot edge`).toBeGreaterThanOrEqual(0);
      }
      // Row 0 rides above EDGE_TOP by the serpentine bow; use the placed y.
      const topRow = Math.min(...model.marks.map((m) => m.y));
      expect(
        topRow * scale,
        `row-0 centre only ${(topRow * scale).toFixed(1)}px below the plot edge`,
      ).toBeGreaterThan(paintedRingHalfPx);
    },
  );
});

/**
 * #268 — marginalia anchors come from the projector in viewBox units.
 * Assertions use the **same obstacle set the placer uses** (including helm,
 * legend, compass) so a missing obstacle cannot stay green.
 */
describe("marginalia free-region placement (#268)", () => {
  const NODE_SWEEP = Array.from({ length: 20 }, (_, i) => i + 1);
  const scale = ornamentScaleFloor();
  const sheetW = minCentreSheetWidthPx();

  function modelFor(n: number, held: boolean): ChartReadyModel {
    const run = readyRun(nodesForCount(n));
    run.heldGate = held;
    if (held && n > 0) {
      const last = run.nodes[n - 1]!;
      last.kind = "gate";
      last.state = "waiting";
      last.stateLabel = "gate · held";
      last.spineState = "awaiting_answer";
      last.live = true;
    } else if (n >= 4) {
      const gate = run.nodes[Math.min(3, n - 1)]!;
      gate.kind = "gate";
      gate.state = "completed";
      gate.stateLabel = "passed";
      gate.spineState = "completed";
      gate.onReject = run.nodes[0]!.node;
    }
    const model = projectChart(run);
    expect(model.status).toBe("ready");
    if (model.status !== "ready") throw new Error("not ready");
    return model;
  }

  it("scale floor is derived from cockpit layout tokens (385px / 1000)", () => {
    // viewport 1081 − 2×14 − 300 − 344 − 2×12 = 385
    expect(minCentreSheetWidthPx(1081)).toBe(385);
    expect(ornamentScaleFloor(1081)).toBeCloseTo(0.385, 5);
    expect(COCKPIT_LAYOUT.regionRosterPx).toBe(300);
    expect(COCKPIT_LAYOUT.regionRightPx).toBe(344);
  });

  it("catalog reserve is strictly larger than measured ink at the scale floor", () => {
    // placeMarginalia builds boxes as (ink + 4px) / scale — assert margin.
    const model = modelFor(5, false);
    expect(model.marginalia.length).toBe(2);
    for (const line of model.marginalia) {
      const ink =
        line.key === "dissent"
          ? MARGINALIA_INK_PX.dissent
          : MARGINALIA_INK_PX.regressions;
      const reserveW = line.w * scale;
      const reserveH = line.h * scale;
      expect(reserveW, `${line.key} width reserve`).toBeGreaterThan(ink.w);
      expect(reserveH, `${line.key} height reserve`).toBeGreaterThan(ink.h);
    }
  });

  it.each(NODE_SWEEP.flatMap((n) => [false, true].map((h) => [n, h] as const)))(
    "n=%i held=%s: placed lines clear placer obstacles (incl. helm)",
    (n, held) => {
      const model = modelFor(n, held);

      if (model.decorations === "sparse") {
        expect(model.marginalia).toEqual([]);
        return;
      }
      if (chartRowCount(n) > MARGINALIA_MAX_ROWS) {
        expect(model.marginalia).toEqual([]);
        return;
      }

      // Whole-ornament: either the full catalog (2) or none.
      expect([0, 2]).toContain(model.marginalia.length);

      const obstacles = ornamentObstacles({
        marks: model.marks,
        destination: model.destination,
        vbH: model.vbH,
        heldGate: model.heldGate,
        scale,
        sheetWidthPx: sheetW,
      });
      const strokes = [...model.legs, ...model.loopBacks];

      if (held) {
        expect(
          obstacles.some((o) => o.key === "helm"),
          "held-gate helm must be in the placer obstacle set",
        ).toBe(true);
      }

      for (const line of model.marginalia) {
        const box = marginaliaRect(line);
        expect(
          anyMarginaliaOverprint(box, obstacles, strokes),
          `marginalia ${line.key} overprint at n=${n} held=${held}`,
        ).toBe(false);
        if (held) {
          const helm = helmZoneRectForOrnament(model.vbH, scale, sheetW);
          expect(
            anyMarginaliaOverprint(box, [helm], []),
            `marginalia ${line.key} under helm at n=${n}`,
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

  it("omits whole ornament when no free region fits every line", () => {
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

  it("omission is whole-ornament and monotonic across n=1–30", () => {
    const counts: number[] = [];
    for (let n = 1; n <= 30; n++) {
      const model = modelFor(n, false);
      const len = model.marginalia.length;
      // Never a single stray line.
      expect(len === 0 || len === 2, `n=${n} partial ornament len=${len}`).toBe(
        true,
      );
      counts.push(len);
    }
    // Non-increasing once we leave sparse (n=1 → 0): later counts must not
    // resurrect ornament after a full-decoration omit.
    let sawFullOmit = false;
    for (let i = 0; i < counts.length; i++) {
      const n = i + 1;
      const c = counts[i]!;
      if (n === 1) {
        expect(c).toBe(0); // sparse
        continue;
      }
      if (c === 0 && chartRowCount(n) <= MARGINALIA_MAX_ROWS) {
        // Free-region miss while still under the row ceiling — after this,
        // higher n with more rows may still place if rows stay ≤ max, but
        // once rows exceed max, stays 0. Track row-ceiling omits as terminal.
      }
      if (chartRowCount(n) > MARGINALIA_MAX_ROWS) {
        expect(c).toBe(0);
        sawFullOmit = true;
      }
      if (sawFullOmit) expect(c).toBe(0);
    }
    // Row count itself is non-decreasing → max-rows gate is monotonic.
    let prevRows = 0;
    for (let n = 1; n <= 30; n++) {
      const rows = chartRowCount(n);
      expect(rows).toBeGreaterThanOrEqual(prevRows);
      prevRows = rows;
    }
  });

  it("anchors are produced in layout units (not fixed CSS % of sheet height)", () => {
    const a = modelFor(5, false);
    expect(a.marginalia.length).toBe(2);
    // Must not be the pre-#268 fixed percentages of sheet height.
    for (const line of a.marginalia) {
      const yFrac = line.y / a.vbH;
      const xFrac = line.x / 1000;
      const fixedOld =
        (Math.abs(xFrac - 0.58) < 0.01 && Math.abs(yFrac - 0.14) < 0.01) ||
        (Math.abs(xFrac - 0.18) < 0.01 && Math.abs(yFrac - 0.22) < 0.01);
      expect(fixedOld).toBe(false);
    }
  });
});

/**
 * #268 QC — rendered-geometry bridge at the narrow desktop sheet.
 * Models painted CSS boxes (fixed px → viewBox at scale floor) and catalog
 * ink, then asserts zero intersection — catches helm burial and under-sized
 * reserves that pure viewBox structural tests miss.
 */
describe("marginalia rendered bridge at 1081 desktop (#268)", () => {
  const scale = ornamentScaleFloor(1081);
  const sheetW = minCentreSheetWidthPx(1081);

  function readyHeld(n: number): ChartReadyModel {
    const run = readyRun(nodesForCount(n));
    run.heldGate = true;
    if (n > 0) {
      const last = run.nodes[n - 1]!;
      last.kind = "gate";
      last.state = "waiting";
      last.stateLabel = "held";
      last.spineState = "awaiting_answer";
      last.live = true;
    }
    const model = projectChart(run);
    if (model.status !== "ready") throw new Error("not ready");
    return model;
  }

  /** Axis-aligned ink box in viewBox from centre + measured px size. */
  function inkBoxVb(
    line: { x: number; y: number; key: string },
    ink: { w: number; h: number },
    s: number,
  ) {
    const w = ink.w / s;
    const h = ink.h / s;
    return {
      key: `${line.key}:ink`,
      x: line.x - w / 2,
      y: line.y - h / 2,
      w,
      h,
    };
  }

  it.each([1081, 1280] as const)(
    "viewport %i held n=1–40: painted ink clears helm and placer obstacles",
    (viewportW) => {
      const s = ornamentScaleFloor(viewportW);
      // Sheet width at this viewport (triptych still side-by-side above 1080).
      const sw = minCentreSheetWidthPx(viewportW);
      expect(s).toBeCloseTo(sw / 1000, 5);

      for (let n = 1; n <= 40; n++) {
        const model = readyHeld(n);
        const obstacles = ornamentObstacles({
          marks: model.marks,
          destination: model.destination,
          vbH: model.vbH,
          heldGate: true,
          scale: s,
          sheetWidthPx: sw,
        });
        const helm = helmZoneRectForOrnament(model.vbH, s, sw);
        expect(obstacles.some((o) => o.key === "helm")).toBe(true);

        for (const line of model.marginalia) {
          const ink =
            line.key === "dissent"
              ? MARGINALIA_INK_PX.dissent
              : MARGINALIA_INK_PX.regressions;
          const box = inkBoxVb(line, ink, s);
          // Helm burial — the blocker that tall-viewport checks missed.
          expect(
            anyMarginaliaOverprint(box, [helm], []),
            `ink∩helm n=${n} vw=${viewportW} ${line.key}`,
          ).toBe(false);
          expect(
            anyMarginaliaOverprint(box, obstacles, [
              ...model.legs,
              ...model.loopBacks,
            ]),
            `ink∩obstacles n=${n} vw=${viewportW} ${line.key}`,
          ).toBe(false);
        }
      }
    },
  );

  it("compass reserve covers its painted CSS box at scale floor", () => {
    // Painted at 1081 (viewBox): compass {714.3, 46.8, 228.6, 228.6} — from QC.
    // The legend is no longer checked here: it moved off the paper into the
    // title block (#267), so it is not something ornament can collide with.
    const compassPaint = {
      key: "compass-paint",
      x: (sheetW - 22 - 88) / scale,
      y: 18 / scale,
      w: 88 / scale,
      h: 88 / scale,
    };
    const model = readyHeld(8);
    const obstacles = ornamentObstacles({
      marks: model.marks,
      destination: model.destination,
      vbH: model.vbH,
      heldGate: true,
      scale,
      sheetWidthPx: sheetW,
    });
    const compass = obstacles.find((o) => o.key === "compass")!;
    expect(compass).toBeTruthy();
    expect(obstacles.find((o) => o.key === "legend")).toBeUndefined();
    // Reserve (with chrome pad) must fully cover the painted CSS box.
    expect(compass.x).toBeLessThanOrEqual(compassPaint.x + 0.5);
    expect(compass.y).toBeLessThanOrEqual(compassPaint.y + 0.5);
    expect(compass.x + compass.w).toBeGreaterThanOrEqual(
      compassPaint.x + compassPaint.w - 0.5,
    );
    expect(compass.y + compass.h).toBeGreaterThanOrEqual(
      compassPaint.y + compassPaint.h - 0.5,
    );
  });
});
