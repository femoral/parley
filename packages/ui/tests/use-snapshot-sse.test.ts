/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ParleyClient, type TaskRow, type TasksResponse } from "@useparley/core";
import { useSnapshot } from "../src/app/hooks/useSnapshot.js";
import { envelope, FakeEventSource, row } from "./fixtures.js";

/** A same-origin fetch stand-in serving `GET /tasks` and `GET /tasks/:ref`. */
function fakeDaemon(snapshot: TasksResponse, detailRows: Record<string, TaskRow>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/tasks") return new Response(JSON.stringify(snapshot), { status: 200 });
    const match = /^\/tasks\/([^/?]+)$/.exec(path);
    const detail = match && detailRows[decodeURIComponent(match[1]!)];
    if (detail) {
      return new Response(
        JSON.stringify({ task: envelope({ task_id: detail.id, state: detail.state }), row: detail }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  FakeEventSource.current = undefined;
});

describe("useSnapshot regroups live on SSE transitions (#66)", () => {
  it("a fake-vendor task moving states visibly re-sorts the roster without reload", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

    const snapshot: TasksResponse = {
      seq: 1,
      tasks: [
        row({
          id: "t1",
          state: "running",
          orchestrator_session_id: "sess-1",
          name: "chart-the-bay",
          branch: "feat/bay",
        }),
      ],
    };
    const client = new ParleyClient({ baseUrl: "", fetch: fakeDaemon(snapshot, {}) });

    const { result } = renderHook(() => useSnapshot(client));

    // Bootstrap settles: one running task, its own group, its session chip.
    await waitFor(() => expect(result.current.groups.map((g) => g.state)).toEqual(["running"]));
    expect(result.current.groups[0]!.tasks[0]!.name).toBe("chart-the-bay");
    expect(result.current.sessions).toEqual([{ id: "sess-1", label: "sess-1", count: 1 }]);
    expect(result.current.durableSessions).toBe(1);

    // The fake vendor raises a question — task.question moves t1 to
    // awaiting_answer, the top of the attention order.
    act(() => {
      FakeEventSource.current!.emit(
        "task.question",
        2,
        envelope({ task_id: "t1", name: "chart-the-bay", state: "awaiting_answer", branch: "feat/bay" }),
      );
    });
    await waitFor(() => expect(result.current.groups.map((g) => g.state)).toEqual(["awaiting_answer"]));
    expect(result.current.groups[0]!.tasks[0]!.name).toBe("chart-the-bay");
    // The envelope carries no orchestrator_session_id — the session grouping
    // must survive the transition, not blank out (the merge invariant).
    expect(result.current.sessions).toEqual([{ id: "sess-1", label: "sess-1", count: 1 }]);
    expect(result.current.durableSessions).toBe(1);

    // ...then completes — it moves to the quiet tail of the order, live,
    // with no reload/refetch of the whole hook.
    act(() => {
      FakeEventSource.current!.emit(
        "task.completed",
        3,
        envelope({ task_id: "t1", name: "chart-the-bay", state: "completed", branch: "feat/bay" }),
      );
    });
    await waitFor(() => expect(result.current.groups.map((g) => g.state)).toEqual(["completed"]));
    // Session chip stays (history keeps its grouping); durable count drops.
    expect(result.current.sessions).toEqual([{ id: "sess-1", label: "sess-1", count: 1 }]);
    expect(result.current.durableSessions).toBe(0);
  });

  it("a task born after bootstrap fetches its row once and joins its session", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

    const snapshot: TasksResponse = { seq: 1, tasks: [] };
    // Only GET /tasks/t2 knows the session — envelopes never carry it.
    const client = new ParleyClient({
      baseUrl: "",
      fetch: fakeDaemon(snapshot, {
        t2: row({ id: "t2", state: "running", orchestrator_session_id: "sess-2", name: "new-voyage" }),
      }),
    });

    const { result } = renderHook(() => useSnapshot(client));
    await waitFor(() => expect(result.current.totalTasks).toBe(0));

    // The orchestrator delegates a new task while the cockpit is open: it
    // arrives only as an envelope, which has no orchestrator_session_id.
    act(() => {
      FakeEventSource.current!.emit("task.started", 2, envelope({ task_id: "t2", state: "running" }));
    });
    await waitFor(() => expect(result.current.totalTasks).toBe(1));

    // The hook repairs the missing session from the task's row — the new task
    // must appear under its session chip without a page reload.
    await waitFor(() =>
      expect(result.current.sessions).toEqual([{ id: "sess-2", label: "sess-2", count: 1 }]),
    );
    expect(result.current.durableSessions).toBe(1);
  });
});
