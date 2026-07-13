/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ParleyClient } from "@useparley/core";
import { useLogTail } from "../src/app/hooks/useLogTail.js";

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
  it("accumulates chunks while live, then stays live=false once the daemon reports eof", async () => {
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
    // below, so the intermediate "still live, idling" window is reliably
    // observed rather than raced past between samples.
    const { result } = renderHook(() => useLogTail(client, "t1", true, 80));
    const opts = { interval: 10, timeout: 3000 };

    // Live and accumulating while the task runs.
    await waitFor(() => expect(result.current.live).toBe(true), opts);
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toContain("l1"), opts);
    expect(result.current.live).toBe(true);

    // ...keeps polling through idle ticks and picks up the second line...
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toContain("l2"), opts);
    expect(result.current.live).toBe(true);

    // ...and stops cleanly the moment `eof` flips, with nothing dropped or duplicated.
    await waitFor(() => expect(result.current.live).toBe(false), opts);
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

    // Wait for the classified line itself, not `live === false` alone — the
    // hook's initial (pre-fetch) view is already `{ lines: [], live: false }`,
    // so that condition would be trivially (and wrongly) satisfied at t=0.
    await waitFor(() => expect(result.current.lines.length).toBeGreaterThan(0), { interval: 10, timeout: 3000 });
    expect(result.current.live).toBe(false);
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

  it("returns an empty, non-live view with no task selected", () => {
    const client = new ParleyClient({ baseUrl: "", fetch: scriptedLogFetch({}) });
    const { result } = renderHook(() => useLogTail(client, null));
    expect(result.current).toEqual({ lines: [], live: false });
  });
});

describe("useLogTail's `follow` toggle (the settings bar's 'Follow logs' control, #70)", () => {
  it("stops polling and reports live=false the instant follow flips off, without losing the tail so far", async () => {
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

    await waitFor(() => expect(result.current.live).toBe(true));
    await waitFor(() => expect(result.current.lines.length).toBeGreaterThan(0));
    const seenBeforePause = result.current.lines.length;

    rerender({ follow: false });
    // No `waitFor` needed for `live` — pausing is synchronous, not a fetch away.
    expect(result.current.live).toBe(false);

    // Give the (stopped) poll loop a couple of its old intervals' worth of
    // time; the line count must not keep growing while paused.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(result.current.lines.length).toBe(seenBeforePause);

    // Resuming picks the tail back up — more lines arrive — without the
    // window resetting to empty first.
    rerender({ follow: true });
    await waitFor(() => expect(result.current.live).toBe(true));
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

    expect(result.current).toEqual({ lines: [], live: false });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(0);

    await act(async () => {
      rerender({ follow: true });
    });
    await waitFor(() => expect(result.current.lines.map((l) => l.text)).toContain("l1"));
  });
});

describe("useLogTail never reports live optimistically (#70 regression: it must reflect a confirmed response, not a guess)", () => {
  it("starts live=false synchronously, even before the very first fetch has resolved", () => {
    // A fetch that never resolves within this test — proves the initial
    // render itself (before any `await`/`waitFor`) is the conservative
    // {lines: [], live: false}, not an optimistic live:true guess derived
    // from `follow`/`taskId` alone.
    const client = new ParleyClient({ baseUrl: "", fetch: (() => new Promise(() => {})) as typeof fetch });
    const { result } = renderHook(() => useLogTail(client, "t1"));
    expect(result.current).toEqual({ lines: [], live: false });
  });

  it("stays live=false forever when every fetch attempt throws (daemon unreachable), never guessing live", async () => {
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
    expect(result.current).toEqual({ lines: [], live: false });
  });
});

describe("useLogTail's returned view is identity-stable across idle re-renders (#70 — memoization)", () => {
  it("returns the exact same object reference across renders where neither lines nor live changed", () => {
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
