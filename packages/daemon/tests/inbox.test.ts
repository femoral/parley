/**
 * #207 — inbox module: ADR-0007 peek / ack / waitFor / allDone policy.
 *
 * Pure unit surface: in-memory task map + ack map + fake WakeSource.
 * No TaskEngine, sqlite, vendor child, or HTTP.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createInbox,
  memoryInboxDeps,
  type InboxTask,
  type WakeSource,
} from "../src/inbox.js";

function task(
  id: string,
  state: string,
  seq: number,
): InboxTask {
  return { id, state, seq };
}

function inbox(seed: InboxTask[] = []) {
  const deps = memoryInboxDeps(seed);
  return { ...deps, box: createInbox(deps.snapshot, deps.acks) };
}

/** WakeSource that records park calls; resolve via returned controls. */
function controllableWake(): {
  wake: WakeSource;
  parks: number;
  resolveNext(woke: boolean): void;
} {
  let parks = 0;
  let pending: ((woke: boolean) => void) | null = null;
  return {
    get parks() {
      return parks;
    },
    resolveNext(woke: boolean) {
      if (!pending) throw new Error("no park pending");
      const r = pending;
      pending = null;
      r(woke);
    },
    wake: {
      park(_timeoutMs: number) {
        parks += 1;
        return new Promise<boolean>((resolve) => {
          pending = resolve;
        });
      },
    },
  };
}

describe("inbox.peek — priority and filter", () => {
  it("returns null when no watched tasks are actionable", () => {
    const { box } = inbox([
      task("a", "running", 1),
      task("b", "pending", 2),
      task("c", "queued", 3),
    ]);
    expect(box.peek(["a", "b", "c"])).toBeNull();
  });

  it("never surfaces non-actionable states (including cancelled)", () => {
    const { box } = inbox([
      task("a", "cancelled", 10),
      task("b", "running", 11),
    ]);
    expect(box.peek(["a", "b"])).toBeNull();
  });

  it("delivers in priority order across tiers", () => {
    // awaiting_answer > stalled > failed > completed
    const { box } = inbox([
      task("done", "completed", 1),
      task("fail", "failed", 2),
      task("stall", "stalled", 3),
      task("q", "awaiting_answer", 4),
    ]);
    expect(box.peek(["done", "fail", "stall", "q"])?.id).toBe("q");
  });

  it("prefers stalled over failed over completed when no question", () => {
    const { box } = inbox([
      task("done", "completed", 1),
      task("fail", "failed", 2),
      task("stall", "stalled", 3),
    ]);
    expect(box.peek(["done", "fail", "stall"])?.id).toBe("stall");
    expect(box.peek(["done", "fail"])?.id).toBe("fail");
    expect(box.peek(["done"])?.id).toBe("done");
  });

  it("FIFO by seq within the same tier", () => {
    const { box } = inbox([
      task("b", "failed", 20),
      task("a", "failed", 10),
      task("c", "failed", 30),
    ]);
    expect(box.peek(["b", "a", "c"])?.id).toBe("a");
  });

  it("dedupes duplicate ids in the watch set", () => {
    const { box } = inbox([task("a", "completed", 5)]);
    expect(box.peek(["a", "a", "a"])?.id).toBe("a");
  });

  it("skips missing ids", () => {
    const { box } = inbox([task("a", "failed", 1)]);
    expect(box.peek(["missing", "a"])?.id).toBe("a");
    expect(box.peek(["missing"])).toBeNull();
  });

  it("redelivers un-acked events on every peek", () => {
    const { box } = inbox([task("a", "awaiting_answer", 7)]);
    expect(box.peek(["a"])?.seq).toBe(7);
    expect(box.peek(["a"])?.seq).toBe(7);
  });
});

describe("inbox.ack — supersession and collapse", () => {
  it("acks current actionable event so peek skips it", () => {
    const { box } = inbox([task("a", "awaiting_answer", 3)]);
    box.ack(3);
    expect(box.peek(["a"])).toBeNull();
  });

  it("is a no-op for non-integer / non-positive event ids", () => {
    const { box } = inbox([task("a", "failed", 5)]);
    box.ack(0);
    box.ack(-1);
    box.ack(1.5);
    box.ack(NaN);
    expect(box.peek(["a"])?.id).toBe("a");
  });

  it("is a no-op when event id is unknown (superseded or never existed)", () => {
    const { box } = inbox([task("a", "failed", 5)]);
    box.ack(99);
    expect(box.peek(["a"])?.id).toBe("a");
  });

  it("is a no-op when the task left the actionable state", () => {
    const { tasks, box } = inbox([task("a", "awaiting_answer", 4)]);
    // Collapse: answer resumes → running. Old event id still "points" at row
    // only if seq unchanged; mark non-actionable with same seq.
    tasks.set("a", task("a", "running", 4));
    box.ack(4);
    // Later failure is a new pending event at a new seq.
    tasks.set("a", task("a", "failed", 5));
    expect(box.peek(["a"])?.seq).toBe(5);
  });

  it("ack of superseded seq is no-op; new state redelivers", () => {
    const { tasks, box } = inbox([task("a", "awaiting_answer", 10)]);
    // Task moved on: new seq, still actionable (e.g. stalled after timeout).
    tasks.set("a", task("a", "stalled", 11));
    box.ack(10); // old event id — getBySeq miss
    expect(box.peek(["a"])?.seq).toBe(11);
    box.ack(11);
    expect(box.peek(["a"])).toBeNull();
  });

  it("leaving actionable state collapses the event without an ack write", () => {
    const { tasks, box } = inbox([task("a", "awaiting_answer", 2)]);
    expect(box.peek(["a"])).not.toBeNull();
    tasks.set("a", task("a", "completed", 3));
    // completed is actionable — still surfaces until acked
    expect(box.peek(["a"])?.state).toBe("completed");
    tasks.set("a", task("a", "running", 4));
    expect(box.peek(["a"])).toBeNull();
  });

  it("re-entry into same state with new seq is un-acked again", () => {
    const { tasks, box } = inbox([task("a", "awaiting_answer", 1)]);
    box.ack(1);
    expect(box.peek(["a"])).toBeNull();
    // Answer → running → ask again
    tasks.set("a", task("a", "running", 2));
    tasks.set("a", task("a", "awaiting_answer", 3));
    expect(box.peek(["a"])?.seq).toBe(3);
  });
});

