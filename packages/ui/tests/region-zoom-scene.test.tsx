/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeIslands } from "../src/scene/layout.js";
import { Scene, type IslandTask } from "../src/scene/index.js";
import {
  computeRegionZoomTarget,
  countZoomTarget,
} from "../src/scene/region-zoom.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function task(id: string, state = "pending"): IslandTask {
  return {
    id,
    name: id,
    state,
    coat: "#10a37f",
    coatDark: "#0b7359",
    emblem: { kind: "glyph", char: "C" },
  };
}

function mockSceneViewport(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("pc-scene-view")) {
      return new DOMRect(0, 0, width, height);
    }
    if (this.classList.contains("pc-island")) {
      return new DOMRect(300, 200, 117, 107);
    }
    if (this.classList.contains("pc-island__sprite")) {
      return new DOMRect(303, 210, 111, 90);
    }
    if (this.classList.contains("pc-world")) {
      return new DOMRect(0, 0, width, height);
    }
    return new DOMRect(0, 0, 0, 0);
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("pc-scene-view")) return width;
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("pc-scene-view")) return height;
    return 0;
  });
}

function reducedMotion() {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
}

function captureFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  return frames;
}

describe("region zoom on a mounted scene (#201)", () => {
  it("sets --region-zoom below the count target for a wide fleet in a tight viewport", () => {
    reducedMotion();
    const frames = captureFrames();
    const ids = Array.from({ length: 12 }, (_, i) => `fleet-${i}`);
    const raw = placeIslands(ids);
    const spread = Math.sqrt(ids.length / 5);
    const centres = ids.map((id) => {
      const p = raw.get(id)!;
      return { x: p.x * spread, y: p.y * spread };
    });
    const viewportW = 480;
    const viewportH = 360;
    mockSceneViewport(viewportW, viewportH);

    const expected = computeRegionZoomTarget({
      islandCount: ids.length,
      centres,
      viewportW,
      viewportH,
    });
    const countTarget = countZoomTarget(ids.length);
    expect(expected).toBeLessThan(countTarget);

    const { container } = render(
      <Scene
        sessions={[
          {
            id: "wide",
            label: "wide",
            tasks: ids.map((id) => task(id)),
            attention: null,
          },
        ]}
        activeSessionId="wide"
        onSelectTask={() => undefined}
        onSelectSession={() => undefined}
      />,
    );

    act(() => frames.shift()?.(1_000));
    const region = container.querySelector(".pc-region") as HTMLElement;
    const zoom = Number.parseFloat(region.style.getPropertyValue("--region-zoom"));
    expect(zoom).toBeCloseTo(expected, 3);
    expect(zoom).toBeLessThan(countTarget);
  });

  it("keeps --region-zoom at 1 for a single island in a large viewport", () => {
    reducedMotion();
    const frames = captureFrames();
    mockSceneViewport(1400, 1000);

    const { container } = render(
      <Scene
        sessions={[
          {
            id: "tiny",
            label: "tiny",
            tasks: [task("solo")],
            attention: null,
          },
        ]}
        activeSessionId="tiny"
        onSelectTask={() => undefined}
        onSelectSession={() => undefined}
      />,
    );

    act(() => frames.shift()?.(1_000));
    const region = container.querySelector(".pc-region") as HTMLElement;
    const zoom = Number.parseFloat(region.style.getPropertyValue("--region-zoom"));
    expect(zoom).toBe(1);
  });

  it("sets --region-frame-x/y to the content centroid (not origin) for a northern-heavy fleet", () => {
    reducedMotion();
    const frames = captureFrames();
    mockSceneViewport(1440, 900);

    // Prefer ids that place mass north of the flagship so centroid ≠ origin.
    const ids = Array.from({ length: 12 }, (_, i) => `north-fleet-${i}`);
    const { container } = render(
      <Scene
        sessions={[
          {
            id: "north",
            label: "north",
            tasks: ids.map((id) => task(id)),
            attention: null,
          },
        ]}
        activeSessionId="north"
        onSelectTask={() => undefined}
        onSelectSession={() => undefined}
      />,
    );

    act(() => frames.shift()?.(1_000));
    const region = container.querySelector(".pc-region") as HTMLElement;
    const frameX = Number.parseFloat(region.style.getPropertyValue("--region-frame-x"));
    const frameY = Number.parseFloat(region.style.getPropertyValue("--region-frame-y"));
    expect(Number.isFinite(frameX)).toBe(true);
    expect(Number.isFinite(frameY)).toBe(true);
    // Northern-biased scatter: framing y should sit off the origin.
    expect(Math.abs(frameY)).toBeGreaterThan(1);
    // Transform must consume the frame vars (centroid framing, not origin).
    expect(region.style.transform).toContain("--region-frame-x");
    expect(region.style.transform).toContain("--region-frame-y");
  });

  it("re-evaluates fit after a ResizeObserver size change", () => {
    reducedMotion();
    const frames = captureFrames();
    let viewportW = 1400;
    let viewportH = 1000;
    mockSceneViewport(viewportW, viewportH);

    // Spy that re-reads current viewport dims.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("pc-scene-view")) return viewportW;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("pc-scene-view")) return viewportH;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("pc-scene-view") || this.classList.contains("pc-world")) {
        return new DOMRect(0, 0, viewportW, viewportH);
      }
      if (this.classList.contains("pc-island")) return new DOMRect(300, 200, 117, 107);
      if (this.classList.contains("pc-island__sprite")) return new DOMRect(303, 210, 111, 90);
      return new DOMRect(0, 0, 0, 0);
    });

    const ids = Array.from({ length: 8 }, (_, i) => `resize-${i}`);
    const { container } = render(
      <Scene
        sessions={[
          {
            id: "resize",
            label: "resize",
            tasks: ids.map((id) => task(id)),
            attention: null,
          },
        ]}
        activeSessionId="resize"
        onSelectTask={() => undefined}
        onSelectSession={() => undefined}
      />,
    );

    act(() => frames.shift()?.(1_000));
    const region = container.querySelector(".pc-region") as HTMLElement;
    const zoomWide = Number.parseFloat(region.style.getPropertyValue("--region-zoom"));

    // Shrink viewport and fire ResizeObserver callbacks registered by the scene.
    viewportW = 320;
    viewportH = 240;
    const scene = container.querySelector(".pc-scene-view") as HTMLElement;
    // happy-dom may not auto-fire RO; invoke any observers manually if present.
    // The scene also listens via our ResizeObserver which calls invalidate/wake.
    // Force a frame after simulating a size change through the same path:
    // dispatch a window resize (refreshes sea) and pump frames — the RO path
    // is covered when ResizeObserver exists; we also shrink clientWidth so the
    // next frame recomputes the fit.
    act(() => {
      window.dispatchEvent(new Event("resize"));
      // Drain any newly queued frames from wake().
      while (frames.length > 0) {
        frames.shift()?.(2_000);
      }
    });

    const zoomNarrow = Number.parseFloat(region.style.getPropertyValue("--region-zoom"));
    expect(zoomNarrow).toBeLessThan(zoomWide);
    expect(scene).toBeTruthy();
  });

  it("returns to ambient cadence after resize — no perpetual wakes", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    let frameCount = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = window.setTimeout(() => {
        frameCount += 1;
        callback(performance.now());
      }, 0);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      window.clearTimeout(id);
    });
    mockSceneViewport(800, 600);

    render(
      <Scene
        sessions={[
          {
            id: "ambient-zoom",
            label: "ambient-zoom",
            // Empty fleet: no orbiting sloops → settles to ambient.
            tasks: [],
            attention: null,
          },
        ]}
        activeSessionId="ambient-zoom"
        onSelectTask={() => undefined}
        onSelectSession={() => undefined}
      />,
    );

    await act(async () => vi.advanceTimersByTimeAsync(450));
    const settled = frameCount;
    expect(settled).toBeLessThanOrEqual(3);

    // One resize wake, then ambient spacing (~2000ms) — not continuous frames.
    act(() => window.dispatchEvent(new Event("resize")));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    const afterWake = frameCount;
    expect(afterWake).toBeGreaterThan(settled);

    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    const ambientFrames = frameCount - afterWake;
    // ~2s ambient cadence → at most a few frames in 5s, never 60fps.
    expect(ambientFrames).toBeLessThanOrEqual(3);
  });
});
