/**
 * #206 — task-state transition module: pairing invariant and hook dispatch.
 *
 * Pure unit surface: temp SQLite + fake hooks. No TaskEngine, children, or MCP.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths, type TaskState } from "@useparley/core";
import {
  getTask,
  insertTask,
  openDatabase,
  updateTask,
  writeTaskState,
  type DatabaseHandle,
  type TaskDataPatch,
} from "../src/db.js";
import {
  createTaskTransitions,
  type Transition,
  type TransitionHooks,
} from "../src/transition.js";

let home: string;
let db: DatabaseHandle;

function seedTask(id: string, state: TaskState = "pending"): void {
  insertTask(db, {
    id,
    name: id,
    vendor: "fake",
    model: null,
    effort: null,
    profile: null,
    repo: null,
    cwd: "/tmp",
    prompt: "do it",
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
  if (state !== "pending") {
    // Privileged fixture write only — production paths use apply().
    writeTaskState(db, id, state);
  }
}

function makeHooks(): TransitionHooks & {
  appended: Transition[];
  wakes: number;
  slotFreed: Array<{ taskId: string; state: TaskState }>;
  terminals: Array<{ taskId: string; state: TaskState }>;
  order: string[];
} {
  const appended: Transition[] = [];
  const slotFreed: Array<{ taskId: string; state: TaskState }> = [];
  const terminals: Array<{ taskId: string; state: TaskState }> = [];
  const order: string[] = [];
  let wakes = 0;
  return {
    appended,
    get wakes() {
      return wakes;
    },
    set wakes(n: number) {
      wakes = n;
    },
    slotFreed,
    terminals,
    order,
    append(t) {
      order.push("append");
      appended.push(t);
    },
    wake() {
      order.push("wake");
      wakes += 1;
    },
    onSlotFreed(taskId, state) {
      order.push("onSlotFreed");
      slotFreed.push({ taskId, state });
    },
    onTerminal(taskId, state) {
      order.push("onTerminal");
      terminals.push({ taskId, state });
    },
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-transition-"));
  db = openDatabase(homePaths(home));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("TaskTransitions.apply (#206)", () => {
  it("writes state and bumps seq", () => {
    seedTask("t1");
    const before = getTask(db, "t1")!;
    expect(before.state).toBe("pending");
    expect(before.seq).toBe(0);

    const hooks = makeHooks();
    const transitions = createTaskTransitions(db, hooks);
    const t = transitions.apply("t1", "running", {
      cause: "spawn",
      fields: { started_at: "2026-01-01T00:00:00.000Z" },
    });

    expect(t).not.toBeNull();
    expect(t!.task_id).toBe("t1");
    expect(t!.state).toBe("running");
    expect(t!.seq).toBeGreaterThan(0);

    const row = getTask(db, "t1")!;
    expect(row.state).toBe("running");
    expect(row.seq).toBe(t!.seq);
    expect(row.started_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("always calls append then wake (pairing invariant)", () => {
    seedTask("t1");
    const hooks = makeHooks();
    const transitions = createTaskTransitions(db, hooks);
    transitions.apply("t1", "queued", {
      cause: "enqueue",
      fields: { queued_at: "2026-01-01T00:00:00.000Z" },
    });

    expect(hooks.appended).toHaveLength(1);
    expect(hooks.wakes).toBe(1);
    const appendIdx = hooks.order.indexOf("append");
    const wakeIdx = hooks.order.indexOf("wake");
    expect(appendIdx).toBeGreaterThanOrEqual(0);
    expect(wakeIdx).toBeGreaterThan(appendIdx);
  });

  it("calls onSlotFreed for terminal and stalled, not for running/queued", () => {
    const cases: Array<{ to: TaskState; expectSlot: boolean; expectTerminal: boolean }> = [
      { to: "completed", expectSlot: true, expectTerminal: true },
      { to: "failed", expectSlot: true, expectTerminal: true },
      { to: "cancelled", expectSlot: true, expectTerminal: true },
      { to: "stalled", expectSlot: true, expectTerminal: false },
      { to: "running", expectSlot: false, expectTerminal: false },
      { to: "queued", expectSlot: false, expectTerminal: false },
    ];

    for (const c of cases) {
      const id = `t-${c.to}`;
      seedTask(id);
      const hooks = makeHooks();
      const transitions = createTaskTransitions(db, hooks);
      transitions.apply(id, c.to, { cause: "test" });

      if (c.expectSlot) {
        expect(hooks.slotFreed).toEqual([{ taskId: id, state: c.to }]);
      } else {
        expect(hooks.slotFreed).toEqual([]);
      }
      if (c.expectTerminal) {
        expect(hooks.terminals).toEqual([{ taskId: id, state: c.to }]);
      } else {
        expect(hooks.terminals).toEqual([]);
      }
    }
  });

  it("returns null and fires no hooks for a missing task", () => {
    const hooks = makeHooks();
    const transitions = createTaskTransitions(db, hooks);
    expect(transitions.apply("missing", "running")).toBeNull();
    expect(hooks.appended).toEqual([]);
    expect(hooks.wakes).toBe(0);
    expect(hooks.slotFreed).toEqual([]);
    expect(hooks.terminals).toEqual([]);
  });

  it("round-trips co-fields with the state write", () => {
    seedTask("t1");
    const hooks = makeHooks();
    const transitions = createTaskTransitions(db, hooks);
    transitions.apply("t1", "awaiting_answer", {
      cause: "ask",
      fields: {
        question_id: "q1",
        question: "what next?",
      },
    });
    const row = getTask(db, "t1")!;
    expect(row.state).toBe("awaiting_answer");
    expect(row.question_id).toBe("q1");
    expect(row.question).toBe("what next?");

    transitions.apply("t1", "failed", {
      cause: "fail",
      fields: {
        error: "boom",
        completed_at: "2026-01-01T00:00:01.000Z",
        question_id: null,
        question: null,
      },
    });
    const failed = getTask(db, "t1")!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("boom");
    expect(failed.completed_at).toBe("2026-01-01T00:00:01.000Z");
    expect(failed.question_id).toBeNull();
    expect(failed.question).toBeNull();
  });

  it("no-ops when state is unchanged and no fields / force", () => {
    seedTask("t1");
    const hooks = makeHooks();
    const transitions = createTaskTransitions(db, hooks);
    transitions.apply("t1", "running", { cause: "spawn" });
    const seqAfter = getTask(db, "t1")!.seq;
    expect(transitions.apply("t1", "running")).toBeNull();
    expect(getTask(db, "t1")!.seq).toBe(seqAfter);
    expect(hooks.appended).toHaveLength(1);
    expect(hooks.wakes).toBe(1);
  });

  it("republishes when force is set on same state", () => {
    seedTask("t1");
    const hooks = makeHooks();
    const transitions = createTaskTransitions(db, hooks);
    transitions.apply("t1", "running", { cause: "spawn" });
    const t2 = transitions.apply("t1", "running", { force: true });
    expect(t2).not.toBeNull();
    expect(hooks.appended).toHaveLength(2);
    expect(hooks.wakes).toBe(2);
  });
});

describe("TaskTransitions.recordExternal (#206)", () => {
  it("bumps seq and appends without waking", () => {
    seedTask("t1");
    // Simulate bulk SQL stall write without going through apply.
    writeTaskState(db, "t1", "stalled", { error: "daemon restarted" });

    const hooks = makeHooks();
    const transitions = createTaskTransitions(db, hooks);
    const t = transitions.recordExternal("t1", "stalled", "bootstrap_sweep");
    expect(t).not.toBeNull();
    expect(t!.state).toBe("stalled");
    expect(hooks.appended).toEqual([t]);
    expect(hooks.wakes).toBe(0);
    expect(hooks.slotFreed).toEqual([]);
  });
});

describe("TaskDataPatch type fence (#206)", () => {
  it("rejects state on updateTask at the type level", () => {
    // Compile-time only — if this ever type-checks with state, the fence is broken.
    expectTypeOf(updateTask).parameter(2).toEqualTypeOf<TaskDataPatch>();
    expectTypeOf<TaskDataPatch>().not.toHaveProperty("state");
  });
});
