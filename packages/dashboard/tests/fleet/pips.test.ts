import { describe, expect, it } from "vitest";
import {
  buildListPipTrack,
  buildPipTrack,
  describePipTrack,
  pipsForRun,
  visiblePipTrack,
  PIP_VISIBLE_CAP,
} from "../../src/screens/fleet/pips.js";
import { run } from "./fixtures.js";

describe("buildListPipTrack — fail pip integrity", () => {
  it("keeps a fail pip when tasks_settled equals the bound (prior overwrite defect)", () => {
    const summary = run({
      run_id: "fail-full",
      state: "failed",
      track_bound: 4,
      tasks_settled: 4,
      tasks_total: 4,
    });
    const pips = buildListPipTrack(summary);
    expect(pips).toHaveLength(4);
    // Prior slots done; mark index is last slot and is fail — never all done.
    expect(pips.map((p) => p.kind)).toEqual(["done", "done", "done", "fail"]);
    expect(pips.some((p) => p.kind === "fail")).toBe(true);
    expect(pips.every((p) => p.kind === "done")).toBe(false);
  });

  it("keeps a fail pip when tasks_settled exceeds the bound (fan-out wider than track)", () => {
    const summary = run({
      run_id: "fail-wide",
      state: "failed",
      track_bound: 3,
      tasks_settled: 12,
      tasks_total: 12,
    });
    const pips = buildListPipTrack(summary);
    expect(pips.map((p) => p.kind)).toEqual(["done", "done", "fail"]);
  });

  it("places fail at tasks_settled index when mid-track", () => {
    const summary = run({
      run_id: "fail-mid",
      state: "failed",
      track_bound: 6,
      tasks_settled: 2,
      tasks_total: 6,
    });
    const pips = buildListPipTrack(summary);
    expect(pips.map((p) => p.kind)).toEqual([
      "done",
      "done",
      "fail",
      "empty",
      "empty",
      "empty",
    ]);
  });

  it("does not paint pending slots as live", () => {
    const summary = run({
      run_id: "running-early",
      state: "running",
      track_bound: 5,
      iteration: 1,
      tasks_settled: 0,
    });
    const pips = buildListPipTrack(summary);
    expect(pips[0]?.kind).toBe("live");
    expect(pips.slice(1).every((p) => p.kind === "empty")).toBe(true);
  });
});

describe("buildPipTrack from list track slice", () => {
  it("maps failed track nodes to fail pips and leaves unbound slots empty", () => {
    const pips = buildPipTrack(
      [
        {
          kind: "step",
          state: "completed",
          tasks_settled: 1,
          tasks_total: 1,
        },
        {
          kind: "step",
          state: "failed",
          tasks_settled: 1,
          tasks_total: 1,
        },
        {
          kind: "gate",
          state: "waiting",
          tasks_settled: 0,
          tasks_total: 0,
        },
      ],
      5,
    );
    expect(pips.map((p) => p.kind)).toEqual([
      "done",
      "fail",
      "gate",
      "empty",
      "empty",
    ]);
  });
});

describe("pipsForRun prefers track when present", () => {
  it("uses track over list fallback", () => {
    const summary = run({
      run_id: "with-track",
      state: "failed",
      track_bound: 3,
      tasks_settled: 99,
      track: [
        {
          kind: "step",
          state: "completed",
          tasks_settled: 1,
          tasks_total: 1,
        },
        {
          kind: "step",
          state: "failed",
          tasks_settled: 1,
          tasks_total: 1,
        },
      ],
    });
    const pips = pipsForRun(summary);
    expect(pips.map((p) => p.kind)).toEqual(["done", "fail", "empty"]);
  });
});

describe("visiblePipTrack severity aggregation", () => {
  it("preserves fail when aggregating past the cap", () => {
    const long = Array.from({ length: PIP_VISIBLE_CAP + 10 }, (_, i) => ({
      kind: i === 25 ? ("fail" as const) : ("done" as const),
    }));
    const visible = visiblePipTrack(long);
    expect(visible).toHaveLength(PIP_VISIBLE_CAP);
    expect(visible.some((p) => p.kind === "fail")).toBe(true);
  });

  it("describePipTrack reports full bound", () => {
    const pips = buildListPipTrack(
      run({
        run_id: "d",
        state: "failed",
        track_bound: 4,
        tasks_settled: 2,
      }),
    );
    expect(describePipTrack(pips)).toMatch(/Progress of 4/);
    expect(describePipTrack(pips)).toMatch(/failed/);
  });
});
