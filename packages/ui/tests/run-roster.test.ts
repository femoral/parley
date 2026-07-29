/**
 * #254 — run roster projection: peer rows, attention grouping, run chips,
 * fan-out-free pip track, inspector node table.
 */
import { describe, expect, it } from "vitest";
import type { NodeProjection, RunDetailResponse, RunSummary } from "@useparley/core";
import type { RunBlock } from "@useparley/core";
import {
  buildListPipTrack,
  buildPipTrack,
  formatBlockReasonLabel,
  formatNodeDuration,
  formatNodeStateLabel,
  formatRunChip,
  formatRunStateLabel,
  projectInspectorRun,
  projectRosterRun,
  runAttentionState,
} from "../src/app/hooks/runs.js";
import { projectRoster, type RosterTaskInput } from "../src/app/hooks/roster.js";
import { stateMetaFor } from "../src/tokens/state-meta.js";

function summary(partial: Partial<RunSummary> & Pick<RunSummary, "run_id" | "state">): RunSummary {
  return {
    workflow: "coding-1",
    workflow_version: 1,
    orchestrator_session_id: "sess-1",
    block: null,
    current_node: "review",
    iteration: 2,
    parent_run_id: null,
    attempt: 1,
    tasks_settled: 3,
    tasks_total: 6,
    usage: { input_tokens: 1000, output_tokens: 200 },
    duration_ms: 660_000,
    branch: "parley/r7-coding-1",
    worktree: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:11:00.000Z",
    completed_at: null,
    purged_at: null,
    workspace: "repo",
    type: "feature",
    repo: null,
    error: null,
    track_bound: 15,
    ...partial,
  };
}

function node(
  partial: Partial<NodeProjection> & Pick<NodeProjection, "node" | "iteration" | "state">,
): NodeProjection {
  return {
    kind: "step",
    tasks_settled: 1,
    tasks_total: 1,
    usage: null,
    duration_ms: 42_000,
    fanout: null,
    tallies: {},
    counts: {},
    summary: null,
    deliverables: [],
    gist: "ok",
    ...partial,
  };
}

function task(partial: Partial<RosterTaskInput> & Pick<RosterTaskInput, "id" | "state">): RosterTaskInput {
  return {
    name: partial.id,
    vendor: "codex",
    model: null,
    branch: "feat/x",
    orchestratorSession: "sess-1",
    question: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...partial,
  };
}

describe("runAttentionState (#254)", () => {
  it("maps blocked to the awaiting tier", () => {
    expect(runAttentionState("blocked")).toBe("awaiting_answer");
  });

  it("maps running / terminal states onto the task vocabulary", () => {
    expect(runAttentionState("running")).toBe("running");
    expect(runAttentionState("completed")).toBe("completed");
    expect(runAttentionState("failed")).toBe("failed");
    expect(runAttentionState("cancelled")).toBe("cancelled");
    expect(runAttentionState("purged")).toBe("cancelled");
  });

  it("passes unknown wire states through for unknown treatment (#261)", () => {
    // Invented daemon-side state must not silently paint as running.
    expect(runAttentionState("mutinied")).toBe("mutinied");
    expect(runAttentionState("mutinied")).not.toBe("running");
    // state-meta's unknown path: uppercased label + neutral colour.
    const meta = stateMetaFor(runAttentionState("mutinied"));
    expect(meta.label).toBe("MUTINIED");
    expect(meta.colorVar).toBe("var(--ink-tan)");
    expect(meta.label).not.toBe(stateMetaFor("running").label);
  });
});

describe("formatRunChip (#254)", () => {
  it("formats short run id · node.iteration[.slot]", () => {
    expect(
      formatRunChip({
        runId: "r7f3abcdef",
        node: "review",
        iteration: 2,
        slot: "tests",
      }),
    ).toBe("r7f3abcd · review.2.tests");
  });

  it("returns null for plain tasks", () => {
    expect(formatRunChip({ runId: null, node: "x", iteration: 1 })).toBeNull();
    expect(formatRunChip({ runId: "r1", node: null, iteration: 1 })).toBeNull();
  });
});

