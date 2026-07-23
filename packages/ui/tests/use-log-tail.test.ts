/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParleyClient } from "@useparley/core";
import { useLogTail } from "../src/app/hooks/useLogTail.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Step {
  chunk: string;
  next: number;
  eof: boolean;
}

/**
 * A same-origin fetch stand-in serving `GET /tasks/:ref/logs?since=…` from a
 * scripted sequence of responses per task id — models a fake-vendor task's
 * log growing over successive polls without spawning a real daemon (the
 * workflow's "hook-level ... test for the log tail" option; mirrors the
 * fake-daemon convention `use-snapshot-sse.test.ts` already established).
 * Ignores the `since` query itself (each task's script is a fixed sequence,
 * already ordered as its own `next` cursors would produce) — what's under
 * test is `useLogTail`'s accumulate/poll/stop behaviour, not cursor framing.
 */
function scriptedLogFetch(scriptByTask: Record<string, Step[]>): typeof fetch {
  const calls: Record<string, number> = {};
  return (async (input: string | URL | Request) => {
    const path = String(input);
    const match = /^\/tasks\/([^/]+)\/logs\?since=\d+$/.exec(path);
    if (!match) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const taskId = decodeURIComponent(match[1]!);
    const steps = scriptByTask[taskId];
    if (!steps) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const i = calls[taskId] ?? 0;
    calls[taskId] = i + 1;
    const step = steps[Math.min(i, steps.length - 1)]!;
    return new Response(JSON.stringify(step), { status: 200 });
  }) as typeof fetch;
}

describe("useLogTail follows a running fake-vendor task and stops cleanly at eof (#68)", () => {
  it("accumulates chunks while tailing, then status=ended once the daemon reports eof", async () => {
    const client = new ParleyClient({
      baseUrl: "",
      fetch: scriptedLogFetch({
        t1: [
          { chunk: "l1\n", next: 5, eof: false },
          { chunk: "", next: 5, eof: false }, // idle tick — running, nothing new yet
          { chunk: "", next: 5, eof: false },
          { chunk: "l2\n", next: 10, eof: false },
          { chunk: "", next: 10, eof: true }, // the vendor process exits — final tail
        ],
      }),
    });

    // A poll interval comfortably wider than `waitFor`'s sampling cadence
    // below, so the intermediate "still tailing, idling" window is reliably
    // observed rather than raced past between samples.
    const { result } = renderHook(() => useLogTail(client, "t1", true, 80));
    const opts = { interval: 10, timeout: 3000 };

    // Tailing and accumulating while the task runs.
    await waitFor(() => expect(result.current.status).toBe("tailing"), opts);
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toContain("l1"), opts);
    expect(result.current.status).toBe("tailing");

    // ...keeps polling through idle ticks and picks up the second line...
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toContain("l2"), opts);
    expect(result.current.status).toBe("tailing");

    // ...and stops cleanly the moment `eof` flips, with nothing dropped or duplicated.
    await waitFor(() => expect(result.current.status).toBe("ended"), opts);
    expect(result.current.lines.map((l) => l.text)).toEqual(["l1", "l2"]);
  });

  it("classifies the accumulated lines by kind as it tails", async () => {
    const client = new ParleyClient({
      baseUrl: "",
      fetch: scriptedLogFetch({
        t1: [
          { chunk: `${JSON.stringify({ type: "turn.failed", error: { message: "boom" } })}\n`, next: 5, eof: true },
        ],
      }),
    });

    const { result } = renderHook(() => useLogTail(client, "t1", true, 80));

    // Wait for the classified line itself, not `status === "ended"` alone — the
    // hook's initial (pre-fetch) view is already `{ lines: [], status: "ended" }`,
    // so that condition would be trivially (and wrongly) satisfied at t=0.
    await waitFor(() => expect(result.current.lines.length).toBeGreaterThan(0), { interval: 10, timeout: 3000 });
    expect(result.current.status).toBe("ended");
    expect(result.current.lines).toEqual([{ key: 0, kind: "error", text: "boom" }]);
  });

  it("resets the tail when the selected task changes, rather than merging logs across tasks", async () => {
    const client = new ParleyClient({
      baseUrl: "",
      fetch: scriptedLogFetch({
        t1: [{ chunk: "from-t1\n", next: 8, eof: true }],
        t2: [{ chunk: "from-t2\n", next: 8, eof: true }],
      }),
    });

    const { result, rerender } = renderHook(({ id }) => useLogTail(client, id, true, 5), {
      initialProps: { id: "t1" as string | null },
    });
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toEqual(["from-t1"]));

    rerender({ id: "t2" });
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toEqual(["from-t2"]));
  });

  it("returns an empty, ended view with no task selected", () => {
    const client = new ParleyClient({ baseUrl: "", fetch: scriptedLogFetch({}) });
    const { result } = renderHook(() => useLogTail(client, null));
    expect(result.current).toEqual({ lines: [], status: "ended" });
  });
});

