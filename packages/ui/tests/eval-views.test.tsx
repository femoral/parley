/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  EvalComparison,
  EvalDistribution,
  EvalFilterBar,
  EvalHeatmap,
  HEATMAP_DARK_INK_AT,
  HEATMAP_PARCHMENT_INK_AT,
  SoundingsPanel,
  cellStyle,
  formatHeatmapRateDisplay,
  heatmapCellInk,
  heatmapMixPercent,
  isSuspectHeatmapRate,
} from "../src/hud/index.js";
import type { SoundingsFiltersView, SoundingsView } from "../src/hud/index.js";
import {
  projectComparisonRow,
  projectDistributionRow,
  projectHeatmap,
  projectSoundings,
} from "../src/app/hooks/metrics.js";
import type { MetricsGroup, MetricsResponse } from "@useparley/core";

afterEach(cleanup);

function emptyFilters(overrides: Partial<SoundingsFiltersView> = {}): SoundingsFiltersView {
  return {
    type: "",
    vendor: "",
    model: "",
    orch_harness: "",
    orch_model: "",
    eval_harness: "",
    eval_model: "",
    rubric: "",
    firstAttemptOnly: false,
    belowBaselineOnly: false,
    active: false,
    ...overrides,
  };
}

function metricsGroup(overrides: Partial<MetricsGroup> = {}): MetricsGroup {
  return {
    key: "codex",
    tasks: {
      total: 2,
      completed: 1,
      failed: 0,
      cancelled: 0,
      running: 1,
      other: 0,
    },
    success_rate: 1,
    evals: {
      count: 2,
      avg: 4.5,
      avg_baseline: 5,
      avg_delta: -0.5,
      below_baseline_rate: 0.5,
      criterion_failures: {},
      first_attempt: {
        count: 1,
        avg: 4,
        avg_baseline: 5,
        avg_delta: -1,
        below_baseline_rate: 1,
      },
      fix: {
        count: 1,
        avg: 5,
        avg_baseline: 5,
        avg_delta: 0,
        below_baseline_rate: 0,
      },
    },
    evals_by_size: {},
    evals_by_difficulty: {},
    tokens: { input: 100, output: 50, cached: 0, tasks_reporting: 1 },
    duration_ms: {
      total: 1000,
      avg: 1000,
      p50: 1000,
      p95: 1000,
      tasks_reporting: 1,
    },
    ...overrides,
  };
}

const DIST_ROW = projectDistributionRow(metricsGroup());
const CMP_ROW = projectComparisonRow(metricsGroup());

function groupWithCriteria(
  key: string,
  failures: Record<string, { failures: number; count: number; rate: number | null }>,
  evalCount = 2,
): MetricsGroup {
  return metricsGroup({
    key,
    evals: {
      count: evalCount,
      avg: 4.5,
      avg_baseline: 5,
      avg_delta: -0.5,
      below_baseline_rate: 0.5,
      criterion_failures: failures,
      first_attempt: {
        count: 1,
        avg: 4,
        avg_baseline: 5,
        avg_delta: -1,
        below_baseline_rate: 1,
      },
      fix: {
        count: 1,
        avg: 5,
        avg_baseline: 5,
        avg_delta: 0,
        below_baseline_rate: 0,
      },
    },
  });
}

const HEAT_GROUPS = [
  groupWithCriteria("coding", {
    "brief-implemented": { failures: 1, count: 2, rate: 0.5 },
    "broke-existing": { failures: 0, count: 2, rate: 0 },
  }),
  groupWithCriteria("design", {
    "brief-implemented": { failures: 2, count: 2, rate: 1 },
    // broke-existing intentionally absent — sparse cell
  }),
];
const HEATMAP = projectHeatmap(HEAT_GROUPS);