describe("pip track is fan-out free (#254)", () => {
  it("uses track_bound even when a node fans out wide", () => {
    const nodes = [
      node({
        node: "search",
        iteration: 1,
        state: "completed",
        tasks_total: 40,
        tasks_settled: 40,
        fanout: { kind: "data", over: "queries", width: 40, failed: [] },
        gist: "40/40 ok · 12 sources",
      }),
    ];
    const pips = buildPipTrack(nodes, 10);
    expect(pips).toHaveLength(10);
    expect(pips[0]!.kind).toBe("done");
    expect(pips.slice(1).every((p) => p.kind === "empty")).toBe(true);
  });

  it("list track length is track_bound, not task count", () => {
    const pips = buildListPipTrack(
      summary({ run_id: "r1", state: "running", track_bound: 12, tasks_total: 99 }),
    );
    expect(pips).toHaveLength(12);
  });

  it("failed run keeps a fail pip when tasks_settled >= pips.length (fan-out)", () => {
    // Fan-out: more settled tasks than the static track bound. The fail mark
    // sits on the last pip and must not be overwritten by the done loop.
    const pips = buildListPipTrack(
      summary({
        run_id: "r-fail",
        state: "failed",
        track_bound: 4,
        tasks_settled: 12,
        tasks_total: 12,
      }),
    );
    expect(pips).toHaveLength(4);
    expect(pips.filter((p) => p.kind === "fail")).toHaveLength(1);
    expect(pips[3]!.kind).toBe("fail");
    expect(pips.slice(0, 3).every((p) => p.kind === "done")).toBe(true);
  });

  it("failed run marks fail at tasks_settled when within the track", () => {
    const pips = buildListPipTrack(
      summary({
        run_id: "r-fail-mid",
        state: "failed",
        track_bound: 6,
        tasks_settled: 2,
        tasks_total: 6,
      }),
    );
    expect(pips).toHaveLength(6);
    expect(pips[2]!.kind).toBe("fail");
    expect(pips[0]!.kind).toBe("done");
    expect(pips[1]!.kind).toBe("done");
    expect(pips.slice(3).every((p) => p.kind === "empty")).toBe(true);
  });
});

describe("projectRoster merges run peers (#254)", () => {
  it("places a blocked run in awaiting while its tasks stay in their own groups", () => {
    const run = projectRosterRun(
      summary({
        run_id: "r-blocked",
        state: "blocked",
        block: {
          reason: "gate",
          node: "rework-or-finish",
          iteration: 1,
          detail: "held",
          verbs: ["approve", "reject", "redirect", "finish"],
        },
      }),
    );
    expect(run.attentionState).toBe("awaiting_answer");
    expect(run.heldGate).toBe(true);

    const { groups } = projectRoster(
      [
        task({ id: "t-run-owned", state: "running", runId: "r-blocked", node: "review", iteration: 2, slot: "tests" }),
        task({ id: "t-plain", state: "running" }),
        task({ id: "t-await", state: "awaiting_answer" }),
      ],
      null,
      null,
      [run],
    );

    const awaiting = groups.find((g) => g.state === "awaiting_answer");
    const running = groups.find((g) => g.state === "running");
    expect(awaiting?.runs?.map((r) => r.id)).toEqual(["r-blocked"]);
    expect(awaiting?.tasks.map((t) => t.id)).toEqual(["t-await"]);
    expect(running?.tasks.map((t) => t.id).sort()).toEqual(["t-plain", "t-run-owned"]);
    expect(running?.runs ?? []).toEqual([]);

    const owned = running?.tasks.find((t) => t.id === "t-run-owned");
    expect(owned?.runChip).toBe("r-blocke · review.2.tests");
    const plain = running?.tasks.find((t) => t.id === "t-plain");
    expect(plain?.runChip).toBeNull();
  });
});

