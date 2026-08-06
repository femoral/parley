/**
 * Fetch `GET /metrics` for the metrics screen. Refreshes on session/groupBy/
 * filters/refreshKey changes — not a fixed poll.
 */
import { useEffect, useState } from "react";
import {
  type MetricsGroupBy,
  type ParleyClient,
  type TaskMetricsFilters,
} from "@useparley/core";
import type { MetricsView, PanelStatus } from "./types.js";

const INITIAL: MetricsView = {
  status: "idle",
  data: null,
  error: null,
};

const NO_FILTERS: TaskMetricsFilters = {};

export interface UseMetricsOptions {
  session: string;
  groupBy: MetricsGroupBy;
  refreshKey: string;
  enabled?: boolean;
  filters?: TaskMetricsFilters;
}

export function useMetrics(client: ParleyClient, options: UseMetricsOptions): MetricsView {
  const { session, groupBy, refreshKey, enabled = true, filters = NO_FILTERS } = options;
  const [state, setState] = useState<MetricsView>(INITIAL);
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

    const parsed = JSON.parse(filtersKey) as TaskMetricsFilters;

    void client
      .metrics({ ...parsed, session, groupBy })
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