describe("inbox.allDone", () => {
  it("empty watch set is vacuously all-done", () => {
    const { box } = inbox([]);
    expect(box.allDone([])).toBe(true);
  });

  it("true when every watched task is terminal and no pending events", () => {
    const { box } = inbox([
      task("a", "completed", 1),
      task("b", "failed", 2),
      task("c", "cancelled", 3),
    ]);
    // completed/failed still pending until acked
    expect(box.allDone(["a", "b", "c"])).toBe(false);
    box.ack(1);
    box.ack(2);
    // cancelled is terminal and non-actionable — no ack needed
    expect(box.allDone(["a", "b", "c"])).toBe(true);
  });

  it("false when any watched task is non-terminal", () => {
    const { box } = inbox([
      task("a", "completed", 1),
      task("b", "running", 2),
    ]);
    box.ack(1);
    expect(box.allDone(["a", "b"])).toBe(false);
  });

  it("false when pending un-acked actionable events remain", () => {
    const { box } = inbox([task("a", "stalled", 1)]);
    expect(box.allDone(["a"])).toBe(false);
  });

  it("ignores missing ids when deciding all-done", () => {
    const { box } = inbox([task("a", "completed", 1)]);
    box.ack(1);
    expect(box.allDone(["a", "ghost"])).toBe(true);
  });
});

describe("inbox.waitFor", () => {
  it("returns immediately when an event is already pending (level-triggered)", async () => {
    const { box } = inbox([task("a", "failed", 9)]);
    const park = vi.fn(async () => false);
    const result = await box.waitFor(["a"], 1000, { park });
    expect(result).toEqual({ task: expect.objectContaining({ id: "a", seq: 9 }) });
    expect(park).not.toHaveBeenCalled();
  });

  it("returns allDone immediately when set is terminal and acked", async () => {
    const { box } = inbox([task("a", "completed", 1)]);
    box.ack(1);
    const park = vi.fn(async () => false);
    const result = await box.waitFor(["a"], 1000, { park });
    expect(result).toEqual({ allDone: true });
    expect(park).not.toHaveBeenCalled();
  });

  it("returns null on timeout when live work remains", async () => {
    const { box } = inbox([task("a", "running", 1)]);
    const park = vi.fn(async () => false);
    const result = await box.waitFor(["a"], 50, { park });
    expect(result).toBeNull();
    expect(park).toHaveBeenCalledOnce();
  });

  it("re-peeks after wake and returns the new event", async () => {
    const { tasks, box } = inbox([task("a", "running", 1)]);
    const ctrl = controllableWake();
    const pending = box.waitFor(["a"], 60_000, ctrl.wake);
    // Let the first park register.
    await Promise.resolve();
    expect(ctrl.parks).toBe(1);
    tasks.set("a", task("a", "awaiting_answer", 2));
    ctrl.resolveNext(true);
    await expect(pending).resolves.toEqual({
      task: expect.objectContaining({ id: "a", state: "awaiting_answer", seq: 2 }),
    });
  });

  it("late re-check after timeout can still surface allDone", async () => {
    const { tasks, box } = inbox([task("a", "running", 1)]);
    const ctrl = controllableWake();
    const pending = box.waitFor(["a"], 60_000, ctrl.wake);
    await Promise.resolve();
    // Complete + would need ack, but cancelled is terminal non-actionable.
    tasks.set("a", task("a", "cancelled", 2));
    ctrl.resolveNext(false); // timeout path with late re-peek
    await expect(pending).resolves.toEqual({ allDone: true });
  });

  it("empty watch set waitFor resolves allDone without parking", async () => {
    const { box } = inbox([]);
    const park = vi.fn(async () => false);
    await expect(box.waitFor([], 100, { park })).resolves.toEqual({
      allDone: true,
    });
    expect(park).not.toHaveBeenCalled();
  });
});
