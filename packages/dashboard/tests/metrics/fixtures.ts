/**
 * Metrics screen fixtures — hand-built wire shapes for pure projection tests
 * and component render tests. Prefer these over shared fixtures.ts edits.
 */
import type {
  MetricsEvalStats,
  MetricsGroup,
  RunMetricsEvalStats,
  RunMetricsGroup,
  MetricsResponse,
  RunMetricsResponse,
} from "@useparley/core";

function emptyAttemptSplit() {
  return {
    count: 0,
    avg: null,
    avg_baseline: null,
    avg_delta: null,
    below_baseline_rate: null,
  };
}

export function makeEvalStats(
  overrides: Partial<MetricsEvalStats> & {
    criterion_failures?: MetricsEvalStats["criterion_failures"];
  } = {},
): MetricsEvalStats {
  return {
    count: overrides.count ?? 0,
    avg: overrides.avg ?? null,
    avg_baseline: overrides.avg_baseline ?? null,
    avg_delta: overrides.avg_delta ?? null,
    below_baseline_rate: overrides.below_baseline_rate ?? null,
    criterion_failures: overrides.criterion_failures ?? {},
    first_attempt: overrides.first_attempt ?? emptyAttemptSplit(),
    fix: overrides.fix ?? emptyAttemptSplit(),
  };
}

export function makeRunEvalStats(
  overrides: Partial<RunMetricsEvalStats> = {},
): RunMetricsEvalStats {
  return {
    count: overrides.count ?? 0,
    avg: overrides.avg ?? null,
    avg_baseline: overrides.avg_baseline ?? null,
    avg_delta: overrides.avg_delta ?? null,
    below_baseline_rate: overrides.below_baseline_rate ?? null,
    criterion_failures: overrides.criterion_failures ?? {},
    first_run: overrides.first_run ?? emptyAttemptSplit(),
    fork: overrides.fork ?? emptyAttemptSplit(),
  };
}

export function makeTaskGroup(
  key: string | null,
  overrides: Partial<MetricsGroup> = {},
): MetricsGroup {
  return {
    key,
    tasks: {
      total: 10,
      completed: 8,
      failed: 2,
      cancelled: 0,
      running: 0,
      other: 0,
      ...overrides.tasks,
    },
    success_rate: overrides.success_rate ?? 0.8,
    evals: overrides.evals ?? makeEvalStats(),
    evals_by_size: overrides.evals_by_size ?? {},
    evals_by_difficulty: overrides.evals_by_difficulty ?? {},
    tokens: {
      input: 12_000,
      output: 4_000,
      cached: 1_500,
      tasks_reporting: 10,
      ...overrides.tokens,
    },
    duration_ms: {
      total: 600_000,
      avg: 60_000,
      p50: 50_000,
      p95: 120_000,
      tasks_reporting: 10,
      ...overrides.duration_ms,
    },
  };
}

export function makeRunGroup(
  key: string | null,
  overrides: Partial<RunMetricsGroup> = {},
): RunMetricsGroup {
  return {
    key,
    runs: {
      total: 4,
      completed: 3,
      failed: 1,
      cancelled: 0,
      running: 0,
      blocked: 0,
      other: 0,
      ...overrides.runs,
    },
    success_rate: overrides.success_rate ?? 0.75,
    evals: overrides.evals ?? makeRunEvalStats(),
    evals_by_size: overrides.evals_by_size ?? {},
    evals_by_difficulty: overrides.evals_by_difficulty ?? {},
    tokens: {
      input: 40_000,
      output: 12_000,
      cached: 2_000,
      tasks_reporting: 12,
      ...overrides.tokens,
    },
    duration_ms: {
      total: 1_200_000,
      avg: 300_000,
      p50: 280_000,
      p95: 500_000,
      tasks_reporting: 4,
      ...overrides.duration_ms,
    },
    cost_per_completed_run: overrides.cost_per_completed_run ?? 17_333,
  };
}

