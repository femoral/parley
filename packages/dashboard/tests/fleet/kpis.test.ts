import { describe, expect, it } from "vitest";
import {
  countSettled24h,
  deriveConcurrencyCap,
  inLast24h,
  projectFleetKpis,
} from "../../src/screens/fleet/kpis.js";
import { run, task } from "./fixtures.js";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");

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

describe("24h window for settled + token-burn KPIs", () => {
  it("excludes tasks older than 24h from settled 24h counts", () => {
    const settled = countSettled24h(
      [
        task({
          task_id: "old-done",
          state: "completed",
          completed_at: "2026-06-05T12:00:00.000Z",
          updated_at: "2026-06-05T12:00:00.000Z",
        }),
        task({
          task_id: "old-fail",
          state: "failed",
          completed_at: "2026-06-05T12:00:00.000Z",
          updated_at: "2026-06-05T12:00:00.000Z",
        }),
        task({
          task_id: "new-done",
          state: "completed",
          completed_at: "2026-06-15T11:00:00.000Z",
          updated_at: "2026-06-15T11:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(settled).toEqual({ completed: 1, failed: 0 });
  });

  it("settled 24h KPI ignores 10-day-old tasks (probe from merge validator)", () => {
    const kpis = projectFleetKpis({
      nowMs: NOW,
      tasks: [
        task({
          task_id: "old-a",
          state: "completed",
          completed_at: "2026-06-05T12:00:00.000Z",
          usage: { input_tokens: 900_000, output_tokens: 1 },
        }),
        task({
          task_id: "old-b",
          state: "failed",
          completed_at: "2026-06-05T12:00:00.000Z",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ],
      runs: [],
    });
    const settled = kpis.find((k) => k.id === "settled");
    expect(settled?.value).toBe("0 / 0");
    const burn = kpis.find((k) => k.id === "token-burn");
    // Must not report 900k from a 10-day-old task.
    expect(burn?.value).toBe("0");
  });

  it("includes in-window completed usage in token-burn KPI", () => {
    const kpis = projectFleetKpis({
      nowMs: NOW,
      tasks: [
        task({
          task_id: "fresh",
          state: "completed",
          completed_at: "2026-06-15T11:30:00.000Z",
          usage: { input_tokens: 1500, output_tokens: 200 },
        }),
      ],
      runs: [],
    });
    const settled = kpis.find((k) => k.id === "settled");
    expect(settled?.value).toBe("1 / 0");
    const burn = kpis.find((k) => k.id === "token-burn");
    expect(burn?.value).toBe("1.5k");
    expect(inLast24h(
      task({
        task_id: "fresh",
        state: "completed",
        completed_at: "2026-06-15T11:30:00.000Z",
      }),
      NOW,
    )).toBe(true);
  });
});

describe("projectFleetKpis", () => {
  it("shows running/cap when max_concurrent is known", () => {
    const kpis = projectFleetKpis({
      nowMs: NOW,
      tasks: [
        task({
          task_id: "r1",
          state: "running",
          max_concurrent: 2,
          started_at: "2026-06-15T11:00:00.000Z",
        }),
        task({
          task_id: "r2",
          state: "running",
          max_concurrent: 2,
          started_at: "2026-06-15T11:00:00.000Z",
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
      nowMs: NOW,
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
      nowMs: NOW,
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
    expect(needs?.note).toMatch(/1 held/);
  });
});
