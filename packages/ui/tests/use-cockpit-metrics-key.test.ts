/** @vitest-environment happy-dom */
/**
 * Asserts useCockpit gates metricsRefreshKey on Soundings mode: Cove keeps a
 * stable empty string (skipping the O(n) id:state join on every SSE tick);
 * Soundings recomputes when tasks transition.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterTaskInput } from "../src/app/hooks/roster.js";
import type { SnapshotView } from "../src/app/hooks/useSnapshot.js";
import type { UseMetricsOptions } from "../src/app/hooks/useMetrics.js";
import { metricsRefreshKey } from "../src/app/hooks/metrics.js";

const metricsOptions: UseMetricsOptions[] = [];

function taskFixture(overrides: Partial<RosterTaskInput> = {}): RosterTaskInput {
  return {
    id: "t1",
    name: "alpha",
    vendor: "codex",
    model: "gpt",
    orchHarness: null,
    state: "running",
    branch: null,
    orchestratorSession: null,
    question: null,
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

/** Mutable live snapshot — reassign `tasks` (new array) to mimic SSE revisions. */
const snapshot = vi.hoisted(() => {
  const state: { tasks: RosterTaskInput[] } = {
    tasks: [
      {
        id: "t1",
        name: "alpha",
        vendor: "codex",
        model: "gpt",
        orchHarness: null,
        state: "running",
        branch: null,
        orchestratorSession: null,
        question: null,
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
    ],
  };
  return {
    get tasks() {
      return state.tasks;
    },
    set tasks(next: RosterTaskInput[]) {
      state.tasks = next;
    },
    view(): SnapshotView {
      return {
        tasks: state.tasks,
        groups: [],
        sessions: [],
        inbox: [],
        scene: { sessions: [] },
        totalTasks: state.tasks.length,
        activeTasks: state.tasks.filter((t) => t.state === "running").length,
        durableSessions: 0,
        connected: true,
        ready: true,
        streamLostSince: null,
      };
    },
  };
});

vi.mock("../src/app/hooks/useMetrics.js", () => ({
  useMetrics: (_client: unknown, options: UseMetricsOptions) => {
    metricsOptions.push({ ...options });
    return {
      status: "idle" as const,
      data: null,
      error: null,
      session: options.session,
      groupBy: options.groupBy,
    };
  },
}));

vi.mock("../src/app/hooks/useSnapshot.js", () => ({
  useSnapshot: () => snapshot.view(),
}));

vi.mock("../src/app/hooks/useHealth.js", () => ({
  useHealth: () => ({
    online: true,
    version: "1.0.0",
    pid: 1,
    startedAt: Date.parse("2026-01-01T00:00:00.000Z"),
  }),
}));

vi.mock("../src/app/hooks/useTaskDetail.js", () => ({
  useTaskDetail: () => null,
}));

vi.mock("../src/app/hooks/useLogTail.js", () => ({
  useLogTail: () => ({ lines: [], status: "ended" as const }),
}));

import { useCockpit } from "../src/app/hooks/useCockpit.js";

function lastRefreshKey(): string {
  const last = metricsOptions[metricsOptions.length - 1];
  if (!last) throw new Error("useMetrics was never called");
  return last.refreshKey;
}

describe("useCockpit metrics refreshKey gating", () => {
  beforeEach(() => {
    metricsOptions.length = 0;
    snapshot.tasks = [taskFixture()];
  });

  it("passes a stable empty refreshKey while mode is cove (Soundings unmounted)", () => {
    const { result, rerender } = renderHook(() => useCockpit());
    expect(result.current.mode).toBe("cove");
    expect(lastRefreshKey()).toBe("");

    // SSE-style task transition while still on Cove — must not rebuild the key.
    snapshot.tasks = [taskFixture({ state: "completed" })];
    rerender();
    expect(result.current.mode).toBe("cove");
    expect(lastRefreshKey()).toBe("");

    snapshot.tasks = [
      taskFixture({ state: "completed" }),
      taskFixture({
        id: "t2",
        name: "beta",
        state: "running",
        updatedAt: "2026-07-16T00:01:00.000Z",
      }),
    ];
    rerender();
    expect(lastRefreshKey()).toBe("");
    // Every call under Cove stayed empty (identity-stable for useMetrics).
    expect(metricsOptions.every((o) => o.refreshKey === "")).toBe(true);
    expect(metricsOptions.every((o) => o.enabled === false)).toBe(true);
  });

  it("recomputes metricsRefreshKey only in soundings mode", () => {
    const { result, rerender } = renderHook(() => useCockpit());
    expect(lastRefreshKey()).toBe("");

    act(() => {
      result.current.setMode("soundings");
    });
    expect(result.current.mode).toBe("soundings");
    expect(lastRefreshKey()).toBe(metricsRefreshKey(snapshot.tasks));
    expect(lastRefreshKey()).toBe("t1:running");

    const keyWhileSoundings = lastRefreshKey();
    // New array identity, same as useSnapshot after an SSE transition.
    snapshot.tasks = [taskFixture({ state: "failed" })];
    rerender();
    expect(lastRefreshKey()).toBe(metricsRefreshKey(snapshot.tasks));
    expect(lastRefreshKey()).toBe("t1:failed");
    expect(lastRefreshKey()).not.toBe(keyWhileSoundings);

    act(() => {
      result.current.setMode("cove");
    });
    expect(lastRefreshKey()).toBe("");
  });
});
