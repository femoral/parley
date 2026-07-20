import { describe, expect, it } from "vitest";
import {
  cancelDeathPhase,
  hasShip,
  sailoffHoldMs,
  SAILOFF_MS,
  shipEffectsOpacity,
  shouldPaintShipEffects,
} from "../src/scene/island-death.js";

describe("cancelDeathPhase (#187)", () => {
  it("is null for non-cancelled states", () => {
    for (const state of ["pending", "running", "awaiting_answer", "stalled", "completed", "failed"]) {
      expect(
        cancelDeathPhase({ state, mountedAsCancelled: false, sailoffComplete: false }),
      ).toBeNull();
    }
  });

  it("settles when the island mounted already cancelled (reload / retained task)", () => {
    expect(
      cancelDeathPhase({
        state: "cancelled",
        mountedAsCancelled: true,
        sailoffComplete: false,
      }),
    ).toBe("settled");
  });

  it("plays live choreography only for an in-session cancel", () => {
    expect(
      cancelDeathPhase({
        state: "cancelled",
        mountedAsCancelled: false,
        sailoffComplete: false,
      }),
    ).toBe("live");
  });

  it("settles after the sailoff fade completes", () => {
    expect(
      cancelDeathPhase({
        state: "cancelled",
        mountedAsCancelled: false,
        sailoffComplete: true,
      }),
    ).toBe("settled");
  });
});

describe("hasShip (#187)", () => {
  it("shows a sloop for active waterborne states", () => {
    expect(hasShip("running", null)).toBe(true);
    expect(hasShip("awaiting_answer", null)).toBe(true);
    expect(hasShip("stalled", null)).toBe(true);
  });

  it("hides the sloop for bare / terminal non-cancelled states", () => {
    expect(hasShip("pending", null)).toBe(false);
    expect(hasShip("completed", null)).toBe(false);
    expect(hasShip("failed", null)).toBe(false);
  });

  it("keeps the sloop only during live cancel, not settled aftermath", () => {
    expect(hasShip("cancelled", "live")).toBe(true);
    expect(hasShip("cancelled", "settled")).toBe(false);
    expect(hasShip("cancelled", null)).toBe(false);
  });
});

describe("sailoffHoldMs", () => {
  it("holds for the full fade under motion, zero under reduced-motion", () => {
    expect(sailoffHoldMs(false)).toBe(SAILOFF_MS);
    expect(sailoffHoldMs(true)).toBe(0);
  });
});

describe("shipEffectsOpacity / shouldPaintShipEffects (#187)", () => {
  it("treats empty inline opacity as fully visible", () => {
    expect(shipEffectsOpacity("")).toBe(1);
    expect(shouldPaintShipEffects("")).toBe(true);
  });

  it("parses the driver's inline fade values", () => {
    expect(shipEffectsOpacity("0.5")).toBe(0.5);
    expect(shouldPaintShipEffects("0.5")).toBe(true);
  });

  it("skips painting when the ship has fully faded out", () => {
    expect(shipEffectsOpacity("0")).toBe(0);
    expect(shouldPaintShipEffects("0")).toBe(false);
    expect(shouldPaintShipEffects("0.01")).toBe(false);
  });

  it("clamps out-of-range values", () => {
    expect(shipEffectsOpacity("1.5")).toBe(1);
    expect(shipEffectsOpacity("-0.2")).toBe(0);
  });
});
