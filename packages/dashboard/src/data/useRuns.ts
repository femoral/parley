/**
 * Poll `GET /runs`; fetch `GET /runs/:ref` for the selected run only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParleyClient, RunDetailResponse, RunSummary } from "@useparley/core";
import type { RunsView, TransportStatus } from "./types.js";
import { usePolling } from "./usePolling.js";

const DEFAULT_POLL_MS = 3000;
const EMPTY_DETAILS: ReadonlyMap<string, RunDetailResponse> = new Map();

export function useRuns(
  client: ParleyClient,
  options: {
    selectedRunId?: string | null;
    pollMs?: number;
    enabled?: boolean;
  } = {},
): RunsView {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const enabled = options.enabled !== false;
  const selectedRunId = options.selectedRunId ?? null;

  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [details, setDetails] = useState<Map<string, RunDetailResponse>>(() => new Map());
  const [status, setStatus] = useState<TransportStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const selectedRef = useRef(selectedRunId);
  selectedRef.current = selectedRunId;

  const tick = useCallback(async (): Promise<void> => {
    const selected = selectedRef.current;
    try {
      const list = await client.listRuns();
      setSummaries(list.runs);
      setStatus("online");
      setError(null);

      if (selected) {
        const prior = detailsRef.current;
        try {
          const detail = await client.getRun(selected);
          setDetails(new Map([[selected, detail]]));
        } catch (err) {
          const kept = prior.get(selected);
          setDetails(kept ? new Map([[selected, kept]]) : new Map());
          setError(err instanceof Error ? err.message : "run detail failed");
        }
      } else {
        setDetails(new Map());
      }
    } catch (err) {
      const httpStatus =
        err &&
        typeof err === "object" &&
        "status" in err &&
        typeof (err as { status: unknown }).status === "number"
          ? (err as { status: number }).status
          : null;
      if (httpStatus != null && httpStatus >= 400) {
        setStatus("online");
      } else {
        setStatus("offline");
      }
      setError(err instanceof Error ? err.message : "runs list failed");
    }
  }, [client]);

  usePolling(tick, { intervalMs: pollMs, enabled });

  // When selection changes, fetch detail promptly without waiting for the next poll.
  useEffect(() => {
    if (!enabled || !selectedRunId) return;
    let cancelled = false;
    void client
      .getRun(selectedRunId)
      .then((detail) => {
        if (!cancelled) setDetails(new Map([[selectedRunId, detail]]));
      })
      .catch(() => {
        /* next poll will surface error */
      });
    return () => {
      cancelled = true;
    };
  }, [client, enabled, selectedRunId]);

  return useMemo(
    () => ({
      summaries,
      details: details.size === 0 ? EMPTY_DETAILS : details,
      status,
      error,
    }),
    [summaries, details, status, error],
  );
}
