/**
 * #171 — per-vendor / per-profile concurrency caps enforced by daemon task queue.
 *
 * Slot holders are simulated with DB rows in `running` so we can unit-test
 * enqueue/FIFO/restart without a live MCP hub or long-running vendor children.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  getTask,
  insertTask,
  listQueuedTasks,
  nextTaskId,
  openDatabase,
  sweepInterruptedTasks,
  updateTask, writeTaskState,
  type DatabaseHandle,
  type TaskRow,
} from "../src/db.js";
import { TaskEngine } from "../src/engine.js";
import {
  InProcessExecutor,
  type InProcessExecutorHost,
} from "../src/executor.js";
import { withFakeAllowlist } from "./helpers.js";

const FAKE_VENDOR_BIN = fileURLToPath(
  new URL("../../cli/tests/fake-vendor.mjs", import.meta.url),
);

let home: string;
let db: DatabaseHandle;
let cwd: string;

function writeParleyConfig(body: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify(withFakeAllowlist(body)));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-concurrency-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "parley-qtask-"));
  // Minimal script so a mistaken spawn still exits quickly.
  fs.writeFileSync(
    path.join(cwd, ".fake-vendor.json"),
    JSON.stringify([{ exit: 0 }]),
  );
  db = openDatabase(homePaths(home));
  process.env.PARLEY_HOME = home;
  process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.PARLEY_FAKE_VENDOR_BIN;
  delete process.env.PARLEY_HOME;
});

function engine(): TaskEngine {
  return new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
}

function baseRequest(
  overrides: Partial<Parameters<TaskEngine["delegate"]>[0]> = {},
): Parameters<TaskEngine["delegate"]>[0] {
  return {
    prompt: "do it",
    vendor: "fake",
    profile: null,
    model: null,
    effort: null,
    name: null,
    orchestratorSessionId: "orch",
    cwd,
    useWorktree: false,
    baseRef: null,
    sandbox: null,
    network: null,
    answerTimeoutMs: null,
    reportSchema: null,
    contexts: [],
    runner: null,
    size: null,
    difficulty: null,
    type: null,
    ...overrides,
  };
}

/** Insert a synthetic slot-holder that occupies vendor/profile capacity. */
function insertRunningSlot(opts: {
  vendor?: string;
  profile?: string | null;
} = {}): string {
  const id = nextTaskId(db);
  insertTask(db, {
    id,
    name: null,
    vendor: opts.vendor ?? "fake",
    model: null,
    effort: null,
    profile: opts.profile ?? null,
    repo: null,
    cwd,
    prompt: "holder",
    orchestrator_session_id: "orch",
    worktree: null,
    branch: null,
    base_sha: null,
    sandbox: "workspace",
    network: true,
    answer_timeout_ms: null,
    report_schema: null,
    size: null,
    difficulty: null,
    type: "other",
  });
  writeTaskState(db, id, "running", {
    started_at: new Date().toISOString(),
  });
  return id;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

describe("concurrency queue (#171)", () => {
  it("with vendor capped at 2, a third task sits queued with position 1 and blocking cap", async () => {
    writeParleyConfig({ vendors: { fake: { maxConcurrent: 2 } } });
    const eng = engine();
    const h1 = insertRunningSlot();
    const h2 = insertRunningSlot();

    const third = eng.delegate(baseRequest());
    await waitFor(() => getTask(db, third.id)?.state === "queued");

    const queued = eng.withQueueInfo(getTask(db, third.id)!);
    expect(queued.state).toBe("queued");
    expect(queued.queue_position).toBe(1);
    expect(queued.blocking_cap).toBe("vendor:fake");
    expect(queued.queued_at).not.toBeNull();

    // Free a slot by marking a holder terminal → drain admits the waiter.
    // Use engine.fail path via cancel on a real row... holders have no child;
    // force terminal through updateTask + manual drain by cancelling the queued
    // task is wrong. Instead complete a holder and call cancel on nothing —
    // dispatchClaim / InProcessExecutor.offer only on new work. Drain runs on
    // transitioned(terminal). cancel requires non-terminal; use a tiny helper
    // path: cancel is fine on holders (no child) and frees the slot.
    eng.cancel(h1);
    // Waiter may go pending→running→failed quickly without a hub; the important
    // acceptance is that it *left* queued once a slot freed.
    await waitFor(() => getTask(db, third.id)?.state !== "queued");
    expect(getTask(db, third.id)!.state).not.toBe("queued");

    // Cleanup remaining
    try {
      eng.cancel(h2);
    } catch {
      /* ok */
    }
    try {
      eng.cancel(third.id);
    } catch {
      /* may already be terminal from spawn failure without hub */
    }
  });

  it("no cap configured behaves like today (starts immediately, never queued)", () => {
    writeParleyConfig({});
    insertRunningSlot();
    insertRunningSlot();
    const eng = engine();
    const row = eng.delegate(baseRequest());
    // Admitted immediately — not parked in queued.
    expect(getTask(db, row.id)!.state).not.toBe("queued");
    try {
      eng.cancel(row.id);
    } catch {
      /* terminal ok */
    }
  });

  it("re-queues durable queued tasks in original order after sweep/restart", async () => {
    writeParleyConfig({ vendors: { fake: { maxConcurrent: 1 } } });
    // One live slot so drain only admits the head of the queue.
    insertRunningSlot();

    const t1 = nextTaskId(db);
    const t2 = nextTaskId(db);
    const t3 = nextTaskId(db);
    for (const [id, at] of [
      [t1, "2026-01-01T00:00:01.000Z"],
      [t2, "2026-01-01T00:00:02.000Z"],
      [t3, "2026-01-01T00:00:03.000Z"],
    ] as const) {
      insertTask(db, {
        id,
        name: null,
        vendor: "fake",
        model: null,
        effort: null,
        profile: null,
        repo: null,
        cwd,
        prompt: "p",
        orchestrator_session_id: "orch",
        worktree: null,
        branch: null,
        base_sha: null,
        sandbox: "workspace",
        network: true,
        answer_timeout_ms: null,
        report_schema: null,
        size: null,
        difficulty: null,
        type: "other",
      });
      writeTaskState(db, id, "queued", { queued_at: at });
    }

    // Sweep stalls the synthetic running holder (no process group child) but
    // must leave queued tasks durable and ordered.
    sweepInterruptedTasks(db);
    expect(listQueuedTasks(db).map((t) => t.id)).toEqual([t1, t2, t3]);
    expect(getTask(db, t1)!.state).toBe("queued");
    expect(getTask(db, t2)!.state).toBe("queued");
    expect(getTask(db, t3)!.state).toBe("queued");

    // After sweep the holder is stalled (not holding a slot). Re-insert a
    // running holder so the new engine's constructor drain cannot empty the
    // queue in one go.
    insertRunningSlot();

    const eng = engine();
    await new Promise((r) => setTimeout(r, 10));
    // Cap 1 with one running holder → nobody dequeued yet; original FIFO
    // order is restored for observability (positions 1..3).
    expect(listQueuedTasks(db).map((t) => t.id)).toEqual([t1, t2, t3]);
    expect(eng.queuePositionFor(getTask(db, t1)!)).toBe(1);
    expect(eng.queuePositionFor(getTask(db, t2)!)).toBe(2);
    expect(eng.queuePositionFor(getTask(db, t3)!)).toBe(3);
    // Head-of-line admission identity is pinned by the #326 drain tests below;
    // here we only pin restart durability + observable FIFO positions.
  });

  it("profile + vendor caps both must have free slots", async () => {
    writeParleyConfig({
      vendors: { fake: { maxConcurrent: 2 } },
      profiles: { slow: { vendor: "fake", maxConcurrent: 1 } },
    });
    insertRunningSlot({ profile: "slow" });
    // Vendor has room (1/2) but profile is full (1/1).
    const eng = engine();
    const row = eng.delegate(baseRequest({ profile: "slow", vendor: null }));
    await waitFor(() => getTask(db, row.id)?.state === "queued");
    const info = eng.withQueueInfo(getTask(db, row.id)!);
    expect(info.blocking_cap).toBe("profile:slow");
    try {
      eng.cancel(row.id);
    } catch {
      /* ok */
    }
  });

  it("cancel on a queued task works without a child", async () => {
    writeParleyConfig({ vendors: { fake: { maxConcurrent: 1 } } });
    insertRunningSlot();
    const eng = engine();
    const row = eng.delegate(baseRequest());
    await waitFor(() => getTask(db, row.id)?.state === "queued");
    const cancelled = eng.cancel(row.id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.queued_at).toBeNull();
  });

  it("retry (fix) re-enters at the back of the queue", async () => {
    writeParleyConfig({ vendors: { fake: { maxConcurrent: 1 } } });
    insertRunningSlot();
    const eng = engine();

    // Terminal parent for fix.
    const parentId = nextTaskId(db);
    insertTask(db, {
      id: parentId,
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      repo: null,
      cwd,
      prompt: "original",
      orchestrator_session_id: "orch",
      worktree: null,
      branch: null,
      base_sha: null,
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "other",
    });
    writeTaskState(db, parentId, "completed", {
      completed_at: new Date().toISOString(),
      report: JSON.stringify({
        summary: "done",
        outcome: "success",
        files_changed: [],
      }),
    });

    const waiter = eng.delegate(baseRequest());
    await waitFor(() => getTask(db, waiter.id)?.state === "queued");

    const fixed = eng.fix({
      parentRef: parentId,
      prompt: "please fix",
      fresh: true,
      orchestratorSessionId: "orch",
    });
    await waitFor(() => getTask(db, fixed.id)?.state === "queued");

    const q = listQueuedTasks(db).map((t) => t.id);
    expect(q.indexOf(waiter.id)).toBeLessThan(q.indexOf(fixed.id));
    expect(eng.queuePositionFor(getTask(db, fixed.id)!)).toBe(
      eng.queuePositionFor(getTask(db, waiter.id)!)! + 1,
    );

    eng.cancel(waiter.id);
    eng.cancel(fixed.id);
  });

  it("resume window is validated at dequeue, not enqueue", async () => {
    writeParleyConfig({
      vendors: { fake: { maxConcurrent: 1, retryWindow: "50ms" } },
      resume: { enabled: true },
      retry: { max: 5, window: "50ms" },
    });
    const holder = insertRunningSlot();
    const eng = engine();

    const parentId = nextTaskId(db);
    insertTask(db, {
      id: parentId,
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      repo: null,
      cwd,
      prompt: "original",
      orchestrator_session_id: "orch",
      worktree: null,
      branch: null,
      base_sha: null,
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "other",
      session_id: "sess-parent",
    });
    // Parent just completed — within window at enqueue.
    writeTaskState(db, parentId, "completed", {
      completed_at: new Date().toISOString(),
      session_id: "sess-parent",
      report: JSON.stringify({
        summary: "done",
        outcome: "success",
        files_changed: [],
      }),
    });

    // Fix should enqueue (budget ok); window is not checked at enqueue.
    const fixed = eng.fix({
      parentRef: parentId,
      prompt: "resume fix",
      fresh: false,
      orchestratorSessionId: "orch",
    });
    await waitFor(() => getTask(db, fixed.id)?.state === "queued");
    expect(getTask(db, fixed.id)!.resumed).toBe(1);

    // Age the parent past the reattempt window while queued.
    updateTask(db, parentId, {
      completed_at: new Date(Date.now() - 60_000).toISOString(),
    });

    // Free the slot → dequeue re-validates and fails with window error.
    eng.cancel(holder);
    await waitFor(() => getTask(db, fixed.id)!.state === "failed");
    const err = getTask(db, fixed.id)!.error ?? "";
    expect(err).toMatch(/reattempt window|expired|terminal for/i);
  });

  it("both caps must free before spawn when both apply", async () => {
    writeParleyConfig({
      vendors: { fake: { maxConcurrent: 1 } },
      profiles: { deep: { vendor: "fake", maxConcurrent: 1 } },
    });
    insertRunningSlot({ profile: "deep" });
    const eng = engine();
    const row = eng.delegate(baseRequest({ profile: "deep", vendor: null }));
    await waitFor(() => getTask(db, row.id)?.state === "queued");
    // Vendor and profile both full → either or both named.
    const cap = eng.blockingCapFor(getTask(db, row.id)!);
    expect(cap).toMatch(/vendor:fake|profile:deep/);
    eng.cancel(row.id);
  });

  /**
   * #312: InProcessExecutor.offer must not short-circuit on shutdown.
   * Develop's scheduleLocalStart never checked shuttingDown; only drain does.
   * A mid-shutdown delegate at the concurrency cap must become durable
   * `queued` (survives crash sweep) rather than stranded `pending` (swept to
   * stalled and never re-drained).
   */
  it("mid-shutdown delegate at cap still parks as queued, not pending (#312)", () => {
    writeParleyConfig({ vendors: { fake: { maxConcurrent: 1 } } });
    insertRunningSlot();
    const eng = engine();
    // Production SIGTERM sets this flag before server.close(); in-flight HTTP
    // may still complete and insert a row after the flag flips.
    eng.killChildren();

    const row = eng.delegate(baseRequest());
    const after = getTask(db, row.id)!;
    expect(after.state).toBe("queued");
    expect(listQueuedTasks(db).map((t) => t.id)).toContain(row.id);
    expect(after.state).not.toBe("pending");
  });

});

/**
 * Direct host-level pins for {@link InProcessExecutor.drain} (#326).
 *
 * Engine-level "who left queued" snapshots race with spawn→fail cascade
 * without a hub and can false-green under LIFO (both waiters leave before
 * the next poll). These host stubs record `executeClaimed` identity with
 * one free slot, so a LIFO walk of the drain loop turns the suite red.
 */
describe("InProcessExecutor drain (#326)", () => {
  function stubTask(id: string): TaskRow {
    // Minimal row: drain only needs id + host callbacks.
    return { id, state: "queued", vendor: "fake" } as TaskRow;
  }

  it("with cap saturated and ≥2 queued, one free slot admits the oldest (FIFO head-of-line)", () => {
    const queue = [stubTask("t-old"), stubTask("t-mid"), stubTask("t-new")];
    const admitted: string[] = [];
    // One free slot: first successful canAdmit admits exactly one task.
    let freeSlots = 1;

    const host: InProcessExecutorHost = {
      isShuttingDown: () => false,
      isLocalTask: () => true,
      canAdmit: () => freeSlots > 0,
      enqueue: () => {
        /* unused */
      },
      executeClaimed: (task) => {
        admitted.push(task.id);
        freeSlots -= 1;
      },
      listQueued: () => queue.filter((t) => !admitted.includes(t.id)),
      isAlreadyAdmitted: (id) => admitted.includes(id),
    };

    const exec = new InProcessExecutor(host);
    exec.drain();

    // Head-of-line identity: oldest first — not the tail a LIFO walk picks.
    expect(admitted).toEqual(["t-old"]);
    expect(admitted).not.toContain("t-new");
    expect(admitted).not.toContain("t-mid");
  });

  it("re-entrant drain during admit is a no-op (no nested walk)", () => {
    const queue = [stubTask("a"), stubTask("b")];
    const admitted: string[] = [];
    let freeSlots = 2;
    let concurrentWalks = 0;
    let maxConcurrentWalks = 0;
    let listQueuedCalls = 0;

    const host: InProcessExecutorHost = {
      isShuttingDown: () => false,
      isLocalTask: () => true,
      canAdmit: () => freeSlots > 0,
      enqueue: () => {
        /* unused */
      },
      executeClaimed: (task) => {
        admitted.push(task.id);
        freeSlots -= 1;
        // Nested call while the outer walk still holds the guard.
        exec.drain();
      },
      listQueued: () => {
        listQueuedCalls += 1;
        concurrentWalks += 1;
        maxConcurrentWalks = Math.max(maxConcurrentWalks, concurrentWalks);
        try {
          return queue.filter((t) => !admitted.includes(t.id));
        } finally {
          concurrentWalks -= 1;
        }
      },
      isAlreadyAdmitted: (id) => admitted.includes(id),
    };

    const exec = new InProcessExecutor(host);
    exec.drain();

    // Outer walk admits both (two free slots); nested drain never walks.
    expect(admitted).toEqual(["a", "b"]);
    expect(maxConcurrentWalks).toBe(1);
    // Without the guard, each executeClaimed would start a nested walk that
    // also calls listQueued — listQueuedCalls would exceed the outer passes.
    // With the guard: one list per outer while-iteration only.
    expect(listQueuedCalls).toBeLessThanOrEqual(3);
  });
});
