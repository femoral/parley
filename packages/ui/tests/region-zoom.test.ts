import { describe, expect, it } from "vitest";
import {
  computeRegionZoomTarget,
  contentFrameOffset,
  countZoomTarget,
  ORBIT_DRAFT_LIFT_FACTOR,
  ORBIT_RADIUS_MIN,
  orbitRadiusForNearest,
  paddedIslandBounds,
  PLANK_CLEARANCE,
  PLANK_EXTENT_BELOW,
  REGION_ZOOM_MIN,
  sloopOrbitDraftLift,
  sloopOrbitRadius,
  TOP_OVERLAY_HEADROOM_PX,
} from "../src/scene/region-zoom.js";

describe("region zoom fit (#201)", () => {
  it("keeps zoom 1 for a small fleet whose padded box already fits", () => {
    const target = computeRegionZoomTarget({
      islandCount: 1,
      centres: [{ x: 0, y: 200 }],
      viewportW: 1200,
      viewportH: 900,
    });
    expect(target).toBe(1);
    expect(countZoomTarget(1)).toBe(1);
  });

  it("drives zoom below the count-based target for a wide/tall placed fleet", () => {
    // Spread-scaled centres spanning far more than a modest viewport.
    const centres = [
      { x: -600, y: -500 },
      { x: 600, y: -500 },
      { x: -600, y: 500 },
      { x: 600, y: 500 },
      { x: 0, y: 0 },
    ];
    const count = centres.length;
    const countTarget = countZoomTarget(count);
    const target = computeRegionZoomTarget({
      islandCount: count,
      centres,
      viewportW: 800,
      viewportH: 600,
    });
    expect(countTarget).toBeCloseTo(Math.sqrt(5 / count), 5);
    expect(target).toBeLessThan(countTarget);
    expect(target).toBeGreaterThanOrEqual(REGION_ZOOM_MIN);
    expect(target).toBeLessThanOrEqual(1);
  });

  it("includes the padded orbit margin so an edge island zooms out even when the body alone fits", () => {
    // Island body (117×107) near the edge of an 400×300 viewport — body alone
    // would fit if centered, but orbit radius sticks past the viewport.
    const radius = sloopOrbitRadius();
    expect(radius).toBeGreaterThan(60);

    // Single island whose body half-extent fits a 400-wide view when centered,
    // but body + orbit pad does not.
    const viewportW = 400;
    const islandHalfW = 117 / 2;
    // Place so island body is inside: centre at 0, body extends ±58.5 → width 117 < 400.
    // Padded width = 117 + 2*radius; for radius ~102 that is ~321 — still < 400.
    // Push centre toward the edge so body+orbit exceeds while body alone would be
    // measured as the fleet box of one island at origin still uses full pad both sides.
    // One island at origin: padded box width = 2*(halfW+radius). Compare:
    const bodyOnlyW = 2 * islandHalfW;
    const padded = paddedIslandBounds([{ x: 0, y: 0 }])!;
    expect(bodyOnlyW).toBeLessThan(viewportW);
    expect(padded.width).toBeGreaterThan(bodyOnlyW);
    // Choose a viewport that fits the island body but not body+orbit.
    const tightW = bodyOnlyW + 20; // body fits with room
    expect(padded.width).toBeGreaterThan(tightW);

    const withOrbit = computeRegionZoomTarget({
      islandCount: 1,
      centres: [{ x: 0, y: 0 }],
      viewportW: tightW,
      viewportH: 2000,
      topHeadroomPx: 0,
    });
    const bodyFitOnly = Math.min(1, tightW / bodyOnlyW);
    // Body-only fit would stay at 1; orbit pad forces zoom-out.
    expect(bodyFitOnly).toBe(1);
    expect(withOrbit).toBeLessThan(1);
    expect(withOrbit).toBeCloseTo(tightW / padded.width, 5);
  });

  it("clamps to REGION_ZOOM_MIN and never exceeds 1", () => {
    const tiny = computeRegionZoomTarget({
      islandCount: 40,
      centres: [
        { x: -5000, y: -5000 },
        { x: 5000, y: 5000 },
      ],
      viewportW: 100,
      viewportH: 100,
    });
    expect(tiny).toBe(REGION_ZOOM_MIN);

    const hugeViewport = computeRegionZoomTarget({
      islandCount: 2,
      centres: [{ x: 10, y: 10 }],
      viewportW: 10_000,
      viewportH: 10_000,
    });
    expect(hugeViewport).toBe(1);
  });

  it("reflects orbit draft lift in the padded vertical extent", () => {
    expect(ORBIT_DRAFT_LIFT_FACTOR).toBeGreaterThan(0.3);
    expect(ORBIT_DRAFT_LIFT_FACTOR).toBeLessThan(0.8);
    const lift = sloopOrbitDraftLift();
    expect(lift).toBeGreaterThan(0);
    const box = paddedIslandBounds([{ x: 0, y: 0 }])!;
    // Lift raises the orbit center, so top extent is farther than body-only top.
    // Plank extends south of the body, so bottom can exceed |top| depending on
    // constants — assert the orbit contribution is present above the body.
    const halfH = 107 / 2;
    expect(box.minY).toBeLessThan(-halfH);
  });

  it("includes the name plank below the island body", () => {
    const box = paddedIslandBounds([{ x: 0, y: 0 }])!;
    const halfH = 107 / 2;
    expect(box.maxY).toBeGreaterThanOrEqual(PLANK_EXTENT_BELOW - 0.01);
    expect(PLANK_EXTENT_BELOW).toBeGreaterThan(halfH);
  });

  it("re-evaluates when the viewport shrinks", () => {
    const centres = [
      { x: -200, y: -150 },
      { x: 200, y: 150 },
    ];
    const wide = computeRegionZoomTarget({
      islandCount: 2,
      centres,
      viewportW: 2000,
      viewportH: 1500,
    });
    const narrow = computeRegionZoomTarget({
      islandCount: 2,
      centres,
      viewportW: 320,
      viewportH: 240,
    });
    expect(wide).toBe(1);
    expect(narrow).toBeLessThan(wide);
  });

  it("subtracts top headroom from usable height when fitting", () => {
    // Tall thin fleet: height-limited fit.
    const centres = [
      { x: 0, y: -400 },
      { x: 0, y: 400 },
    ];
    const box = paddedIslandBounds(centres)!;
    const viewportW = 4000; // never width-limited
    const viewportH = box.height; // exact fit without headroom
    const noHead = computeRegionZoomTarget({
      islandCount: 2,
      centres,
      viewportW,
      viewportH,
      topHeadroomPx: 0,
    });
    const withHead = computeRegionZoomTarget({
      islandCount: 2,
      centres,
      viewportW,
      viewportH,
      topHeadroomPx: TOP_OVERLAY_HEADROOM_PX,
    });
    expect(noHead).toBeCloseTo(1, 5);
    expect(withHead).toBeLessThan(noHead);
  });
});

