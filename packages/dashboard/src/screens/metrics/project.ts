/**
 * Pure projections from wire MetricsGroup / RunMetricsGroup → display rows.
 * No Cove imports; shapes re-derived from PRODUCT/DESIGN + wire contract.
 */
import type {
  MetricsCriterionFailureStats,
  MetricsEvalStats,
  MetricsGroup,
  RunMetricsEvalStats,
  RunMetricsGroup,
} from "@useparley/core";
import {
  formatDelta,
  formatDurationMs,
  formatGroupKey,
  formatRate,
  formatScore,
  formatTokens,
  rateWidth,
} from "./format.js";

export type MetricsDim =
  | "vendor"
  | "model"
  | "profile"
  | "size"
  | "difficulty"
  | "type"
  | "orch_harness"
  | "orch_model"
  | "orch_effort"
  | "eval_harness"
  | "eval_model"
  | "eval_effort"
  | "rubric"
  | "workflow";

/** Task-side group_by dimensions (GET /metrics). */
export const TASK_DIMS: readonly Exclude<MetricsDim, "workflow">[] = [
  "vendor",
  "model",
  "profile",
  "size",
  "difficulty",
  "type",
  "orch_harness",
  "orch_model",
  "orch_effort",
  "eval_harness",
  "eval_model",
  "eval_effort",
  "rubric",
] as const;

/** Primary tabs shown as buttons; the rest live in the overflow select. */
export const PRIMARY_DIMS: readonly MetricsDim[] = [
  "vendor",
  "model",
  "type",
  "size",
  "difficulty",
  "workflow",
] as const;

export const DIM_LABELS: Record<MetricsDim, string> = {
  vendor: "vendor",
  model: "model",
  profile: "profile",
  size: "size",
  difficulty: "difficulty",
  type: "type",
  orch_harness: "orch harness",
  orch_model: "orch model",
  orch_effort: "orch effort",
  eval_harness: "judge harness",
  eval_model: "judge model",
  eval_effort: "judge effort",
  rubric: "rubric",
  workflow: "workflow",
};

export function isWorkflowDim(dim: MetricsDim): boolean {
  return dim === "workflow";
}

export function isTaskDim(dim: MetricsDim): dim is Exclude<MetricsDim, "workflow"> {
  return dim !== "workflow";
}

export interface GroupRow {
  key: string | null;
  label: string;
  /** Task or run total depending on population. */
  count: number;
  successRate: number | null;
  successLabel: string;
  successWidth: string;
  successTone: "good" | "mid" | "poor" | "none";
  evalAvg: number | null;
  evalBaseline: number | null;
  evalDelta: number | null;
  evalLabel: string;
  /** Full explanation for title (e.g. "no rubric · n=4"). */
  evalTitle: string;
  evalTone: "good" | "poor" | "none";
  belowBaselineRate: number | null;
  belowLabel: string;
  belowTone: "poor" | "none";
  tokensLabel: string;
  durationLabel: string;
  /** Present only on workflow/run-metrics rows. */
  costPerCompleted: number | null;
  costLabel: string;
  evals: MetricsEvalStats | RunMetricsEvalStats | null;
  decided: number;
}

function successTone(rate: number | null): GroupRow["successTone"] {
  if (rate == null) return "none";
  if (rate > 0.85) return "good";
  if (rate > 0.7) return "mid";
  return "poor";
}

function evalTone(avg: number | null, baseline: number | null): GroupRow["evalTone"] {
  if (avg == null) return "none";
  if (baseline == null) return "none";
  return avg >= baseline ? "good" : "poor";
}

function projectEvals(
  evals: MetricsEvalStats | RunMetricsEvalStats | undefined,
  decidedHint: number,
): Pick<
  GroupRow,
  | "evalAvg"
  | "evalBaseline"
  | "evalDelta"
  | "evalLabel"
  | "evalTitle"
  | "evalTone"
  | "belowBaselineRate"
  | "belowLabel"
  | "belowTone"
  | "evals"
