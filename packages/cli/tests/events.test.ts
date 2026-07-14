import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  ParleyClient,
  bootstrapTaskStream,
  type EventSourceLike,
  type StreamEvent,
  type TaskEnvelope,
} from "@useparley/core";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  readDiscovery,
  runCli,
  waitForState,
  type FakeVendorAction,
} from "./helpers.js";

let home: string;
const taskDirs: string[] = [];

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of taskDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function taskDir(actions: FakeVendorAction[]): string {
  const dir = makeTaskDir(actions);
  taskDirs.push(dir);
  return dir;
}

const REPORT = { summary: "did it", outcome: "success", files_changed: ["a.ts"] };

/** A quick vendor run: session, then a report. */
function quick(): FakeVendorAction[] {
  return [{ emit: { type: "session", session_id: "s" } }, { submit_report: REPORT }];
}

/** Delegate (always async); returns the parsed ack `{task_id, name, state, seq}`. */
async function delegate(cwd: string, name?: string): Promise<Record<string, unknown>> {
  const args = ["delegate", "-v", "fake", "--cwd", cwd, ...(name ? ["-n", name] : []), "run"];
  const res = await runCli(args, home);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

/** The daemon origin, after a first CLI call has spawned it and written discovery. */
function baseUrl(): string {
  const discovery = readDiscovery(home);
  if (!discovery) throw new Error("no discovery file — daemon not spawned yet");
  return `http://127.0.0.1:${discovery.port}`;
}

// ---------------------------------------------------------------------------
// A tiny SSE reader over fetch — the browser has EventSource, Node does not, so
// the boundary tests parse the wire frames themselves (and inject a fetch-backed
// EventSource into the core helper below).
// ---------------------------------------------------------------------------

interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

function parseFrame(raw: string): SseFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // comment (keep-alive / connected)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (id === undefined && event === undefined && data.length === 0) return null;
  return { id, event, data: data.join("\n") };
}

interface SseConnection {
  frames: SseFrame[];
  waitFor: (n: number, timeoutMs?: number) => Promise<void>;
  close: () => void;
}

function openSse(url: string, headers: Record<string, string> = {}): SseConnection {
  const controller = new AbortController();
  const frames: SseFrame[] = [];
  const wakers = new Set<() => void>();
  const wake = (): void => {
    for (const w of wakers) w();
    wakers.clear();
  };
  void fetch(url, { headers, signal: controller.signal })
    .then(async (res) => {
      if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = parseFrame(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
          if (frame) {
            frames.push(frame);
            wake();
          }
        }
      }
    })
    .catch(() => {
      /* aborted on close, or daemon gone — the test asserts on collected frames */
    });
  return {
    frames,
    async waitFor(n, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (frames.length < n) {
        if (Date.now() > deadline) {
          throw new Error(`only ${frames.length}/${n} SSE frames arrived`);
        }
        await new Promise<void>((resolve) => {
          wakers.add(resolve);
          setTimeout(resolve, 100);
        });
      }
    },
    close() {
      controller.abort();
    },
  };
}

describe("SSE transition stream (#62)", () => {
  it("streams transitions from the feed with pinned envelopes and seq ids", async () => {
    // First delegate spawns the daemon and produces t1's transitions.
    await delegate(taskDir(quick()), "one");
    await waitForState(home, "t1", "completed");

    // since=0 replays every transition recorded so far, in order.
    const sse = openSse(`${baseUrl()}/events/stream?since=0`);
    try {
      await sse.waitFor(2);
      const events = sse.frames.map((f) => ({
        id: Number(f.id),
        event: f.event,
        task: JSON.parse(f.data) as TaskEnvelope,
      }));
      // t1: running (task.started) then completed (task.completed).
      expect(events[0]!.event).toBe("task.started");
      expect(events[1]!.event).toBe("task.completed");
      // ids are the transition seqs, strictly increasing.
      expect(events[0]!.id).toBeGreaterThan(0);
      expect(events[1]!.id).toBeGreaterThan(events[0]!.id);
      // Envelope carries the task and is pinned to the transition.
      expect(events[0]!.task.task_id).toBe("t1");
      expect(events[0]!.task.state).toBe("running");
      expect(events[0]!.task.seq).toBe(events[0]!.id);
      expect(events[1]!.task.state).toBe("completed");
    } finally {
      sse.close();
    }
  });

  it("Last-Event-ID replays only transitions after that seq", async () => {
    await delegate(taskDir(quick()), "one");
    await waitForState(home, "t1", "completed");

    // Capture t1's last transition seq from the full replay.
    const first = openSse(`${baseUrl()}/events/stream?since=0`);
    let lastSeq: number;
    try {
      await first.waitFor(2);
      lastSeq = Number(first.frames[first.frames.length - 1]!.id);
    } finally {
      first.close();
    }

    // A second task's transitions land after lastSeq.
    await delegate(taskDir(quick()), "two");
    await waitForState(home, "t2", "completed");

    // Reconnect with Last-Event-ID = t1's last seq: only t2 replays, nothing before.
    const resumed = openSse(`${baseUrl()}/events/stream`, { "last-event-id": String(lastSeq) });
    try {
      await resumed.waitFor(2);
      const ids = resumed.frames.map((f) => Number(f.id));
      expect(Math.min(...ids)).toBeGreaterThan(lastSeq);
      const tasks = resumed.frames.map((f) => (JSON.parse(f.data) as TaskEnvelope).task_id);
      expect(new Set(tasks)).toEqual(new Set(["t2"]));
      expect(resumed.frames[0]!.event).toBe("task.started");
      expect(resumed.frames[1]!.event).toBe("task.completed");
    } finally {
      resumed.close();
    }
  });

  it("pins a superseded transition's state/seq even after the row moved on", async () => {
    // running -> awaiting_answer -> (answer) -> running -> completed.
    const dir = taskDir([
      { emit: { type: "session", session_id: "s" } },
      { ask: "which db?" },
      { submit_report: REPORT },
    ]);
    await delegate(dir, "pin");
    await waitForState(home, "t1", "awaiting_answer");
    const answer = await runCli(["answer", "t1", "postgres"], home);
    expect(answer.code).toBe(0);
    await waitForState(home, "t1", "completed");

    // Replay: the very first transition must still report state=running with its
    // own seq, though the row is now completed (the pinning rule).
    const sse = openSse(`${baseUrl()}/events/stream?since=0`);
    try {
      await sse.waitFor(4);
      const started = sse.frames[0]!;
      const env = JSON.parse(started.data) as TaskEnvelope;
      expect(started.event).toBe("task.started");
      expect(env.state).toBe("running");
      expect(env.seq).toBe(Number(started.id));
      // The row itself has moved to completed — prove the envelope was pinned.
      const detail = await new ParleyClient({ baseUrl: baseUrl() }).getTask("t1");
      expect(detail.row.state).toBe("completed");
      // The stream also surfaced the awaiting_answer transition in order.
      expect(sse.frames.map((f) => f.event)).toEqual([
        "task.started",
        "task.question",
        "task.started",
        "task.completed",
      ]);
    } finally {
      sse.close();
    }
  });

  it("does not disturb the long-poll watch surface", async () => {
    await delegate(taskDir(quick()), "one");
    await waitForState(home, "t1", "completed");
    // The existing multi-task long-poll still answers with a transition envelope.
    const res = await runCli(["status", "t1", "--json"], home);
    expect(res.code).toBe(0);
    const row = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(row.state).toBe("completed");
  });
});

