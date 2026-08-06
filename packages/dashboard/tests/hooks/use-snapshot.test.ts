/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ParleyClient, type TasksResponse } from "@useparley/core";
import { useSnapshot } from "../../src/data/useSnapshot.js";
import { envelope, FakeEventSource } from "../fixtures.js";

function fakeDaemon(snapshot: TasksResponse): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/tasks" || path.endsWith("/tasks")) {
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

async function flushEmitTick(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
  });
}

const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  FakeEventSource.current = undefined;
});

describe("useSnapshot", () => {
  it("bootstraps full envelopes and merges SSE transitions", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

    const snapshot: TasksResponse = {
      seq: 1,
      tasks: [
        envelope({
          task_id: "t1",
          state: "running",
          usage: { input_tokens: 10, output_tokens: 2 },
          duration_ms: null,
        }),
      ],
    };
    const client = new ParleyClient({ baseUrl: "", fetch: fakeDaemon(snapshot) });
    const { result } = renderHook(() => useSnapshot(client));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.connected).toBe(true);
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0]!.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(result.current.activeTasks).toBe(1);

    act(() => {
      FakeEventSource.current!.emit(
        "task.completed",
        2,
        envelope({
          task_id: "t1",
          state: "completed",
          usage: { input_tokens: 12, output_tokens: 4 },
          duration_ms: 1500,
          report: {
            summary: "done",
            outcome: "success",
            files_changed: [{ path: "a.ts", added: 1, removed: 0 }],
          },
        }),
      );
    });
    await flushEmitTick();
    await waitFor(() => expect(result.current.tasks[0]!.state).toBe("completed"));
    expect(result.current.tasks[0]!.duration_ms).toBe(1500);
    expect(result.current.tasks[0]!.report?.files_changed).toEqual([
      { path: "a.ts", added: 1, removed: 0 },
    ]);
    expect(result.current.activeTasks).toBe(0);
  });

  it("marks disconnected on stream error", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: fakeDaemon({ seq: 0, tasks: [] }),
    });
    const { result } = renderHook(() => useSnapshot(client));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      FakeEventSource.current!.emitError();
    });
    await waitFor(() => expect(result.current.connected).toBe(false));
    expect(result.current.streamLostSince).not.toBeNull();
  });
});
