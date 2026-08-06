/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  formatDelta,
  formatDurationMs,
  formatGroupKey,
  formatRate,
  formatScore,
  formatTokens,
} from "../../src/screens/metrics/format.js";
import {
  heatCell,
  projectBuckets,
  projectComparison,
  projectDistribution,
  projectHeatmap,
  projectRunGroup,
  projectTaskGroup,
  totalEvalSamples,
} from "../../src/screens/metrics/project.js";
import {
  filtersActive,
  toRunFilters,
  toTaskFilters,
  EMPTY_FILTERS,
} from "../../src/screens/metrics/filters.js";
import {
  makeEvalStats,
  makeRunGroup,
  makeTaskGroup,
  populatedMetrics,
  populatedRunMetrics,
} from "./fixtures.js";

describe("metrics formatters", () => {
  it("formats tokens compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(1_500_000)).toBe("1.5m");
  });

  it("formats duration, rate, score, delta", () => {
    expect(formatDurationMs(null)).toBe("—");
    expect(formatDurationMs(12_000)).toBe("12s");
    expect(formatDurationMs(125_000)).toBe("2m 5s");
    expect(formatRate(0.875)).toBe("88%");
    expect(formatRate(null)).toBe("—");
    expect(formatScore(7.25)).toBe("7.3");
    expect(formatDelta(1.2)).toBe("+1.2");
    expect(formatDelta(-0.4)).toBe("\u22120.4"); // real U+2212 minus
    expect(formatGroupKey(null)).toBe("(unset)");
  });
});

describe("metrics projections", () => {
  it("projects task groups with eval tones", () => {
    const g = makeTaskGroup("fake", {
      evals: makeEvalStats({
        count: 4,
        avg: 7.0,
        avg_baseline: 5.0,
        avg_delta: 2.0,
        below_baseline_rate: 0.1,
      }),
    });
    const row = projectTaskGroup(g);
    expect(row.label).toBe("fake");
    expect(row.count).toBe(10);
    expect(row.evalTone).toBe("good");
    expect(row.successLabel).toBe("80%");
    expect(row.costLabel).toBe("—");
  });

  it("projects run groups with cost-per-completed-run", () => {
    const row = projectRunGroup(makeRunGroup("coding-1@3", { cost_per_completed_run: 18500 }));
    expect(row.label).toBe("coding-1@3");
    expect(row.costLabel).toBe("18.5k");
    expect(row.costPerCompleted).toBe(18500);
  });

  it("builds distribution only for scored groups", () => {
    const rows = populatedMetrics().groups.map(projectTaskGroup);
    const dist = projectDistribution(rows);
    expect(dist.length).toBe(2);
    expect(dist[0]!.tone).toBe("good");
    expect(dist.some((d) => d.tone === "poor")).toBe(true);
  });

  it("builds heatmap with low/suspect/none kinds and zero bar", () => {
    const rows = populatedMetrics().groups.map(projectTaskGroup);
    const heat = projectHeatmap(rows);
    expect(heat.columns.length).toBe(2);
    expect(heat.rows.length).toBeGreaterThan(0);
    expect(heat.sampleShown).toBe(heat.sampleTotal);
    expect(heat.truncated).toBe(false);
    const cells = heat.rows.flatMap((r) => r.cells);
    expect(cells.some((c) => c.kind === "suspect" || c.kind === "low-suspect")).toBe(true);
    expect(cells.some((c) => c.kind === "ok" || c.kind === "low")).toBe(true);
    // Zero rate must not floor the bar
    const zero = cells.find((c) => c.rate === 0);
    if (zero) expect(zero.barW).toBe("0%");
  });

  it("discloses heatmap column truncation", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      projectTaskGroup(
        makeTaskGroup(`g${i}`, {
          evals: makeEvalStats({
            count: 4,
            avg: 6,
            avg_baseline: 5,
            avg_delta: 1,
            criterion_failures: {
              "brief-implemented": { failures: 1, count: 4, rate: 0.25 },
            },
          }),
        }),
      ),
    );
    const heat = projectHeatmap(many, 6);
    expect(heat.shownCols).toBe(6);
    expect(heat.totalCols).toBe(10);
    expect(heat.truncated).toBe(true);
    expect(heat.sampleShown).toBe(24);
    expect(heat.sampleTotal).toBe(40);
    expect(heat.selectionRule.length).toBeGreaterThan(0);
  });

  it("marks low+suspect together and puts n= in low labels", () => {
    const cell = heatCell({ failures: 1, count: 1, rate: 1 });
    expect(cell.low).toBe(true);
    expect(cell.suspect).toBe(true);
    expect(cell.kind).toBe("low-suspect");
    expect(cell.label).toMatch(/n=1/);
    expect(cell.barW).toBe("100%");
    const zero = heatCell({ failures: 0, count: 5, rate: 0 });
    expect(zero.barW).toBe("0%");
    expect(zero.label).toBe("0%");
  });

  it("aggregates first-attempt vs fix comparison", () => {
    const rows = populatedMetrics().groups.map(projectTaskGroup);
    const cmp = projectComparison(rows, "task");
    expect(cmp).not.toBeNull();
    expect(cmp!.left.label).toBe("first attempt");
    expect(cmp!.right.label).toBe("fix");
    expect(cmp!.left.count).toBeGreaterThan(0);
    expect(cmp!.right.count).toBeGreaterThan(0);
  });

  it("aggregates first-run vs fork for workflow", () => {
    const rows = populatedRunMetrics().groups.map(projectRunGroup);
    const cmp = projectComparison(rows, "run");
    expect(cmp!.left.label).toBe("first run");
    expect(cmp!.right.label).toBe("fork");
  });

  it("projects size/difficulty buckets", () => {
    const groups = populatedMetrics().groups;
    const sizes = projectBuckets(groups, "evals_by_size");
    expect(sizes.map((s) => s.id).sort()).toEqual(["M", "S"]);
    expect(totalEvalSamples(groups.map(projectTaskGroup))).toBe(10);
  });
});

describe("metrics filters", () => {
  it("serializes task and run filter sets", () => {
    const f = {
      ...EMPTY_FILTERS,
      vendor: "fake",
      type: "coding",
      first_attempt: true,
      below_baseline: true,
    };
    expect(filtersActive(f)).toBe(true);
    const task = toTaskFilters(f);
    expect(task.vendor).toBe("fake");
    expect(task.first_attempt).toBe(true);
    expect(task.below_baseline).toBe(true);
    const run = toRunFilters(f);
    expect(run).not.toHaveProperty("vendor");
    expect(run.first_run).toBe(true);
    expect(run.type).toBe("coding");
  });
});
