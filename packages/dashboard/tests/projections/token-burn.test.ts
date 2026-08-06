import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION_DAYS,
  projectTokenBurn,
  TOKEN_BURN_WINDOW_MS,
} from "../../src/data/projections/tokenBurn.js";
import { envelope } from "../fixtures.js";

describe("projectTokenBurn", () => {
  const now = Date.parse("2026-06-15T12:30:00.000Z");

  it("buckets usage into 24 hourly cells and exposes the retention bound", () => {
    const tasks = [
      envelope({
        task_id: "t1",
        state: "completed",
        completed_at: "2026-06-15T11:15:00.000Z",
        usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 5 },
      }),
      envelope({
        task_id: "t2",
        state: "completed",
        completed_at: "2026-06-15T11:45:00.000Z",
        usage: { input_tokens: 50, output_tokens: 10 },
        cached_input_tokens: 3,
      }),
      // Outside 24h window — ignored.
      envelope({
        task_id: "old",
        state: "completed",
        completed_at: "2026-06-10T00:00:00.000Z",
        usage: { input_tokens: 999, output_tokens: 999 },
      }),
    ];

    const view = projectTokenBurn(tasks, { nowMs: now });
    expect(view.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(view.windowMs).toBe(TOKEN_BURN_WINDOW_MS);
    expect(view.asOfMs).toBe(now);
    expect(view.totals).toEqual({ input: 150, output: 30, cached: 8, tasks: 2 });
    expect(view.buckets.length).toBeGreaterThanOrEqual(24);
    const hour11 = view.buckets.find(
      (b) => b.hourStartMs === Date.parse("2026-06-15T11:00:00.000Z"),
    );
    expect(hour11).toMatchObject({ input: 150, output: 30, cached: 8, tasks: 2 });
  });

  it("allows an explicit retentionDays override", () => {
    const view = projectTokenBurn([], { nowMs: now, retentionDays: 7 });
    expect(view.retentionDays).toBe(7);
    expect(view.totals.tasks).toBe(0);
  });
});
