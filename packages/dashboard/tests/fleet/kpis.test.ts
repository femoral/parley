import { describe, expect, it } from "vitest";
import {
  deriveConcurrencyCap,
  projectFleetKpis,
} from "../../src/screens/fleet/kpis.js";
import { run, task } from "./fixtures.js";

describe("deriveConcurrencyCap", () => {
  it("returns null when no task exposes max_concurrent (honest absence)", () => {
    expect(
      deriveConcurrencyCap([
        task({ task_id: "a", state: "running" }),
        task({ task_id: "b", state: "queued", queue_position: 1 }),
      ]),
    ).toBeNull();
  });

  it("reads max_concurrent from envelopes when present", () => {
    expect(
      deriveConcurrencyCap([
        task({
          task_id: "a",
          state: "queued",
          max_concurrent: 2,
          blocking_cap: "vendor:fake",
          queue_position: 1,
        }),
      ]),
    ).toBe(2);
  });
});

describe("projectFleetKpis", () => {
  it("shows running/cap when max_concurrent is known", () => {
    const kpis = projectFleetKpis({
      tasks: [
        task({
          task_id: "r1",
          state: "running",
          max_concurrent: 2,
        }),
        task({
          task_id: "r2",
          state: "running",
          max_concurrent: 2,
        }),
        task({
          task_id: "q1",
          state: "queued",
          max_concurrent: 2,
          queue_position: 1,
          blocking_cap: "vendor:fake",
        }),
      ],
      runs: [],
    });
    const running = kpis.find((k) => k.id === "running");
    expect(running?.value).toBe("2/2");
    expect(running?.note).toMatch(/cap 2/);
    expect(running?.note).toMatch(/1 queued/);
  });

  it("does not invent a cap denominator when max_concurrent is absent", () => {
    const kpis = projectFleetKpis({
      tasks: [
        task({ task_id: "r1", state: "running" }),
        task({ task_id: "q1", state: "queued", queue_position: 3 }),
      ],
      runs: [run({ run_id: "x", state: "running" })],
    });
    const running = kpis.find((k) => k.id === "running");
    expect(running?.value).toBe("1");
    expect(running?.note).toMatch(/cap unknown/);
    expect(running?.value).not.toMatch(/\//);
  });

  it("counts held gates in needs-orchestrator", () => {
    const kpis = projectFleetKpis({
      tasks: [
        task({ task_id: "ask", state: "awaiting_answer" }),
      ],
      runs: [
        run({
          run_id: "g",
          state: "blocked",
          block: {
            reason: "gate",
            node: "land",
            iteration: 1,
            detail: null,
            verbs: ["approve"],
          },
        }),
      ],
    });
    const needs = kpis.find((k) => k.id === "needs-orch");
    expect(needs?.value).toBe("2");
    expect(needs?.note).toMatch(/1 held gate/);
  });
});