describe("projectInspectorRun (#254)", () => {
  it("renders one row per (node, iteration), never per task", () => {
    const detail: RunDetailResponse = {
      run: summary({ run_id: "r7", state: "blocked", track_bound: 10 }),
      block: {
        reason: "loop_exhausted",
        node: "adversarial-review",
        iteration: 2,
        max: 2,
        detail: "coverage still insufficient",
        verbs: ["approve", "redirect", "finish"],
      },
      nodes: [
        node({ node: "scope", iteration: 1, state: "completed", gist: "6 queries · angles" }),
        node({
          node: "search",
          iteration: 1,
          state: "completed",
          tasks_total: 6,
          tasks_settled: 6,
          fanout: { kind: "data", over: "queries", width: 6, failed: [] },
          gist: "6/6 ok · 41 sources",
        }),
        node({
          node: "accept",
          iteration: 1,
          state: "waiting",
          kind: "gate",
          tasks_total: 0,
          tasks_settled: 0,
          gist: "Proceed?",
          on_reject: "funnel",
        }),
      ],
    };
    const view = projectInspectorRun(detail);
    expect(view.status).toBe("ready");
    if (view.status !== "ready") throw new Error("expected ready");
    expect(view.nodes).toHaveLength(3);
    expect(view.nodes.map((n) => n.node)).toEqual(["scope", "search", "accept"]);
    expect(view.nodes[1]!.fanoutWidth).toBe(6);
    expect(view.nodes[1]!.tasksLabel).toBe("6");
    expect(formatNodeStateLabel(detail.nodes[2]!)).toBe("gate · held");
    expect(view.nodes[2]!.stateLabel).toBe("gate · held");
    expect(view.nodes[2]!.onReject).toBe("funnel");
    expect(view.heldGate).toBe(false); // loop_exhausted, not gate
    // CLI parenthetical vocabulary — never the wire enum (#261 QC).
    expect(view.stateLabel).toBe("blocked · loop 2/2");
    expect(view.stateLabel).not.toMatch(/loop_exhausted/i);
  });

  it("STATE is polymorphic: step task projection vs gate verb", () => {
    expect(formatNodeStateLabel(node({ node: "x", iteration: 1, state: "completed" }))).toBe(
      "COMPLETED",
    );
    expect(
      formatNodeStateLabel(
        node({ node: "g", iteration: 1, state: "approved", kind: "gate", tasks_total: 0 }),
      ),
    ).toBe("APPROVED");
    expect(
      formatNodeStateLabel(
        node({ node: "g", iteration: 1, state: "waiting", kind: "gate", tasks_total: 0 }),
      ),
    ).toBe("gate · held");
  });

  it("awaiting_answer uses the same state-meta label as the roster (#261)", () => {
    const label = formatNodeStateLabel(
      node({ node: "review", iteration: 1, state: "awaiting_answer" }),
    );
    expect(label).toBe(stateMetaFor("awaiting_answer").label);
    expect(label).toBe("AWAITING");
    // Never the raw wire enum (which CSS would render as AWAITING_ANSWER).
    expect(label).not.toBe("awaiting_answer");
    expect(label).not.toMatch(/awaiting_answer/i);
  });

  it("run state labels present CLI vocabulary, never wire enums (#261)", () => {
    expect(formatRunStateLabel("running", null)).toBe("RUNNING");
    expect(formatRunStateLabel("completed", null)).toBe("COMPLETED");
    expect(formatRunStateLabel("failed", null)).toBe("FAILED");
    expect(formatRunStateLabel("cancelled", null)).toBe("CANCELLED");
    expect(formatRunStateLabel("purged", null)).toBe("PURGED");

    const loopBlock: RunBlock = {
      reason: "loop_exhausted",
      node: "review",
      iteration: 2,
      max: 2,
      detail: "coverage still insufficient",
      verbs: ["approve", "redirect", "finish"],
    };
    expect(formatRunStateLabel("blocked", loopBlock)).toBe("blocked · loop 2/2");
    expect(formatRunStateLabel("blocked", loopBlock)).not.toMatch(/loop_exhausted/i);

    expect(
      formatRunStateLabel("blocked", {
        reason: "gate",
        node: "accept",
        iteration: 1,
        detail: "held",
        verbs: ["approve", "reject", "redirect", "finish"],
      }),
    ).toBe("blocked · gate");

    // Full reason matrix — presented words, not identifiers.
    const reasons: Array<{ block: RunBlock; presented: string }> = [
      {
        block: {
          reason: "gate",
          node: "g",
          iteration: 1,
          detail: "held",
          verbs: ["approve", "reject", "redirect", "finish"],
        },
        presented: "gate",
      },
      {
        block: {
          reason: "loop_exhausted",
          node: "r",
          iteration: 2,
          max: 2,
          detail: null,
          verbs: ["approve", "redirect", "finish"],
        },
        presented: "loop 2/2",
      },
      {
        block: {
          reason: "success_policy",
          node: "r",
          iteration: 1,
          detail: "blocked (2/3 slots)",
          verbs: ["approve", "redirect", "finish"],
        },
        presented: "2/3 slots",
      },
      {
        block: {
          reason: "success_policy",
          node: "r",
          iteration: 1,
          detail: "min not met",
          verbs: ["approve", "redirect", "finish"],
        },
        presented: "slots",
      },
      {
        block: {
          reason: "spawn_error",
          node: "r",
          iteration: 1,
          detail: "spawn failed",
          verbs: ["redirect", "finish"],
        },
        presented: "spawn",
      },
      {
        block: {
          reason: "unfilled_inputs",
          node: "r",
          iteration: 1,
          detail: "missing port",
          verbs: ["redirect", "finish"],
        },
        presented: "inputs",
      },
      {
        block: {
          reason: "unknown",
          node: null,
          iteration: null,
          detail: null,
          verbs: ["finish"],
        },
        presented: "blocked",
      },
    ];
    for (const { block, presented } of reasons) {
      expect(formatBlockReasonLabel(block)).toBe(presented);
      const label = formatRunStateLabel("blocked", block);
      expect(label).toBe(`blocked · ${presented}`);
      // Wire enum must not appear verbatim in presented text.
      expect(label).not.toMatch(/loop_exhausted|success_policy|spawn_error|unfilled_inputs/i);
    }
  });

  it("duration column is duration-only on every path (#261)", () => {
    expect(formatNodeDuration(42_000)).toBe("<1m");
    expect(formatNodeDuration(18 * 60_000)).toBe("18m");
    expect(formatNodeDuration(90 * 60_000)).toBe("1h");
    expect(formatNodeDuration(null)).toBeNull();
    // Projection fills age from duration_ms only — no elapsed-since branch.
    const view = projectInspectorRun({
      run: summary({ run_id: "r-dur", state: "running" }),
      block: null,
      nodes: [
        node({ node: "scope", iteration: 1, state: "completed", duration_ms: 18 * 60_000 }),
        node({ node: "search", iteration: 1, state: "running", duration_ms: null }),
      ],
    });
    expect(view.status).toBe("ready");
    if (view.status !== "ready") throw new Error("expected ready");
    expect(view.nodes[0]!.age).toBe("18m");
    expect(view.nodes[1]!.age).toBeNull();
  });

  it("unknown run state projects with unknown treatment, not running (#261)", () => {
    const view = projectRosterRun(summary({ run_id: "r-x", state: "mutinied" }));
    expect(view.attentionState).toBe("mutinied");
    expect(view.attentionState).not.toBe("running");
    // Roster colour/mark still via stateMetaFor on the attention key.
    expect(stateMetaFor(view.attentionState).label).toBe("MUTINIED");
    expect(stateMetaFor(view.attentionState).colorVar).toBe("var(--ink-tan)");

    const detail = projectInspectorRun({
      run: summary({ run_id: "r-x", state: "mutinied" }),
      block: null,
      nodes: [],
    });
    expect(detail.status).toBe("ready");
    if (detail.status !== "ready") throw new Error("expected ready");
    // Header string is presentation words; CSS uppercases for display.
    // Must not silently claim RUNNING.
    expect(detail.stateLabel).toBe("mutinied");
    expect(detail.stateLabel).not.toBe("RUNNING");
    expect(detail.stateLabel.toLowerCase()).not.toBe("running");
  });
});