> {
  const count = evals?.count ?? 0;
  const avg = evals?.avg ?? null;
  const baseline = evals?.avg_baseline ?? null;
  const delta = evals?.avg_delta ?? null;
  const below = evals?.below_baseline_rate ?? null;
  const n = count > 0 ? count : decidedHint;
  // Visible "no rubric" cue (fits at ≥1361 and at ≤1360 after column drop).
  // Full explanation still rides on title.
  const evalLabel =
    avg == null
      ? n > 0
        ? `no rubric · n=${n}`
        : "—"
      : `${formatScore(avg)} · n=${count}`;
  const evalTitle =
    avg == null
      ? n > 0
        ? `no rubric · n=${n} decided`
        : "no eval"
      : `avg ${formatScore(avg)} · baseline ${formatScore(baseline)} · n=${count}`;
  return {
    evalAvg: avg,
    evalBaseline: baseline,
    evalDelta: delta,
    evalLabel,
    evalTitle,
    evalTone: evalTone(avg, baseline),
    belowBaselineRate: below,
    belowLabel: formatRate(below),
    belowTone: below != null && below > 0.15 ? "poor" : "none",
    evals: evals ?? null,
  };
}

export function projectTaskGroup(g: MetricsGroup): GroupRow {
  const decided = g.tasks.completed + g.tasks.failed;
  const evalPart = projectEvals(g.evals, decided);
  return {
    key: g.key,
    label: formatGroupKey(g.key),
    count: g.tasks.total,
    successRate: g.success_rate,
    successLabel: formatRate(g.success_rate),
    successWidth: rateWidth(g.success_rate),
    successTone: successTone(g.success_rate),
    ...evalPart,
    tokensLabel: `${formatTokens(g.tokens.input)} ▸ ${formatTokens(g.tokens.output)} ▸ ${formatTokens(g.tokens.cached)}`,
    durationLabel:
      g.duration_ms.avg != null
        ? `${formatDurationMs(g.duration_ms.avg)} · ${formatDurationMs(g.duration_ms.p95)}`
        : "—",
    costPerCompleted: null,
    costLabel: "—",
    decided,
  };
}

export function projectRunGroup(g: RunMetricsGroup): GroupRow {
  const decided = g.runs.completed + g.runs.failed;
  const evalPart = projectEvals(g.evals, decided);
  const cost = g.cost_per_completed_run;
  return {
    key: g.key,
    label: formatGroupKey(g.key),
    count: g.runs.total,
    successRate: g.success_rate,
    successLabel: formatRate(g.success_rate),
    successWidth: rateWidth(g.success_rate),
    successTone: successTone(g.success_rate),
    ...evalPart,
    tokensLabel: `${formatTokens(g.tokens.input)} ▸ ${formatTokens(g.tokens.output)} ▸ ${formatTokens(g.tokens.cached)}`,
    durationLabel:
      g.duration_ms.avg != null
        ? `${formatDurationMs(g.duration_ms.avg)} · ${formatDurationMs(g.duration_ms.p95)}`
        : "—",
    costPerCompleted: cost,
    costLabel: cost == null ? "—" : formatTokens(cost),
    decided,
  };
}

export interface DistributionBar {
  key: string | null;
  label: string;
  score: number;
  baseline: number;
  delta: number;
  deltaLabel: string;
  tone: "good" | "poor";
}

export function projectDistribution(rows: readonly GroupRow[]): DistributionBar[] {
  return rows
    .filter((r) => r.evalAvg != null && r.evalBaseline != null)
    .map((r) => {
      const score = r.evalAvg!;
      const baseline = r.evalBaseline!;
      const delta = r.evalDelta ?? score - baseline;
      return {
        key: r.key,
        label: r.label,
        score,
        baseline,
        delta,
        deltaLabel: formatDelta(delta),
        tone: score >= baseline ? "good" : "poor",
      };
    });
}

export interface HeatCell {
  /** Display label: "—" | "12%" | "100%!" · optional n= for low sample */
  label: string;
  rate: number | null;
  /** Rubric evals that answered this criterion */
  count: number;
  /** Primary visual kind for class hooks */
  kind: "none" | "low" | "ok" | "suspect" | "low-suspect";
  low: boolean;
  suspect: boolean;
  barW: string;
}

export interface HeatRow {
  criterion: string;
  cells: HeatCell[];
}

export interface HeatmapModel {
  columns: { key: string | null; label: string }[];
  rows: HeatRow[];
  /** Rubric samples across *shown* columns. */
  sampleShown: number;
  /** Rubric samples across *all* groups with evals (before column cap). */
  sampleTotal: number;
  /** Groups with evals that are shown. */
  shownCols: number;
  /** Groups with evals available (may exceed shownCols). */
  totalCols: number;
  /**
   * Column selection rule (disclosed when truncated):
   * first N groups that have rubric evals, in table row order (volume sort).
   */
  selectionRule: string;
  truncated: boolean;
}

