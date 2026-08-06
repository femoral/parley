/**
 * Run-tasks panel data:
 * - `GET /runs/:ref/nodes/:node` for per-node rows
 * - client-side `run_id` filter over the live snapshot for the whole-run list
 *
 * Fetch effect is gated on runRef/node/query only — NOT snapshotTasks identity.
 * useSnapshot flush() allocates a new array every rAF; depending on it re-issued
 * GET /runs/:ref/nodes/:node up to ~60 req/s on a busy fleet (HIGH-1).
 */
import { useEffect, useMemo, useState } from "react";
import type { NodeDetailResponse, ParleyClient, TaskEnvelope } from "@useparley/core";
import { fetchNodeDetail, type NodeDetailQuery } from "./clientExtras.js";
import { filterTasksByRunId } from "./projections/runTasks.js";
import type { NodeTasksView, PanelStatus } from "./types.js";

export function useNodeTasks(
  client: ParleyClient,
  options: {
    runRef: string | null;
    node: string | null;
    query?: NodeDetailQuery;
    /** Live snapshot envelopes (from useSnapshot) for client-side run filter. */
    snapshotTasks: readonly TaskEnvelope[];
    enabled?: boolean;
  },
): NodeTasksView {
  const { runRef, node, query, snapshotTasks, enabled = true } = options;
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [data, setData] = useState<NodeDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryKey = JSON.stringify(query ?? {});

  // Client-side filter only — must recompute when snapshot identity changes,
  // but must NOT trigger the network effect below.
  const runTasks = useMemo(
    () => filterTasksByRunId(snapshotTasks, runRef),
    [snapshotTasks, runRef],
  );

  useEffect(() => {
    if (!enabled || !runRef || !node) {
      setStatus("idle");
      setData(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus((prev) => (prev === "ready" || prev === "empty" ? prev : "loading"));
    setError(null);

    const parsed = JSON.parse(queryKey) as NodeDetailQuery;
    void fetchNodeDetail(client, runRef, node, parsed)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setStatus(next.tasks.length === 0 ? "empty" : "ready");
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "node detail failed");
      });

    return () => {
      cancelled = true;
    };
    // Intentionally omit snapshotTasks — see file header (HIGH-1).
  }, [client, runRef, node, queryKey, enabled]);

  return useMemo(
    () => ({
      status,
      data,
      runTasks,
      error,
    }),
    [status, data, runTasks, error],
  );
}
