/**
 * Poll `GET /runs`; fetch `GET /runs/:ref` for the selected run only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ParleyClient, RunDetailResponse, RunSummary } from "@useparley/core";
import type { RunsView, TransportStatus } from "./types.js";

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

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      try {
        const list = await client.listRuns();
        if (cancelled) return;
        setSummaries(list.runs);
        setStatus("online");
        setError(null);

        if (selectedRunId) {
          const prior = detailsRef.current;
          try {
            const detail = await client.getRun(selectedRunId);
            if (!cancelled) setDetails(new Map([[selectedRunId, detail]]));
          } catch (err) {
            const kept = prior.get(selectedRunId);
            if (!cancelled) {
              setDetails(kept ? new Map([[selectedRunId, kept]]) : new Map());
              setError(err instanceof Error ? err.message : "run detail failed");
            }
          }
        } else if (!cancelled) {
          setDetails(new Map());
        }
      } catch (err) {
        if (!cancelled) {
          // HTTP errors (daemon answered with 4xx/5xx) → online + error so the
          // screen can render panel-error. Network/unreachable → offline so
          // cold-load against a dead daemon shows "Daemon offline" (N3).
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
      }
      if (!cancelled) timer = setTimeout(() => void tick(), pollMs);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, enabled, pollMs, selectedRunId]);

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
