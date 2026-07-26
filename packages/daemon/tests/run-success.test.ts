/**
 * #238 — fan-out success policy + retries (ADR-0017).
 */
import { describe, expect, it } from "vitest";
import { parseWorkflowDefinition, type WorkflowStepNode } from "@useparley/core";
import {
  evaluateSuccessPolicy,
  formatSuccessSummary,
  isUsableTask,
  planRetries,
  resolveSuccessPolicy,
  type PolicyTask,
} from "../src/run-success.js";

function step(partial: Partial<WorkflowStepNode> & { id: string }): WorkflowStepNode {
  return {
    kind: "step",
    prompt: "prompts/x.md",
    in: {},
    out: {},
    ...partial,
  };
}

function task(
  partial: Partial<PolicyTask> & { id: string; state: string },
): PolicyTask {
  return {
    slot: null,
    outcome: null,
    ...partial,
  };
}

describe("resolveSuccessPolicy", () => {
  it("defaults authored slots to all", () => {
    const s = step({
      id: "review",
      slots: {
        a: {},
        b: {},
      },
    });
    expect(resolveSuccessPolicy(s)).toEqual({ kind: "all" });
  });

  it("defaults data fan-out to min 1", () => {
    const s = step({ id: "search", over: "query" });
    expect(resolveSuccessPolicy(s)).toEqual({ kind: "min", min: 1 });
  });

  it("defaults a single-task step to all", () => {
    expect(resolveSuccessPolicy(step({ id: "plan" }))).toEqual({ kind: "all" });
  });

  it("honours explicit min", () => {
    const s = step({ id: "search", over: "query", success: { min: 3 } });
    expect(resolveSuccessPolicy(s)).toEqual({ kind: "min", min: 3 });
  });

  it("honours required slots", () => {
    const s = step({
      id: "review",
      slots: { a: {}, b: {}, c: {} },
      success: { required: ["a", "c"] },
    });
    expect(resolveSuccessPolicy(s)).toEqual({
      kind: "required",
      slots: ["a", "c"],
    });
  });
});

describe("isUsableTask / evaluateSuccessPolicy", () => {
  it("counts completed + partial as usable; blocked outcome is not", () => {
    expect(
      isUsableTask(task({ id: "t1", state: "completed", outcome: "success" })),
    ).toBe(true);
    expect(
      isUsableTask(task({ id: "t2", state: "completed", outcome: "partial" })),
    ).toBe(true);
    expect(
      isUsableTask(task({ id: "t3", state: "completed", outcome: null })),
    ).toBe(true);
    expect(
      isUsableTask(task({ id: "t4", state: "completed", outcome: "blocked" })),
    ).toBe(false);
    expect(isUsableTask(task({ id: "t5", state: "failed" }))).toBe(false);
    expect(isUsableTask(task({ id: "t6", state: "cancelled" }))).toBe(false);
    expect(isUsableTask(task({ id: "t7", state: "stalled" }))).toBe(false);
  });

  it("all: met only when every sibling is usable", () => {
    const s = step({
      id: "review",
      slots: { a: {}, b: {}, c: {} },
    });
    const tasks = [
      task({ id: "1", state: "completed", slot: "a" }),
      task({ id: "2", state: "completed", slot: "b" }),
      task({ id: "3", state: "failed", slot: "c" }),
    ];
    const r = evaluateSuccessPolicy(s, tasks);
    expect(r.met).toBe(false);
    expect(r.succeeded).toEqual(["1", "2"]);
    expect(r.failed).toEqual(["3"]);
    expect(r.summary).toContain("NOT MET");
  });

  it("min 1: met when one sibling succeeds (data default)", () => {
    const s = step({ id: "search", over: "query" });
    const tasks = [
      task({ id: "1", state: "failed", slot: "0" }),
      task({ id: "2", state: "completed", slot: "1" }),
      task({ id: "3", state: "cancelled", slot: "2" }),
    ];
    const r = evaluateSuccessPolicy(s, tasks);
    expect(r.met).toBe(true);
    expect(r.policy).toEqual({ kind: "min", min: 1 });
    expect(r.summary).toMatch(/min 1 — MET, 1 of 3/);
  });

  it("min 1: not met when every sibling fails", () => {
    const s = step({ id: "search", over: "query" });
    const tasks = [
      task({ id: "1", state: "failed", slot: "0" }),
      task({ id: "2", state: "failed", slot: "1" }),
    ];
    expect(evaluateSuccessPolicy(s, tasks).met).toBe(false);
  });

  it("required: met only when named slots are usable", () => {
    const s = step({
      id: "review",
      slots: { a: {}, b: {}, c: {} },
      success: { required: ["a", "c"] },
    });
    const ok = evaluateSuccessPolicy(s, [
      task({ id: "1", state: "completed", slot: "a" }),
      task({ id: "2", state: "failed", slot: "b" }),
      task({ id: "3", state: "completed", slot: "c" }),
    ]);
    expect(ok.met).toBe(true);

    const missing = evaluateSuccessPolicy(s, [
      task({ id: "1", state: "completed", slot: "a" }),
      task({ id: "2", state: "completed", slot: "b" }),
      task({ id: "3", state: "failed", slot: "c" }),
    ]);
    expect(missing.met).toBe(false);
  });

  it("cancelled sibling is a failure under the policy (current step)", () => {
    // Cancelling one task inside a run routes as a sibling failure.
    const s = step({
      id: "review",
      slots: { a: {}, b: {} },
    });
    const r = evaluateSuccessPolicy(s, [
      task({ id: "1", state: "completed", slot: "a" }),
      task({ id: "2", state: "cancelled", slot: "b" }),
    ]);
    expect(r.met).toBe(false);
    expect(r.failed).toContain("2");
  });
});

