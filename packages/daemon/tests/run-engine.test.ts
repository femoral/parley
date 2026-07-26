/**
 * #237 — pure advance, port fill (accumulate / from-less), loop budget, gate block.
 * ADR-0017 core. No spawn / verbs / failure policy (#238).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  homePaths,
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from "@useparley/core";
import {
  bumpRunSeq,
  getRun,
  getRunBlockReason,
  insertDeliverable,
  insertRun,
  insertTask,
  nextDeliverableId,
  nextRunId,
  nextTaskId,
  openDatabase,
  type DatabaseHandle,
  type NewTask,
  type RunRow,
} from "../src/db.js";
import {
  createInbox,
  runInboxTierState,
  sqliteAckStore,
  sqliteRunSnapshot,
  sqliteTaskSnapshot,
} from "../src/inbox.js";
import {
  accumulatePort,
  advance,
  advanceRun,
  applyAdvanceDecision,
  buildAdvanceContext,
  collectOutputFromRows,
  completedIterationsFromRows,
  drainRuns,
  fillStepInputs,
  isStepSettled,
  mergeAccumulated,
  missingInputPorts,
  mostRecentOutput,
  type AdvanceContext,
  type AdvanceDecision,
  type AdvanceTask,
} from "../src/run-engine.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function miniDefinition(): WorkflowDefinition {
  const raw = {
    id: "mini",
    version: 1,
    type: "other",
    workspace: "scratch",
    inputs: { brief: { type: "text" } },
    outputs: { out: { type: "text", from: "end.report" } },
    types: {
      coverage: { enum: ["sufficient", "insufficient"] },
      verdict: { enum: ["approve", "changes_requested"] },
    },
    nodes: [
      {
        id: "scope",
        kind: "step",
        prompt: "prompts/scope.md",
        in: {
          brief: { type: "text", from: "run.brief" },
          // from-less: loop-filled (Research scope.gaps pattern)
          gaps: { type: "text" },
        },
        out: {
          queries: { type: "dict<string, text>", max_items: 4 },
        },
      },
      {
        id: "search",
        kind: "step",
        prompt: "prompts/search.md",
        over: "query",
        in: {
          query: { type: "text", from: "scope.queries" },
        },
        out: {
          sources: { type: "text[]", max_items: 5 },
        },
      },
      {
        id: "funnel",
        kind: "step",
        prompt: "prompts/funnel.md",
        in: {
          harvest: {
            type: "dict<string, text[]>",
            from: "search.sources",
            accumulate: true,
          },
          brief: { type: "text", from: "run.brief" },
        },
        out: {
          shortlist: { type: "text[]", max_items: 8 },
        },
      },
      {
        id: "review",
        kind: "step",
        prompt: "prompts/review.md",
        in: {
          shortlist: { type: "text[]", from: "funnel.shortlist" },
        },
        out: {
          coverage: { type: "coverage" },
          gaps: { type: "text", max_length: 500 },
          report: { type: "text", max_length: 2000 },
        },
        loop: {
          to: "scope",
          while: { port: "coverage", is: "insufficient" },
          max: 2,
          with: { gaps: "review.gaps" },
        },
      },
      {
        id: "approve",
        kind: "gate",
        question: "Ship it?",
        shows: { report: { from: "review.report" } },
        on_reject: "finish",
      },
      {
        id: "end",
        kind: "step",
        prompt: "prompts/end.md",
        in: {
          report: { type: "text", from: "review.report" },
        },
        out: {
          report: { type: "text" },
        },
      },
    ],
  };
  return parseWorkflowDefinition(raw, {
    dir: "/tmp/mini-workflow",
    expectedId: "mini",
    typeCheck: true,
  }).definition;
}

function linearWithGate(): WorkflowDefinition {
  const raw = {
    id: "linear",
    version: 1,
    type: "other",
    workspace: "scratch",
    inputs: { brief: { type: "text" } },
    outputs: { plan: { type: "text", from: "plan.plan" } },
    nodes: [
      {
        id: "plan",
        kind: "step",
        prompt: "p.md",
        in: { brief: { type: "text", from: "run.brief" } },
        out: { plan: { type: "text" } },
      },
      {
        id: "gate",
        kind: "gate",
        question: "ok?",
        shows: { plan: { from: "plan.plan" } },
        on_reject: "finish",
      },
      {
        id: "implement",
        kind: "step",
        prompt: "i.md",
        in: {
          plan: { type: "text", from: "plan.plan" },
          rework: { type: "text" },
        },
        out: { branch: { type: "text" } },
      },
    ],
  };
  return parseWorkflowDefinition(raw, {
    dir: "/tmp/linear-workflow",
    expectedId: "linear",
    typeCheck: true,
  }).definition;
}

function makeCtx(opts: {
  definition: WorkflowDefinition;
  run?: Partial<AdvanceContext["run"]>;
  currentTasks?: readonly AdvanceTask[];
  runInputs?: Readonly<Record<string, unknown>>;
  outputs?: Record<string, unknown>;
  iterations?: Record<string, number[]>;
}): AdvanceContext {
  const outputs = opts.outputs ?? {};
  const iterations = opts.iterations ?? {};
  const run: AdvanceContext["run"] = {
    id: "r1",
    state: "running",
    current_node: "scope",
    iteration: 1,
    ...opts.run,
  };
  return {
    run,
    definition: opts.definition,
    currentTasks: opts.currentTasks ?? [],
    runInputs: opts.runInputs ?? { brief: "find the answer" },
    outputAt: (nodeId, port, iteration) => {
      const key = `${nodeId}.${port}@${iteration}`;
      return Object.prototype.hasOwnProperty.call(outputs, key)
        ? outputs[key]
        : undefined;
    },
    completedIterations: (nodeId, port) => {
      const key = `${nodeId}.${port}`;
      return iterations[key] ?? [];
    },
  };
}

function completed(id = "t1"): AdvanceTask {
  return { id, state: "completed", slot: null };
}

// ---------------------------------------------------------------------------
// isStepSettled
// ---------------------------------------------------------------------------

describe("isStepSettled", () => {
  it("requires every sibling settled, and stalled counts", () => {
    expect(isStepSettled([])).toBe(false);
    expect(
      isStepSettled([
        { id: "a", state: "completed", slot: "x" },
        { id: "b", state: "running", slot: "y" },
      ]),
    ).toBe(false);
    expect(
      isStepSettled([
        { id: "a", state: "completed", slot: "x" },
        { id: "b", state: "stalled", slot: "y" },
      ]),
    ).toBe(true);
    expect(
      isStepSettled([
        { id: "a", state: "failed", slot: null },
        { id: "b", state: "cancelled", slot: null },
      ]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// from-less exemption (scope.gaps deadlock)
// ---------------------------------------------------------------------------

describe("from-less input ports", () => {
  it("exempts from-less ports so first-node loop payloads do not deadlock", () => {
    const def = miniDefinition();
    const scope = def.nodes[0]!;
    expect(scope.kind).toBe("step");
    if (scope.kind !== "step") return;

    const ctx = makeCtx({
      definition: def,
      run: { current_node: "scope", iteration: 1 },
      // brief is available via runInputs; gaps has no from and no loop fill
    });

    // Without exemption, gaps would be "missing" and block enter forever.
    expect(missingInputPorts(scope, ctx, 1, {})).toEqual([]);

    // Wired ports still required:
    const ctxNoBrief = makeCtx({
      definition: def,
      runInputs: {},
    });
    expect(missingInputPorts(scope, ctxNoBrief, 1, {})).toEqual(["brief"]);
  });

  it("counts loopFills as filled for from-less ports", () => {
    const def = miniDefinition();
    const scope = def.nodes.find((n) => n.id === "scope")!;
    expect(scope.kind).toBe("step");
    if (scope.kind !== "step") return;

    const ctx = makeCtx({ definition: def });
    const fills = fillStepInputs(scope, ctx, { gaps: "need more on X" });
    expect(fills).toEqual({
      brief: "find the answer",
      gaps: "need more on X",
    });
  });
});

// ---------------------------------------------------------------------------
// advance order
// ---------------------------------------------------------------------------

describe("advance — settled?", () => {
  it("waits while any sibling is unsettled (including awaiting_answer)", () => {
    const def = miniDefinition();
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "scope", iteration: 1 },
      currentTasks: [
        { id: "t1", state: "completed", slot: null },
        { id: "t2", state: "awaiting_answer", slot: null },
      ],
    });
    expect(advance(ctx)).toEqual({ kind: "wait" });
  });

  it("waits when no tasks have been spawned yet", () => {
    const def = miniDefinition();
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "scope", iteration: 1 },
      currentTasks: [],
    });
    expect(advance(ctx)).toEqual({ kind: "wait" });
  });

  it("does not hang forever on stalled (stalled is settled)", () => {
    const def = miniDefinition();
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "scope", iteration: 1 },
      currentTasks: [{ id: "t1", state: "stalled", slot: null }],
      // stalled ⇒ not completed ⇒ unfilled outputs handoff for #238
    });
    const d = advance(ctx);
    expect(d.kind).toBe("unfilled_outputs");
  });
});

describe("advance — ports filled? → next node", () => {
  it("enters the next step when current completed with outputs", () => {
    const def = miniDefinition();
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "scope", iteration: 1 },
      currentTasks: [completed()],
      outputs: {
        "scope.queries@1": { q1: "what is X?" },
      },
      iterations: { "scope.queries": [1] },
    });
    expect(advance(ctx)).toEqual({
      kind: "enter",
      node: "search",
      iteration: 1,
      loopFills: {},
    });
  });

  it("completes when the last node settles", () => {
    const def = miniDefinition();
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "end", iteration: 1 },
      currentTasks: [completed()],
      outputs: { "end.report@1": "done" },
      iterations: { "end.report": [1] },
    });
    expect(advance(ctx)).toEqual({ kind: "complete" });
  });

  it("blocks on a gate node instead of entering it", () => {
    const def = linearWithGate();
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "plan", iteration: 1 },
      currentTasks: [completed()],
      outputs: { "plan.plan@1": "do the thing" },
      iterations: { "plan.plan": [1] },
    });
    expect(advance(ctx)).toEqual({
      kind: "block",
      reason: "gate",
      node: "gate",
      iteration: 1,
    });
  });

  it("re-asserts gate block when current_node is already the gate", () => {
    const def = linearWithGate();
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "gate", iteration: 1, state: "running" },
      currentTasks: [],
    });
    expect(advance(ctx)).toEqual({
      kind: "block",
      reason: "gate",
      node: "gate",
      iteration: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

describe("advance — loop", () => {
  it("loops back with iteration+1 and loop.with fills when while matches", () => {
    const def = miniDefinition();
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "review", iteration: 1 },
      currentTasks: [completed()],
      outputs: {
        "review.coverage@1": "insufficient",
        "review.gaps@1": "need primary sources",
        "review.report@1": "thin",
        // scope.queries from pass 1 so enter scope is port-ready
        "scope.queries@1": { q1: "x" },
      },
      iterations: {
        "review.coverage": [1],
        "review.gaps": [1],
        "review.report": [1],
        "scope.queries": [1],
      },
    });
    const d = advance(ctx);
    expect(d).toEqual({
      kind: "enter",
      node: "scope",
      iteration: 2,
      loopFills: { gaps: "need primary sources" },
    });
  });

  it("falls through to next when while is not satisfied", () => {
    const def = miniDefinition();
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "review", iteration: 1 },
      currentTasks: [completed()],
      outputs: {
        "review.coverage@1": "sufficient",
        "review.gaps@1": "",
        "review.report@1": "solid",
      },
      iterations: {
        "review.coverage": [1],
        "review.gaps": [1],
        "review.report": [1],
      },
    });
    // next node after review is the gate "approve"
    expect(advance(ctx)).toEqual({
      kind: "block",
      reason: "gate",
      node: "approve",
      iteration: 1,
    });
  });

  it("blocks as implicit gate when loop budget is exhausted (not proceed, not fail)", () => {
    const def = miniDefinition();
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "review", iteration: 2 }, // max is 2
      currentTasks: [completed()],
      outputs: {
        "review.coverage@2": "insufficient",
        "review.gaps@2": "still thin",
        "review.report@2": "still thin",
      },
      iterations: {
        "review.coverage": [1, 2],
        "review.gaps": [1, 2],
        "review.report": [1, 2],
      },
    });
    const d = advance(ctx);
    expect(d).toEqual({
      kind: "block",
      reason: "loop_budget",
      node: "review",
      iteration: 2,
      loopMax: 2,
    });
  });

  it("loops when iteration is still under max", () => {
    const def = miniDefinition();
    // max 2, currently at 1, while true → enter scope at 2
    const ctx = makeCtx({
      definition: def,
      run: { current_node: "review", iteration: 1 },
      currentTasks: [completed()],
      outputs: {
        "review.coverage@1": "insufficient",
        "review.gaps@1": "g",
        "review.report@1": "r",
      },
      iterations: {
        "review.coverage": [1],
        "review.gaps": [1],
        "review.report": [1],
      },
    });
    const d = advance(ctx) as Extract<AdvanceDecision, { kind: "enter" }>;
    expect(d.kind).toBe("enter");
    expect(d.iteration).toBe(2);
    expect(d.node).toBe("scope");
  });
});

// ---------------------------------------------------------------------------
// Accumulate
// ---------------------------------------------------------------------------

describe("accumulate / most-recent", () => {
  it("mostRecentOutput resolves only the latest completed iteration", () => {
    const def = miniDefinition();
    const ctx = makeCtx({
      definition: def,
      outputs: {
        "search.sources@1": { q1: ["a"] },
        "search.sources@2": { q2: ["b"] },
      },
      iterations: { "search.sources": [1, 2] },
    });
    expect(mostRecentOutput("search", "sources", ctx)).toEqual({ q2: ["b"] });
  });

  it("accumulatePort merges all iterations; dict later key wins; arrays concat", () => {
    const def = miniDefinition();
    const ctx = makeCtx({
      definition: def,
      outputs: {
        "search.sources@1": { q1: ["a"], shared: ["old"] },
        "search.sources@2": { q2: ["b"], shared: ["new"] },
      },
      iterations: { "search.sources": [1, 2] },
    });
    expect(accumulatePort("search", "sources", ctx)).toEqual({
      q1: ["a"],
      q2: ["b"],
      shared: ["new"], // later wins
    });

    expect(mergeAccumulated(["x"], ["y", "z"])).toEqual(["x", "y", "z"]);
    expect(mergeAccumulated({ a: 1 }, { a: 2, b: 3 })).toEqual({ a: 2, b: 3 });
  });

  it("fillStepInputs uses accumulate on funnel.harvest", () => {
    const def = miniDefinition();
    const funnel = def.nodes.find((n) => n.id === "funnel")!;
    expect(funnel.kind).toBe("step");
    if (funnel.kind !== "step") return;

    const ctx = makeCtx({
      definition: def,
      outputs: {
        "search.sources@1": { q1: ["s1"] },
        "search.sources@2": { q2: ["s2"] },
      },
      iterations: { "search.sources": [1, 2] },
    });
    const filled = fillStepInputs(funnel, ctx);
    expect(filled.harvest).toEqual({ q1: ["s1"], q2: ["s2"] });
    expect(filled.brief).toBe("find the answer");
  });
});

// ---------------------------------------------------------------------------
// Collect from deliverable rows
// ---------------------------------------------------------------------------

describe("collectOutputFromRows", () => {
  it("collects fan-out dict by slot and lists completed iterations", () => {
    const rows = [
      {
        id: "d1",
        run_id: "r1",
        node: "search",
        port: "sources",
        iteration: 1,
        slot: "q1",
        task_id: "t1",
        kind: "inline" as const,
        value: JSON.stringify(["a"]),
        created_at: "",
        purged_at: null,
      },
      {
        id: "d2",
        run_id: "r1",
        node: "search",
        port: "sources",
        iteration: 1,
        slot: "q2",
        task_id: "t2",
        kind: "inline" as const,
        value: JSON.stringify(["b"]),
        created_at: "",
        purged_at: null,
      },
      {
        id: "d3",
        run_id: "r1",
        node: "search",
        port: "sources",
        iteration: 2,
        slot: "q3",
        task_id: "t3",
        kind: "inline" as const,
        value: JSON.stringify(["c"]),
        created_at: "",
        purged_at: null,
      },
    ];
    expect(collectOutputFromRows(rows, "search", "sources", 1, "dict")).toEqual({
      q1: ["a"],
      q2: ["b"],
    });
    expect(completedIterationsFromRows(rows, "search", "sources")).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// apply + drain against sqlite
// ---------------------------------------------------------------------------

describe("applyAdvanceDecision + advanceRun", () => {
  let home: string;
  let db: DatabaseHandle;
  const def = miniDefinition();

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-advance-"));
    db = openDatabase(homePaths(home));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* */
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  function seedRun(partial: Partial<RunRow> & { current_node: string | null }): RunRow {
    const id = nextRunId(db);
    return insertRun(db, {
      id,
      workflow: "mini",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: partial.current_node,
      iteration: partial.iteration ?? 1,
      state: partial.state ?? "running",
    });
  }

  function seedTask(
    run: RunRow,
    node: string,
    state: string,
    iteration = run.iteration,
  ): string {
    const id = nextTaskId(db);
    const base: NewTask = {
      id,
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      repo: null,
      cwd: "/tmp",
      prompt: "x",
      orchestrator_session_id: null,
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
      run_id: run.id,
      node,
      iteration,
      slot: null,
    };
    insertTask(db, base);
    // insertTask always creates pending — patch to the desired settled state.
    db.prepare(`UPDATE tasks SET state = ? WHERE id = ?`).run(state, id);
    return id;
  }

  function seedDeliverable(
    run: RunRow,
    taskId: string,
    node: string,
    port: string,
    value: unknown,
    iteration = run.iteration,
    slot: string | null = null,
  ): void {
    insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: run.id,
      node,
      port,
      iteration,
      slot,
      task_id: taskId,
      kind: "inline",
      value: JSON.stringify(value),
    });
  }

  it("applyAdvanceDecision blocks on loop_budget with a legible error", () => {
    const run = seedRun({ current_node: "review", iteration: 2 });
    const applied = applyAdvanceDecision(db, run, {
      kind: "block",
      reason: "loop_budget",
      node: "review",
      iteration: 2,
      loopMax: 2,
    });
    expect(applied.changed).toBe(true);
    expect(applied.run.state).toBe("blocked");
    expect(applied.run.error).toBe("blocked (loop 2/2)");
    expect(applied.run.current_node).toBe("review");
    // ADR-0019: reason is persisted for the inbox (not re-derived from error).
    expect(getRunBlockReason(db, run.id)).toBe("loop_budget");
  });

  it("persists gate vs spawn block_reason so poison error text cannot forge a gate", () => {
    const gateRun = seedRun({ current_node: "review", iteration: 1 });
    applyAdvanceDecision(db, gateRun, {
      kind: "block",
      reason: "gate",
      node: "review",
      iteration: 1,
    });
    expect(getRunBlockReason(db, gateRun.id)).toBe("gate");
    expect(
      runInboxTierState({
        state: "blocked",
        block_reason: getRunBlockReason(db, gateRun.id),
      }),
    ).toBe("gate");

    // Spawn error whose free-text contains "gate" substrings (DelegateError,
    // investigate, propagate) must still be stored as spawn — and the inbox
    // must treat it as ackable tier 2.
    const spawnRun = seedRun({ current_node: "search", iteration: 1 });
    applyAdvanceDecision(
      db,
      spawnRun,
      {
        kind: "block",
        reason: "spawn",
        node: "search",
        iteration: 1,
      },
      {
        error:
          "blocked (spawn investigate): DelegateError: cannot propagate",
      },
    );
    expect(getRunBlockReason(db, spawnRun.id)).toBe("spawn");
    expect(
      runInboxTierState({
        state: "blocked",
        block_reason: getRunBlockReason(db, spawnRun.id),
      }),
    ).toBe("blocked");

    // Wire through sqlite inbox adapters: gate unackable, spawn ackable.
    const gateSeq = bumpRunSeq(db, gateRun.id);
    const spawnSeq = bumpRunSeq(db, spawnRun.id);
    const box = createInbox(
      sqliteTaskSnapshot(db),
      sqliteAckStore(db),
      sqliteRunSnapshot(db),
    );
    const w = { taskIds: [] as string[], runIds: [gateRun.id, spawnRun.id] };
    // Gate is tier 1 → delivered first.
    expect(box.peek(w)?.id).toBe(gateRun.id);
    expect(box.peek(w)?.state).toBe("gate");
    box.ack(gateSeq);
    // Ack of gate is a no-op — still first.
    expect(box.peek(w)?.id).toBe(gateRun.id);

    // Isolate spawn: ackable tier 2.
    const spawnOnly = { taskIds: [] as string[], runIds: [spawnRun.id] };
    expect(box.peek(spawnOnly)?.state).toBe("blocked");
    box.ack(spawnSeq);
    expect(box.peek(spawnOnly)).toBeNull();
  });

  it("advanceRun: settled scope → enter search (cursor moves)", () => {
    const run = seedRun({ current_node: "scope", iteration: 1 });
    const tid = seedTask(run, "scope", "completed");
    seedDeliverable(run, tid, "scope", "queries", { q1: "what?" });

    const result = advanceRun(db, run.id, {
      loadDefinition: () => def,
      runInputs: () => ({ brief: "find the answer" }),
    });
    expect(result?.decision.kind).toBe("enter");
    expect(result?.run.current_node).toBe("search");
    expect(result?.run.iteration).toBe(1);
    expect(result?.run.state).toBe("running");
  });

  it("advanceRun: review while insufficient at max → blocked, not completed/failed", () => {
    const run = seedRun({ current_node: "review", iteration: 2 });
    const tid = seedTask(run, "review", "completed", 2);
    seedDeliverable(run, tid, "review", "coverage", "insufficient", 2);
    seedDeliverable(run, tid, "review", "gaps", "still thin", 2);
    seedDeliverable(run, tid, "review", "report", "r", 2);

    const result = advanceRun(db, run.id, {
      loadDefinition: () => def,
    });
    expect(result?.decision).toMatchObject({
      kind: "block",
      reason: "loop_budget",
    });
    expect(result?.run.state).toBe("blocked");
    expect(result?.run.state).not.toBe("failed");
    expect(result?.run.state).not.toBe("completed");
  });

  it("drainRuns walks running runs with a host", () => {
    const run = seedRun({ current_node: "scope", iteration: 1 });
    const tid = seedTask(run, "scope", "completed");
    seedDeliverable(run, tid, "scope", "queries", { q1: "x" });

    const enters: string[] = [];
    drainRuns(db, {
      loadDefinition: () => def,
      runInputs: () => ({ brief: "b" }),
      onEnter: ({ step }) => {
        enters.push(step.id);
      },
    });

    const after = getRun(db, run.id)!;
    expect(after.current_node).toBe("search");
    expect(enters).toEqual(["search"]);
  });

  it("null definition loader is a no-op (does not fail the run)", () => {
    const run = seedRun({ current_node: "scope", iteration: 1 });
    seedTask(run, "scope", "completed");
    const result = advanceRun(db, run.id, { loadDefinition: () => null });
    expect(result?.changed).toBe(false);
    expect(getRun(db, run.id)!.state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// buildAdvanceContext integration smoke
// ---------------------------------------------------------------------------

describe("buildAdvanceContext", () => {
  it("projects current tasks and deliverables into pure outputAt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ctx-"));
    const db = openDatabase(homePaths(home));
    try {
      const def = linearWithGate();
      const run = insertRun(db, {
        id: nextRunId(db),
        workflow: "linear",
        version: 1,
        type: "other",
        workspace: "scratch",
        repo: null,
        current_node: "plan",
        iteration: 1,
      });
      const tid = nextTaskId(db);
      insertTask(db, {
        id: tid,
        name: null,
        vendor: "fake",
        model: null,
        effort: null,
        profile: null,
        repo: null,
        cwd: "/tmp",
        prompt: "x",
        orchestrator_session_id: null,
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
        run_id: run.id,
        node: "plan",
        iteration: 1,
        slot: null,
      });
      db.prepare(`UPDATE tasks SET state = 'completed' WHERE id = ?`).run(tid);
      insertDeliverable(db, {
        id: nextDeliverableId(db),
        run_id: run.id,
        node: "plan",
        port: "plan",
        iteration: 1,
        slot: null,
        task_id: tid,
        kind: "inline",
        value: JSON.stringify("the plan"),
      });

      const ctx = buildAdvanceContext({
        run: getRun(db, run.id)!,
        definition: def,
        db,
        runInputs: { brief: "b" },
      });
      expect(ctx.currentTasks).toHaveLength(1);
      expect(ctx.currentTasks[0]!.state).toBe("completed");
      expect(ctx.outputAt("plan", "plan", 1)).toBe("the plan");
      expect(advance(ctx).kind).toBe("block"); // next is gate
    } finally {
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
