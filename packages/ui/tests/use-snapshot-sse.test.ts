/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ParleyClient, type TasksResponse } from "@useparley/core";
import { useSnapshot } from "../src/app/hooks/useSnapshot.js";
import { envelope, FakeEventSource } from "./fixtures.js";

/** A same-origin fetch stand-in serving `GET /tasks` (envelope list, #208). */
function fakeDaemon(snapshot: TasksResponse): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/tasks") return new Response(JSON.stringify(snapshot), { status: 200 });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  FakeEventSource.current = undefined;
});

describe("useSnapshot regroups live on SSE transitions (#66 / #208)", () => {
  it("a fake-vendor task moving states visibly re-sorts the roster without reload", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

    const snapshot: TasksResponse = {
      seq: 1,
      tasks: [
        envelope({
          task_id: "t1",
          state: "running",
          orchestrator_session_id: "sess-1",
          name: "chart-the-bay",
          branch: "feat/bay",
          orch_harness: "claude",
          updated_at: "2026-01-01T00:00:01.000Z",
        }),
      ],
    };
    const client = new ParleyClient({ baseUrl: "", fetch: fakeDaemon(snapshot) });

    const { result } = renderHook(() => useSnapshot(client));

    // Bootstrap settles: one running task, its own group, its session chip.
    await waitFor(() => expect(result.current.groups.map((g) => g.state)).toEqual(["running"]));
    expect(result.current.connected).toBe(true);
    expect(result.current.streamLostSince).toBeNull();
    expect(result.current.groups[0]!.tasks[0]!.name).toBe("chart-the-bay");
    expect(result.current.sessions).toEqual([
      {
        id: "sess-1",
        handle: "chart-the-bay",
        shortRef: "sess-1",
        label: "chart-the-bay · 1 task",
        count: 1,
      },
    ]);
    expect(result.current.durableSessions).toBe(1);

    // The fake vendor raises a question — task.question moves t1 to
    // awaiting_answer, the top of the attention order. Session rides the
    // envelope (#208), so grouping survives without a row fetch.
    act(() => {
      FakeEventSource.current!.emit(
        "task.question",
        2,
        envelope({
          task_id: "t1",
          name: "chart-the-bay",
          state: "awaiting_answer",
          branch: "feat/bay",
          orchestrator_session_id: "sess-1",
          orch_harness: "claude",
          updated_at: "2026-01-01T00:00:02.000Z",
        }),
      );
    });
    await waitFor(() => expect(result.current.groups.map((g) => g.state)).toEqual(["awaiting_answer"]));
    expect(result.current.groups[0]!.tasks[0]!.name).toBe("chart-the-bay");
    expect(result.current.sessions).toEqual([
      {
        id: "sess-1",
        handle: "chart-the-bay",
        shortRef: "sess-1",
        label: "chart-the-bay · 1 task",
        count: 1,
      },
    ]);
    expect(result.current.durableSessions).toBe(1);

    // ...then completes — it moves to the quiet tail of the order, live,
    // with no reload/refetch of the whole hook.
    act(() => {
      FakeEventSource.current!.emit(
        "task.completed",
        3,
        envelope({
          task_id: "t1",
          name: "chart-the-bay",
          state: "completed",
          branch: "feat/bay",
          orchestrator_session_id: "sess-1",
          orch_harness: "claude",
          updated_at: "2026-01-01T00:00:03.000Z",
        }),
      );
    });
    await waitFor(() => expect(result.current.groups.map((g) => g.state)).toEqual(["completed"]));
    // Session chip stays (history keeps its grouping); durable count drops.
    expect(result.current.sessions).toEqual([
      {
        id: "sess-1",
        handle: "chart-the-bay",
        shortRef: "sess-1",
        label: "chart-the-bay · 1 task",
        count: 1,
      },
    ]);
    expect(result.current.durableSessions).toBe(0);
  });

  it("a task born after bootstrap joins its session from the envelope alone", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

    const snapshot: TasksResponse = { seq: 1, tasks: [] };
    const client = new ParleyClient({
      baseUrl: "",
      fetch: fakeDaemon(snapshot),
    });

    const { result } = renderHook(() => useSnapshot(client));
    await waitFor(() => expect(result.current.totalTasks).toBe(0));

    // The orchestrator delegates a new task while the cockpit is open: it
    // arrives as a full envelope with session/recency (#208) — no GET detail.
    act(() => {
      FakeEventSource.current!.emit(
        "task.started",
        2,
        envelope({
          task_id: "t2",
          state: "running",
          name: "new-voyage",
          orchestrator_session_id: "sess-2",
          orch_harness: "codex",
          updated_at: "2026-01-01T00:00:02.000Z",
        }),
      );
    });
    await waitFor(() => expect(result.current.totalTasks).toBe(1));
    await waitFor(() =>
      expect(result.current.sessions).toEqual([
        {
          id: "sess-2",
          handle: "new-voyage",
          shortRef: "sess-2",
          label: "new-voyage · 1 task",
          count: 1,
        },
      ]),
    );
    expect(result.current.durableSessions).toBe(1);
  });
});

describe("useSnapshot connection / stream-lost signal", () => {
  it("latches ready after the first successful bootstrap (even with an empty fleet)", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: fakeDaemon({ seq: 1, tasks: [] }),
    });
    const { result } = renderHook(() => useSnapshot(client));
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.connected).toBe(true);
    expect(result.current.totalTasks).toBe(0);
  });

  it("starts disconnected with streamLostSince set, then connects on bootstrap", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

    const client = new ParleyClient({
      baseUrl: "",
      fetch: fakeDaemon({ seq: 1, tasks: [] }),
    });
    const { result } = renderHook(() => useSnapshot(client));

    expect(result.current.connected).toBe(false);
    expect(result.current.streamLostSince).toEqual(expect.any(Number));

    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.streamLostSince).toBeNull();
  });

  it("marks disconnected on bootstrap failure and keeps streamLostSince", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

    const failing: typeof fetch = (async () => {
      throw new Error("daemon down");
    }) as typeof fetch;
    const client = new ParleyClient({ baseUrl: "", fetch: failing });
    const { result } = renderHook(() => useSnapshot(client));

    await waitFor(() => {
      expect(result.current.connected).toBe(false);
      expect(result.current.streamLostSince).toEqual(expect.any(Number));
    });
    const lostAt = result.current.streamLostSince;

    // Stay disconnected across the retry window — no successful bootstrap yet.
    await waitFor(() => expect(result.current.connected).toBe(false));
    expect(result.current.streamLostSince).toBe(lostAt);
  });

  it("flips connected false on stream error, recovers on the next event", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

    const snapshot: TasksResponse = {
      seq: 1,
      tasks: [
        envelope({
          task_id: "t1",
          state: "running",
          orchestrator_session_id: "sess-1",
        }),
      ],
    };
    const client = new ParleyClient({ baseUrl: "", fetch: fakeDaemon(snapshot) });
    const { result } = renderHook(() => useSnapshot(client));

    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      FakeEventSource.current!.emitError();
    });
    await waitFor(() => expect(result.current.connected).toBe(false));
    expect(result.current.streamLostSince).toEqual(expect.any(Number));
    // Prior fleet data is retained — honesty is the signal, not a blank chart.
    expect(result.current.totalTasks).toBe(1);

    act(() => {
      FakeEventSource.current!.emit(
        "task.started",
        2,
        envelope({
          task_id: "t1",
          state: "running",
          name: "still-here",
          orchestrator_session_id: "sess-1",
        }),
      );
    });
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.streamLostSince).toBeNull();
  });
});
