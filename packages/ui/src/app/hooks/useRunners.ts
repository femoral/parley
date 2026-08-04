import { useEffect, useState } from "react";
import type { ParleyClient, RunnerListEntry, RunnersListResponse } from "@useparley/core";

/** Raw fleet from `GET /runners`, as polled. */
export interface RunnersState {
  /**
   * Probe lifecycle. `connecting` only until the first poll settles (success
   * or failure); thereafter `online`/`offline` track the last probe.
   */
  status: "connecting" | "online" | "offline";
  /** Registered runners (last successful body). Empty when never reached. */
  runners: RunnerListEntry[];
}

const INITIAL: RunnersState = {
  status: "connecting",
  runners: [],
};

/**
 * Fetch `GET /runners` via the client's base URL. ParleyClient has no
 * `listRunners` yet (#324 UI-only), so this is the thin same-origin call the
 * CLI makes through `daemonGet`. Tests inject `fetch` on ParleyClient options
 * by mocking global fetch against `client.url("/runners")`.
 */
export async function fetchRunnersList(client: ParleyClient): Promise<RunnerListEntry[]> {
  const res = await fetch(client.url("/runners"));
  if (!res.ok) {
    throw new Error(`GET /runners failed with status ${res.status}`);
  }
  const body = (await res.json()) as RunnersListResponse;
  return body.runners ?? [];
}

/**
 * Layer 4 (hooks) — poll `GET /runners` for the registered runner fleet (#324).
 * Mirrors {@link useHealth}: visibility-gated, keeps last-known runners on
 * failure so the panel does not blank between beats. The daemon card is
 * projected separately (always present) from health + task in-flight counts.
 */
export function useRunners(client: ParleyClient, pollMs = 5000): RunnersState {
  const [state, setState] = useState<RunnersState>(INITIAL);

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
          setState((prev) => ({
            ...prev,
            status: prev.status === "connecting" ? "offline" : "offline",
          }));
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
