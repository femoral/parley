/**
 * Bounds-aware region zoom (#201).
 *
 * The historical target is count-only: `min(1, sqrt(5/N))`, the exact reciprocal
 * of SessionRegion's layout spread. That keeps berth spacing count-invariant but
 * never fits the placed fleet to the camera viewport.
 *
 * This module computes a fit target from the padded bounding box of spread-scaled
 * island centres. Padding covers each island's half-extent plus the sloop orbit
 * ellipse (radius horizontally, radius×squish vertically), including the draft
 * lift that shifts the orbit center.
 *
 * All measurements are in region-local CSS pixels — the same space that
 * `scale(var(--region-zoom))` shrinks. Island slot positions are already
 * multiplied by spread before this runs.
 */

/** Floor so dense fleets stay legible; documented choice for #201. */
export const REGION_ZOOM_MIN = 0.35;

/**
 * Multiplier on the sloop draft-offset that lifts the orbit ellipse center.
 * 1 = historical full lift; lower values seat the orbit slightly lower on the
 * island (~45% less lift at 0.55).
 */
export const ORBIT_DRAFT_LIFT_FACTOR = 0.55;

/** Matches `.pc-island` footprint in scene.css. */
export const ISLAND_LAYOUT = { width: 117, height: 107 } as const;

/** Matches `.pc-island__art` width — orbit radius uses half sprite width. */
export const ISLAND_SPRITE_WIDTH = 111;

/**
 * Design-unit root width used by the sailing driver's localIslandGeometry scale
 * (`rootRect.width / ISLAND_ROOT_WIDTH`). Kept in sync so orbit radius for fit
 * matches the radius used for motion.
 */
export const ISLAND_ROOT_WIDTH = 156;

/** Orbit constants — mirror SailingScene ORBIT (gap + squish only). */
export const ORBIT_FIT = { gapPx: 60, squish: 0.4 } as const;

/** Sloop calibration slice needed for draft lift (mirrors SHIPS.sloop). */
const SLOOP_LIFT = {
  width: 90,
  aspect: 539 / 640,
  draftFy: 0.48,
} as const;

export interface Point {
  x: number;
  y: number;
}

/**
 * Sloop orbit radius in region-local units — same formula as
 * `localIslandGeometry`: gapPx + half sprite width / scale.
 */
export function sloopOrbitRadius(): number {
  const scale = ISLAND_LAYOUT.width / ISLAND_ROOT_WIDTH;
  return ORBIT_FIT.gapPx + ISLAND_SPRITE_WIDTH / (2 * scale);
}

/** Upward lift (px) applied to the orbit center; reduced vs historical full draft. */
export function sloopOrbitDraftLift(): number {
  return (
    SLOOP_LIFT.width * SLOOP_LIFT.aspect * SLOOP_LIFT.draftFy * ORBIT_DRAFT_LIFT_FACTOR
  );
}

/**
 * Padded axis-aligned box of all island centres (spread-scaled, region-local).
 * Returns null when there are no centres to fit.
 */
export function paddedIslandBounds(centres: readonly Point[]): {
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} | null {
  if (centres.length === 0) return null;

  const radius = sloopOrbitRadius();
  const lift = sloopOrbitDraftLift();
  const halfW = ISLAND_LAYOUT.width / 2;
  const halfH = ISLAND_LAYOUT.height / 2;
  const padX = halfW + radius;
  const orbitHalfY = radius * ORBIT_FIT.squish;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const c of centres) {
    minX = Math.min(minX, c.x - padX);
    maxX = Math.max(maxX, c.x + padX);
    // Island body
    minY = Math.min(minY, c.y - halfH);
    maxY = Math.max(maxY, c.y + halfH);
    // Orbit ellipse: center is lifted above the island centre by `lift`
    // (negative y). Reducing ORBIT_DRAFT_LIFT_FACTOR lowers this center and
    // shifts the padded vertical extent accordingly.
    const orbitCy = c.y - lift;
    minY = Math.min(minY, orbitCy - orbitHalfY);
    maxY = Math.max(maxY, orbitCy + orbitHalfY);
  }

  return {
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
    minX,
    maxX,
    minY,
    maxY,
  };
}

/** Count-only zoom target (historical behaviour; also the fit ceiling). */
export function countZoomTarget(islandCount: number): number {
  return islandCount > 0 ? Math.min(1, Math.sqrt(5 / islandCount)) : 1;
}

/**
 * Combined zoom target: min of count-based target and viewport fit, clamped to
 * [REGION_ZOOM_MIN, 1]. Small fleets whose padded box already fits keep 1.
 */
export function computeRegionZoomTarget(input: {
  islandCount: number;
  centres: readonly Point[];
  viewportW: number;
  viewportH: number;
}): number {
  const countTarget = countZoomTarget(input.islandCount);
  if (input.centres.length === 0 || input.viewportW <= 0 || input.viewportH <= 0) {
    return countTarget;
  }

  const box = paddedIslandBounds(input.centres);
  if (!box) return countTarget;

  const fit = Math.min(input.viewportW / box.width, input.viewportH / box.height);
  // Never over-zoom (max 1); never ignore the count ceiling; floor at REGION_ZOOM_MIN.
  return Math.max(REGION_ZOOM_MIN, Math.min(1, countTarget, fit));
}

/** Read spread-scaled island centres from slot data attributes. */
export function readIslandCentres(region: HTMLElement): Point[] {
  const centres: Point[] = [];
  for (const slot of region.querySelectorAll<HTMLElement>(".pc-island-slot")) {
    const x = Number.parseFloat(slot.dataset.x ?? "");
    const y = Number.parseFloat(slot.dataset.y ?? "");
    if (Number.isFinite(x) && Number.isFinite(y)) centres.push({ x, y });
  }
  return centres;
}
