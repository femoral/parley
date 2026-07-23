/**
 * Bounds-aware region zoom + content framing (#201 / scene composition).
 *
 * The historical target is count-only: `min(1, sqrt(5/N))`, the exact reciprocal
 * of SessionRegion's layout spread. That keeps berth spacing count-invariant but
 * never fits the placed fleet to the camera viewport.
 *
 * This module computes a fit target from the padded bounding box of spread-scaled
 * island centres. Padding covers each island's half-extent, the name plank below,
 * and the sloop orbit ellipse (radius horizontally, radius×squish vertically),
 * including the draft lift that shifts the orbit center.
 *
 * Framing rule: the camera / region scale should centre on the padded content
 * centroid (not the region origin), with headroom reserved for the scene's top
 * overlay. Otherwise a northern-heavy lattice is clipped even when zoom "fits"
 * the box dimensions (origin ≠ centroid).
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

/**
 * Orbit constants — mirror SailingScene ORBIT (gap + squish only).
 * gapPx is deliberately tight so a sloop at common lattice pitch does not
 * rake a neighbour's name plank (see `orbitRadiusForNearest`).
 */
export const ORBIT_FIT = { gapPx: 28, squish: 0.4 } as const;

/**
 * Name-plank extent below the island centre (half-height + hung plank).
 * `.pc-plank` sits at `bottom: -6px` with ~16px body.
 */
export const PLANK_EXTENT_BELOW = ISLAND_LAYOUT.height / 2 + 22;

/**
 * Horizontal clearance from island centre to the far edge of a neighbour's
 * plank — used when clamping orbit radius against nearest-neighbour distance.
 */
export const PLANK_CLEARANCE = ISLAND_SPRITE_WIDTH / 2 + 8;

/**
 * Viewport pixels reserved at the top of the scene when fitting / framing
 * (cartouche / head chrome sits above the sea; content must not kiss the edge).
 */
export const TOP_OVERLAY_HEADROOM_PX = 48;

/**
 * Viewport pixels reserved on each horizontal edge for edge-of-frame session
 * chips (`.pc-edge-alerts`). Chips stay z-on-top for navigation; framing must
 * keep islands + name planks out of those gutters at typical widths.
 * ~chip max width (label 11ch + glyph + count + pad) + 10px inset.
 */
export const EDGE_CHIP_GUTTER_PX = 168;

/**
 * Viewport pixels reserved at the bottom of the scene so a southern island
 * sprite + plank is not clipped mid-body at the scene boundary (stacked 900px).
 */
export const BOTTOM_SCENE_MARGIN_PX = 36;

/** Floor on per-island orbit radius so a tight pack still reads as sailing. */
export const ORBIT_RADIUS_MIN = 78;

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

export interface ContentBounds {
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Centre of the padded box — the default framing target. */
  cx: number;
  cy: number;
}

/**
 * Sloop orbit radius in region-local units — same formula as
 * `localIslandGeometry`: gapPx + half sprite width / scale.
 */
export function sloopOrbitRadius(): number {
  const scale = ISLAND_LAYOUT.width / ISLAND_ROOT_WIDTH;
  return ORBIT_FIT.gapPx + ISLAND_SPRITE_WIDTH / (2 * scale);
}

/**
 * Clamp a base orbit radius so the far leg stays clear of a neighbour's plank
 * at the given centre distance. No full collision solver — nearest neighbour
 * only, which cleans up the common lattice densities.
 */
export function orbitRadiusForNearest(
  nearestCentreDist: number,
  baseRadius: number = sloopOrbitRadius(),
): number {
  if (!Number.isFinite(nearestCentreDist) || nearestCentreDist <= 0) {
    return baseRadius;
  }
  const maxClear = nearestCentreDist - PLANK_CLEARANCE;
  return Math.max(ORBIT_RADIUS_MIN, Math.min(baseRadius, maxClear));
}

/** Upward lift (px) applied to the orbit center; reduced vs historical full draft. */
export function sloopOrbitDraftLift(): number {
  return (
    SLOOP_LIFT.width * SLOOP_LIFT.aspect * SLOOP_LIFT.draftFy * ORBIT_DRAFT_LIFT_FACTOR
  );
}

