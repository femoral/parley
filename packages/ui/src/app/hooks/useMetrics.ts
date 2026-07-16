/**
 * Layer 4 (hooks) — fetch `GET /metrics` for the Soundings dashboard (#119).
 * Refreshes when session/groupBy change and when the live task revision
 * advances (SSE transitions from {@link useSnapshot}), never by polling.
 */
import { useEffect, useState } from "react";
import {
  type MetricsGroupBy,
  type MetricsResponse,
  type ParleyClient,
} from "@useparley/core";

export type MetricsStatus = "idle" | "loading" | "ready" | "error";

export interface MetricsState {
  status: MetricsStatus;
  /** Last successful response; kept across soft reloads so the board does not flash empty. */
  data: MetricsResponse | null;
  /** Human-readable error when {@link status} is `"error"`. */
  error: string | null;
  /** Session query sent on the last (attempted) fetch (`all` or a session id). */
  session: string;
  /** Group-by dimension sent on the last (attempted) fetch. */
  groupBy: MetricsGroupBy;
}

const INITIAL: MetricsState = {
  status: "idle",
  data: null,
  error: null,
  session: "all",
  groupBy: "vendor",
};

export interface UseMetricsOptions {
  /** `"all"` or a concrete orchestrator session id. */
  session: string;
  groupBy: MetricsGroupBy;
  /**
   * Opaque revision from the live task stream. Any change triggers a refetch
   * (task state transitions, new tasks, etc.). Pass a stable empty string
   * when the Soundings view is not mounted to skip work.
   */
  refreshKey: string;
  /** When false, the hook stays idle and does not hit the network. */
  enabled?: boolean;
}

/**
 * Load metrics for the Soundings plate. Only the hooks layer may call
 * `client.metrics` (contract 4).
 */
export function useMetrics(client: ParleyClient, options: UseMetricsOptions): MetricsState {
  const { session, groupBy, refreshKey, enabled = true } = options;
  const [state, setState] = useState<MetricsState>(INITIAL);

  useEffect(() => {
    if (!enabled) {
      setState((prev) =>
        prev.status === "idle" && prev.data === null
          ? prev
          : { ...INITIAL },
      );
      return;
    }

    let cancelled = false;
    setState((prev) => ({
      ...prev,
      status: prev.data === null ? "loading" : prev.status === "error" ? "loading" : prev.status,
      session,
      groupBy,
      // Keep prior data visible while revalidating after SSE / control changes.
      error: null,
    }));

    void client
      .metrics({ session, groupBy })
      .then((data) => {
        if (cancelled) return;
        setState({
          status: "ready",
          data,
          error: null,
          session,
          groupBy,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Could not reach the daemon.";
        setState((prev) => ({
          status: "error",
          data: prev.data,
          error: message,
          session,
          groupBy,
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [client, session, groupBy, refreshKey, enabled]);

  return state;
}
