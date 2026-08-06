/**
 * Poll `GET /runners` for the registered runner fleet.
 */
import { useEffect, useState } from "react";
import type { ParleyClient } from "@useparley/core";
import { fetchRunnersList } from "./clientExtras.js";
import type { RunnersView } from "./types.js";

const INITIAL: RunnersView = {
  status: "connecting",
  runners: [],
};

export function useRunners(client: ParleyClient, pollMs = 5000): RunnersView {
  const [state, setState] = useState<RunnersView>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = (): boolean => typeof document !== "undefined" && document.hidden;

    const poll = async (): Promise<void> => {
      try {
        const runners = await fetchRunnersList(client);
        if (cancelled) return;
        setState({ status: "online", runners });
      } catch {
        if (!cancelled) {
          setState((prev) => ({ ...prev, status: "offline" }));
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
