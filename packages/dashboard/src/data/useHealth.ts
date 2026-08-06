/**
 * Poll `GET /health` — liveness, version, pid, start time, sessions.
 */
import { useCallback, useState } from "react";
import type { ParleyClient } from "@useparley/core";
import type { HealthView } from "./types.js";
import { usePolling } from "./usePolling.js";

const INITIAL: HealthView = {
  status: "connecting",
  online: false,
  version: null,
  pid: null,
  startedAt: null,
  uptimeMs: null,
};

export function useHealth(client: ParleyClient, pollMs = 5000): HealthView {
  const [state, setState] = useState<HealthView>(INITIAL);

  const tick = useCallback(async (): Promise<void> => {
    try {
      const health = await client.health();
      const startedAt = Date.parse(health.started_at);
      const started = Number.isNaN(startedAt) ? null : startedAt;
      setState({
        status: "online",
        online: true,
        version: health.version ?? null,
        pid: typeof health.pid === "number" ? health.pid : null,
        startedAt: started,
        uptimeMs: started !== null ? Date.now() - started : null,
      });
    } catch {
      setState((prev) => ({ ...prev, status: "offline", online: false, uptimeMs: null }));
    }
  }, [client]);

  usePolling(tick, { intervalMs: pollMs });

  return state;
}
