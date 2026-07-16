import { describe, expect, it } from "vitest";
import {
  FLAGSHIP_CENTER,
  FLAGSHIP_EXCLUSION_RADIUS,
  LAYOUT_BOUNDS,
  MIN_ISLAND_DISTANCE,
  placeIslands,
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
