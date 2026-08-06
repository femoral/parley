import { describe, expect, it } from "vitest";
import type { NodeProjection, RunBlock, RunSummary } from "@useparley/core";
import {
  formatBlockDetail,
  formatBlockParenthetical,
  GATE_READONLY_NOTICE,
  GATE_VERBS,
  gateReadonlyNotice,
  projectNodeDisplay,
  projectRunStateLabel,
  verbsForDisplay,
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
  });

  it("renders skipped with loud cue + SKIPPED label", () => {
    const d = projectNodeDisplay(
      node({ node: "approve", kind: "gate", state: "skipped", iteration: 0 }),
    );
    expect(d.forkKind).toBe("skipped");
    expect(d.label).toBe("SKIPPED");
    expect(d.cue).toMatch(/fork|⊘/);
  });
});

describe("block reason vocabulary", () => {
  it("formats wire reasons without stuttering on unknown", () => {
    expect(formatBlockParenthetical(block({ reason: "gate" }))).toBe("gate");
    expect(
      formatBlockParenthetical(block({ reason: "loop_exhausted", iteration: 2, max: 2 })),
    ).toBe("loop 2/2");
    expect(formatBlockParenthetical(block({ reason: "unknown" }))).toBe("held");
    expect(formatBlockParenthetical(block({ reason: "spawn_error" }))).toBe("spawn");
  });

  it("strips blocked() wrapper from detail", () => {
    const b = block({
      reason: "unknown",
      detail: "blocked (all — NOT MET, 0 of 1)",
      node: "plan",
    });
    const line = formatBlockDetail(b);
    expect(line.toLowerCase()).not.toMatch(/^blocked/);
    expect(line).toMatch(/NOT MET|plan/i);
    // Must not stutter "blocked · blocked"
    expect(line.toLowerCase().split("blocked").length - 1).toBeLessThanOrEqual(0);
  });
});

describe("verbsForDisplay", () => {
  it("prefers wire block.verbs over full GATE_VERBS", () => {
    const b = block({
      reason: "unknown",
      verbs: ["redirect", "finish"],
    });
    expect([...verbsForDisplay(b)]).toEqual(["redirect", "finish"]);
  });

  it("falls back to GATE_VERBS when verbs absent", () => {
    const b = block({ reason: "gate", verbs: [] as unknown as RunBlock["verbs"] });
    // empty array → still fall back? Spec: fall back when absent, not empty.
    // Our impl: length > 0 required for wire verbs.
    expect([...verbsForDisplay(b)]).toEqual([...GATE_VERBS]);
    expect([...verbsForDisplay(null)]).toEqual([...GATE_VERBS]);
  });
});

describe("projectRunStateLabel", () => {
  it("labels gate-held as BLOCKED · GATE HELD", () => {
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
    expect(projectRunStateLabel(run, run.block).label).toBe("BLOCKED · GATE HELD");
  });

  it("does not stutter BLOCKED · BLOCKED for unknown reason", () => {
    const run: RunSummary = {
      run_id: "r1",
      workflow: "w",
      workflow_version: 1,
      orchestrator_session_id: null,
      state: "blocked",
      block: block({
        reason: "unknown",
        detail: "blocked (all — NOT MET, 0 of 1)",
        verbs: ["redirect", "finish"],
      }),
      current_node: "plan",
      iteration: 1,
      parent_run_id: null,
      attempt: 1,
      tasks_settled: 0,
      tasks_total: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
      duration_ms: 100,
      branch: null,
      worktree: null,
      created_at: "",
      updated_at: "",
      completed_at: null,
      purged_at: null,
      workspace: "repo",
      type: "other",
      repo: null,
      error: "blocked (all — NOT MET, 0 of 1)",
    };
    const label = projectRunStateLabel(run, run.block).label;
    expect(label).toBe("BLOCKED");
    expect(label).not.toMatch(/BLOCKED · BLOCKED/i);
  });
});

describe("gate read-only contract", () => {
  it("exposes the exact verb list as type source", () => {
    expect([...GATE_VERBS]).toEqual(["approve", "reject", "redirect", "finish"]);
    expect(GATE_READONLY_NOTICE).toContain("approve · reject · redirect · finish");
    expect(gateReadonlyNotice(["redirect", "finish"])).toContain("redirect · finish");
    expect(gateReadonlyNotice(["redirect", "finish"])).not.toContain("approve");
  });
});