describe("planRetries", () => {
  it("default retries 0 → no plan", () => {
    const s = step({ id: "impl" });
    expect(
      planRetries(s, [task({ id: "1", state: "failed" })]),
    ).toEqual([]);
  });

  it("fires only on task-state failed, not cancelled/stalled", () => {
    const s = step({ id: "impl", retries: 1 });
    expect(
      planRetries(s, [task({ id: "1", state: "cancelled" })]),
    ).toEqual([]);
    expect(
      planRetries(s, [task({ id: "1", state: "stalled" })]),
    ).toEqual([]);
  });

  it("plans a fresh spawn when failedAttempts <= retries", () => {
    const s = step({ id: "impl", retries: 1 });
    const plans = planRetries(s, [task({ id: "1", state: "failed" })]);
    expect(plans).toEqual([
      { slot: null, failedAttempts: 1, retries: 1 },
    ]);
  });

  it("stops after the retry budget is exhausted", () => {
    const s = step({ id: "impl", retries: 1 });
    // Two failed attempts already — budget was 1 additional after the first.
    const plans = planRetries(s, [
      task({ id: "1", state: "failed" }),
      task({ id: "2", state: "failed" }),
    ]);
    // failedCount=2 > retries=1 → no more
    expect(plans).toEqual([]);
  });

  it("per-slot: only the failed slot is retried", () => {
    const s = step({
      id: "review",
      retries: 1,
      slots: { a: {}, b: {} },
    });
    const plans = planRetries(s, [
      task({ id: "1", state: "completed", slot: "a" }),
      task({ id: "2", state: "failed", slot: "b" }),
    ]);
    expect(plans).toEqual([{ slot: "b", failedAttempts: 1, retries: 1 }]);
  });

  it("does not retry when a later attempt for the same slot succeeded", () => {
    const s = step({ id: "impl", retries: 2 });
    const plans = planRetries(s, [
      task({ id: "1", state: "failed" }),
      task({ id: "2", state: "completed" }),
    ]);
    expect(plans).toEqual([]);
  });
});

describe("formatSuccessSummary", () => {
  it("renders policy kind and verdict", () => {
    expect(formatSuccessSummary({ kind: "all" }, 2, 3, false)).toBe(
      "all — NOT MET, 2 of 3",
    );
    expect(formatSuccessSummary({ kind: "min", min: 1 }, 1, 3, true)).toBe(
      "min 1 — MET, 1 of 3",
    );
  });
});

describe("parser accepts success.required", () => {
  it("round-trips required through parseWorkflowDefinition", () => {
    const { definition } = parseWorkflowDefinition(
      {
        id: "t",
        version: 1,
        type: "other",
        workspace: "scratch",
        inputs: {},
        outputs: {},
        nodes: [
          {
            id: "review",
            kind: "step",
            prompt: "p.md",
            slots: { a: {}, b: {} },
            success: { required: ["a"] },
            in: {},
            out: { v: { type: "text" } },
          },
        ],
      },
      { dir: "/tmp/t", expectedId: "t", typeCheck: false },
    );
    const n = definition.nodes[0]!;
    expect(n.kind).toBe("step");
    if (n.kind === "step") {
      expect(n.success?.required).toEqual(["a"]);
    }
  });
});
