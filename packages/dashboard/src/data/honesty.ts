/**
 * Connection honesty state machine — first-class phases the console screens
 * will render (coverage audit: loading/connecting, offline, stale-reconnecting,
 * per-panel error, empty).
 */
import { useEffect, useMemo, useState } from "react";
import type { HonestyPhase, HonestyState } from "./types.js";

/**
 * How long stream and/or health must stay bad before promoting to
 * stale-reconnecting. A single SSE hiccup must not flash the band.
 */
export const STALE_DEBOUNCE_MS = 4000;

export interface HonestyInputs {
  /** Latched after first successful task snapshot. */
  ready: boolean;
  streamConnected: boolean;
  healthOnline: boolean;
  /** Epoch ms when stream last dropped; null while connected. */
  streamLostSince: number | null;
  /** Number of tasks in the live snapshot (for empty vs live). */
  taskCount: number;
  /** Optional per-panel error (metrics, log tail, …). */
  panelError?: string | null;
  /** Debounced stale flag from {@link useStaleFlag}. */
  stale: boolean;
}

/**
 * Pure phase derivation from transport + panel signals.
 * Priority: offline (never ready + unreachable) → loading → connecting →
 * stale-reconnecting → panel-error → empty → live.
 */
export function deriveHonestyPhase(input: HonestyInputs): HonestyPhase {
  const {
    ready,
    streamConnected,
    healthOnline,
    taskCount,
    panelError = null,
    stale,
  } = input;

  const transportOk = streamConnected && healthOnline;

  if (!ready) {
    // Never successfully bootstrapped.
    if (!streamConnected && !healthOnline) {
      // Still the first probe vs confirmed offline: treat initial as loading,
      // offline only once both have had a chance and failed (stale flag or
      // explicit lost-since).
      if (stale || input.streamLostSince !== null) return "offline";
      return "loading";
    }
    return "connecting";
  }

  // Had a good snapshot at least once.
  if (stale || !transportOk) {
    return "stale-reconnecting";
  }

  if (panelError) return "panel-error";
  if (taskCount === 0) return "empty";
  return "live";
}

export function projectHonesty(input: HonestyInputs): HonestyState {
  return {
    phase: deriveHonestyPhase(input),
    streamConnected: input.streamConnected,
    healthOnline: input.healthOnline,
    stale: input.stale,
    streamLostSince: input.streamLostSince,
    ready: input.ready,
    panelError: input.panelError ?? null,
  };
}

/**
 * Debounced staleness: true when stream is down or health is offline, only
 * after {@link STALE_DEBOUNCE_MS} of continuous failure. Clears immediately
 * when both recover.
 */
export function useStaleFlag(
  streamConnected: boolean,
  healthOnline: boolean,
  debounceMs: number = STALE_DEBOUNCE_MS,
): boolean {
  const rawStale = !streamConnected || !healthOnline;
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!rawStale) {
      setStale(false);
      return;
    }
    const id = setTimeout(() => setStale(true), debounceMs);
    return () => clearTimeout(id);
  }, [rawStale, debounceMs]);

  return stale;
}

/**
 * Compose honesty from snapshot + health (+ optional panel error).
 * Screens pass the live signals; this hook owns debounce + phase derivation.
 */
export function useHonesty(options: {
  ready: boolean;
  streamConnected: boolean;
  healthOnline: boolean;
  streamLostSince: number | null;
  taskCount: number;
  panelError?: string | null;
  staleDebounceMs?: number;
}): HonestyState {
  const stale = useStaleFlag(
    options.streamConnected,
    options.healthOnline,
    options.staleDebounceMs ?? STALE_DEBOUNCE_MS,
  );

  return useMemo(
    () =>
      projectHonesty({
        ready: options.ready,
        streamConnected: options.streamConnected,
        healthOnline: options.healthOnline,
        streamLostSince: options.streamLostSince,
        taskCount: options.taskCount,
        panelError: options.panelError ?? null,
        stale,
      }),
    [
      options.ready,
      options.streamConnected,
      options.healthOnline,
      options.streamLostSince,
      options.taskCount,
      options.panelError,
      stale,
    ],
  );
}