function baseView(overrides: Partial<SoundingsView> = {}): SoundingsView {
  return {
    status: "ready",
    error: null,
    groups: [
      {
        key: "codex",
        label: "codex",
        tasks: { total: 2, done: 1, failed: 0, running: 1 },
        successRate: "100%",
        successRateValue: 1,
        evals: "4.5 · n=2",
        tokens: { input: "100", output: "50", cached: "0" },
        duration: { avg: "1s", p95: "1s" },
        evalsBySize: [],
        evalsByDifficulty: [],
      },
    ],
    distribution: [DIST_ROW],
    comparison: [CMP_ROW],
    heatmap: HEATMAP,
    groupBy: "vendor",
    sessionLabel: "All hands",
    generatedAt: "2026-07-16T00:00:00.000Z",
    filters: emptyFilters(),
    viewTab: "groups",
    evalPresence: "ready",
    ...overrides,
  };
}

describe("projectDistributionRow / projectComparisonRow (#165)", () => {
  it("shapes score vs baseline positions on a 0–10 axis", () => {
    expect(DIST_ROW.score).toBe("4.5");
    expect(DIST_ROW.baseline).toBe("5");
    expect(DIST_ROW.scorePos).toBeCloseTo(0.45);
    expect(DIST_ROW.baselinePos).toBeCloseTo(0.5);
    expect(DIST_ROW.delta).toBe("−0.5");
    expect(DIST_ROW.deltaValue).toBe(-0.5);
  });

  it("shapes comparison stats including recovery split", () => {
    expect(CMP_ROW.avgDelta).toBe("−0.5");
    expect(CMP_ROW.belowBaselineRate).toBe("50%");
    expect(CMP_ROW.firstAttempt).toBe("4 · n=1");
    expect(CMP_ROW.fix).toBe("5 · n=1");
  });

  it("marks evalPresence off when groups lack rubric evals", () => {
    const data: MetricsResponse = {
      generated_at: "2026-07-16T00:00:00.000Z",
      groups: [
        metricsGroup({
          evals: {
            count: 0,
            avg: null,
            avg_baseline: null,
            avg_delta: null,
            below_baseline_rate: null,
            criterion_failures: {},
            first_attempt: {
              count: 0,
              avg: null,
              avg_baseline: null,
              avg_delta: null,
              below_baseline_rate: null,
            },
            fix: {
              count: 0,
              avg: null,
              avg_baseline: null,
              avg_delta: null,
              below_baseline_rate: null,
            },
          },
        }),
      ],
    };
    const view = projectSoundings(data, "ready", null, "vendor", "All hands");
    expect(view.evalPresence).toBe("off");
    expect(view.distribution[0]!.count).toBe(0);
  });
});

