/**
 * #238 — gate verbs (approve / reject / redirect / finish) and block reasons.
 */
import { describe, expect, it } from "vitest";
import { parseWorkflowDefinition, type WorkflowDefinition } from "@useparley/core";
import {
  actionGateVerb,
  inferBlockReason,
  verbsForBlockReason,
  type GateVerbContext,
} from "../src/run-gates.js";

function def(): WorkflowDefinition {
  return parseWorkflowDefinition(
    {
      id: "g",
      version: 1,
      type: "other",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "end.report" } },
      nodes: [
        {
          id: "plan",
          kind: "step",
          prompt: "p.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { plan: { type: "text" } },
        },
        {
          id: "approve-plan",
          kind: "gate",
          question: "Ship the plan?",
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
          out: { report: { type: "text" } },
        },
        {
          id: "rework-or-finish",
          kind: "gate",
          question: "Rework?",
          shows: {},
          on_reject: "finish",
          loop: {
            to: "implement",
            max: 2,
            with: { rework: "plan.plan" },
          },
        },
        {
          id: "end",
          kind: "step",
          prompt: "e.md",
          in: { report: { type: "text", from: "implement.report" } },
          out: { report: { type: "text" } },
        },
      ],
    },
    { dir: "/tmp/g", expectedId: "g", typeCheck: true },
  ).definition;
}

function emptyCtx(extra?: Partial<GateVerbContext>): GateVerbContext {
  return {
    runInputs: { brief: "b" },
    outputAt: () => undefined,
    completedIterations: () => [],
    ...extra,
  };
}

describe("verbsForBlockReason", () => {
  it("offers reject only on an author-declared gate", () => {
    expect(verbsForBlockReason("gate")).toEqual([
      "approve",
      "reject",
      "redirect",
      "finish",
    ]);
    expect(verbsForBlockReason("loop_budget")).toEqual([
      "approve",
      "redirect",
      "finish",
    ]);
    expect(verbsForBlockReason("success_policy")).not.toContain("reject");
    expect(verbsForBlockReason("spawn")).not.toContain("reject");
  });
});

describe("inferBlockReason", () => {
  it("reads gate from current_node kind", () => {
    const d = def();
    expect(
      inferBlockReason(
        {
          state: "blocked",
          error: "blocked (gate approve-plan)",
          current_node: "approve-plan",
        },
        d,
      ),
    ).toBe("gate");
  });

  it("reads loop_budget from error text", () => {
    const d = def();
    expect(
      inferBlockReason(
        {
          state: "blocked",
          error: "blocked (loop 2/2)",
          current_node: "implement",
        },
        d,
      ),
    ).toBe("loop_budget");
  });
});

