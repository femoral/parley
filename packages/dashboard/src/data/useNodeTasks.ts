/**
 * Run-tasks panel data:
 * - `GET /runs/:ref/nodes/:node` for per-node rows
 * - client-side `run_id` filter over the live snapshot for the whole-run list
 */
import { useEffect, useMemo, useState } from "react";
import type { ParleyClient, TaskEnvelope } from "@useparley/core";
import { fetchNodeDetail, type NodeDetailQuery } from "./clientExtras.js";
import { filterTasksByRunId } from "./projections/runTasks.js";
import type { NodeTasksView } from "./types.js";

const INITIAL: NodeTasksView = {
  status: "idle",
  data: null,
  runTasks: [],
  error: null,
};

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
  const [state, setState] = useState<NodeTasksView>(INITIAL);
  const queryKey = JSON.stringify(query ?? {});

  const runTasks = useMemo(
    () => filterTasksByRunId(snapshotTasks, runRef),
    [snapshotTasks, runRef],
  );

  useEffect(() => {
    if (!enabled || !runRef || !node) {
      setState((prev) => ({
        ...INITIAL,
        runTasks: filterTasksByRunId(snapshotTasks, runRef),
        status: !runRef || !node ? "idle" : prev.status,
      }));
      return;
    }

    let cancelled = false;
    setState((prev) => ({
      ...prev,
      status: prev.data === null ? "loading" : prev.status,
      error: null,
      runTasks: filterTasksByRunId(snapshotTasks, runRef),
    }));

    const parsed = JSON.parse(queryKey) as NodeDetailQuery;
    void fetchNodeDetail(client, runRef, node, parsed)
      .then((data) => {
        if (cancelled) return;
        setState({
          status: data.tasks.length === 0 ? "empty" : "ready",
          data,
          runTasks: filterTasksByRunId(snapshotTasks, runRef),
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((prev) => ({
          status: "error",
          data: prev.data,
          runTasks: filterTasksByRunId(snapshotTasks, runRef),
          error: err instanceof Error ? err.message : "node detail failed",
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [client, runRef, node, queryKey, enabled, snapshotTasks]);

  // Keep runTasks fresh when only the snapshot changes.
  return useMemo(
    () => ({
      ...state,
      runTasks,
    }),
    [state, runTasks],
  );
}
