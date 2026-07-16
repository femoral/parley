/**
 * Charted Waters art — pre-generated raster sprites and per-variant anchors.
 *
 * Islands are aged-chart cutouts (rock + palm + shallow-water skirt). A task
 * picks a variant once via a stable hash of its id, so the same island keeps
 * the same silhouette for its whole life. Peak anchors plant the completed
 * flag; wreck/flare/fog sit via CSS keyed on `data-variant`.
 *
 * Asset imports are Vite-resolved URLs — the only binary art the scene uses.
 */
import island1Url from "./assets/charted/island-1.png";
import island2Url from "./assets/charted/island-2.png";
import island3Url from "./assets/charted/island-3.png";
import galleonUrl from "./assets/charted/galleon.png";
import { fnv1a } from "./layout.js";

/** Peak of the rocky mound, in % of the sprite box (0–100). Flag pole base. */
export interface PeakAnchor {
  x: number;
  y: number;
}

export interface IslandVariant {
  /** 1-based id matching the asset filename (`island-N.png`). */
  id: 1 | 2 | 3;
  src: string;
  /** Rock apex — completed flag plants here. */
  peak: PeakAnchor;
}

/**
 * Three island silhouettes. Peak anchors were tuned against the sprites so the
 * pennant seats on stone, not air or palm fronds.
 *
 *  - v1: single palm right, mid rock  — peak slightly left of centre-top
 *  - v2: twin palms flanking a lower mound — peak mid, lower in frame
 *  - v3: tall central spire, palm right — peak high near frame top
 */
export const ISLAND_VARIANTS: readonly IslandVariant[] = [
  { id: 1, src: island1Url, peak: { x: 44, y: 10 } },
  { id: 2, src: island2Url, peak: { x: 49, y: 30 } },
  { id: 3, src: island3Url, peak: { x: 45, y: 8 } },
] as const;

/** Orchestrator galleon sprite (two-masted, waterline ripple baked in). */
export const GALLEON_SRC = galleonUrl;

/**
 * Dressing-lines overlay is authored in the galleon sprite's native pixel
 * space (560×466) so mastheads land on the raster masts. Halyard runs
 * stem → fore → main → stern ("dressed overall").
 */
export const GALLEON_VIEW = { w: 560, h: 466 } as const;
/** Fore and main mastheads (native px) — dress flags string between them. */
export const GALLEON_MASTS = {
  fore: { x: 248, y: 52 },
  main: { x: 362, y: 48 },
  stem: { x: 78, y: 305 },
  stern: { x: 505, y: 295 },
} as const;

/** Deterministic island art variant for a task id (stable for the task's life). */
export function islandVariantFor(taskId: string): IslandVariant {
  const index = fnv1a(taskId) % ISLAND_VARIANTS.length;
  return ISLAND_VARIANTS[index]!;
}
