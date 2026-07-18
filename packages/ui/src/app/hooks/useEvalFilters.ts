/**
 * Layer 4 — React state for the shared eval filter bag (#165 / #166).
 * Pure transitions live in {@link ./evalFilters.js}; this hook only holds
 * state so multiple Soundings views can subscribe via the cockpit.
 */
import { useCallback, useMemo, useState } from "react";
import {
  emptyEvalFilters,
  evalFiltersToMetricsQuery,
  hasActiveEvalFilters,
  patchEvalFilters,
  type EvalFilterState,
} from "./evalFilters.js";

export interface UseEvalFiltersResult {
  filters: EvalFilterState;
  /** Replace any subset of fields. */
  setFilters: (patch: Partial<EvalFilterState>) => void;
  /** Reset to no constraints. */
  clearFilters: () => void;
  /** True when any text filter or toggle is on. */
  active: boolean;
  /** Wire fragment for `client.metrics` (no session/groupBy). */
  metricsQuery: ReturnType<typeof evalFiltersToMetricsQuery>;
}

/**
 * Own the composable eval filter state. Optional `initial` seeds from URL
 * parse or tests; defaults to empty (no constraints).
 */
export function useEvalFilters(initial?: EvalFilterState): UseEvalFiltersResult {
  const [filters, setState] = useState<EvalFilterState>(
    () => initial ?? emptyEvalFilters(),
  );

  const setFilters = useCallback((patch: Partial<EvalFilterState>) => {
    setState((prev) => patchEvalFilters(prev, patch));
  }, []);

  const clearFilters = useCallback(() => {
    setState(emptyEvalFilters());
  }, []);

  const active = useMemo(() => hasActiveEvalFilters(filters), [filters]);
  const metricsQuery = useMemo(() => evalFiltersToMetricsQuery(filters), [filters]);

  return { filters, setFilters, clearFilters, active, metricsQuery };
}
