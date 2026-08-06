import { describe, expect, it } from "vitest";
import type { NodeProjection, RunBlock, RunSummary } from "@useparley/core";
import {
  formatBlockParenthetical,
  GATE_READONLY_NOTICE,
  GATE_VERBS,
  projectNodeDisplay,
  projectRunStateLabel,
} from "../../src/screens/run/state.js";

function node(partial: Partial<NodeProjection> & Pick<NodeProjection, "node" | "state">): NodeProjection {
  return {
    kind: "step",
    iteration: 1,
    tasks_settled: 0,
    tasks_total: 0,
    usage: null,
    duration_ms: null,
    fanout: null,
    tallies: {},
    counts: {},
    summary: null,
    deliverables: [],
    gist: "",
    ...partial,
  };
}

function block(partial: Partial<RunBlock> & Pick<RunBlock, "reason">): RunBlock {
  return {
    node: null,
    iteration: null,
    detail: null,
    verbs: ["approve", "reject", "redirect", "finish"],
    ...partial,
  };
}

describe("projectNodeDisplay — fork vocabulary", () => {
  it("renders inherited as struck + quiet + INHERITED label (not hue-only)", () => {
    const d = projectNodeDisplay(node({ node: "plan", state: "inherited", iteration: 0 }));
    expect(d.forkKind).toBe("inherited");
    expect(d.struck).toBe(true);
    expect(d.quiet).toBe(true);
    expect(d.label).toBe("INHERITED");
    expect(d.cue).toBeNull();
  });

  it("renders skipped with loud cue + SKIPPED label (shape/weight, not hue-only)", () => {
    const d = projectNodeDisplay(
      node({ node: "approve", kind: "gate", state: "skipped", iteration: 0 }),
    );
    expect(d.forkKind).toBe("skipped");
    expect(d.struck).toBe(false);
    expect(d.label).toBe("SKIPPED");
    expect(d.cue).toMatch(/fork|⊘/);
  });

  it("renders held gates as HELD with awaiting token", () => {
    const d = projectNodeDisplay(
      node({ node: "approve", kind: "gate", state: "waiting", iteration: 1 }),
    );
    expect(d.label).toBe("HELD");
    expect(d.token).toBe("awaiting");
    expect(d.live).toBe(true);
    expect(d.emphasis).toBe("held");
  });
});

describe("block reason vocabulary", () => {
  it("formats every wire reason", () => {
    expect(formatBlockParenthetical(block({ reason: "gate" }))).toBe("gate");
    expect(
      formatBlockParenthetical(block({ reason: "loop_exhausted", iteration: 2, max: 2 })),
    ).toBe("loop 2/2");
    expect(
      formatBlockParenthetical(
        block({ reason: "success_policy", detail: "blocked (2/3 slots)" }),
      ),
    ).toBe("2/3 slots");
    expect(formatBlockParenthetical(block({ reason: "spawn_error" }))).toBe("spawn");
    expect(formatBlockParenthetical(block({ reason: "unfilled_inputs" }))).toBe("inputs");
  });
});

describe("gate read-only contract", () => {
  it("exposes the exact verb list from the design register", () => {
    expect([...GATE_VERBS]).toEqual(["approve", "reject", "redirect", "finish"]);
    expect(GATE_READONLY_NOTICE).toContain("approve · reject · redirect · finish");
    expect(GATE_READONLY_NOTICE.toLowerCase()).toContain("read-only");
  });
});

describe("projectRunStateLabel", () => {
  it("labels gate-held runs as BLOCKED · GATE HELD", () => {
    const run: RunSummary = {
      run_id: "r1",
      workflow: "w",
      workflow_version: 1,
      orchestrator_session_id: null,
      state: "blocked",
      block: block({ reason: "gate", node: "approve", iteration: 1 }),
      current_node: "approve",
      iteration: 1,
      parent_run_id: null,
      attempt: 1,
      tasks_settled: 1,
      tasks_total: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
      duration_ms: 1000,
      branch: null,
      worktree: null,
      created_at: "",
      updated_at: "",
      completed_at: null,
      purged_at: null,
      workspace: "scratch",
      type: "other",
      repo: null,
      error: null,
    };
    const chip = projectRunStateLabel(run, run.block);
    expect(chip.label).toBe("BLOCKED · GATE HELD");
    expect(chip.token).toBe("awaiting");
  });
});
