/**
 * #207 / #240 — inbox module: ADR-0007 / ADR-0019 peek / ack / waitFor / allDone.
 *
 * Pure unit surface: in-memory task map + run map + ack map + fake WakeSource.
 * No TaskEngine, sqlite, vendor child, or HTTP.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createInbox,
  memoryInboxDeps,
  type InboxRun,
  type InboxTask,
  type WakeSource,
  type WatchSet,
} from "../src/inbox.js";

function task(
  id: string,
  state: string,
  seq: number,
  extra: Partial<InboxTask> = {},
): InboxTask {
  return { id, state, seq, ...extra };
}

function run(
  id: string,
  state: string,
  seq: number,
  extra: Partial<InboxRun> = {},
): InboxRun {
  return {
    id,
    state,
    seq,
    current_node: extra.current_node ?? "n1",
    iteration: extra.iteration ?? 1,
    workflow: extra.workflow ?? "wf",
    error: extra.error ?? null,
    orchestrator_session_id: extra.orchestrator_session_id ?? "sess",
    ...extra,
  };
}

function watch(taskIds: string[], runIds: string[] = []): WatchSet {
  return { taskIds, runIds };
}

function inbox(seedTasks: InboxTask[] = [], seedRuns: InboxRun[] = []) {
  const deps = memoryInboxDeps(seedTasks, seedRuns);
  return {
    ...deps,
    box: createInbox(deps.snapshot, deps.acks, deps.runSnapshot),
  };
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
    expect(box.peek(watch(["a", "b", "c"]))).toBeNull();
  });

  it("never surfaces non-actionable states (including cancelled)", () => {
    const { box } = inbox([
      task("a", "cancelled", 10),
      task("b", "running", 11),
    ]);
    expect(box.peek(watch(["a", "b"]))).toBeNull();
  });

  it("delivers in priority order across tiers", () => {
    // awaiting_answer > stalled > failed > completed
    const { box } = inbox([
      task("done", "completed", 1),
      task("fail", "failed", 2),
      task("stall", "stalled", 3),
      task("q", "awaiting_answer", 4),
    ]);
    expect(box.peek(watch(["done", "fail", "stall", "q"]))?.id).toBe("q");
  });

  it("prefers stalled over failed over completed when no question", () => {
    const { box } = inbox([
      task("done", "completed", 1),
      task("fail", "failed", 2),
      task("stall", "stalled", 3),
    ]);
    expect(box.peek(watch(["done", "fail", "stall"]))?.id).toBe("stall");
    expect(box.peek(watch(["done", "fail"]))?.id).toBe("fail");
    expect(box.peek(watch(["done"]))?.id).toBe("done");
  });

  it("FIFO by seq within the same tier", () => {
    const { box } = inbox([
      task("b", "failed", 20),
      task("a", "failed", 10),
      task("c", "failed", 30),
    ]);
    expect(box.peek(watch(["b", "a", "c"]))?.id).toBe("a");
  });

  it("dedupes duplicate ids in the watch set", () => {
    const { box } = inbox([task("a", "completed", 5)]);
    expect(box.peek(watch(["a", "a", "a"]))?.id).toBe("a");
  });

  it("skips missing ids", () => {
    const { box } = inbox([task("a", "failed", 1)]);
    expect(box.peek(watch(["missing", "a"]))?.id).toBe("a");
    expect(box.peek(watch(["missing"]))).toBeNull();
  });

  it("redelivers un-acked events on every peek", () => {
    const { box } = inbox([task("a", "awaiting_answer", 7)]);
    expect(box.peek(watch(["a"]))?.seq).toBe(7);
    expect(box.peek(watch(["a"]))?.seq).toBe(7);
  });
});

describe("inbox.ack — supersession and collapse", () => {
  it("acks current actionable event so peek skips it", () => {
    const { box } = inbox([task("a", "awaiting_answer", 3)]);
    box.ack(3);
    expect(box.peek(watch(["a"]))).toBeNull();
  });

  it("is a no-op for non-integer / non-positive event ids", () => {
    const { box } = inbox([task("a", "failed", 5)]);
    box.ack(0);
    box.ack(-1);
    box.ack(1.5);
    box.ack(NaN);
    expect(box.peek(watch(["a"]))?.id).toBe("a");
  });

  it("is a no-op when event id is unknown (superseded or never existed)", () => {
    const { box } = inbox([task("a", "failed", 5)]);
    box.ack(99);
    expect(box.peek(watch(["a"]))?.id).toBe("a");
  });

  it("is a no-op when the task left the actionable state", () => {
    const { tasks, box } = inbox([task("a", "awaiting_answer", 4)]);
    tasks.set("a", task("a", "running", 4));
    box.ack(4);
    tasks.set("a", task("a", "failed", 5));
    expect(box.peek(watch(["a"]))?.seq).toBe(5);
  });

  it("ack of superseded seq is no-op; new state redelivers", () => {
    const { tasks, box } = inbox([task("a", "awaiting_answer", 10)]);
    tasks.set("a", task("a", "stalled", 11));
    box.ack(10);
    expect(box.peek(watch(["a"]))?.seq).toBe(11);
    box.ack(11);
    expect(box.peek(watch(["a"]))).toBeNull();
  });

  it("leaving actionable state collapses the event without an ack write", () => {
    const { tasks, box } = inbox([task("a", "awaiting_answer", 2)]);
    expect(box.peek(watch(["a"]))).not.toBeNull();
    tasks.set("a", task("a", "completed", 3));
    expect(box.peek(watch(["a"]))?.state).toBe("completed");
    tasks.set("a", task("a", "running", 4));
    expect(box.peek(watch(["a"]))).toBeNull();
  });

  it("re-entry into same state with new seq is un-acked again", () => {
    const { tasks, box } = inbox([task("a", "awaiting_answer", 1)]);
    box.ack(1);
    expect(box.peek(watch(["a"]))).toBeNull();
    tasks.set("a", task("a", "running", 2));
    tasks.set("a", task("a", "awaiting_answer", 3));
    expect(box.peek(watch(["a"]))?.seq).toBe(3);
  });
});

describe("inbox.allDone", () => {
  it("empty watch set is vacuously all-done", () => {
    const { box } = inbox([]);
    expect(box.allDone(watch([]))).toBe(true);
  });

  it("true when every watched task is terminal and no pending events", () => {
    const { box } = inbox([
      task("a", "completed", 1),
      task("b", "failed", 2),
      task("c", "cancelled", 3),
    ]);
    expect(box.allDone(watch(["a", "b", "c"]))).toBe(false);
    box.ack(1);
    box.ack(2);
    expect(box.allDone(watch(["a", "b", "c"]))).toBe(true);
  });

  it("false when any watched task is non-terminal", () => {
    const { box } = inbox([
      task("a", "completed", 1),
      task("b", "running", 2),
    ]);
    box.ack(1);
    expect(box.allDone(watch(["a", "b"]))).toBe(false);
  });

  it("false when pending un-acked actionable events remain", () => {
    const { box } = inbox([task("a", "stalled", 1)]);
    expect(box.allDone(watch(["a"]))).toBe(false);
  });

  it("ignores missing ids when deciding all-done", () => {
    const { box } = inbox([task("a", "completed", 1)]);
    box.ack(1);
    expect(box.allDone(watch(["a", "ghost"]))).toBe(true);
  });

  it("task-only session is observationally identical to ADR-0007 (no runs)", () => {
    // Explicit regression: session with no runs must match pre-#240 all-done.
    const { box } = inbox([
      task("a", "completed", 1),
      task("b", "cancelled", 2),
    ]);
    expect(box.allDone(watch(["a", "b"]))).toBe(false);
    box.ack(1);
    expect(box.allDone(watch(["a", "b"]))).toBe(true);
    expect(box.peek(watch(["a", "b"]))).toBeNull();
  });
});

describe("inbox.waitFor", () => {
  it("returns immediately when an event is already pending (level-triggered)", async () => {
    const { box } = inbox([task("a", "failed", 9)]);
    const park = vi.fn(async () => false);
    const result = await box.waitFor(watch(["a"]), 1000, { park });
    expect(result).toEqual({
      event: expect.objectContaining({ id: "a", seq: 9, kind: "task" }),
    });
    expect(park).not.toHaveBeenCalled();
  });

  it("returns allDone immediately when set is terminal and acked", async () => {
    const { box } = inbox([task("a", "completed", 1)]);
    box.ack(1);
    const park = vi.fn(async () => false);
    const result = await box.waitFor(watch(["a"]), 1000, { park });
    expect(result).toEqual({ allDone: true });
    expect(park).not.toHaveBeenCalled();
  });

  it("returns null on timeout when live work remains", async () => {
    const { box } = inbox([task("a", "running", 1)]);
    const park = vi.fn(async () => false);
    const result = await box.waitFor(watch(["a"]), 50, { park });
    expect(result).toBeNull();
    expect(park).toHaveBeenCalledOnce();
  });

  it("re-peeks after wake and returns the new event", async () => {
    const { tasks, box } = inbox([task("a", "running", 1)]);
    const ctrl = controllableWake();
    const pending = box.waitFor(watch(["a"]), 60_000, ctrl.wake);
    await Promise.resolve();
    expect(ctrl.parks).toBe(1);
    tasks.set("a", task("a", "awaiting_answer", 2));
    ctrl.resolveNext(true);
    await expect(pending).resolves.toEqual({
      event: expect.objectContaining({
        id: "a",
        state: "awaiting_answer",
        seq: 2,
      }),
    });
  });

  it("late re-check after timeout can still surface allDone", async () => {
    const { tasks, box } = inbox([task("a", "running", 1)]);
    const ctrl = controllableWake();
    const pending = box.waitFor(watch(["a"]), 60_000, ctrl.wake);
    await Promise.resolve();
    tasks.set("a", task("a", "cancelled", 2));
    ctrl.resolveNext(false);
    await expect(pending).resolves.toEqual({ allDone: true });
  });

  it("empty watch set waitFor resolves allDone without parking", async () => {
    const { box } = inbox([]);
    const park = vi.fn(async () => false);
    await expect(box.waitFor(watch([]), 100, { park })).resolves.toEqual({
      allDone: true,
    });
    expect(park).not.toHaveBeenCalled();
  });
});

describe("ADR-0019 — runs as inbox subjects", () => {
  it("questions pierce the run's shell; outcomes do not (fan-out)", () => {
    // Twelve completed fan-out siblings must NOT surface — only questions/stalls.
    const fanOut: InboxTask[] = [];
    for (let i = 0; i < 12; i++) {
      fanOut.push(
        task(`t${i}`, "completed", 100 + i, {
          run_id: "r1",
          node: "research",
          iteration: 1,
          slot: String(i),
        }),
      );
    }
    // One question among them must still surface against the *task* id.
    fanOut.push(
      task("tq", "awaiting_answer", 200, {
        run_id: "r1",
        node: "research",
        iteration: 1,
        slot: "q",
      }),
    );
    const { box } = inbox(fanOut, [
      run("r1", "running", 50, { current_node: "research" }),
    ]);
    const ev = box.peek(watch(fanOut.map((t) => t.id), ["r1"]));
    expect(ev?.kind).toBe("task");
    expect(ev?.id).toBe("tq");
    expect(ev?.state).toBe("awaiting_answer");
    // No completed siblings in the pending set after acking the question.
    box.ack(200);
    expect(box.peek(watch(fanOut.map((t) => t.id), ["r1"]))).toBeNull();
  });

  it("run-owned stalled still surfaces; completed/failed suppressed", () => {
    const { box } = inbox(
      [
        task("s", "stalled", 1, { run_id: "r1" }),
        task("f", "failed", 2, { run_id: "r1" }),
        task("c", "completed", 3, { run_id: "r1" }),
      ],
      [run("r1", "running", 10)],
    );
    const ev = box.peek(watch(["s", "f", "c"], ["r1"]));
    expect(ev?.id).toBe("s");
    expect(ev?.state).toBe("stalled");
  });

  it("gate is tier 1; blocked is tier 2; fold into four tiers", () => {
    const { box } = inbox(
      [task("done", "completed", 1)],
      [
        run("rg", "blocked", 5, {
          error: "blocked (gate review)",
          current_node: "review",
        }),
        run("rb", "blocked", 6, {
          error: "blocked (spawn research)",
          current_node: "research",
        }),
        run("rf", "failed", 7, { error: "gone" }),
        run("rc", "completed", 8),
      ],
    );
    const w = watch(["done"], ["rg", "rb", "rf", "rc"]);
    expect(box.peek(w)?.state).toBe("gate");
    expect(box.peek(w)?.id).toBe("rg");
  });

  it("stall-and-block collision resolves on seq alone", () => {
    // Same tier (2): stalled task vs blocked run — lower seq wins.
    const { box } = inbox(
      [task("s", "stalled", 20)],
      [
        run("rb", "blocked", 10, {
          error: "blocked (spawn x)",
        }),
      ],
    );
    const ev = box.peek(watch(["s"], ["rb"]));
    expect(ev?.id).toBe("rb");
    expect(ev?.state).toBe("blocked");
    // Flip seqs — stalled wins.
    const { box: box2 } = inbox(
      [task("s", "stalled", 5)],
      [run("rb", "blocked", 15, { error: "blocked (spawn x)" })],
    );
    expect(box2.peek(watch(["s"], ["rb"]))?.id).toBe("s");
  });

  it("gate is never acked — only actioned", () => {
    const { box } = inbox(
      [],
      [
        run("rg", "blocked", 3, {
          error: "blocked (gate review)",
          current_node: "review",
        }),
      ],
    );
    box.ack(3);
    // Still pending — deliberate blackhole until a verb moves the run.
    expect(box.peek(watch([], ["rg"]))?.state).toBe("gate");
  });

  it("non-gate run blocked can be acked", () => {
    const { box } = inbox(
      [],
      [run("rb", "blocked", 4, { error: "blocked (spawn x)" })],
    );
    box.ack(4);
    expect(box.peek(watch([], ["rb"]))).toBeNull();
  });

  it("session finished requires every run terminal too", () => {
    const { box } = inbox(
      [task("a", "completed", 1)],
      [run("r1", "running", 2, { current_node: "step2" })],
    );
    box.ack(1);
    // Tasks all-done but run still mid-pipeline → not session-finished.
    expect(box.allDone(watch(["a"], ["r1"]))).toBe(false);
  });

  it("session finished when runs completed/failed/cancelled and acked", () => {
    const { box } = inbox(
      [task("a", "completed", 1)],
      [run("r1", "completed", 2)],
    );
    box.ack(1);
    box.ack(2);
    expect(box.allDone(watch(["a"], ["r1"]))).toBe(true);
  });

  it("gate ranks above stalled (tier 1 vs tier 2)", () => {
    const { box } = inbox(
      [task("s", "stalled", 1)],
      [
        run("rg", "blocked", 99, {
          error: "blocked (gate g)",
        }),
      ],
    );
    expect(box.peek(watch(["s"], ["rg"]))?.state).toBe("gate");
  });
});