describe("actionGateVerb", () => {
  it("refuses verbs on a non-blocked run", () => {
    const d = def();
    const r = actionGateVerb(
      {
        state: "running",
        current_node: "approve-plan",
        iteration: 1,
        error: null,
      },
      d,
      { verb: "approve" },
      emptyCtx(),
    );
    expect(r.kind).toBe("error");
  });

  it("approve on a linear gate enters the next step", () => {
    const d = def();
    const r = actionGateVerb(
      {
        state: "blocked",
        current_node: "approve-plan",
        iteration: 1,
        error: "blocked (gate approve-plan)",
      },
      d,
      { verb: "approve" },
      emptyCtx(),
    );
    expect(r).toMatchObject({
      kind: "enter",
      node: "implement",
      iteration: 1,
      via: "approve",
    });
  });

  it("reject with on_reject:finish completes the run", () => {
    const d = def();
    const r = actionGateVerb(
      {
        state: "blocked",
        current_node: "approve-plan",
        iteration: 1,
        error: "blocked (gate approve-plan)",
      },
      d,
      { verb: "reject" },
      emptyCtx(),
    );
    expect(r).toEqual({ kind: "complete", via: "reject" });
  });

  it("finish completes the run", () => {
    const d = def();
    const r = actionGateVerb(
      {
        state: "blocked",
        current_node: "approve-plan",
        iteration: 1,
        error: "blocked (gate approve-plan)",
      },
      d,
      { verb: "finish" },
      emptyCtx(),
    );
    expect(r).toEqual({ kind: "complete", via: "finish" });
  });

  it("redirect requires --to and opens a new iteration", () => {
    const d = def();
    const missing = actionGateVerb(
      {
        state: "blocked",
        current_node: "approve-plan",
        iteration: 1,
        error: "blocked (gate approve-plan)",
      },
      d,
      { verb: "redirect" },
      emptyCtx(),
    );
    expect(missing.kind).toBe("error");

    const r = actionGateVerb(
      {
        state: "blocked",
        current_node: "approve-plan",
        iteration: 1,
        error: "blocked (gate approve-plan)",
      },
      d,
      { verb: "redirect", to: "implement", note: "skip the plan gate" },
      emptyCtx(),
    );
    expect(r).toMatchObject({
      kind: "enter",
      node: "implement",
      iteration: 2,
      note: "skip the plan gate",
      via: "redirect",
    });
  });

  it("redirect is exempt from the loop budget (iteration+1 always, no max check)", () => {
    // Sitting on a gate at iteration == loop.max — redirect still opens
    // iteration+1 rather than being refused as a loop-budget path.
    const d = def();
    const r = actionGateVerb(
      {
        state: "blocked",
        current_node: "rework-or-finish",
        iteration: 2,
        error: "blocked (gate rework-or-finish)",
      },
      d,
      { verb: "redirect", to: "implement", note: "one more pass" },
      emptyCtx(),
    );
    expect(r).toMatchObject({
      kind: "enter",
      node: "implement",
      iteration: 3,
      note: "one more pass",
      via: "redirect",
      loopFills: {},
    });
  });

  it("redirect rewinds nothing — does not clear prior deliverables (pure decision only)", () => {
    // The pure verb only names the entry; apply never deletes rows. Guard
    // that the decision carries no rewind/clear payload.
    const d = def();
    const r = actionGateVerb(
      {
        state: "blocked",
        current_node: "approve-plan",
        iteration: 1,
        error: "blocked (gate approve-plan)",
      },
      d,
      { verb: "redirect", to: "plan" },
      emptyCtx(),
    );
    expect(r.kind).toBe("enter");
    if (r.kind === "enter") {
      expect(r.loopFills).toEqual({});
      expect(Object.keys(r)).not.toContain("clear");
      expect(Object.keys(r)).not.toContain("rewind");
    }
  });

  it("approve on a gated loop takes the loop under budget", () => {
    const d = def();
    const r = actionGateVerb(
      {
        state: "blocked",
        current_node: "rework-or-finish",
        iteration: 1,
        error: "blocked (gate rework-or-finish)",
      },
      d,
      { verb: "approve" },
      emptyCtx({
        outputAt: (node, port) =>
          node === "plan" && port === "plan" ? "the plan" : undefined,
        completedIterations: (node, port) =>
          node === "plan" && port === "plan" ? [1] : [],
      }),
    );
    expect(r).toMatchObject({
      kind: "enter",
      node: "implement",
      iteration: 2,
      via: "approve",
    });
    if (r.kind === "enter") {
      expect(r.loopFills.rework).toBe("the plan");
    }
  });

  it("approve on loop_budget force-exits to the next node", () => {
    const d = def();
    // Blocked at implement with loop_budget (step loop not shown; use implement
    // as the cursor after a loop step).
    const r = actionGateVerb(
      {
        state: "blocked",
        current_node: "implement",
        iteration: 2,
        error: "blocked (loop 2/2)",
      },
      d,
      { verb: "approve" },
      emptyCtx(),
    );
    expect(r).toMatchObject({
      kind: "enter",
      node: "rework-or-finish",
      iteration: 2,
      via: "approve",
    });
  });

  it("reject is refused on loop_budget", () => {
    const d = def();
    const r = actionGateVerb(
      {
        state: "blocked",
        current_node: "implement",
        iteration: 2,
        error: "blocked (loop 2/2)",
      },
      d,
      { verb: "reject" },
      emptyCtx(),
    );
    expect(r.kind).toBe("error");
  });
});