describe("health version + core SDK (#62)", () => {
  it("GET /health carries the daemon package version", async () => {
    await delegate(taskDir(quick()), "one");
    const client = new ParleyClient({ baseUrl: baseUrl() });
    const health = await client.health();
    expect(health.status).toBe("ok");
    expect(typeof health.pid).toBe("number");
    // Matches the daemon package version (the workspace ships 0.0.0 pre-release).
    expect(health.version).toBe("0.0.0");
  });

  it("the core SSE helper bootstraps from the snapshot seq and decodes events", async () => {
    // Spawn the daemon and settle one task before bootstrap so the snapshot is
    // non-empty and its seq excludes t1's transitions from the live stream.
    await delegate(taskDir(quick()), "one");
    await waitForState(home, "t1", "completed");

    const client = new ParleyClient({ baseUrl: baseUrl() });

    // A fetch-backed EventSource shim — the browser global the helper expects.
    class FetchEventSource implements EventSourceLike {
      private readonly listeners = new Map<string, ((e: { data: string; lastEventId: string }) => void)[]>();
      private readonly controller = new AbortController();
      constructor(url: string) {
        void this.run(url);
      }
      addEventListener(type: string, listener: (e: { data: string; lastEventId: string }) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      close(): void {
        this.controller.abort();
      }
      private async run(url: string): Promise<void> {
        try {
          const res = await fetch(url, { signal: this.controller.signal });
          if (!res.body) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const frame = parseFrame(buf.slice(0, idx));
              buf = buf.slice(idx + 2);
              if (frame?.event) {
                for (const cb of this.listeners.get(frame.event) ?? []) {
                  cb({ data: frame.data, lastEventId: frame.id ?? "" });
                }
              }
            }
          }
        } catch {
          /* aborted */
        }
      }
    }

    const received: StreamEvent[] = [];
    const { snapshot, stream } = await bootstrapTaskStream({
      client,
      EventSource: FetchEventSource,
      onEvent: (e) => received.push(e),
    });
    try {
      // Snapshot captured the settled t1 and an atomic seq baseline.
      expect(snapshot.tasks.some((t) => t.id === "t1")).toBe(true);
      expect(typeof snapshot.seq).toBe("number");

      // A new task after bootstrap streams through the helper, decoded.
      await delegate(taskDir(quick()), "two");
      await waitForState(home, "t2", "completed");
      const deadline = Date.now() + 10_000;
      while (received.filter((e) => e.task.task_id === "t2").length < 2) {
        if (Date.now() > deadline) throw new Error(`only got ${received.length} helper events`);
        await new Promise((r) => setTimeout(r, 100));
      }
      const t2 = received.filter((e) => e.task.task_id === "t2");
      expect(t2[0]!.event).toBe("task.started");
      expect(t2[0]!.seq).toBeGreaterThan(snapshot.seq);
      expect(t2.at(-1)!.event).toBe("task.completed");
      // Nothing before the snapshot seq leaked into the live stream.
      expect(received.every((e) => e.seq > snapshot.seq)).toBe(true);
    } finally {
      stream.close();
    }
  });
});
