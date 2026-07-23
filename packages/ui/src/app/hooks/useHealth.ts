import { useEffect, useState } from "react";
import type { ParleyClient } from "@useparley/core";

/** Raw daemon health, as probed (uptime is derived in {@link useCockpit}). */
export type HealthStatus = "connecting" | "online" | "offline";

export interface HealthState {
  /** Probe lifecycle; connecting is reserved for the unresolved first probe. */
  status: HealthStatus;
  online: boolean;
  version: string | null;
  pid: number | null;
  /** Epoch ms of daemon start (from `/health` `started_at`), or null. */
  startedAt: number | null;
}

const INITIAL: HealthState = {
  status: "connecting",
  online: false,
  version: null,
  pid: null,
  startedAt: null,
};

/**
 * Layer 4 (hooks) — poll `GET /health` and expose liveness + version + pid +
 * start time. The only place, alongside {@link useSnapshot}, that touches the
 * core SDK (contract 4). A failed probe flips `online` false but keeps the last
 * known version/pid so the panel doesn't flicker to blanks between beats.
 */
export function useHealth(client: ParleyClient, pollMs = 5000): HealthState {
  const [state, setState] = useState<HealthState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Gate on visibility like useVisibleClock/useLogTail: a hidden tab issues
    // no probes all night; returning re-probes immediately so the panel is
    // honest again within one beat instead of a stale poll interval.
    const hidden = (): boolean => typeof document !== "undefined" && document.hidden;

    const poll = async (): Promise<void> => {
      try {
        const health = await client.health();
        if (cancelled) return;
        const startedAt = Date.parse(health.started_at);
        setState({
          status: "online",
          online: true,
          version: health.version,
          pid: health.pid,
          startedAt: Number.isNaN(startedAt) ? null : startedAt,
        });
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, status: "offline", online: false }));
      }
      if (!cancelled && !hidden()) timer = setTimeout(() => void poll(), pollMs);
    };

    const onVisibility = (): void => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!hidden()) void poll();
    };

    void poll();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [client, pollMs]);

  return state;
}
