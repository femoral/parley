/**
 * Layer 4 — project `MetricsResponse` into plain Soundings view props (#119 / #165).
 * Keeps `@useparley/core` types out of the hud layer (contract 2).
 */
import type { MetricsGroup, MetricsGroupBy, MetricsResponse } from "@useparley/core";
import {
  formatDurationMs,
  formatEvalAvg,
  formatEvalDelta,
  formatRate,
  formatScore,
  formatSuccessRate,
  formatTokenCount,
} from "./format.js";
import type { EvalFilterState } from "./evalFilters.js";
import { emptyEvalFilters, hasActiveEvalFilters } from "./evalFilters.js";
import type {
  SoundingsComparisonRow,
  SoundingsDistributionRow,
  SoundingsEvalBucket,
  SoundingsFiltersView,
  SoundingsGroupView,
  SoundingsHeatmapCell,
  SoundingsHeatmapView,
  SoundingsView,
  SoundingsViewTab,
} from "../../hud/types.js";

/** Human labels for the group-by control (Cinzel chrome stays ALL-CAPS in CSS). */
export const GROUP_BY_OPTIONS: readonly { value: MetricsGroupBy; label: string }[] = [
  { value: "vendor", label: "Vendor" },
  { value: "model", label: "Model" },
  { value: "profile", label: "Profile" },
  { value: "size", label: "Size" },
  { value: "difficulty", label: "Difficulty" },
  { value: "type", label: "Type" },
  { value: "orch_harness", label: "Orch harness" },
  { value: "orch_model", label: "Orch model" },
  { value: "orch_effort", label: "Orch effort" },
  { value: "eval_harness", label: "Judge harness" },
  { value: "eval_model", label: "Judge model" },
  { value: "eval_effort", label: "Judge effort" },
  { value: "rubric", label: "Rubric" },
];

/**
 * Dimensions the comparison view highlights (vendor / orchestrator / judge).
 * Subset of {@link GROUP_BY_OPTIONS}; full group-by still available on Groups.
 */
export const COMPARISON_DIMENSIONS: readonly { value: MetricsGroupBy; label: string }[] = [
  { value: "vendor", label: "Vendor" },
  { value: "model", label: "Model" },
  { value: "orch_harness", label: "Orch harness" },
  { value: "orch_model", label: "Orch model" },
  { value: "eval_harness", label: "Judge harness" },
  { value: "eval_model", label: "Judge model" },
];

/**
 * Heatmap column dimensions (#166): task type / vendor / orchestrator.
 * Switching reuses the shared metrics `group_by` (same as comparison chips).
 */
export const HEATMAP_DIMENSIONS: readonly { value: MetricsGroupBy; label: string }[] = [
  { value: "type", label: "Type" },
  { value: "vendor", label: "Vendor" },
  { value: "orch_harness", label: "Orchestrator" },
];

function projectEvalBuckets(map: Record<string, { count: number; avg: number | null }>): SoundingsEvalBucket[] {
  return Object.keys(map)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const e = map[key]!;
      return {
        key,
        avg: formatEvalAvg(e.avg, e.count),
        count: e.count,
      };
    });
}

export function projectMetricsGroup(group: MetricsGroup): SoundingsGroupView {
  return {
    key: group.key,
    label: group.key ?? "(none)",
    tasks: {
      total: group.tasks.total,
      done: group.tasks.completed,
      failed: group.tasks.failed,
      running: group.tasks.running,
    },
    successRate: formatSuccessRate(group.success_rate),
    successRateValue: group.success_rate,
    evals: formatEvalAvg(group.evals.avg, group.evals.count),
    tokens: {
      input: formatTokenCount(group.tokens.input),
      output: formatTokenCount(group.tokens.output),
      cached: formatTokenCount(group.tokens.cached),
    },
    duration: {
      avg: formatDurationMs(group.duration_ms.avg),
      p95: formatDurationMs(group.duration_ms.p95),
    },
    evalsBySize: projectEvalBuckets(group.evals_by_size),
    evalsByDifficulty: projectEvalBuckets(group.evals_by_difficulty),
  };
}

/** Score-vs-baseline row for the distribution view (#165). */
export function projectDistributionRow(group: MetricsGroup): SoundingsDistributionRow {
  const score = group.evals.avg;
  const baseline = group.evals.avg_baseline;
  return {
    key: group.key,
    label: group.key ?? "(none)",
    count: group.evals.count,
    score: formatScore(score),
    baseline: formatScore(baseline),
    /** 0–1 position on a 0–10 score axis; null when unscored. */
    scorePos: score === null || !Number.isFinite(score) ? null : clamp01(score / 10),
    baselinePos:
      baseline === null || !Number.isFinite(baseline) ? null : clamp01(baseline / 10),
    delta: formatEvalDelta(group.evals.avg_delta),
    deltaValue: group.evals.avg_delta,
  };
}

/** Comparison row: avg delta, below-baseline rate, first vs fix split (#165). */
export function projectComparisonRow(group: MetricsGroup): SoundingsComparisonRow {
  const fa = group.evals.first_attempt;
  const fix = group.evals.fix;
  return {
    key: group.key,
    label: group.key ?? "(none)",
    count: group.evals.count,
    avgDelta: formatEvalDelta(group.evals.avg_delta),
    avgDeltaValue: group.evals.avg_delta,
    belowBaselineRate: formatRate(group.evals.below_baseline_rate),
    belowBaselineRateValue: group.evals.below_baseline_rate,
    firstAttempt: formatEvalAvg(fa.avg, fa.count),
    firstAttemptCount: fa.count,
    fix: formatEvalAvg(fix.avg, fix.count),
    fixCount: fix.count,
  };
}