describe("useLogTail's `follow` toggle (the settings bar's 'Follow logs' control, #70)", () => {
  it("stops polling and reports paused-by-setting (not ended) when follow flips off while task running", async () => {
    let calls = 0;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () => {
        calls += 1;
        // An always-live, ever-growing tail — eof never comes on its own, so
        // the only thing that can stop this task's tail is `follow`.
        return new Response(JSON.stringify({ chunk: `l${calls}\n`, next: calls, eof: false }), { status: 200 });
      }) as typeof fetch,
    });

    const { result, rerender } = renderHook(({ follow }) => useLogTail(client, "t1", follow, 20), {
      initialProps: { follow: true },
    });

    await waitFor(() => expect(result.current.status).toBe("tailing"));
    await waitFor(() => expect(result.current.lines.length).toBeGreaterThan(0));
    const seenBeforePause = result.current.lines.length;

    rerender({ follow: false });
    // No `waitFor` needed — pausing is synchronous, not a fetch away.
    // Critical honesty: not "ended" while the task is still producing logs.
    expect(result.current.status).toBe("paused-by-setting");
    expect(result.current.status).not.toBe("ended");

    // Give the (stopped) poll loop a couple of its old intervals' worth of
    // time; the line count must not keep growing while paused.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(result.current.lines.length).toBe(seenBeforePause);
    expect(result.current.status).toBe("paused-by-setting");

    // Resuming picks the tail back up — more lines arrive — without the
    // window resetting to empty first. Status returns to tailing.
    rerender({ follow: true });
    await waitFor(() => expect(result.current.status).toBe("tailing"));
    await waitFor(() => expect(result.current.lines.length).toBeGreaterThan(seenBeforePause));
    expect(result.current.lines.slice(0, seenBeforePause).map((l) => l.text)).toEqual(
      Array.from({ length: seenBeforePause }, (_, i) => `l${i + 1}`),
    );
  });

  it("starting paused (follow=false) never fetches until switched on", async () => {
    let calls = 0;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ chunk: "l1\n", next: 1, eof: false }), { status: 200 });
      }) as typeof fetch,
    });

    const { result, rerender } = renderHook(({ follow }) => useLogTail(client, "t1", follow, 15), {
      initialProps: { follow: false },
    });

    expect(result.current).toEqual({ lines: [], status: "paused-by-setting" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(0);

    await act(async () => {
      rerender({ follow: true });
    });
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toContain("l1"));
    expect(result.current.status).toBe("tailing");
  });
});

