/**
 * Poll `GET /runners` for the registered runner fleet.
 */
import { useCallback, useState } from "react";
import type { ParleyClient } from "@useparley/core";
import { fetchRunnersList } from "./clientExtras.js";
import type { RunnersView } from "./types.js";
import { usePolling } from "./usePolling.js";

const INITIAL: RunnersView = {
  status: "connecting",
  runners: [],
};

export function useRunners(client: ParleyClient, pollMs = 5000): RunnersView {
  const [state, setState] = useState<RunnersView>(INITIAL);

  const tick = useCallback(async (): Promise<void> => {
    try {
      const runners = await fetchRunnersList(client);
      setState({ status: "online", runners });
    } catch {
      setState((prev) => ({ ...prev, status: "offline" }));
    }
  }, [client]);

  usePolling(tick, { intervalMs: pollMs });

  return state;
}
