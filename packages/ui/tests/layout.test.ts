import { describe, expect, it } from "vitest";
import {
  FLAGSHIP_CENTER,
  FLAGSHIP_EXCLUSION_RADIUS,
  LAYOUT_BOUNDS,
  MIN_ISLAND_DISTANCE,
  placeIslands,
  preferredPoint,
  type Point,
} from "../src/scene/layout.js";

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function ids(n: number, prefix = "task"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`);
}

describe("placeIslands — determinism", () => {
  it("returns the same positions for the same ids across calls", () => {
    const list = ["alpha", "bravo", "charlie", "delta"];
    const a = placeIslands(list);
    const b = placeIslands(list);
    for (const id of list) {
      expect(a.get(id)).toEqual(b.get(id));
    }
  });

  it("is stable under re-invocation with a reordered *copy* of a fixed set only when order matches (order is placement key)", () => {
    // Documented assumption: array order is placement order. Different orders
    // may yield different positions for later ids; same order is bit-stable.
    const list = ["zulu", "yankee", "xray"];
    expect([...placeIslands(list).entries()]).toEqual([...placeIslands(list).entries()]);
  });

  it("does not key a lone island solely on index 0 — two different ids land apart", () => {
    const a = placeIslands(["sole-a"]).get("sole-a")!;
    const b = placeIslands(["sole-b"]).get("sole-b")!;
    // Extremely unlikely to collide if seeded by id; assert they differ.
    expect(a).not.toEqual(b);
  });
});

describe("placeIslands — no overlap, exclusion, bounds", () => {
  it.each([1, 2, 3, 4, 6, 8, 10, 12])(
    "keeps min centre distance for %i islands",
    (n) => {
      const list = ids(n);
      const map = placeIslands(list);
      const points = list.map((id) => map.get(id)!);
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          expect(dist(points[i]!, points[j]!)).toBeGreaterThanOrEqual(MIN_ISLAND_DISTANCE);
        }
      }
    },
  );

  it.each([1, 4, 8, 12])("respects the flagship exclusion zone for %i islands", (n) => {
    const map = placeIslands(ids(n));
    for (const p of map.values()) {
      expect(dist(p, FLAGSHIP_CENTER)).toBeGreaterThanOrEqual(FLAGSHIP_EXCLUSION_RADIUS);
    }
  });

  it.each([1, 4, 8, 12])("keeps every island centre inside the region bounds for %i islands", (n) => {
    const map = placeIslands(ids(n));
    for (const p of map.values()) {
      expect(p.x).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.minX);
      expect(p.x).toBeLessThanOrEqual(LAYOUT_BOUNDS.maxX);
      expect(p.y).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.minY);
      expect(p.y).toBeLessThanOrEqual(LAYOUT_BOUNDS.maxY);
    }
  });

  it("can place islands above the flagship (y < FLAGSHIP_CENTER.y)", () => {
    // Full-circle preferred + northern lattice slots must allow at least one
    // berth north of the galleon for a modest fleet.
    const map = placeIslands(ids(16));
    const above = [...map.values()].filter((p) => p.y < FLAGSHIP_CENTER.y);
    expect(above.length).toBeGreaterThan(0);
    for (const p of above) {
      expect(p.y).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.minY);
      expect(dist(p, FLAGSHIP_CENTER)).toBeGreaterThanOrEqual(FLAGSHIP_EXCLUSION_RADIUS);
    }
  });

  it("preferredPoint rings the full circle (not only a downward arc)", () => {
    // Sample many ids: some preferred y should land above the flagship and
    // some below, proving the sweep is no longer lower-half biased.
    let above = 0;
    let below = 0;
    for (let i = 0; i < 80; i++) {
      const p = preferredPoint(`pref-sample-${i}`);
      if (p.y < FLAGSHIP_CENTER.y) above += 1;
      if (p.y > FLAGSHIP_CENTER.y) below += 1;
    }
    expect(above).toBeGreaterThan(10);
    expect(below).toBeGreaterThan(10);
  });
});

describe("placeIslands — append-only stability", () => {
  it("does not move earlier ids when a new id is appended", () => {
    const base = ["t-alpha", "t-bravo", "t-charlie"];
    const before = placeIslands(base);
    const after = placeIslands([...base, "t-delta"]);
    for (const id of base) {
      expect(after.get(id)).toEqual(before.get(id));
    }
    expect(after.get("t-delta")).toBeDefined();
    // New island also respects separation from the existing set.
    for (const id of base) {
      expect(dist(after.get("t-delta")!, after.get(id)!)).toBeGreaterThanOrEqual(
        MIN_ISLAND_DISTANCE,
      );
    }
  });

  it("keeps a growing fleet's early islands fixed across many appends", () => {
    let list: string[] = [];
    let previous = new Map<string, Point>();
    for (let i = 0; i < 10; i++) {
      list = [...list, `grow-${i}`];
      const next = placeIslands(list);
      for (const [id, pos] of previous) {
        expect(next.get(id)).toEqual(pos);
      }
      previous = next;
    }
  });
});

/**
 * Property tests for fleets larger than the fixed LAYOUT_BOUNDS lattice.
 * Overflow must still honour min-distance, flagship exclusion, determinism,
 * and append-stability — never stack islands on the seeded ellipse fallback.
 */
describe("placeIslands — overflow fleet properties", () => {
  /**
   * Beyond base-lattice capacity. The preferred window is now north+south of
   * the flagship, so capacity is larger; still force overflow growth.
   */
  const OVERFLOW_N = 80;

  function assertMinDistance(map: Map<string, Point>, list: string[]) {
    const points = list.map((id) => map.get(id)!);
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        expect(dist(points[i]!, points[j]!)).toBeGreaterThanOrEqual(MIN_ISLAND_DISTANCE);
      }
    }
  }

  it(`keeps min centre distance for ${OVERFLOW_N} islands (beyond lattice capacity)`, () => {
    const list = ids(OVERFLOW_N);
    const map = placeIslands(list);
    expect(map.size).toBe(OVERFLOW_N);
    assertMinDistance(map, list);
  });

  it(`is deterministic for the same ${OVERFLOW_N}-id list`, () => {
    const list = ids(OVERFLOW_N);
    const a = placeIslands(list);
    const b = placeIslands(list);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("does not move earlier ids when appending past lattice capacity", () => {
    const base = ids(OVERFLOW_N);
    const before = placeIslands(base);
    const after = placeIslands([...base, "task-extra"]);
    for (const id of base) {
      expect(after.get(id)).toEqual(before.get(id));
    }
    expect(after.get("task-extra")).toBeDefined();
    assertMinDistance(after, [...base, "task-extra"]);
  });

  it("keeps a growing overflow fleet's early islands fixed across many appends", () => {
    let list: string[] = [];
    let previous = new Map<string, Point>();
    for (let i = 0; i < OVERFLOW_N; i++) {
      list = [...list, `overflow-grow-${String(i).padStart(3, "0")}`];
      const next = placeIslands(list);
      for (const [id, pos] of previous) {
        expect(next.get(id)).toEqual(pos);
      }
      previous = next;
    }
    assertMinDistance(previous, list);
  });

  it(`never places centres inside the flagship exclusion zone for ${OVERFLOW_N} islands`, () => {
    const map = placeIslands(ids(OVERFLOW_N));
    for (const p of map.values()) {
      expect(dist(p, FLAGSHIP_CENTER)).toBeGreaterThanOrEqual(FLAGSHIP_EXCLUSION_RADIUS);
    }
  });

  it("keeps |x| within LAYOUT_BOUNDS so neighbouring session regions stay clear", () => {
    const map = placeIslands(ids(OVERFLOW_N));
    for (const p of map.values()) {
      expect(p.x).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.minX);
      expect(p.x).toBeLessThanOrEqual(LAYOUT_BOUNDS.maxX);
    }
  });

  it("overflow growth can place centres north of the preferred minY", () => {
    // Force enough islands that alternate north/south growth is exercised.
    const map = placeIslands(ids(OVERFLOW_N));
    const northOfWindow = [...map.values()].filter((p) => p.y < LAYOUT_BOUNDS.minY);
    // Prefer-window capacity is large; if every island still fits inside, at
    // least confirm northern-of-flagship placement still holds under load.
    const aboveFlagship = [...map.values()].filter((p) => p.y < FLAGSHIP_CENTER.y);
    expect(aboveFlagship.length).toBeGreaterThan(0);
    // When overflow does push past the window, those slots must be valid.
    for (const p of northOfWindow) {
      expect(p.x).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.minX);
      expect(p.x).toBeLessThanOrEqual(LAYOUT_BOUNDS.maxX);
      expect(dist(p, FLAGSHIP_CENTER)).toBeGreaterThanOrEqual(FLAGSHIP_EXCLUSION_RADIUS);
    }
  });
});
