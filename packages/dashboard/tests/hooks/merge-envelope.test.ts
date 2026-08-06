import { describe, expect, it } from "vitest";
import { mergeEnvelope, evictTerminalOverflow } from "../../src/data/useSnapshot.js";
import { projectQueueContext } from "../../src/data/projections/queueContext.js";
import { envelope } from "../fixtures.js";
import type { StreamEvent, TaskEnvelope } from "@useparley/core";

function event(task: TaskEnvelope, name = "task.started"): StreamEvent {
  return { seq: task.seq, event: name, task };
}

describe("mergeEnvelope clear semantics (MED-1)", () => {
  it("does not revive null-cleared usage/report/duration/completed_at", () => {
    const prev = envelope({
      task_id: "t1",
      state: "running",
      usage: { input_tokens: 100, output_tokens: 10 },
      report: { summary: "old", outcome: "success", files_changed: [] },
      duration_ms: 5000,
      completed_at: "2026-01-01T00:00:00.000Z",
      orch_harness: "claude",
      orch_model: "opus",
      orch_effort: "high",
    });
    const next = envelope({
      task_id: "t1",
      state: "running",
      usage: null,
      report: null,
      duration_ms: null,
      completed_at: null,
      orch_harness: null,
      orch_model: null,
      orch_effort: null,
    });
    const merged = mergeEnvelope(prev, event(next));
    expect(merged.usage).toBeNull();
    expect(merged.report).toBeNull();
    expect(merged.duration_ms).toBeNull();
    expect(merged.completed_at).toBeNull();
    expect(merged.orch_harness).toBeNull();
    expect(merged.orch_model).toBeNull();
    expect(merged.orch_effort).toBeNull();
  });

  it("keeps prior when wire omits optional fields (undefined)", () => {
    const prev = envelope({
      task_id: "t1",
      state: "queued",
      queue_position: 3,
      blocking_cap: "vendor:fake",
      max_concurrent: 2,
      usage: { input_tokens: 1 },
    });
    // Simulate a partial envelope that re-spreads only required fields.
    const partial = {
      ...envelope({ task_id: "t1", state: "queued" }),
      usage: undefined as unknown as null,
      queue_position: undefined,
      blocking_cap: undefined,
      max_concurrent: undefined,
    } as TaskEnvelope;
    // Force undefined by deleting after construct (spread may still set null).
    delete (partial as { usage?: unknown }).usage;
    delete (partial as { queue_position?: unknown }).queue_position;
    delete (partial as { blocking_cap?: unknown }).blocking_cap;
    delete (partial as { max_concurrent?: unknown }).max_concurrent;

    const merged = mergeEnvelope(prev, event(partial));
    expect(merged.usage).toEqual({ input_tokens: 1 });
    expect(merged.queue_position).toBe(3);
    expect(merged.blocking_cap).toBe("vendor:fake");
    expect(merged.max_concurrent).toBe(2);
  });

  it("projectQueueContext ignores stale queue fields when state is running", () => {
    // Chained consequence: merge left queue fields, state advanced to running.
    const view = projectQueueContext({
      state: "running",
      queue_position: 3,
      blocking_cap: "vendor:fake",
      max_concurrent: 2,
    });
    expect(view.label).toBeNull();
    expect(view.position).toBeNull();
  });
});

describe("evictTerminalOverflow", () => {
  it("drops oldest terminal tasks over the cap; keeps active", () => {
    const map = new Map<string, TaskEnvelope>();
    for (let i = 0; i < 5; i++) {
      map.set(
        `done-${i}`,
        envelope({
          task_id: `done-${i}`,
          state: "completed",
          updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }
    map.set(
      "live",
      envelope({
        task_id: "live",
        state: "running",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    evictTerminalOverflow(map, 2);
    expect(map.has("live")).toBe(true);
    expect(map.size).toBe(3); // 2 terminal + 1 live
    expect(map.has("done-3")).toBe(true);
    expect(map.has("done-4")).toBe(true);
    expect(map.has("done-0")).toBe(false);
  });
});
