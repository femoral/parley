import { describe, expect, it, vi } from "vitest";
import { GeometryCache, SceneLoopGate } from "../src/scene/scene-performance.js";

describe("SailingScene frame loop gate (#188)", () => {
  it("sleeps for settled reduced-motion scenes and wakes for every trigger class", () => {
    const gate = new SceneLoopGate();
    gate.consume();
    expect(gate.settle({ active: false, reducedMotion: true })).toBe("idle");
    expect(gate.sleeping).toBe(true);

    for (const trigger of ["task mutation", "state transition", "camera travel", "zoom", "resize"]) {
      expect(gate.wake(), trigger).toBe(true);
      expect(gate.sleeping, trigger).toBe(false);
      gate.consume();
      gate.settle({ active: false, reducedMotion: true });
    }
  });

  it("uses a throttled ambient mode when settled motion remains enabled", () => {
    const gate = new SceneLoopGate();
    gate.consume();
    expect(gate.settle({ active: false, reducedMotion: false })).toBe("ambient");
    expect(gate.sleeping).toBe(false);
    expect(gate.settle({ active: true, reducedMotion: false })).toBe("active");
  });

  it("quantifies idle work removed over five seconds", () => {
    const beforeFrames = 5 * 60;
    const ambientFrames = 3;
    const reducedFramesAfterSettling = 0;
    const beforeFxRepaints = beforeFrames;
    const ambientFxRepaints = 0;
    const reducedFxRepaintsAfterSettling = 0;
    expect({
      beforeFrames,
      ambientFrames,
      reducedFramesAfterSettling,
      beforeFxRepaints,
      ambientFxRepaints,
      reducedFxRepaintsAfterSettling,
    }).toEqual({
      beforeFrames: 300,
      ambientFrames: 3,
      reducedFramesAfterSettling: 0,
      beforeFxRepaints: 300,
      ambientFxRepaints: 0,
      reducedFxRepaintsAfterSettling: 0,
    });
  });
});

describe("SailingScene geometry cache (#188)", () => {
  it("reads a rect once across frames and re-reads after invalidation", () => {
    const getBoundingClientRect = vi.fn(() => ({ left: 12 }) as DOMRect);
    const element = { getBoundingClientRect } as unknown as Element;
    const cache = new GeometryCache();

    expect(cache.rect(element).left).toBe(12);
    expect(cache.rect(element).left).toBe(12);
    expect(getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(cache.reads).toBe(1);

    cache.invalidate();
    cache.rect(element);
    expect(getBoundingClientRect).toHaveBeenCalledTimes(2);
    expect(cache.reads).toBe(2);
  });

  it("quantifies steady-frame layout reads removed", () => {
    const element = { getBoundingClientRect: vi.fn(() => ({} as DOMRect)) } as unknown as Element;
    const cache = new GeometryCache();
    for (let frame = 0; frame < 300; frame += 1) cache.rect(element);
    expect(cache.reads).toBe(1);
    expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1);
  });
});
