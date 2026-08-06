/**
 * Poll `GET /health` — liveness, version, pid, start time, sessions.
 */
import { useEffect, useState } from "react";
import type { ParleyClient } from "@useparley/core";
import type { HealthView } from "./types.js";

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

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = (): boolean => typeof document !== "undefined" && document.hidden;

    const poll = async (): Promise<void> => {
      try {
        const health = await client.health();
        if (cancelled) return;
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
        if (!cancelled) {
          setState((prev) => ({ ...prev, status: "offline", online: false, uptimeMs: null }));
        }
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
