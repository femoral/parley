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
 * - Horizontal bounds of {@link LAYOUT_BOUNDS} keep |x| clear of neighbouring
 *   sessions (stride 780px). Large fleets grow the lattice south past
 *   `maxY` rather than violating min-distance.
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
 * Preferred scatter window for island centres. Tall enough to hex-pack a dozen
 * islands at {@link MIN_ISLAND_DISTANCE} while keeping |x| ≤ 330 so neighbouring
 * session regions (stride 780px) stay clear of each other.
 *
 * When a fleet outgrows this window, {@link placeIslands} extends the hex
 * lattice south (larger y) rather than packing tighter — |x| still respects
 * these horizontal bounds so neighbour regions never collide.
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

/** Horizontal clamp only — y may grow past {@link LAYOUT_BOUNDS.maxY} on overflow. */
function inXBounds(p: Point): boolean {
  return p.x >= LAYOUT_BOUNDS.minX && p.x <= LAYOUT_BOUNDS.maxX;
}

function clearOfFlagship(p: Point): boolean {
  return dist(p, FLAGSHIP_CENTER) >= FLAGSHIP_EXCLUSION_RADIUS;
}

function quantize(p: Point): Point {
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}

/**
 * Append one hex-lattice row (by row index from {@link LAYOUT_BOUNDS.minY}).
 * Spacing equals {@link LATTICE_PITCH} so any two slots are non-overlapping;
 * flagship-excluded cells are dropped. X stays inside {@link LAYOUT_BOUNDS}.
 */
function appendLatticeRow(slots: Point[], row: number): void {
  const y = LAYOUT_BOUNDS.minY + row * LATTICE_ROW;
  if (y < LAYOUT_BOUNDS.minY) return;
  const stagger = (row % 2) * (LATTICE_PITCH / 2);
  for (let col = 0; ; col++) {
    const x = LAYOUT_BOUNDS.minX + stagger + col * LATTICE_PITCH;
    if (x > LAYOUT_BOUNDS.maxX) break;
    const p = { x, y };
    if (inXBounds(p) && clearOfFlagship(p)) slots.push(p);
  }
}

/**
 * Hex lattice of legal island centres inside the preferred vertical window.
 * Built once per `placeIslands` call; overflow grows further rows south.
 */
function buildBaseLattice(): { slots: Point[]; nextRow: number } {
  const slots: Point[] = [];
  let row = 0;
  for (; ; row++) {
    const y = LAYOUT_BOUNDS.minY + row * LATTICE_ROW;
    if (y > LAYOUT_BOUNDS.maxY) break;
    appendLatticeRow(slots, row);
  }
  return { slots, nextRow: row };
}

/**
 * Preferred "pops out of the water" point for a task id — organic look before
 * snapping to the nearest free lattice slot. Pure function of the id alone.
 */
export function preferredPoint(id: string): Point {
  const seed = fnv1a(id);
  const rand = mulberry32(seed);

  // Seeded point on a fan ringing the flagship: radius bands just outside the
  // exclusion zone, sweep biased to the lower half-circle with a little spill
  // past horizontal on both flanks. Mass gathers around the galleon (the
  // composition's anchor) instead of pooling in the lower cove, so a typical
  // fleet stays inside one viewport fold; deep rows fill only as the lattice
  // near the flagship runs out. Golden-angle jitter keeps the fan organic.
  const radius = FLAGSHIP_EXCLUSION_RADIUS + 40 + rand() * 180;
  const sweep = -0.15 + rand() * 1.3; // of π: −27°…207°, flank-to-flank
  const angle = sweep * Math.PI + GOLDEN_ANGLE * (seed % 17) * 0.02;
  return {
    x: FLAGSHIP_CENTER.x + radius * Math.cos(angle),
    y: FLAGSHIP_CENTER.y + radius * Math.sin(angle),
  };
}

/**
 * Place every island for the given task ids (array order = placement order).
 * Returns a Map of task id → centre offset from the region origin.
 *
 * When the preferred-window lattice is full, further slots are opened by
 * extending the same hex lattice south. That preserves the min-distance
 * guarantee (lattice pitch), flagship exclusion, |x| neighbour clearance,
 * determinism, and append-only stability — unlike the old seeded-ellipse
 * fallback, which could stack centres a few pixels apart.
 */
export function placeIslands(taskIds: readonly string[]): Map<string, Point> {
  const { slots: free, nextRow: startRow } = buildBaseLattice();
  let nextRow = startRow;
  const result = new Map<string, Point>();

  /** Grow south until at least one free lattice slot exists. */
  const ensureFreeSlot = (): void => {
    // Pathological safety: each row yields several legal cols; this is far
    // beyond any realistic fleet and only guards a broken geometry constant.
    const rowLimit = nextRow + taskIds.length + 64;
    while (free.length === 0) {
      if (nextRow >= rowLimit) {
        throw new Error("placeIslands: unable to grow lattice for free slot");
      }
      appendLatticeRow(free, nextRow);
      nextRow += 1;
    }
  };

  for (const id of taskIds) {
    ensureFreeSlot();

    const preferred = preferredPoint(id);
    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < free.length; i++) {
      const d = dist(free[i]!, preferred);
      // Prefer closer slots; tie-break on lower index for stability.
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    const [slot] = free.splice(bestIdx, 1);
    result.set(id, quantize(slot!));
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
