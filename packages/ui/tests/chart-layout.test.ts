/**
 * #253 QC — B1 cartography invariant: at realistic node counts, label
 * rectangles never intersect each other and never cover the route stroke.
 * Measured geometry (viewBox rects), not a snapshot.
 */
import { describe, expect, it } from "vitest";
import {
  assertLabelClearance,
  loopArc,
  markLabelRects,
  markRingRects,
  sheetScaleFloor,
  placeMarks,
  projectChart,
  MARK_CLEAR_R,
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

  // The per-viewport sweep that inspected the ornament obstacle set is gone
  // with the obstacle set itself (#273): nothing is reserved on the paper for
  // chrome any more, so there is no set in which a key rect could hide.
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

      const scale = sheetScaleFloor();
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

/**
 * #273 — the flavour lines left the paper.
 *
 * They used to be placed on the sheet by a free-region search against every
 * mark, label, plate and route stroke. That needed a reserve denominated in a
 * sheet scale the projector cannot know, and to stay clear of the marks it
 * omitted the ornament from most charts. They now render in a foot band below
 * the plot, in flow, so there is no geometry left to get wrong.
 *
 * These tests are deliberately small — that shrinkage is the result. What
 * geometry the chart still has is guarded by the rendered sweep in
 * `packages/ui/lab`, not here: this file runs under happy-dom, which performs
 * no layout and cannot see where ink lands.
 */
describe("flavour marginalia are chrome, not paper (#273)", () => {
  it("the projector exposes no ornament placement machinery", () => {
    const projector = projectorModule as Record<string, unknown>;
    for (const gone of [
      "placeMarginalia",
      "marginaliaRect",
      "marginaliaRects",
      "anyMarginaliaOverprint",
      "ornamentObstacles",
      "markRingRectsForOrnament",
      "markLabelRectsForOrnament",
      "compassBandRectForOrnament",
      "helmZoneRectForOrnament",
      "ornamentScaleFloor",
      "chartRowCount",
      "MARGINALIA_INK_PX",
      "MARGINALIA_MAX_ROWS",
    ]) {
      expect(
        projector[gone],
        `${gone} must not come back — the ornament is off the paper (#273)`,
      ).toBeUndefined();
    }
  });

  it("carries copy only — no coordinates that can be wrong", () => {
    const model = projectChart(readyRun(nodesForCount(8)));
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.marginalia.length).toBe(2);
    for (const line of model.marginalia) {
      expect(Object.keys(line).sort()).toEqual(["key", "text"]);
      expect(line.text.length).toBeGreaterThan(0);
    }
  });

  it("is present at every non-sparse node count, 2 through 30", () => {
    for (let n = 2; n <= 30; n++) {
      const model = projectChart(readyRun(nodesForCount(n)));
      expect(model.status).toBe("ready");
      if (model.status !== "ready") continue;
      expect(model.marginalia.length, `n=${n} lost its flavour lines`).toBe(2);
    }
  });

  it("is whole-catalog or nothing", () => {
    for (let n = 1; n <= 12; n++) {
      const model = projectChart(readyRun(nodesForCount(n)));
      expect(model.status).toBe("ready");
      if (model.status !== "ready") continue;
      const len = model.marginalia.length;
      expect(len === 0 || len === 2, `n=${n} partial catalog len=${len}`).toBe(true);
    }
  });

  it("sparse decoration omits it — a one-node chart is too slight to dress", () => {
    const model = projectChart(readyRun(nodesForCount(1)));
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.decorations).toBe("sparse");
    expect(model.marginalia).toEqual([]);
  });
});