export const HEATMAP_MAX_COLS = 6;
const LOW_SAMPLE = 3;

export function heatCell(stat: MetricsCriterionFailureStats | undefined): HeatCell {
  if (!stat || stat.count === 0 || stat.rate == null) {
    return {
      label: "—",
      rate: null,
      count: 0,
      kind: "none",
      low: false,
      suspect: false,
      barW: "0%",
    };
  }
  const pct = Math.round(stat.rate * 100);
  const suspect = stat.rate >= 1 && stat.count >= 1;
  const low = stat.count < LOW_SAMPLE;
  // Zero rate → zero bar (no floor).
  const barW = stat.rate === 0 ? "0%" : rateWidth(stat.rate);
  let kind: HeatCell["kind"] = "ok";
  if (low && suspect) kind = "low-suspect";
  else if (suspect) kind = "suspect";
  else if (low) kind = "low";
  // Low sample: put n= in the cell so "50%" on n=2 is never read as no-data.
  let label = suspect ? `${pct}%!` : `${pct}%`;
  if (low) label = `${label} n=${stat.count}`;
  return {
    label,
    rate: stat.rate,
    count: stat.count,
    kind,
    low,
    suspect,
    barW,
  };
}

/**
 * Criterion × group heatmap.
 * Columns: first {@link HEATMAP_MAX_COLS} groups that have rubric evals,
 * preserving group-table order (volume-sorted upstream). Truncation is
 * disclosed via shownCols/totalCols/sampleShown/sampleTotal.
 */
export function projectHeatmap(
  rows: readonly GroupRow[],
  maxCols = HEATMAP_MAX_COLS,
): HeatmapModel {
  const allWithEvals = rows.filter((r) => r.evals && r.evals.count > 0);
  const shown = allWithEvals.slice(0, maxCols);
  const criterionIds = new Set<string>();
  for (const r of shown) {
    for (const id of Object.keys(r.evals?.criterion_failures ?? {})) {
      criterionIds.add(id);
    }
  }
  const criteria = [...criterionIds].sort();
  let sampleShown = 0;
  for (const r of shown) sampleShown += r.evals?.count ?? 0;
  let sampleTotal = 0;
  for (const r of allWithEvals) sampleTotal += r.evals?.count ?? 0;

  return {
    columns: shown.map((r) => ({ key: r.key, label: r.label })),
    rows: criteria.map((criterion) => ({
      criterion,
      cells: shown.map((r) => heatCell(r.evals?.criterion_failures?.[criterion])),
    })),
    sampleShown,
    sampleTotal,
    shownCols: shown.length,
    totalCols: allWithEvals.length,
    selectionRule:
      "first groups with rubric evals, in table order (by task/run volume)",
    truncated: allWithEvals.length > shown.length,
  };
}

export interface ComparisonSplit {
  label: string;
  count: number;
  avg: number | null;
  avgDelta: number | null;
  belowRate: number | null;
  avgLabel: string;
  deltaLabel: string;
  belowLabel: string;
}

export interface ComparisonModel {
  /** Task: first_attempt/fix; Run: first_run/fork. */
  left: ComparisonSplit;
  right: ComparisonSplit;
  overallDelta: number | null;
  overallDeltaLabel: string;
  kind: "task" | "run";
}

function splitFrom(
  label: string,
  s: {
    count: number;
    avg: number | null;
    avg_delta: number | null;
    below_baseline_rate: number | null;
  },
): ComparisonSplit {
  return {
    label,
    count: s.count,
    avg: s.avg,
    avgDelta: s.avg_delta,
    belowRate: s.below_baseline_rate,
    avgLabel: formatScore(s.avg),
    deltaLabel: formatDelta(s.avg_delta),
    belowLabel: formatRate(s.below_baseline_rate),
  };
}

