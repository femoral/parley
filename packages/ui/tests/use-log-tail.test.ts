/** @vitest-environment happy-dom */
import { renderHook, waitFor } from "@testing-library/react";
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
    const { result } = renderHook(() => useLogTail(client, "t1", 80));
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

    const { result } = renderHook(() => useLogTail(client, "t1", 80));

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

    const { result, rerender } = renderHook(({ id }) => useLogTail(client, id, 5), {
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