/**
 * Build the criterion × group failure-rate matrix for the heatmap (#166).
 * Missing criterion answers in a group become null intensity (empty tile),
 * never a false zero rate — sparse data must stay honest.
 */
export function projectHeatmap(groups: readonly MetricsGroup[]): SoundingsHeatmapView {
  const criterionIds = new Set<string>();
  let sampleEvals = 0;
  for (const group of groups) {
    sampleEvals += group.evals.count;
    for (const id of Object.keys(group.evals.criterion_failures)) {
      criterionIds.add(id);
    }
  }
  const criteria = [...criterionIds].sort((a, b) => a.localeCompare(b));
  const groupCols = groups.map((g) => ({
    key: g.key,
    label: g.key ?? "(none)",
  }));

  const cells: SoundingsHeatmapCell[][] = criteria.map((criterionId) =>
    groups.map((group) => {
      const stats = group.evals.criterion_failures[criterionId];
      const groupLabel = group.key ?? "(none)";
      if (!stats || stats.count === 0) {
        return {
          criterionId,
          groupKey: group.key,
          groupLabel,
          failures: 0,
          count: 0,
          rate: null,
          rateLabel: "—",
          intensity: null,
        };
      }
      const rate = stats.rate;
      return {
        criterionId,
        groupKey: group.key,
        groupLabel,
        failures: stats.failures,
        count: stats.count,
        rate,
        rateLabel: formatRate(rate),
        // Raw failure rate drives shade; plate applies a legibility floor in CSS.
        intensity: rate === null || !Number.isFinite(rate) ? null : clamp01(rate),
      };
    }),
  );

  return { criteria, groups: groupCols, cells, sampleEvals };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Project filter bag into the plain hud shape (identity map today). */
export function projectFiltersView(filters: EvalFilterState): SoundingsFiltersView {
  return {
    type: filters.type,
    vendor: filters.vendor,
    model: filters.model,
    orch_harness: filters.orch_harness,
    orch_model: filters.orch_model,
    eval_harness: filters.eval_harness,
    eval_model: filters.eval_model,
    rubric: filters.rubric,
    firstAttemptOnly: filters.first_attempt,
    belowBaselineOnly: filters.below_baseline,
    active: hasActiveEvalFilters(filters),
  };
}

/**
 * Whether the metrics response contains any structured rubric evals.
 * Used to distinguish "eval off / no scores yet" from a healthy chart.
 */
export function metricsHasRubricEvals(data: MetricsResponse | null): boolean {
  if (!data) return false;
  return data.groups.some((g) => g.evals.count > 0);
}

/**
 * Build the plain Soundings view the plate renders. Empty groups → empty
 * status once ready (not while loading). Errors preserve last groups when
 * present so a transient fault does not blank the board.
 */
export function projectSoundings(
  data: MetricsResponse | null,
  status: "idle" | "loading" | "ready" | "error",
  error: string | null,
  groupBy: MetricsGroupBy,
  sessionLabel: string,
  options: {
    filters?: EvalFilterState;
    viewTab?: SoundingsViewTab;
  } = {},
): SoundingsView {
  const filters = options.filters ?? emptyEvalFilters();
  const viewTab = options.viewTab ?? "groups";
  const groups = data?.groups.map(projectMetricsGroup) ?? [];
  const distribution = data?.groups.map(projectDistributionRow) ?? [];
  const comparison = data?.groups.map(projectComparisonRow) ?? [];
  const heatmap = projectHeatmap(data?.groups ?? []);
  const empty = status === "ready" && groups.length === 0;
  const hasEvals = metricsHasRubricEvals(data);
  /**
   * Eval presence for quality views:
   * - `loading` while idle/loading with no data yet
   * - `off` when ready (or revalidated) with groups/tasks but zero rubric evals
   * - `ready` when at least one rubric eval exists
   * - `empty` when ready with no groups at all (fleet empty / filters miss)
   */
  let evalPresence: SoundingsView["evalPresence"] = "loading";
  if (status === "ready" || (status === "error" && data !== null)) {
    if (groups.length === 0) evalPresence = "empty";
    else if (!hasEvals) evalPresence = "off";
    else evalPresence = "ready";
  } else if (status === "error" && data === null) {
    evalPresence = "empty";
  }

  return {
    status: empty ? "empty" : status === "idle" ? "loading" : status,
    error,
    groups,
    distribution,
    comparison,
    heatmap,
    groupBy,
    sessionLabel,
    generatedAt: data?.generated_at ?? null,
    filters: projectFiltersView(filters),
    viewTab,
    evalPresence,
  };
}

/**
 * Compact revision of the live task list for metrics refresh. State transitions
 * and membership changes advance the key; pure re-projection with identical
 * id/state pairs does not.
 */
export function metricsRefreshKey(
  tasks: readonly { id: string; state: string }[],
): string {
  if (tasks.length === 0) return "0";
  // Sort for stability if order is not guaranteed; snapshot emits map order.
  return tasks.map((t) => `${t.id}:${t.state}`).join("|");
}
