/**
 * Cancelled-island death choreography (#187).
 *
 * A task that mounts already-cancelled must render the settled aftermath
 * (sunk island, no sloop). Sink + sailoff play only on a live transition into
 * cancelled while the island is mounted. After the sailoff fade completes the
 * sloop unmounts so canvas foam cannot linger forever.
 */

/** Matches the sailing driver's sailoff fade: `ease(elapsed / 2.4)`. */
export const SAILOFF_MS = 2400;

/** Matches the CSS sink keyframe duration on `.pc-island[data-state="cancelled"]`. */
export const SINK_MS = 2200;

/**
 * Death presentation for a cancelled island.
 * - `live`: play sink + sailoff once (in-session cancellation).
 * - `settled`: end state only — no replay on remount / after fade.
 */
export type CancelDeathPhase = "live" | "settled";

/**
 * Decide whether a cancelled island should choreograph or rest.
 *
 * Non-cancelled states return `null` (no death attribute / no special path).
 */
export function cancelDeathPhase(input: {
  state: string;
  /** True when the island's first mount state was already `cancelled`. */
  mountedAsCancelled: boolean;
  /** True after the live sailoff fade has finished (or reduced-motion skip). */
  sailoffComplete: boolean;
}): CancelDeathPhase | null {
  if (input.state !== "cancelled") return null;
  if (input.mountedAsCancelled || input.sailoffComplete) return "settled";
  return "live";
}

/**
 * States where a sloop is present at the island.
 * Settled cancelled has no ship (aftermath). Live cancelled keeps the ship for
 * the sailoff voyage. `completed` / `failed` / `pending` hide the ship.
 */
export function hasShip(state: string, deathPhase: CancelDeathPhase | null): boolean {
  if (state === "cancelled") return deathPhase === "live";
  return state === "running" || state === "awaiting_answer" || state === "stalled";
}

/**
 * How long to keep the sailoff sloop mounted after a live cancel.
 * Reduced motion jumps to the settled end state immediately.
 */
export function sailoffHoldMs(reducedMotion: boolean): number {
  return reducedMotion ? 0 : SAILOFF_MS;
}

/**
 * Canvas ship effects (hull foam, waterline block) must not paint for ships
 * that have fully faded out — DOM presence alone is not enough (#187).
 */
export function shipEffectsOpacity(styleOpacity: string): number {
  if (styleOpacity === "") return 1;
  const value = Number.parseFloat(styleOpacity);
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

/** True when foam / cover-block painting should run for this ship. */
export function shouldPaintShipEffects(styleOpacity: string): boolean {
  return shipEffectsOpacity(styleOpacity) > 0.02;
}
