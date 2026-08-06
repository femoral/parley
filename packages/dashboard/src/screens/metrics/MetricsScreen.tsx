/**
 * Metrics center screen (#358).
 *
 * - Group table, score-vs-baseline, criterion heatmap from useMetrics
 * - Workflow tab from useRunMetrics (incl. cost-per-completed-run)
 * - Session is a scope filter, never a group_by tab
 * - Soundings-parity filter bar + comparison + size/difficulty buckets
 * - Full per-panel honesty (loading / empty / error / stale)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type MetricsGroupBy,
  type OrchestratorSession,
} from "@useparley/core";
import { Select } from "../../components/index.js";
import {
  useConsoleData,
  useMetrics,
  usePolling,
  useRunMetrics,
} from "../../data/index.js";
import type { ScreenMountProps } from "../types.js";
import { Buckets } from "./Buckets.js";
import { ComparisonPanel } from "./ComparisonPanel.js";
import { CriterionHeatmap } from "./CriterionHeatmap.js";
import {
  clearFilters,
  filtersActive,
  toRunFilters,
  toTaskFilters,
  type MetricsFilterState,
  EMPTY_FILTERS,
} from "./filters.js";
import { FilterBar } from "./FilterBar.js";
import { formatGeneratedAt } from "./format.js";
import { GroupTable } from "./GroupTable.js";
import { ErrorBanner, StaleBanner } from "./Honesty.js";
import {
  DIM_LABELS,
  PRIMARY_DIMS,
  TASK_DIMS,
  isWorkflowDim,
  projectBuckets,
  projectComparison,
  projectDistribution,
  projectHeatmap,
  projectRunGroup,
  projectTaskGroup,
  totalDecided,
  totalEvalSamples,
  type MetricsDim,
  type GroupRow,
} from "./project.js";
import { ScoreDistribution } from "./ScoreDistribution.js";
import "./metrics.css";


const OVERFLOW_DIMS = TASK_DIMS.filter(
  (d) => !PRIMARY_DIMS.includes(d as MetricsDim),
);

export function MetricsScreen(_props: ScreenMountProps) {
  const { client } = useConsoleData();

  const [dim, setDim] = useState<MetricsDim>("vendor");
  const [session, setSession] = useState("all");
  const [filters, setFilters] = useState<MetricsFilterState>(EMPTY_FILTERS);
  const [view, setView] = useState<"overview" | "comparison">("overview");
  const [sessions, setSessions] = useState<OrchestratorSession[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Light refresh every 30s while visible; usePolling gates on document.hidden.
  usePolling(
    useCallback(() => {
      setRefreshKey((k) => k + 1);
    }, []),
    { intervalMs: 30_000, immediate: false },
  );

  useEffect(() => {
    let cancelled = false;
    void client
      .listSessions()
      .then((res) => {
        if (!cancelled) setSessions(res.sessions);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, refreshKey]);

  const workflow = isWorkflowDim(dim);
  const taskFilters = useMemo(() => toTaskFilters(filters), [filters]);
  const runFilters = useMemo(() => toRunFilters(filters), [filters]);
  const filterOn = filtersActive(filters);

  const taskMetrics = useMetrics(client, {
    session,
    groupBy: (workflow ? "vendor" : dim) as MetricsGroupBy,
    refreshKey: String(refreshKey),
    enabled: !workflow,
    filters: taskFilters,
  });

  const runMetrics = useRunMetrics(client, {
    session,
    groupBy: "workflow",
    refreshKey: String(refreshKey),
    enabled: workflow,
    filters: runFilters,
  });

  const active = workflow ? runMetrics : taskMetrics;
  const status = active.status;
  const error = active.error;

  const rows: GroupRow[] = useMemo(() => {
    if (workflow) {
      return (runMetrics.data?.groups ?? []).map(projectRunGroup);
    }
    return (taskMetrics.data?.groups ?? []).map(projectTaskGroup);
  }, [workflow, runMetrics.data, taskMetrics.data]);

  const distribution = useMemo(() => projectDistribution(rows), [rows]);
  const heatmap = useMemo(() => projectHeatmap(rows), [rows]);
  const comparison = useMemo(
    () => projectComparison(rows, workflow ? "run" : "task"),
    [rows, workflow],
  );
  const sizeBuckets = useMemo(() => {
    if (workflow) return projectBuckets(runMetrics.data?.groups ?? [], "evals_by_size");
    return projectBuckets(taskMetrics.data?.groups ?? [], "evals_by_size");
  }, [workflow, runMetrics.data, taskMetrics.data]);
  const diffBuckets = useMemo(() => {
    if (workflow) {
      return projectBuckets(runMetrics.data?.groups ?? [], "evals_by_difficulty");
    }
    return projectBuckets(taskMetrics.data?.groups ?? [], "evals_by_difficulty");
  }, [workflow, runMetrics.data, taskMetrics.data]);

  const generatedAt = workflow
    ? runMetrics.data?.generated_at
    : taskMetrics.data?.generated_at;

  const scopeLabel =
    session === "all"
      ? "all sessions"
      : sessions.find((s) => s.id === session)?.id ?? session;

  const meta = `${scopeLabel} · ${totalDecided(rows)} decided · ${totalEvalSamples(rows)} scored · ${formatGeneratedAt(generatedAt)}`;

  // Chart panels: empty when no eval samples even if groups exist.
  const chartStatus =
    status === "ready" && totalEvalSamples(rows) === 0 && rows.length > 0
      ? "empty"
      : status === "ready" && rows.length === 0
        ? "empty"
        : status;

  const tableStatus = status;
  const hasStaleData =
    (status === "error" || status === "loading") && rows.length > 0;

  const primarySelected = PRIMARY_DIMS.includes(dim);
  const overflowValue = primarySelected ? "" : dim;

  return (
    <div
      className="pc-metrics"
      data-testid="screen-metrics"
      data-screen="metrics"
      data-dim={dim}
      data-session={session}
    >
      <div className="pc-metrics__toolbar">
        <span className="pc-metrics__title">metrics</span>
        <span className="pc-metrics__group-label">group by</span>

        <div
          className="pc-metrics__tabs"
          role="tablist"
          aria-label="Group-by dimension"
          data-testid="metrics-dim-tabs"
        >
          {PRIMARY_DIMS.map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              className="pc-metrics__tab"
              aria-selected={dim === d}
              onClick={() => setDim(d)}
              data-testid={`metrics-dim-${d}`}
            >
              {DIM_LABELS[d]}
            </button>
          ))}
        </div>
        <Select
          label="more"
          layout="inline"
          className="pc-metrics__scope"
          value={overflowValue}
          onChange={(v) => {
            if (v) setDim(v as MetricsDim);
          }}
          testId="metrics-dim-more"
          aria-label="Additional group-by dimensions"
        >
          <option value="">…</option>
          {OVERFLOW_DIMS.map((d) => (
            <option key={d} value={d}>
              {DIM_LABELS[d]}
            </option>
          ))}
        </Select>

        {/* Session = scope filter, not a group_by tab (#344) */}
        <div className="pc-metrics__scope" data-testid="metrics-session-scope">
          <Select
            label="session"
            layout="inline"
            value={session}
            onChange={setSession}
            testId="metrics-session-select"
            aria-label="Session scope filter"
          >
            <option value="all">all sessions</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </Select>
        </div>

        <div className="pc-metrics__view-switch" role="group" aria-label="Metrics view">
          <button
            type="button"
            className="pc-metrics__view-btn"
            aria-pressed={view === "overview"}
            onClick={() => setView("overview")}
            data-testid="metrics-view-overview"
          >
            overview
          </button>
          <button
            type="button"
            className="pc-metrics__view-btn"
            aria-pressed={view === "comparison"}
            onClick={() => setView("comparison")}
            data-testid="metrics-view-comparison"
          >
            comparison
          </button>
        </div>

        <span className="pc-metrics__meta" title={meta} data-testid="metrics-meta">
          {meta}
        </span>
      </div>

      <div className="pc-metrics__body">
        <FilterBar
          dim={dim}
          filters={filters}
          onChange={setFilters}
          onClear={() => setFilters(clearFilters())}
        />

        {hasStaleData && status === "error" && error ? (
          <ErrorBanner message={`${error} — last good groups still shown.`} />
        ) : null}
        {hasStaleData && status === "loading" ? <StaleBanner /> : null}
        {status === "error" && rows.length === 0 && error ? (
          <ErrorBanner message={error} />
        ) : null}

        {view === "overview" ? (
          <>
            <GroupTable
              rows={rows}
              dimLabel={DIM_LABELS[dim]}
              workflow={workflow}
              status={tableStatus}
              error={error}
              filterActive={filterOn}
            />

            <div className="pc-metrics__charts">
              <ScoreDistribution
                bars={distribution}
                status={chartStatus}
                error={error}
                filterActive={filterOn}
              />
              <CriterionHeatmap
                model={heatmap}
                status={chartStatus}
                error={error}
                filterActive={filterOn}
              />
            </div>

            <Buckets bySize={sizeBuckets} byDifficulty={diffBuckets} />
          </>
        ) : (
          <ComparisonPanel
            model={comparison}
            status={chartStatus}
            error={error}
            filterActive={filterOn}
          />
        )}
      </div>
    </div>
  );
}
