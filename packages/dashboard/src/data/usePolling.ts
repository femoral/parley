/**
 * Shared interval + document.visibility gating (#367).
 * Nothing polls while the tab is hidden; a visibilitychange to visible
 * resumes immediately. Chain-after-tick pattern from useHealth / useRunners.
 */
import { useEffect, useRef } from "react";

export function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

export interface UsePollingOptions {
  /** Delay before the next tick after the previous finishes (ms). */
  intervalMs: number;
  /** When false, no timers and no immediate tick. Default true. */
  enabled?: boolean;
  /**
   * Fire once immediately on mount / when enabled becomes true.
   * Default true (matches health/runners cadence).
   */
  immediate?: boolean;
}

/**
 * Call `tick` in a setTimeout chain while the document is visible.
 * The next schedule is after `tick` settles (awaited if it returns a promise).
 */
export function usePolling(
  tick: () => void | Promise<void>,
  options: UsePollingOptions,
): void {
  const { intervalMs, enabled = true, immediate = true } = options;
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        await tickRef.current();
      } finally {
        if (!cancelled && !isDocumentHidden()) {
          timer = setTimeout(() => void poll(), intervalMs);
        }
      }
    };

    const onVisibility = (): void => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!isDocumentHidden()) void poll();
    };

    if (immediate) void poll();
    else if (!isDocumentHidden()) {
      timer = setTimeout(() => void poll(), intervalMs);
    }

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
  }, [intervalMs, enabled, immediate]);
}
