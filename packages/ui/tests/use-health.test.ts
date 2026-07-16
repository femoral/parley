/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParleyClient } from "@useparley/core";
import { useHealth } from "../src/app/hooks/useHealth.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("useHealth reachable / unreachable signal", () => {
  it("sets online true with version/pid/startedAt on a successful probe", async () => {
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            version: "1.2.3",
            pid: 99,
            started_at: "2026-01-01T00:00:00.000Z",
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    const { result } = renderHook(() => useHealth(client, 60_000));
    await waitFor(() => expect(result.current.online).toBe(true));
    expect(result.current.version).toBe("1.2.3");
    expect(result.current.pid).toBe(99);
    expect(result.current.startedAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("flips online false on probe failure while keeping last-known version/pid", async () => {
    let fail = false;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () => {
        if (fail) throw new Error("unreachable");
        return new Response(
          JSON.stringify({
            version: "0.1.0",
            pid: 7,
            started_at: "2026-01-01T00:00:00.000Z",
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    const { result } = renderHook(() => useHealth(client, 50));
    await waitFor(() => expect(result.current.online).toBe(true));
    expect(result.current.version).toBe("0.1.0");

    fail = true;
    await waitFor(() => expect(result.current.online).toBe(false));
    // Last successful probe's identity stays — panel doesn't blank between beats.
    expect(result.current.version).toBe("0.1.0");
    expect(result.current.pid).toBe(7);
  });

  it("starts unreachable before the first probe settles", () => {
    const client = new ParleyClient({
      baseUrl: "",
      // Never resolves during this sync assertion.
      fetch: (() => new Promise(() => {})) as typeof fetch,
    });
    const { result } = renderHook(() => useHealth(client, 60_000));
    expect(result.current.online).toBe(false);
    expect(result.current.version).toBeNull();
  });
});

describe("useChartStale debounce (composed from health + stream signals)", () => {
  it("does not report stale on a sub-debounce hiccup, then does after the window", async () => {
    vi.useFakeTimers();
    const { useChartStale, CHART_STALE_DEBOUNCE_MS } = await import("../src/app/hooks/useCockpit.js");

    const { result, rerender } = renderHook(
      ({ connected, online }: { connected: boolean; online: boolean }) =>
        useChartStale(connected, online, CHART_STALE_DEBOUNCE_MS),
      { initialProps: { connected: true, online: true } },
    );
    expect(result.current).toBe(false);

    // Stream blip shorter than the debounce — must not flash.
    rerender({ connected: false, online: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHART_STALE_DEBOUNCE_MS - 500);
    });
    expect(result.current).toBe(false);

    rerender({ connected: true, online: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current).toBe(false);

    // Sustained health loss past the debounce → stale.
    rerender({ connected: true, online: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHART_STALE_DEBOUNCE_MS);
    });
    expect(result.current).toBe(true);

    // Recovery clears immediately (no trailing debounce).
    rerender({ connected: true, online: true });
    expect(result.current).toBe(false);
  });

  it("treats either stream loss or health unreachable as raw stale", async () => {
    vi.useFakeTimers();
    const { useChartStale } = await import("../src/app/hooks/useCockpit.js");

    const { result, rerender } = renderHook(
      ({ connected, online }: { connected: boolean; online: boolean }) =>
        useChartStale(connected, online, 100),
      { initialProps: { connected: false, online: true } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current).toBe(true);

    rerender({ connected: true, online: false });
    // Still raw-stale; timer restarts but stays stale once it fires again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current).toBe(true);
  });
});
