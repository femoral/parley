import { describe, expect, it } from "vitest";
import { projectQueueContext } from "../../src/data/projections/queueContext.js";

describe("projectQueueContext", () => {
  it("formats QUEUED #N · cap max/max when max_concurrent is known", () => {
    const view = projectQueueContext({
      state: "queued",
      queue_position: 3,
      blocking_cap: "vendor:claude",
      max_concurrent: 2,
    });
    expect(view.label).toBe("QUEUED #3 · vendor:claude 2/2");
    expect(view.position).toBe(3);
    expect(view.blockingCap).toBe("vendor:claude");
    expect(view.maxConcurrent).toBe(2);
  });

  it("omits denominator when max_concurrent is null", () => {
    const view = projectQueueContext({
      state: "queued",
      queue_position: 1,
      blocking_cap: "vendor:fake",
      max_concurrent: null,
    });
    expect(view.label).toBe("QUEUED #1 · vendor:fake");
  });

  it("returns null label when not queued", () => {
    const view = projectQueueContext({
      state: "running",
      queue_position: null,
      blocking_cap: null,
      max_concurrent: null,
    });
    expect(view.label).toBeNull();
  });

  it("does not label QUEUED when state is running even with queue fields present", () => {
    // Stale queue fields after state advanced (merge clear / partial wire).
    const view = projectQueueContext({
      state: "running",
      queue_position: 3,
      blocking_cap: "vendor:fake",
      max_concurrent: 2,
    });
    expect(view.label).toBeNull();
    expect(view.position).toBeNull();
    expect(view.blockingCap).toBeNull();
    expect(view.maxConcurrent).toBeNull();
  });
});