describe("useLogTail never reports tailing optimistically (#70 regression: it must reflect a confirmed response, not a guess)", () => {
  it("starts status=ended synchronously, even before the very first fetch has resolved", () => {
    // A fetch that never resolves within this test — proves the initial
    // render itself (before any `await`/`waitFor`) is the conservative
    // {lines: [], status: "ended"}, not an optimistic tailing guess derived
    // from `follow`/`taskId` alone.
    const client = new ParleyClient({ baseUrl: "", fetch: (() => new Promise(() => {})) as typeof fetch });
    const { result } = renderHook(() => useLogTail(client, "t1"));
    expect(result.current).toEqual({ lines: [], status: "ended" });
  });

  it("flips to unreachable (not tailing) when every fetch attempt throws (daemon unreachable)", async () => {
    let calls = 0;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () => {
        calls += 1;
        throw new Error("network down");
      }) as typeof fetch,
    });

    const { result } = renderHook(() => useLogTail(client, "t1", true, 15));

    // Give it several retry cycles' worth of time.
    await waitFor(() => expect(calls).toBeGreaterThan(2));
    expect(result.current.status).toBe("unreachable");
    expect(result.current.lines).toEqual([]);
  });

  it("mid-tail fetch failure flips to unreachable (not staying Live/tailing)", async () => {
    // Gate failures so the intermediate "tailing" window is observable — a
    // fixed call-count script races past it when the poll interval is short.
    let phase: "ok" | "fail" = "ok";
    let delivered = false;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () => {
        if (phase === "fail") throw new Error("daemon blip");
        const chunk = delivered ? "" : "ok\n";
        delivered = true;
        return new Response(JSON.stringify({ chunk, next: 3, eof: false }), { status: 200 });
      }) as typeof fetch,
    });

    const { result } = renderHook(() => useLogTail(client, "t1", true, 20));

    await waitFor(() => expect(result.current.status).toBe("tailing"));
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toEqual(["ok"]));

    phase = "fail";
    await waitFor(() => expect(result.current.status).toBe("unreachable"));
    // Prior lines preserved; status is no longer the healthy live claim.
    expect(result.current.lines.map((l) => l.text)).toEqual(["ok"]);
    expect(result.current.status).not.toBe("tailing");
  });

  it("recovery after unreachable returns to tailing automatically", async () => {
    // Phase gate keeps each status stable long enough for waitFor to observe.
    let phase: "ok" | "fail" | "recovered" = "ok";
    let deliveredBefore = false;
    let deliveredAfter = false;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () => {
        if (phase === "fail") throw new Error("temporary outage");
        if (phase === "ok") {
          const chunk = deliveredBefore ? "" : "before\n";
          deliveredBefore = true;
          return new Response(JSON.stringify({ chunk, next: 7, eof: false }), { status: 200 });
        }
        const chunk = deliveredAfter ? "" : "after\n";
        deliveredAfter = true;
        return new Response(JSON.stringify({ chunk, next: 13, eof: false }), { status: 200 });
      }) as typeof fetch,
    });

    const { result } = renderHook(() => useLogTail(client, "t1", true, 20));

    await waitFor(() => expect(result.current.status).toBe("tailing"));
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toEqual(["before"]));

    phase = "fail";
    await waitFor(() => expect(result.current.status).toBe("unreachable"));

    phase = "recovered";
    await waitFor(() => expect(result.current.status).toBe("tailing"));
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toEqual(["before", "after"]));
  });
});

describe("useLogTail's returned view is identity-stable across idle re-renders (#70 — memoization)", () => {
  it("returns the exact same object reference across renders where neither lines nor status changed", () => {
    const client = new ParleyClient({ baseUrl: "", fetch: (() => new Promise(() => {})) as typeof fetch });
    const { result, rerender } = renderHook(({ _n }) => useLogTail(client, "t1", true, 1000), {
      initialProps: { _n: 0 },
    });
    const first = result.current;
    // Re-render for an unrelated reason (the hook's own inputs are unchanged
    // apart from this throwaway prop) — mirrors useCockpit's once-a-second
    // clock tick re-rendering everything below it.
    rerender({ _n: 1 });
    expect(result.current).toBe(first);
  });
});

describe("useLogTail idle polling (#199)", () => {
  it("backs off on silent responses and resets to the base interval on new bytes", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () => {
        calls += 1;
        const chunk = calls === 4 ? "awake\n" : "";
        return new Response(JSON.stringify({ chunk, next: chunk ? 6 : 0, eof: false }), { status: 200 });
      }) as typeof fetch,
    });
    renderHook(() => useLogTail(client, "t1", true, 1_000));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(calls).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(calls).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(calls).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(3_999));
    expect(calls).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(calls).toBe(3);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(calls).toBe(4);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(calls).toBe(4);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(calls).toBe(5);
  });

  it("pauses while hidden and polls immediately when visible again", async () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    let calls = 0;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ chunk: "", next: 0, eof: false }), { status: 200 });
      }) as typeof fetch,
    });
    renderHook(() => useLogTail(client, "t1", true, 1_000));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(calls).toBe(1);
    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(calls).toBe(1);
    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(calls).toBe(2);
  });
});
