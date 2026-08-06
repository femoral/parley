import { describe, expect, it } from "vitest";
import {
  isFreshFailure,
  sortRunsByAttention,
  sortTasksByAttention,
} from "../../src/screens/fleet/attentionSort.js";
import { run, task } from "./fixtures.js";

describe("sortTasksByAttention", () => {
  it("surfaces questions, stalls, and failures before calm progress", () => {
    const tasks = [
      task({ task_id: "done", state: "completed", updated_at: "2026-01-01T00:00:00.000Z" }),
      task({ task_id: "run", state: "running", updated_at: "2026-01-01T00:01:00.000Z" }),
      task({ task_id: "fail", state: "failed", updated_at: "2026-01-01T00:02:00.000Z" }),
      task({ task_id: "ask", state: "awaiting_answer", updated_at: "2026-01-01T00:03:00.000Z" }),
      task({ task_id: "stall", state: "stalled", updated_at: "2026-01-01T00:04:00.000Z" }),
      task({ task_id: "queue", state: "queued", updated_at: "2026-01-01T00:05:00.000Z" }),
    ];
    const ids = sortTasksByAttention(tasks).map((t) => t.task_id);
    expect(ids).toEqual(["ask", "stall", "fail", "run", "queue", "done"]);
  });

  it("within a rank, older tasks sort first", () => {
    const tasks = [
      task({
        task_id: "new-ask",
        state: "awaiting_answer",
        updated_at: "2026-01-01T02:00:00.000Z",
      }),
      task({
        task_id: "old-ask",
        state: "awaiting_answer",
        updated_at: "2026-01-01T01:00:00.000Z",
      }),
    ];
    expect(sortTasksByAttention(tasks).map((t) => t.task_id)).toEqual([
      "old-ask",
      "new-ask",
    ]);
  });
});

describe("isFreshFailure", () => {
  const now = Date.parse("2026-06-15T12:00:00.000Z");

  it("is true within the 5-minute window", () => {
    expect(
      isFreshFailure(
        task({
          task_id: "f",
          state: "failed",
          completed_at: "2026-06-15T11:56:00.000Z",
        }),
        now,
      ),
    ).toBe(true);
  });

  it("is false outside the window", () => {
    expect(
      isFreshFailure(
        task({
          task_id: "f",
          state: "failed",
          completed_at: "2026-06-15T11:00:00.000Z",
        }),
        now,
      ),
    ).toBe(false);
  });
});

describe("sortRunsByAttention", () => {
  it("puts held gates first", () => {
    const runs = [
      run({ run_id: "r1", state: "running" }),
      run({
        run_id: "r2",
        state: "blocked",
        block: {
          reason: "gate",
          node: "review",
          iteration: 1,
          detail: null,
          verbs: ["approve", "reject"],
        },
      }),
      run({ run_id: "r3", state: "failed" }),
    ];
    expect(sortRunsByAttention(runs).map((r) => r.run_id)).toEqual([
      "r2",
      "r3",
      "r1",
    ]);
  });
});