/**
 * Padded axis-aligned box of all island centres (spread-scaled, region-local).
 * Includes island body, hung name plank, and sloop orbit ellipse.
 * Returns null when there are no centres to fit.
 */
export function paddedIslandBounds(centres: readonly Point[]): ContentBounds | null {
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
    // Hung name plank below the island body
    maxY = Math.max(maxY, c.y + PLANK_EXTENT_BELOW);
    // Orbit ellipse: center is lifted above the island centre by `lift`
    // (negative y). Reducing ORBIT_DRAFT_LIFT_FACTOR lowers this center and
    // shifts the padded vertical extent accordingly.
    const orbitCy = c.y - lift;
    minY = Math.min(minY, orbitCy - orbitHalfY);
    maxY = Math.max(maxY, orbitCy + orbitHalfY);
  }

  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  return {
    width,
    height,
    minX,
    maxX,
    minY,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

/**
 * Region-local framing point for the content centroid, biased north so the
 * visual mass sits slightly below viewport centre and leaves top headroom.
 * Bottom margin is mirrored so southern islands are not clipped at the scene
 * edge; horizontal chip gutters are symmetric so no lateral bias is needed.
 *
 * The region transform applies `scale(z) translate(-fx, -fy)` so this point
 * lands on the camera target (region world origin).
 */
export function contentFrameOffset(
  centres: readonly Point[],
  zoom: number,
  topHeadroomPx: number = TOP_OVERLAY_HEADROOM_PX,
  bottomMarginPx: number = BOTTOM_SCENE_MARGIN_PX,
): Point {
  const box = paddedIslandBounds(centres);
  if (!box) return { x: 0, y: 0 };
  const z = zoom > 0 ? zoom : 1;
  // Net vertical chrome: more top reserve → bias north (content sits lower).
  const netHeadroom = topHeadroomPx - bottomMarginPx;
  const headroomBias = netHeadroom / (2 * z);
  return { x: box.cx, y: box.cy - headroomBias };
}

/** Count-only zoom target (historical behaviour; also the fit ceiling). */
export function countZoomTarget(islandCount: number): number {
  return islandCount > 0 ? Math.min(1, Math.sqrt(5 / islandCount)) : 1;
}

/**
 * Combined zoom target: min of count-based target and viewport fit, clamped to
 * [REGION_ZOOM_MIN, 1]. Small fleets whose padded box already fits keep 1.
 * Usable size subtracts top-overlay headroom, bottom margin, and edge-chip
 * gutters so fit does not pack content under chrome or navigation chips.
 */
export function computeRegionZoomTarget(input: {
  islandCount: number;
  centres: readonly Point[];
  viewportW: number;
  viewportH: number;
  topHeadroomPx?: number;
  bottomMarginPx?: number;
  edgeChipGutterPx?: number;
}): number {
  const countTarget = countZoomTarget(input.islandCount);
  if (input.centres.length === 0 || input.viewportW <= 0 || input.viewportH <= 0) {
    return countTarget;
  }

  const box = paddedIslandBounds(input.centres);
  if (!box) return countTarget;

  const headroom = input.topHeadroomPx ?? TOP_OVERLAY_HEADROOM_PX;
  const bottom = input.bottomMarginPx ?? BOTTOM_SCENE_MARGIN_PX;
  const sideGutter = input.edgeChipGutterPx ?? EDGE_CHIP_GUTTER_PX;
  const usableW = Math.max(1, input.viewportW - 2 * sideGutter);
  const usableH = Math.max(1, input.viewportH - headroom - bottom);
  const fit = Math.min(usableW / box.width, usableH / box.height);
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

/**
 * Nearest sibling island centre distance (region-local) for an island slot.
 * Returns Infinity when the island is alone.
 */
export function nearestIslandDistance(
  region: HTMLElement,
  slot: HTMLElement,
): number {
  const x = Number.parseFloat(slot.dataset.x ?? "");
  const y = Number.parseFloat(slot.dataset.y ?? "");
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;

  let best = Infinity;
  for (const other of region.querySelectorAll<HTMLElement>(".pc-island-slot")) {
    if (other === slot) continue;
    const ox = Number.parseFloat(other.dataset.x ?? "");
    const oy = Number.parseFloat(other.dataset.y ?? "");
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) continue;
    const d = Math.hypot(x - ox, y - oy);
    if (d < best) best = d;
  }
  return best;
}
