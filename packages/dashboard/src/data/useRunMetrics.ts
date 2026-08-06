/**
 * Fetch `GET /run-metrics` — workflow-dimension metrics the console's
 * workflow tab consumes (wire-verification §2B; unused by Cove).
 */
import { useEffect, useState } from "react";
import {
  type ParleyClient,
  type RunMetricsFilters,
  type RunMetricsGroupBy,
} from "@useparley/core";
import type { PanelStatus, RunMetricsView } from "./types.js";

const INITIAL: RunMetricsView = {
  status: "idle",
  data: null,
  error: null,
};

const NO_FILTERS: RunMetricsFilters = {};

export interface UseRunMetricsOptions {
  session?: string;
  groupBy?: RunMetricsGroupBy;
  refreshKey: string;
  enabled?: boolean;
  filters?: RunMetricsFilters;
}

export function useRunMetrics(
  client: ParleyClient,
  options: UseRunMetricsOptions,
): RunMetricsView {
  const {
    session = "all",
    groupBy = "workflow",
    refreshKey,
    enabled = true,
    filters = NO_FILTERS,
  } = options;
  const [state, setState] = useState<RunMetricsView>(INITIAL);
  const filtersKey = JSON.stringify(filters);

  useEffect(() => {
    if (!enabled) {
      setState((prev) =>
        prev.status === "idle" && prev.data === null ? prev : { ...INITIAL },
      );
      return;
    }

    let cancelled = false;
    setState((prev) => ({
      ...prev,
      status: (prev.data === null
        ? "loading"
        : prev.status === "error"
          ? "loading"
          : prev.status) as PanelStatus,
      error: null,
    }));

    const parsed = JSON.parse(filtersKey) as RunMetricsFilters;

    void client
      .runMetrics({ ...parsed, session, groupBy })
      .then((data) => {
        if (cancelled) return;
        setState({
          status: data.groups.length === 0 ? "empty" : "ready",
          data,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Could not reach the daemon.";
        setState((prev) => ({
          status: "error",
          data: prev.data,
          error: message,
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [client, session, groupBy, refreshKey, enabled, filtersKey]);

  return state;
}
