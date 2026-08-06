/** @vitest-environment happy-dom */
/**
 * HIGH-4: after a successful bootstrap, an SSE drop must re-bootstrap
 * (with backoff) so an idle fleet re-arms `connected` without a task event.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParleyClient, type TasksResponse } from "@useparley/core";
import { STREAM_RETRY_MS, useSnapshot } from "../../src/data/useSnapshot.js";
import { FakeEventSource } from "../fixtures.js";

const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  FakeEventSource.current = undefined;
  vi.useRealTimers();
});

function fakeDaemon(snapshot: TasksResponse, onList?: () => void): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/tasks" || path.endsWith("/tasks")) {
      onList?.();
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

describe("useSnapshot SSE re-bootstrap (HIGH-4)", () => {
  it("re-connects after stream error on an idle fleet (no task events)", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let listCount = 0;
    const snapshot: TasksResponse = { seq: 1, tasks: [] };
    const client = new ParleyClient({
      baseUrl: "",
      fetch: fakeDaemon(snapshot, () => {
        listCount += 1;
      }),
    });

    const { result } = renderHook(() => useSnapshot(client));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.connected).toBe(true);
    expect(listCount).toBe(1);
    const es = FakeEventSource.current;
    expect(es).toBeDefined();

    // SSE drop — no task events will arrive (idle fleet).
    act(() => {
      es!.emitError();
    });
    await waitFor(() => expect(result.current.connected).toBe(false));

    // Advance past STREAM_RETRY_MS — re-bootstrap must run without a task event.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS + 50);
    });

    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(listCount).toBeGreaterThanOrEqual(2);
    expect(result.current.ready).toBe(true);
  });

  it("exports STREAM_RETRY_MS used by the reconnect timer (neuter target)", () => {
    // Wiring: if reconnect is deleted, this constant is unused and HIGH-4
    // behavioral test fails; keep the export as an explicit contract.
    expect(STREAM_RETRY_MS).toBe(3000);
    // Source must schedule setTimeout with STREAM_RETRY_MS on stream error.
    // (behavioral coverage above is the real proof; this pins the constant.)
    expect(STREAM_RETRY_MS).toBeGreaterThan(0);
  });
});
