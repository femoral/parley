import { useEffect, useState } from "react";
import type { ParleyClient } from "@useparley/core";

/** Raw daemon health, as probed (uptime is derived in {@link useCockpit}). */
export interface HealthState {
  online: boolean;
  version: string | null;
  pid: number | null;
  /** Epoch ms of daemon start (from `/health` `started_at`), or null. */
  startedAt: number | null;
}

const INITIAL: HealthState = { online: false, version: null, pid: null, startedAt: null };

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

    const poll = async (): Promise<void> => {
      try {
        const health = await client.health();
        if (cancelled) return;
        const startedAt = Date.parse(health.started_at);
        setState({
          online: true,
          version: health.version,
          pid: health.pid,
          startedAt: Number.isNaN(startedAt) ? null : startedAt,
        });
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, online: false }));
      }
      if (!cancelled) timer = setTimeout(() => void poll(), pollMs);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, pollMs]);

  return state;
}