/** Aggregate first-vs-fix (or first_run-vs-fork) across all groups. */
export function projectComparison(
  rows: readonly GroupRow[],
  kind: "task" | "run",
): ComparisonModel | null {
  const emptySplit = {
    count: 0,
    avg: null as number | null,
    avg_baseline: null as number | null,
    avg_delta: null as number | null,
    below_baseline_rate: null as number | null,
  };

  const leftAcc = { ...emptySplit, sumAvg: 0, sumDelta: 0, sumBelow: 0, nAvg: 0, nDelta: 0, nBelow: 0 };
  const rightAcc = { ...emptySplit, sumAvg: 0, sumDelta: 0, sumBelow: 0, nAvg: 0, nDelta: 0, nBelow: 0 };

  for (const r of rows) {
    const e = r.evals;
    if (!e) continue;
    if (kind === "task") {
      const te = e as MetricsEvalStats;
      acc(leftAcc, te.first_attempt);
      acc(rightAcc, te.fix);
    } else {
      const re = e as RunMetricsEvalStats;
      acc(leftAcc, re.first_run);
      acc(rightAcc, re.fork);
    }
  }

  if (leftAcc.count === 0 && rightAcc.count === 0) return null;

  const left = finalize(leftAcc, kind === "task" ? "first attempt" : "first run");
  const right = finalize(rightAcc, kind === "task" ? "fix" : "fork");
  const overallDelta =
    left.avg != null && right.avg != null ? right.avg - left.avg : null;

  return {
    left,
    right,
    overallDelta,
    overallDeltaLabel: formatDelta(overallDelta),
    kind,
  };
}

function acc(
  a: {
    count: number;
    sumAvg: number;
    sumDelta: number;
    sumBelow: number;
    nAvg: number;
    nDelta: number;
    nBelow: number;
  },
  s: {
    count: number;
    avg: number | null;
    avg_delta: number | null;
    below_baseline_rate: number | null;
  },
): void {
  a.count += s.count;
  if (s.avg != null) {
    a.sumAvg += s.avg * s.count;
    a.nAvg += s.count;
  }
  if (s.avg_delta != null) {
    a.sumDelta += s.avg_delta * s.count;
    a.nDelta += s.count;
  }
  if (s.below_baseline_rate != null) {
    a.sumBelow += s.below_baseline_rate * s.count;
    a.nBelow += s.count;
  }
}

function finalize(
  a: {
    count: number;
    sumAvg: number;
    sumDelta: number;
    sumBelow: number;
    nAvg: number;
    nDelta: number;
    nBelow: number;
  },
  label: string,
): ComparisonSplit {
  return splitFrom(label, {
    count: a.count,
    avg: a.nAvg > 0 ? a.sumAvg / a.nAvg : null,
    avg_delta: a.nDelta > 0 ? a.sumDelta / a.nDelta : null,
    below_baseline_rate: a.nBelow > 0 ? a.sumBelow / a.nBelow : null,
  });
}

export interface BucketChip {
  id: string;
  count: number;
  avg: number | null;
  avgLabel: string;
  belowLabel: string;
}

/** Flatten evals_by_size / evals_by_difficulty across groups. */
export function projectBuckets(
  groups: readonly MetricsGroup[] | readonly RunMetricsGroup[],
  field: "evals_by_size" | "evals_by_difficulty",
): BucketChip[] {
  const map = new Map<
    string,
    { count: number; sumAvg: number; nAvg: number; sumBelow: number; nBelow: number }
  >();
  for (const g of groups) {
    const bag = g[field] as Record<string, MetricsEvalStats | RunMetricsEvalStats>;
    for (const [id, stats] of Object.entries(bag ?? {})) {
      let accu = map.get(id);
      if (!accu) {
        accu = { count: 0, sumAvg: 0, nAvg: 0, sumBelow: 0, nBelow: 0 };
        map.set(id, accu);
      }
      accu.count += stats.count;
      if (stats.avg != null) {
        accu.sumAvg += stats.avg * stats.count;
        accu.nAvg += stats.count;
      }
      if (stats.below_baseline_rate != null) {
        accu.sumBelow += stats.below_baseline_rate * stats.count;
        accu.nBelow += stats.count;
      }
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([id, v]) => ({
      id,
      count: v.count,
      avg: v.nAvg > 0 ? v.sumAvg / v.nAvg : null,
      avgLabel: formatScore(v.nAvg > 0 ? v.sumAvg / v.nAvg : null),
      belowLabel: formatRate(v.nBelow > 0 ? v.sumBelow / v.nBelow : null),
    }));
}

export function totalDecided(rows: readonly GroupRow[]): number {
  return rows.reduce((n, r) => n + r.decided, 0);
}

export function totalEvalSamples(rows: readonly GroupRow[]): number {
  return rows.reduce((n, r) => n + (r.evals?.count ?? 0), 0);
}
