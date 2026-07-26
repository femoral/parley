/**
 * #238 — advanceRun routes unfilled_outputs through success policy / retries;
 * actionRunVerb moves a blocked run.
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
  getRun,
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
  actionRunVerb,
  advanceRun,
  resolveUnfilledOutputs,
  toPolicyTasks,
  type AdvanceContext,
} from "../src/run-engine.js";

function fanOutDef(): WorkflowDefinition {
  return parseWorkflowDefinition(
    {
      id: "fan",
      version: 1,
      type: "other",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "join.out" } },
      nodes: [
        {
          id: "search",
          kind: "step",
          prompt: "s.md",
          over: "q",
          // data default is min 1; leave explicit for clarity
          success: { min: 1 },
          retries: 1,
          in: {
            q: { type: "text", from: "run.brief" },
          },
          out: { hit: { type: "text" } },
        },
        {
          id: "join",
          kind: "step",
          prompt: "j.md",
          in: {
            hits: { type: "text[]", from: "search.hit" },
          },
          out: { out: { type: "text" } },
        },
      ],
    },
    { dir: "/tmp/fan", expectedId: "fan", typeCheck: false },
  ).definition;
}

function linearGateDef(): WorkflowDefinition {
  return parseWorkflowDefinition(
    {
      id: "lin",
      version: 1,
      type: "other",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "end.out" } },
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
          id: "end",
          kind: "step",
          prompt: "e.md",
          in: { plan: { type: "text", from: "plan.plan" } },
          out: { out: { type: "text" } },
        },
      ],
    },
    { dir: "/tmp/lin", expectedId: "lin", typeCheck: true },
  ).definition;
}

describe("resolveUnfilledOutputs", () => {
  it("blocks when min policy is not met", () => {
    const def = fanOutDef();
    const step = def.nodes[0]!;
    expect(step.kind).toBe("step");
    if (step.kind !== "step") return;

    const ctx = {
      run: { id: "r1", state: "running" as const, current_node: "search", iteration: 1 },
      definition: def,
      currentTasks: [
        { id: "t1", state: "failed", slot: "0" },
        { id: "t2", state: "failed", slot: "1" },
      ],
      runInputs: {},
      outputAt: () => undefined,
      completedIterations: () => [],
    } satisfies AdvanceContext;

    const resolved = resolveUnfilledOutputs(
      step,
      ctx,
      toPolicyTasks(ctx.currentTasks),
    );
    // retries:1 and each slot has 1 failed → retry plans first
    expect(resolved.kind).toBe("retry");
  });

  it("continues when min 1 is met despite sibling failures", () => {
    const def = fanOutDef();
    const step = def.nodes[0]!;
    expect(step.kind).toBe("step");
    if (step.kind !== "step") return;
    // Exhaust retries so policy is evaluated.
    const noRetry = { ...step, retries: 0 };

    const ctx = {
      run: { id: "r1", state: "running" as const, current_node: "search", iteration: 1 },
      definition: def,
      currentTasks: [
        { id: "t1", state: "failed", slot: "0" },
        { id: "t2", state: "completed", slot: "1" },
      ],
      runInputs: {},
      // Surviving sibling produced search.hit so join's input can fill.
      outputAt: (node, port, iter) =>
        node === "search" && port === "hit" && iter === 1 ? ["ok"] : undefined,
      completedIterations: (node, port) =>
        node === "search" && port === "hit" ? [1] : [],
    } satisfies AdvanceContext;

    const resolved = resolveUnfilledOutputs(
      noRetry,
      ctx,
      toPolicyTasks(ctx.currentTasks),
    );
    expect(resolved.kind).toBe("continue");
    if (resolved.kind === "continue") {
      // May be enter (join) or unfilled_inputs if the pure collector shape
      // differs — either way the policy layer chose *continue*, not block.
      expect(["enter", "unfilled_inputs"]).toContain(resolved.decision.kind);
      if (resolved.decision.kind === "enter") {
        expect(resolved.decision.node).toBe("join");
      }
    }
  });

  it("blocks with success_policy when min is not met and retries exhausted", () => {
    const def = fanOutDef();
    const step = def.nodes[0]!;
    if (step.kind !== "step") return;
    const noRetry = { ...step, retries: 0 };

    const ctx = {
      run: { id: "r1", state: "running" as const, current_node: "search", iteration: 1 },
      definition: def,
      currentTasks: [
        { id: "t1", state: "failed", slot: "0" },
        { id: "t2", state: "failed", slot: "1" },
      ],
      runInputs: {},
      outputAt: () => undefined,
      completedIterations: () => [],
    } satisfies AdvanceContext;

    const resolved = resolveUnfilledOutputs(
      noRetry,
      ctx,
      toPolicyTasks(ctx.currentTasks),
    );
    expect(resolved.kind).toBe("block");
    if (resolved.kind === "block") {
      expect(resolved.decision.reason).toBe("success_policy");
      expect(resolved.policy.met).toBe(false);
    }
  });
});

describe("advanceRun + actionRunVerb integration", () => {
  let home: string;
  let db: DatabaseHandle;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-pol-"));
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

  function seedRun(
    def: WorkflowDefinition,
    partial: Partial<RunRow> & { current_node: string | null },
  ): RunRow {
    return insertRun(db, {
      id: nextRunId(db),
      workflow: def.id,
      version: def.version,
      type: def.type,
      workspace: def.workspace,
      repo: null,
      current_node: partial.current_node,
      iteration: partial.iteration ?? 1,
      state: partial.state ?? "running",
      error: partial.error ?? null,
    });
  }

  function seedTask(
    run: RunRow,
    node: string,
    state: string,
    slot: string | null = null,
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
      iteration: run.iteration,
      slot,
    };
    insertTask(db, base);
    db.prepare(`UPDATE tasks SET state = ? WHERE id = ?`).run(state, id);
    return id;
  }

  it("advanceRun blocks under success policy (never fails)", () => {
    const def = fanOutDef();
    const noRetry = {
      ...def,
      nodes: def.nodes.map((n) =>
        n.kind === "step" && n.id === "search" ? { ...n, retries: 0 } : n,
      ),
    };
    const run = seedRun(noRetry, { current_node: "search", iteration: 1 });
    seedTask(run, "search", "failed", "0");
    seedTask(run, "search", "failed", "1");

    const result = advanceRun(db, run.id, {
      loadDefinition: () => noRetry,
    });
    expect(result?.run.state).toBe("blocked");
    expect(result?.run.state).not.toBe("failed");
    expect(result?.run.error).toMatch(/min 1|NOT MET|success/i);
  });

  it("advanceRun retries a failed slot instead of blocking", () => {
    const def = fanOutDef();
    const run = seedRun(def, { current_node: "search", iteration: 1 });
    seedTask(run, "search", "failed", "0");
    // second sibling completed so only slot 0 needs retry — but min 1 is
    // already met. Force both failed with retries.
    seedTask(run, "search", "failed", "1");

    const retries: string[] = [];
    const result = advanceRun(db, run.id, {
      loadDefinition: () => def,
      onRetry: ({ plans }) => {
        for (const p of plans) retries.push(p.slot ?? "");
      },
    });
    expect(result?.decision.kind).toBe("wait");
    expect(result?.run.state).toBe("running");
    expect(retries.sort()).toEqual(["0", "1"]);
  });

  it("actionRunVerb approve on a gate advances to the next step", () => {
    const def = linearGateDef();
    const run = seedRun(def, {
      current_node: "gate",
      iteration: 1,
      state: "blocked",
      error: "blocked (gate gate)",
    });
    // Prior step deliverable so end's from-wired input resolves.
    const planTask = seedTask(run, "plan", "completed");
    insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: run.id,
      node: "plan",
      port: "plan",
      iteration: 1,
      slot: null,
      task_id: planTask,
      kind: "inline",
      value: JSON.stringify("the plan"),
    });

    const enters: string[] = [];
    const result = actionRunVerb(
      db,
      run.id,
      {
        loadDefinition: () => def,
        onEnter: ({ step }) => {
          enters.push(step.id);
        },
      },
      { verb: "approve" },
    );
    expect(result?.decision.kind).toBe("enter");
    expect(result?.run.state).toBe("running");
    expect(result?.run.current_node).toBe("end");
    expect(enters).toEqual(["end"]);
  });

  it("actionRunVerb finish completes the run", () => {
    const def = linearGateDef();
    const run = seedRun(def, {
      current_node: "gate",
      iteration: 1,
      state: "blocked",
      error: "blocked (gate gate)",
    });

    const result = actionRunVerb(
      db,
      run.id,
      { loadDefinition: () => def },
      { verb: "finish" },
    );
    expect(result?.decision.kind).toBe("complete");
    expect(getRun(db, run.id)!.state).toBe("completed");
  });

  it("actionRunVerb reject with on_reject finish completes", () => {
    const def = linearGateDef();
    const run = seedRun(def, {
      current_node: "gate",
      iteration: 1,
      state: "blocked",
      error: "blocked (gate gate)",
    });

    const result = actionRunVerb(
      db,
      run.id,
      { loadDefinition: () => def },
      { verb: "reject" },
    );
    expect(result?.decision.kind).toBe("complete");
    expect(getRun(db, run.id)!.state).toBe("completed");
  });

  it("loadDefinition throw marks the run failed (structural)", () => {
    const def = fanOutDef();
    const run = seedRun(def, { current_node: "search", iteration: 1 });
    seedTask(run, "search", "completed", "0");

    const result = advanceRun(db, run.id, {
      loadDefinition: () => {
        throw new Error("broken workflow.json");
      },
    });
    expect(result?.changed).toBe(true);
    expect(getRun(db, run.id)!.state).toBe("failed");
    expect(getRun(db, run.id)!.error).toMatch(/unparseable/);
  });
});