describe("EvalFilterBar (#165)", () => {
  it("fires onChange for text and toggles; clear when active", () => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    render(
      <EvalFilterBar
        filters={emptyFilters({ vendor: "codex", active: true })}
        onChange={onChange}
        onClear={onClear}
      />,
    );
    // Filters disclosure is collapsed by default — expand before field access.
    fireEvent.click(screen.getByRole("button", { name: "Filters, 1 active" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. coding"), {
      target: { value: "docs" },
    });
    expect(onChange).toHaveBeenCalledWith({ type: "docs" });

    fireEvent.click(screen.getByRole("button", { name: "First attempt only" }));
    expect(onChange).toHaveBeenCalledWith({ firstAttemptOnly: true });

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("shows active-filter count on the collapsed disclosure", () => {
    render(
      <EvalFilterBar
        filters={emptyFilters({ vendor: "codex", firstAttemptOnly: true, active: true })}
        onChange={() => {}}
        onClear={() => {}}
      />,
    );
    // vendor + firstAttemptOnly → 2
    const disclosure = screen.getByRole("button", { name: "Filters, 2 active" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.textContent).toContain("2");
    expect(screen.queryByPlaceholderText("e.g. coding")).toBeNull();
  });

  it("chunks expanded fields under Task / Orchestrator / Judge headings", () => {
    render(
      <EvalFilterBar
        filters={emptyFilters()}
        onChange={() => {}}
        onClear={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("group", { name: "Task" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Orchestrator" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Judge" })).toBeTruthy();
    // Toggles stay outside the field groups.
    expect(screen.getByRole("button", { name: "First attempt only" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Below baseline only" })).toBeTruthy();
  });
});

describe("EvalDistribution (#165)", () => {
  it("renders score track with baseline mark and legend", () => {
    render(
      <EvalDistribution rows={[DIST_ROW]} evalPresence="ready" filtersActive={false} />,
    );
    expect(screen.getByLabelText("Score vs baseline distribution")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("4.5")).toBeTruthy();
    expect(screen.getAllByText("5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Baseline")).toBeTruthy();
    const track = screen.getByRole("img", { name: /score 4\.5 of 10, baseline 5/i });
    expect(track.querySelector(".pc-eval-dist__baseline-mark")).toBeTruthy();
  });

  it("shows eval-off explanatory state", () => {
    render(<EvalDistribution rows={[]} evalPresence="off" filtersActive={false} />);
    expect(screen.getByText("No structured evals yet")).toBeTruthy();
    expect(screen.getByText(/parley eval/)).toBeTruthy();
  });
});

describe("EvalComparison (#165)", () => {
  it("renders three stats and recovery split", () => {
    render(
      <EvalComparison
        rows={[CMP_ROW]}
        groupBy="vendor"
        evalPresence="ready"
        filtersActive={false}
        onGroupBy={() => {}}
      />,
    );
    expect(screen.getByText("Avg delta")).toBeTruthy();
    expect(screen.getByText("−0.5")).toBeTruthy();
    expect(screen.getByText("Below baseline")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByLabelText("First attempt vs fix recovery")).toBeTruthy();
    expect(screen.getByText("4 · n=1")).toBeTruthy();
    expect(screen.getByText("5 · n=1")).toBeTruthy();
  });

  it("fires onGroupBy when a compare dimension is pressed", () => {
    const onGroupBy = vi.fn();
    render(
      <EvalComparison
        rows={[CMP_ROW]}
        groupBy="vendor"
        evalPresence="ready"
        filtersActive={false}
        onGroupBy={onGroupBy}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Judge harness" }));
    expect(onGroupBy).toHaveBeenCalledWith("eval_harness");
  });
});

describe("SoundingsPanel quality views (#165)", () => {
  it("switches tabs and keeps the filter bar mounted", () => {
    const onViewTab = vi.fn();
    const onFiltersChange = vi.fn();
    render(
      <SoundingsPanel
        soundings={baseView({ viewTab: "groups" })}
        onGroupBy={() => {}}
        onFiltersChange={onFiltersChange}
        onFiltersClear={() => {}}
        onViewTab={onViewTab}
      />,
    );
    expect(screen.getByLabelText("Eval filters")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Score vs baseline" }));
    expect(onViewTab).toHaveBeenCalledWith("distribution");

    fireEvent.click(screen.getByRole("tab", { name: "Comparison" }));
    expect(onViewTab).toHaveBeenCalledWith("comparison");

    fireEvent.click(screen.getByRole("tab", { name: "Criterion failures" }));
    expect(onViewTab).toHaveBeenCalledWith("heatmap");
  });

  it("renders distribution tab content from projected props", () => {
    render(
      <SoundingsPanel
        soundings={baseView({ viewTab: "distribution" })}
        onGroupBy={() => {}}
        onFiltersChange={() => {}}
        onFiltersClear={() => {}}
        onViewTab={() => {}}
      />,
    );
    expect(screen.getByLabelText("Score vs baseline distribution")).toBeTruthy();
    expect(screen.getByText("Avg score")).toBeTruthy();
  });

  it("renders comparison tab with three stats", () => {
    render(
      <SoundingsPanel
        soundings={baseView({ viewTab: "comparison" })}
        onGroupBy={() => {}}
        onFiltersChange={() => {}}
        onFiltersClear={() => {}}
        onViewTab={() => {}}
      />,
    );
    expect(screen.getByLabelText("Quality comparison")).toBeTruthy();
    expect(screen.getByText("Avg delta")).toBeTruthy();
    expect(screen.getByText("Below baseline")).toBeTruthy();
  });

  it("renders heatmap tab from projected matrix", () => {
    render(
      <SoundingsPanel
        soundings={baseView({ viewTab: "heatmap", groupBy: "type" })}
        onGroupBy={() => {}}
        onFiltersChange={() => {}}
        onFiltersClear={() => {}}
        onViewTab={() => {}}
      />,
    );
    expect(screen.getByLabelText("Criterion failure heatmap")).toBeTruthy();
    expect(screen.getByText("brief-implemented")).toBeTruthy();
  });
});

describe("EvalHeatmap low-sample honesty", () => {
  it("renders a visible n cue and legend entry for thin cells", () => {
    const { container } = render(
      <EvalHeatmap
        heatmap={HEATMAP}
        groupBy="type"
        evalPresence="ready"
        filtersActive={false}
        onGroupBy={() => {}}
      />,
    );
    // HEATMAP cells with count=2 are below the low-sample threshold (3).
    const lowN = container.querySelectorAll(".pc-eval-heat__cell--low-n");
    expect(lowN.length).toBeGreaterThan(0);
    expect(container.querySelector(".pc-eval-heat__cell-n")?.textContent).toMatch(/^n=\d+$/);
    expect(screen.getByText(/Low n/)).toBeTruthy();
  });
});

describe("projectHeatmap (#166)", () => {
  it("shapes criteria × groups with rates and nulls for missing samples", () => {
    expect(HEATMAP.criteria).toEqual(["brief-implemented", "broke-existing"]);
    expect(HEATMAP.groups.map((g) => g.label)).toEqual(["coding", "design"]);
    expect(HEATMAP.sampleEvals).toBe(4);

    const briefCoding = HEATMAP.cells[0]![0]!;
    expect(briefCoding.rate).toBe(0.5);
    expect(briefCoding.rateLabel).toBe("50%");
    expect(briefCoding.intensity).toBe(0.5);
    expect(briefCoding.failures).toBe(1);
    expect(briefCoding.count).toBe(2);

    // design never answered broke-existing → empty tile, not zero.
    const brokeDesign = HEATMAP.cells[1]![1]!;
    expect(brokeDesign.rate).toBeNull();
    expect(brokeDesign.intensity).toBeNull();
    expect(brokeDesign.rateLabel).toBe("—");
    expect(brokeDesign.count).toBe(0);

    // design fails brief-implemented always.
    const briefDesign = HEATMAP.cells[0]![1]!;
    expect(briefDesign.rate).toBe(1);
    expect(briefDesign.rateLabel).toBe("100%");
  });

  it("returns empty criteria when no criterion_failures exist", () => {
    const empty = projectHeatmap([metricsGroup()]);
    expect(empty.criteria).toEqual([]);
    expect(empty.cells).toEqual([]);
    expect(empty.sampleEvals).toBe(2);
  });

  it("projects heatmap onto SoundingsView", () => {
    const data: MetricsResponse = {
      generated_at: "2026-07-16T00:00:00.000Z",
      groups: HEAT_GROUPS,
    };
    const view = projectSoundings(data, "ready", null, "type", "All hands", {
      viewTab: "heatmap",
    });
    expect(view.heatmap.criteria).toContain("brief-implemented");
    expect(view.viewTab).toBe("heatmap");
    expect(view.evalPresence).toBe("ready");
  });
});

describe("EvalHeatmap (#166)", () => {
  it("renders matrix cells and dimension chips", () => {
    const onGroupBy = vi.fn();
    render(
      <EvalHeatmap
        heatmap={HEATMAP}
        groupBy="type"
        evalPresence="ready"
        filtersActive={false}
        onGroupBy={onGroupBy}
      />,
    );
    expect(screen.getByLabelText("Criterion failure heatmap")).toBeTruthy();
    expect(screen.getByText("brief-implemented")).toBeTruthy();
    expect(screen.getByText("broke-existing")).toBeTruthy();
    expect(screen.getByText("coding")).toBeTruthy();
    expect(screen.getByText("design")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    // Missing sample for broke-existing × design.
    expect(
      screen.getByLabelText("broke-existing × design: no sample"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Orchestrator" }));
    expect(onGroupBy).toHaveBeenCalledWith("orch_harness");
  });

  it("shows eval-off explanatory state", () => {
    render(
      <EvalHeatmap
        heatmap={{ criteria: [], groups: [], cells: [], sampleEvals: 0 }}
        groupBy="vendor"
        evalPresence="off"
        filtersActive={false}
        onGroupBy={() => {}}
      />,
    );
    expect(screen.getByText("No structured evals yet")).toBeTruthy();
    expect(screen.getByText(/parley eval/)).toBeTruthy();
  });

  it("shows sparse empty when evals exist without criterion answers", () => {
    render(
      <EvalHeatmap
        heatmap={{ criteria: [], groups: [{ key: "codex", label: "codex" }], cells: [], sampleEvals: 2 }}
        groupBy="vendor"
        evalPresence="ready"
        filtersActive={false}
        onGroupBy={() => {}}
      />,
    );
    expect(screen.getByText("No criterion answers yet")).toBeTruthy();
  });

  it("flags sparse sample banner when n ≤ 2", () => {
    const sparse = projectHeatmap([
      groupWithCriteria(
        "codex",
        { "brief-implemented": { failures: 1, count: 1, rate: 1 } },
        1,
      ),
    ]);
    render(
      <EvalHeatmap
        heatmap={sparse}
        groupBy="vendor"
        evalPresence="ready"
        filtersActive={false}
        onGroupBy={() => {}}
      />,
    );
    expect(screen.getByText(/Sparse — n=1 eval/)).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
  });
});

describe("EvalHeatmap cell ink AA flip", () => {
  it("uses soft ink below parchment threshold, parchment mid, dark-on-gold at worst", () => {
    expect(heatmapCellInk(0)).toBe("var(--ink-soft)");
    expect(heatmapCellInk(HEATMAP_PARCHMENT_INK_AT - 0.01)).toBe("var(--ink-soft)");
    expect(heatmapCellInk(HEATMAP_PARCHMENT_INK_AT)).toBe("var(--ink-parchment)");
    expect(heatmapCellInk(0.5)).toBe("var(--ink-parchment)");
    expect(heatmapCellInk(HEATMAP_DARK_INK_AT - 0.01)).toBe("var(--ink-parchment)");
    // Above HEATMAP_DARK_INK_AT the mix is light enough for dark-on-gold (≥4.5:1 AA).
    expect(heatmapCellInk(HEATMAP_DARK_INK_AT)).toBe("var(--ink-dark-on-gold)");
    expect(heatmapCellInk(1)).toBe("var(--ink-dark-on-gold)");
  });

  it("cellStyle color tracks the ink ramp", () => {
    expect(cellStyle(null)).toBeUndefined();
    expect(cellStyle(0.2)?.color).toBe("var(--ink-soft)");
    expect(cellStyle(0.5)?.color).toBe("var(--ink-parchment)");
    expect(cellStyle(1)?.color).toBe("var(--ink-dark-on-gold)");
    // Full intensity still mixes toward quality-poor on opaque plate-top.
    expect(String(cellStyle(1)?.background)).toMatch(/quality-poor/);
    expect(String(cellStyle(1)?.background)).toMatch(/plate-top/);
    expect(String(cellStyle(1)?.background)).not.toMatch(/rgba/);
  });

  it("paints dark-on-gold on a full-intensity rendered cell", () => {
    const heatmap = projectHeatmap([
      groupWithCriteria(
        "coding",
        { "brief-implemented": { failures: 4, count: 4, rate: 1 } },
        4,
      ),
    ]);
    const { container } = render(
      <EvalHeatmap
        heatmap={heatmap}
        groupBy="type"
        evalPresence="ready"
        filtersActive={false}
        onGroupBy={() => {}}
      />,
    );
    const cell = container.querySelector(".pc-eval-heat__cell:not(.pc-eval-heat__cell--empty)");
    expect(cell).toBeTruthy();
    expect((cell as HTMLElement).style.color).toBe("var(--ink-dark-on-gold)");
  });

  /**
   * WCAG 2.x relative-luminance contrast of cell ink vs the composited cell
   * background. Mix is opaque color-mix(quality-poor, plate-top) — no alpha
   * wash — matching cellStyle after the H1 fix.
   */
  it("keeps ink ≥4.5:1 against the composited cell at every 0.05 intensity step", () => {
    // Token hex from tokens.css (layer 0) — mirrored here so the test does not
    // depend on a CSSOM that happy-dom will not resolve from var().
    const QUALITY_POOR: Rgb = [232, 136, 160]; // --quality-poor #e888a0
    const PLATE_TOP: Rgb = [29, 20, 12]; // --plate-top #1d140c
    const INKS: Record<string, Rgb> = {
      "var(--ink-soft)": [216, 195, 154], // #d8c39a
      "var(--ink-parchment)": [242, 227, 196], // #f2e3c4
      "var(--ink-dark-on-gold)": [42, 26, 8], // #2a1a08
    };

    for (let step = 0; step <= 20; step++) {
      const intensity = step / 20;
      const pct = heatmapMixPercent(intensity);
      const bg = mixSrgb(QUALITY_POOR, PLATE_TOP, pct);
      const inkVar = heatmapCellInk(intensity);
      const ink = INKS[inkVar];
      expect(ink, `unknown ink token at intensity ${intensity}`).toBeDefined();
      const ratio = contrastRatio(ink!, bg);
      expect(
        ratio,
        `intensity ${intensity.toFixed(2)} mix ${pct}% ${inkVar} on rgb(${bg}) = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

type Rgb = [number, number, number];

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.x contrast ratio of two opaque sRGB colours. */
function contrastRatio(a: Rgb, b: Rgb): number {
  const L1 = relativeLuminance(a);
  const L2 = relativeLuminance(b);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** CSS color-mix(in srgb, a pct%, b) for opaque colours — matches the browser. */
function mixSrgb(a: Rgb, b: Rgb, pctA: number): Rgb {
  const t = pctA / 100;
  return [
    Math.round(a[0] * t + b[0] * (1 - t)),
    Math.round(a[1] * t + b[1] * (1 - t)),
    Math.round(a[2] * t + b[2] * (1 - t)),
  ];
}

describe("EvalHeatmap rate >100% honesty clamp", () => {
  it("flags failures > count and rate > 1 as suspect", () => {
    expect(isSuspectHeatmapRate({ rate: 1.5, failures: 3, count: 2 })).toBe(true);
    expect(isSuspectHeatmapRate({ rate: 1, failures: 2, count: 2 })).toBe(false);
    expect(isSuspectHeatmapRate({ rate: 0.5, failures: 1, count: 2 })).toBe(false);
    expect(isSuspectHeatmapRate({ rate: null, failures: 5, count: 2 })).toBe(true);
  });

  it("clamps display label at 100%! and never paints verbatim over-100%", () => {
    expect(
      formatHeatmapRateDisplay({
        rate: 1.5,
        rateLabel: "150%",
        failures: 3,
        count: 2,
        intensity: 1,
      }),
    ).toBe("100%!");
    expect(
      formatHeatmapRateDisplay({
        rate: 0.5,
        rateLabel: "50%",
        failures: 1,
        count: 2,
        intensity: 0.5,
      }),
    ).toBe("50%");
  });

  it("renders 100%! with suspect aria note when wire rate exceeds 100%", () => {
    // Bypass projectHeatmap clamp01 so the plate sees raw impossible data.
    const heatmap: SoundingsView["heatmap"] = {
      criteria: ["brief-implemented"],
      groups: [{ key: "coding", label: "coding" }],
      sampleEvals: 2,
      cells: [
        [
          {
            criterionId: "brief-implemented",
            groupKey: "coding",
            groupLabel: "coding",
            failures: 3,
            count: 2,
            rate: 1.5,
            rateLabel: "150%",
            intensity: 1,
          },
        ],
      ],
    };
    render(
      <EvalHeatmap
        heatmap={heatmap}
        groupBy="type"
        evalPresence="ready"
        filtersActive={false}
        onGroupBy={() => {}}
      />,
    );
    expect(screen.getByText("100%!")).toBeTruthy();
    expect(screen.queryByText("150%")).toBeNull();
    expect(
      screen.getByLabelText(/suspect data \(rate exceeds 100%\)/),
    ).toBeTruthy();
    expect(document.querySelector(".pc-eval-heat__cell--suspect")).toBeTruthy();
  });
});
