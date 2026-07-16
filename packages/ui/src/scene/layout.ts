/**
 * Deterministic scatter layout for task islands inside a session region.
 *
 * Replaces the old index-keyed grid (`slot(i, count)`) with an organic cove
 * placement: each task id seeds a preferred point (FNV-1a → mulberry32 +
 * golden-angle spiral), then claims the nearest free hex-lattice slot. A given
 * island therefore lands at the same spot on every render/reload and never
 * leaps when a sibling's array index shifts.
 *
 * ## Append-only stability
 *
 * Islands are placed in **task-array order**. Each new id is resolved against
 * the slots already taken by earlier entries; earlier ids are never re-placed.
 * Adding a task at the end of the list cannot move existing islands.
 *
 * **Assumption:** the caller passes ids in creation / append order. In practice
 * `projectScene` sorts by task id, so full append-stability holds when newly
 * created ids sort after those already present (monotonic ids / ULIDs). For any
 * *fixed* set of ids the result is always deterministic. Placement is never a
 * pure function of array index alone.
 *
 * ## Constraints
 *
 * - Min centre distance ≥ {@link MIN_ISLAND_DISTANCE} (150×128 footprint + plank).
 * - Flagship exclusion: no centre within {@link FLAGSHIP_EXCLUSION_RADIUS} of
 *   {@link FLAGSHIP_CENTER} (galleon sits at translateY(-70px) on the region).
 * - Bounds {@link LAYOUT_BOUNDS} keep islands inside the region window so
 *   neighbouring sessions (stride 780px) never visually collide.
 */

export interface Point {
  x: number;
  y: number;
}

/** Min centre-to-centre distance — island body 150×128 plus name-plank air. */
export const MIN_ISLAND_DISTANCE = 190;

/** No island centre within this radius of the flagship centre. */
export const FLAGSHIP_EXCLUSION_RADIUS = 170;

/**
 * Flagship centre relative to the region origin.
 * Matches `.pc-region__flagship { transform: … translateY(-70px) }`.
 */
export const FLAGSHIP_CENTER: Point = { x: 0, y: -70 };

/**
 * Scatter window for island centres. Tall enough to hex-pack a dozen islands
 * at {@link MIN_ISLAND_DISTANCE} while keeping |x| ≤ 330 so neighbouring
 * session regions (stride 780px) stay clear of each other.
 */
export const LAYOUT_BOUNDS = {
  minX: -330,
  maxX: 330,
  minY: -20,
  maxY: 500,
} as const;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Slightly above min distance so √3 float error never undershoots 190. */
const LATTICE_PITCH = MIN_ISLAND_DISTANCE + 1;
const LATTICE_ROW = LATTICE_PITCH * (Math.sqrt(3) / 2);

/** FNV-1a 32-bit — stable string → seed. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG; returns [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function inBounds(p: Point): boolean {
  return (
    p.x >= LAYOUT_BOUNDS.minX &&
    p.x <= LAYOUT_BOUNDS.maxX &&
    p.y >= LAYOUT_BOUNDS.minY &&
    p.y <= LAYOUT_BOUNDS.maxY
  );
}

function clearOfFlagship(p: Point): boolean {
  return dist(p, FLAGSHIP_CENTER) >= FLAGSHIP_EXCLUSION_RADIUS;
}

function quantize(p: Point): Point {
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}

/**
 * Hex lattice of legal island centres. Spacing equals {@link MIN_ISLAND_DISTANCE}
 * so any two slots are non-overlapping; flagship-excluded cells are dropped.
 * Built once per `placeIslands` call (tiny).
 */
function buildLattice(): Point[] {
  const slots: Point[] = [];
  for (let row = 0; ; row++) {
    const y = LAYOUT_BOUNDS.minY + row * LATTICE_ROW;
    if (y > LAYOUT_BOUNDS.maxY) break;
    const stagger = (row % 2) * (LATTICE_PITCH / 2);
    for (let col = 0; ; col++) {
      const x = LAYOUT_BOUNDS.minX + stagger + col * LATTICE_PITCH;
      if (x > LAYOUT_BOUNDS.maxX) break;
      const p = { x, y };
      if (inBounds(p) && clearOfFlagship(p)) slots.push(p);
    }
  }
  return slots;
}

/**
 * Preferred "pops out of the water" point for a task id — organic look before
 * snapping to the nearest free lattice slot. Pure function of the id alone.
 */
export function preferredPoint(id: string): Point {
  const seed = fnv1a(id);
  const rand = mulberry32(seed);

  // Seeded origin in the lower cove + a short golden-angle hop.
  const originX =
    LAYOUT_BOUNDS.minX + rand() * (LAYOUT_BOUNDS.maxX - LAYOUT_BOUNDS.minX);
  const originY =
    LAYOUT_BOUNDS.minY +
    0.25 * (LAYOUT_BOUNDS.maxY - LAYOUT_BOUNDS.minY) +
    rand() * 0.55 * (LAYOUT_BOUNDS.maxY - LAYOUT_BOUNDS.minY);
  const hop = 20 + rand() * 120;
  const angle = rand() * Math.PI * 2 + GOLDEN_ANGLE * (seed % 17);
  return {
    x: originX + hop * Math.cos(angle),
    y: originY + hop * Math.sin(angle),
  };
}

/**
 * Place every island for the given task ids (array order = placement order).
 * Returns a Map of task id → centre offset from the region origin.
 */
export function placeIslands(taskIds: readonly string[]): Map<string, Point> {
  const free = buildLattice();
  const result = new Map<string, Point>();

  for (const id of taskIds) {
    const preferred = preferredPoint(id);
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < free.length; i++) {
      const d = dist(free[i]!, preferred);
      // Prefer closer slots; tie-break on lower index for stability.
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const [slot] = free.splice(bestIdx, 1);
      result.set(id, quantize(slot!));
      continue;
    }

    // Lattice exhausted (beyond designed fleet size): fall back to a seeded
    // ring so the island still has a deterministic home. May pack tighter.
    const angle = (fnv1a(id) % 360) * (Math.PI / 180);
    result.set(
      id,
      quantize({
        x: Math.cos(angle) * 240,
        y: 200 + Math.sin(angle) * 120,
      }),
    );
  }

  return result;
}

/** CSS transform string for an island slot at a scatter centre. */
export function islandSlotTransform(p: Point): string {
  return `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)`;
}

/**
 * Voyage start (flagship → island) in island-local coordinates: the vector
 * from the island centre back to the flagship centre. The sloop animates from
 * this translate to its on-station offset.
 */
export function voyageFromFlagship(island: Point): Point {
  return {
    x: FLAGSHIP_CENTER.x - island.x,
    y: FLAGSHIP_CENTER.y - island.y,
  };
}

/**
 * On-station hold point relative to the island centre — just offshore on the
 * flagship-facing side, so the sloop arrives from the approach direction and
 * sits on the near water rather than the far side of the rock.
 *
 * @param closeness — distance from island centre toward the flagship (px).
 */
export function stationOffset(island: Point, closeness = 88): Point {
  const toFlag = voyageFromFlagship(island);
  const len = Math.hypot(toFlag.x, toFlag.y) || 1;
  return {
    x: Math.round((toFlag.x / len) * closeness * 100) / 100,
    y: Math.round((toFlag.y / len) * closeness * 100) / 100,
  };
}