describe("content framing (centroid + headroom)", () => {
  it("exposes the padded-box centroid on bounds", () => {
    const box = paddedIslandBounds([
      { x: -100, y: -400 },
      { x: 100, y: 0 },
    ])!;
    expect(box.cx).toBeCloseTo((box.minX + box.maxX) / 2, 5);
    expect(box.cy).toBeCloseTo((box.minY + box.maxY) / 2, 5);
    // Northern-heavy fleet: centroid sits north of origin.
    expect(box.cy).toBeLessThan(0);
  });

  it("frames on the content centroid, not the region origin", () => {
    const centres = [
      { x: -100, y: -500 },
      { x: 100, y: -500 },
      { x: 0, y: 100 },
    ];
    const box = paddedIslandBounds(centres)!;
    const frame = contentFrameOffset(centres, 1, 0);
    expect(frame.x).toBeCloseTo(box.cx, 5);
    expect(frame.y).toBeCloseTo(box.cy, 5);
    expect(frame.y).not.toBe(0);
  });

  it("biases the frame north so content sits below viewport centre (top headroom)", () => {
    const centres = [{ x: 0, y: 0 }];
    const plain = contentFrameOffset(centres, 1, 0);
    const headed = contentFrameOffset(centres, 1, 48);
    expect(headed.y).toBeLessThan(plain.y);
    expect(plain.y - headed.y).toBeCloseTo(24, 5);
  });

  it("returns origin frame when there are no islands", () => {
    expect(contentFrameOffset([], 1)).toEqual({ x: 0, y: 0 });
  });
});

describe("orbit radius nearest-neighbour clamp", () => {
  it("leaves the base radius alone when the neighbour is far", () => {
    const base = sloopOrbitRadius();
    expect(orbitRadiusForNearest(400, base)).toBe(base);
  });

  it("clamps when the neighbour is within plank-rake range", () => {
    const base = sloopOrbitRadius();
    const tight = base + PLANK_CLEARANCE - 20; // forces a clamp
    const clamped = orbitRadiusForNearest(tight, base);
    expect(clamped).toBeLessThan(base);
    expect(clamped).toBeGreaterThanOrEqual(ORBIT_RADIUS_MIN);
    expect(clamped).toBeCloseTo(Math.max(ORBIT_RADIUS_MIN, tight - PLANK_CLEARANCE), 5);
  });

  it("never drops below ORBIT_RADIUS_MIN", () => {
    expect(orbitRadiusForNearest(10, sloopOrbitRadius())).toBe(ORBIT_RADIUS_MIN);
  });
});