export function populatedMetrics(): MetricsResponse {
  return {
    generated_at: "2026-08-06T12:00:00.000Z",
    groups: [
      makeTaskGroup("fake", {
        evals: makeEvalStats({
          count: 6,
          avg: 7.2,
          avg_baseline: 5.0,
          avg_delta: 2.2,
          below_baseline_rate: 0.17,
          criterion_failures: {
            "brief-implemented": { failures: 1, count: 6, rate: 0.17 },
            "suite-green": { failures: 2, count: 6, rate: 0.33 },
            "minimal-diff": { failures: 0, count: 6, rate: 0 },
          },
          first_attempt: {
            count: 4,
            avg: 6.5,
            avg_baseline: 5.0,
            avg_delta: 1.5,
            below_baseline_rate: 0.25,
          },
          fix: {
            count: 2,
            avg: 8.5,
            avg_baseline: 5.0,
            avg_delta: 3.5,
            below_baseline_rate: 0,
          },
        }),
        evals_by_size: {
          S: makeEvalStats({ count: 3, avg: 7.0, avg_baseline: 5.0, avg_delta: 2.0 }),
          M: makeEvalStats({ count: 3, avg: 7.4, avg_baseline: 5.0, avg_delta: 2.4 }),
        },
        evals_by_difficulty: {
          easy: makeEvalStats({ count: 2, avg: 8.0, avg_baseline: 5.0, avg_delta: 3.0 }),
          medium: makeEvalStats({ count: 4, avg: 6.8, avg_baseline: 5.0, avg_delta: 1.8 }),
        },
      }),
      makeTaskGroup("claude", {
        tasks: {
          total: 5,
          completed: 3,
          failed: 2,
          cancelled: 0,
          running: 0,
          other: 0,
        },
        success_rate: 0.6,
        evals: makeEvalStats({
          count: 4,
          avg: 4.2,
          avg_baseline: 5.0,
          avg_delta: -0.8,
          below_baseline_rate: 0.75,
          criterion_failures: {
            "brief-implemented": { failures: 3, count: 4, rate: 0.75 },
            "suite-green": { failures: 4, count: 4, rate: 1 },
            "minimal-diff": { failures: 1, count: 2, rate: 0.5 },
          },
          first_attempt: {
            count: 3,
            avg: 3.8,
            avg_baseline: 5.0,
            avg_delta: -1.2,
            below_baseline_rate: 1,
          },
          fix: {
            count: 1,
            avg: 5.5,
            avg_baseline: 5.0,
            avg_delta: 0.5,
            below_baseline_rate: 0,
          },
        }),
      }),
      makeTaskGroup("codex", {
        // Group with tasks but no rubric evals — common when eval is off.
        evals: makeEvalStats({ count: 0 }),
      }),
    ],
  };
}

export function emptyMetrics(): MetricsResponse {
  return {
    generated_at: "2026-08-06T12:00:00.000Z",
    groups: [],
  };
}

export function populatedRunMetrics(): RunMetricsResponse {
  return {
    generated_at: "2026-08-06T12:00:00.000Z",
    groups: [
      makeRunGroup("coding-1@3", {
        evals: makeRunEvalStats({
          count: 3,
          avg: 6.8,
          avg_baseline: 5.0,
          avg_delta: 1.8,
          below_baseline_rate: 0.33,
          criterion_failures: {
            "brief-implemented": { failures: 1, count: 3, rate: 0.33 },
          },
          first_run: {
            count: 2,
            avg: 6.0,
            avg_baseline: 5.0,
            avg_delta: 1.0,
            below_baseline_rate: 0.5,
          },
          fork: {
            count: 1,
            avg: 8.5,
            avg_baseline: 5.0,
            avg_delta: 3.5,
            below_baseline_rate: 0,
          },
        }),
        cost_per_completed_run: 18_500,
      }),
    ],
  };
}

/** Minimal ParleyClient mock for screen unit tests. */
export function mockClient(opts: {
  metrics?: MetricsResponse | (() => Promise<MetricsResponse>);
  runMetrics?: RunMetricsResponse | (() => Promise<RunMetricsResponse>);
  sessions?: { id: string; last_activity_at: string; task_count: number }[];
  metricsError?: string;
  runMetricsError?: string;
}) {
  return {
    metrics: async () => {
      if (opts.metricsError) throw new Error(opts.metricsError);
      if (typeof opts.metrics === "function") return opts.metrics();
      return opts.metrics ?? emptyMetrics();
    },
    runMetrics: async () => {
      if (opts.runMetricsError) throw new Error(opts.runMetricsError);
      if (typeof opts.runMetrics === "function") return opts.runMetrics();
      return opts.runMetrics ?? { generated_at: "2026-08-06T12:00:00.000Z", groups: [] };
    },
    listSessions: async () => ({
      sessions: opts.sessions ?? [
        {
          id: "verify-orch",
          last_activity_at: "2026-08-06T11:00:00.000Z",
          task_count: 3,
        },
      ],
    }),
  };
}
