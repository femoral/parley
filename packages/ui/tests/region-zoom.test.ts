import { describe, expect, it } from "vitest";
import {
  computeRegionZoomTarget,
  countZoomTarget,
  ORBIT_DRAFT_LIFT_FACTOR,
  paddedIslandBounds,
  REGION_ZOOM_MIN,
  sloopOrbitDraftLift,
  sloopOrbitRadius,
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
    const viewportH = 300;
    const islandHalfW = 117 / 2;
    // Place so island body is inside: centre at 0, body extends ±58.5 → width 117 < 400.
    // Padded width = 117 + 2*radius; for radius ~115 that is ~347 — still < 400.
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
    // Lift raises the orbit center, so top extent is farther than bottom from 0.
    expect(Math.abs(box.minY)).toBeGreaterThan(Math.abs(box.maxY));
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
});
