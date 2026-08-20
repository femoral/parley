/**
 * #388 / ADR-0035 — a run output is a **view** over the node its `from` names,
 * addressed `run.<name>`.
 *
 * These are the rules a unit test can pin: the completed-iteration selection
 * (which differs from the node-address resolver's on a node mid-loop), the
 * refusal to fall back past a purged latest, iteration 0 as a fork's inherited
 * contribution, and the values-free outputs index. The wiring itself — that
 * `run get run.<name>` reaches any of this on a genuinely completed run — is
 * only provable against a real daemon; see
 * `packages/cli/tests/run-outputs.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  homePaths,
  parseWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowRunOutput,
} from "@useparley/core";
import {
  CODE_RUN_OUTPUT_NOT_PRODUCED,
  deliverableRowToQuery,
  EXIT_DELIVERABLE_PURGED,
  EXIT_RUN_OUTPUT_NOT_PRODUCED,
  parseDeliverableAddress,
  projectRunDetail,
  projectRunOutputs,
  renderDeliverableBare,
  renderRunSummary,
  resolveDeliverableValue,
  resolveRunOutput,
  runOutputCoordinateError,
  unknownRunOutputError,
  type QueryDeliverable,
} from "../src/run-query.js";
import {
  insertDeliverable,
  insertRun,
  insertTask,
  latestNodeIteration,
  listDeliverablesForRun,
  openDatabase,
  type DatabaseHandle,
  type RunRow,
} from "../src/db.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Two steps and a loop back to `work`, so a mid-loop node is expressible. */
function loopingDef(): WorkflowDefinition {
  return parseWorkflowDefinition(
    {
      id: "looping",
      version: 1,
      type: "other",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: {
        result: { type: "text", from: "work.result" },
        digest: { type: "text", from: "wrap.digest" },
      },
      nodes: [
        {
          id: "work",
          kind: "step",
          prompt: "w.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { result: { type: "text" } },
        },
        {
          id: "wrap",
          kind: "step",
          prompt: "x.md",
          in: { result: { type: "text", from: "work.result" } },
          out: { digest: { type: "text" } },
          loop: { to: "work", max: 3 },
        },
      ],
    },
    { dir: "/tmp/looping", expectedId: "looping", typeCheck: false },
  ).definition;
}

function del(
  partial: Partial<QueryDeliverable> &
    Pick<QueryDeliverable, "id" | "node" | "port" | "iteration">,
): QueryDeliverable {
  return {
    run_id: "r7",
    slot: null,
    task_id: "t1",
    kind: "inline",
    value: JSON.stringify("body"),
    created_at: "2026-08-19T09:00:00Z",
    purged_at: null,
    ...partial,
  };
}

function out(from: string): WorkflowRunOutput {
  return { type: { kind: "text" }, bounds: {}, from };
}

function baseRun(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "r7",
    workflow: "looping",
    version: 1,
    type: "other",
    workspace: "scratch",
    repo: null,
    state: "completed",
    current_node: null,
    iteration: 2,
    error: null,
    session_id: null,
    parent_run_id: null,
    attempt: 1,
    base_ref: null,
    eval_score: null,
    eval_baseline: null,
    eval_rubric: null,
    eval_rubric_version: null,
    eval_answers: null,
    eval_feedback: null,
    created_at: "2026-08-19T09:00:00Z",
    updated_at: "2026-08-19T09:05:00Z",
    completed_at: "2026-08-19T09:05:00Z",
    ...over,
  } as RunRow;
}

// ---------------------------------------------------------------------------
// Selection rule
// ---------------------------------------------------------------------------

describe("run output resolution (ADR-0035)", () => {
  it("takes the most recent completed iteration, not the highest one entered", () => {
    // Iteration 1 completed; iteration 2 is running and has no row yet. The
    // node-address resolver would pick 2 and find nothing; a run output is
    // what a node placed after the last one would have read — iteration 1.
    const deliverables = [
      del({ id: "d1", node: "work", port: "result", iteration: 1 }),
    ];
    const resolved = resolveRunOutput("result", out("work.result"), deliverables);
    expect(resolved.iteration).toBe(1);
    expect(resolved.state).toBe("produced");
    expect(resolved.deliverable?.id).toBe("d1");
  });

  it("advances to the newer iteration once it produces a row", () => {
    const deliverables = [
      del({ id: "d1", node: "work", port: "result", iteration: 1 }),
      del({ id: "d2", node: "work", port: "result", iteration: 2 }),
    ];
    const resolved = resolveRunOutput("result", out("work.result"), deliverables);
    expect(resolved.iteration).toBe(2);
    expect(resolved.deliverable?.id).toBe("d2");
  });

  it("resolves a fork's inherited iteration 0 with no special case", () => {
    const deliverables = [
      del({ id: "d0", node: "work", port: "result", iteration: 0 }),
    ];
    const resolved = resolveRunOutput("result", out("work.result"), deliverables);
    expect(resolved.iteration).toBe(0);
    expect(resolved.state).toBe("produced");
    expect(resolved.deliverable?.id).toBe("d0");
  });

  it("reports decay on a purged latest rather than serving a stale iteration", () => {
    const deliverables = [
      del({ id: "d1", node: "work", port: "result", iteration: 1 }),
      del({
        id: "d2",
        node: "work",
        port: "result",
        iteration: 2,
        value: null,
        purged_at: "2026-08-19T10:00:00Z",
      }),
    ];
    const resolved = resolveRunOutput("result", out("work.result"), deliverables);
    expect(resolved.state).toBe("purged");
    expect(resolved.iteration).toBe(2);
    // The load-bearing half: never d1.
    expect(resolved.deliverable?.id).toBe("d2");
  });

  it("is pending when the producing node has no completed iteration", () => {
    const resolved = resolveRunOutput("result", out("work.result"), [
      del({ id: "d9", node: "other", port: "result", iteration: 1 }),
    ]);
    expect(resolved.state).toBe("pending");
    expect(resolved.iteration).toBeNull();
    expect(resolved.deliverable).toBeNull();
  });

  it("does not confuse a same-named port on another node", () => {
    const deliverables = [
      del({ id: "dA", node: "wrap", port: "result", iteration: 5 }),
      del({ id: "dB", node: "work", port: "result", iteration: 1 }),
    ];
    const resolved = resolveRunOutput("result", out("work.result"), deliverables);
    expect(resolved.deliverable?.id).toBe("dB");
  });

  it("reports an unparsable from without a node or port", () => {
    const resolved = resolveRunOutput("result", out("work"), [
      del({ id: "d1", node: "work", port: "result", iteration: 1 }),
    ]);
    expect(resolved.node).toBeNull();
    expect(resolved.port).toBeNull();
    expect(resolved.state).toBe("pending");
  });

  it("refuses to read a run input as a node called run", () => {
    // Lint rejects `outputs.*.from = "run.<input>"` outright; if one reaches
    // the resolver anyway it must not be split into node `run`, port `brief`.
    const resolved = resolveRunOutput("echo", out("run.brief"), [
      del({ id: "d1", node: "run", port: "brief", iteration: 1 }),
    ]);
    expect(resolved.node).toBeNull();
    expect(resolved.port).toBeNull();
    expect(resolved.deliverable).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outputs index on the run detail response
// ---------------------------------------------------------------------------

describe("run outputs index", () => {
  it("carries type, from, deliverable id, address and state — and no values", () => {
    const index = projectRunOutputs(loopingDef(), [
      del({ id: "d1", node: "work", port: "result", iteration: 2 }),
    ]);
    expect(index).toEqual({
      result: {
        type: "text",
        from: "work.result",
        deliverable_id: "d1",
        address: "work.result.2",
        state: "produced",
      },
      digest: {
        type: "text",
        from: "wrap.digest",
        deliverable_id: null,
        address: null,
        state: "pending",
      },
    });
    for (const entry of Object.values(index)) {
      expect(entry).not.toHaveProperty("value");
    }
  });

  it("is empty when the definition snapshot is unavailable", () => {
    expect(projectRunOutputs(null, [])).toEqual({});
  });

  it("rides the run detail response and leaves the run summary untouched", () => {
    const definition = loopingDef();
    const deliverables = [
      del({ id: "d1", node: "work", port: "result", iteration: 1 }),
    ];
    const detail = projectRunDetail({
      run: baseRun(),
      tasks: [],
      deliverables,
      definition,
    });
    expect(detail.outputs.result?.state).toBe("produced");
    expect(detail.outputs.result?.address).toBe("work.result.1");
    expect(detail.run).not.toHaveProperty("outputs");
  });

  it("renders as a table under run status, with a fetch hint and no values", () => {
    const text = renderRunSummary(
      projectRunDetail({
        run: baseRun(),
        tasks: [],
        deliverables: [del({ id: "d1", node: "work", port: "result", iteration: 1 })],
        definition: loopingDef(),
      }),
    );
    expect(text).toMatch(/^OUTPUT\s+TYPE\s+STATE\s+FROM\s+AT$/m);
    expect(text).toMatch(/^result\s+text\s+produced\s+work\.result\s+work\.result\.1$/m);
    expect(text).toMatch(/^digest\s+text\s+pending\s+wrap\.digest\s+-$/m);
    expect(text).toContain("fetch    parley run get run.result --run r7");
  });

  it("still resolves on a cancelled run whose producer completed", () => {
    const detail = projectRunDetail({
      run: baseRun({ state: "cancelled", current_node: "wrap" }),
      tasks: [],
      deliverables: [del({ id: "d1", node: "work", port: "result", iteration: 1 })],
      definition: loopingDef(),
    });
    expect(detail.outputs.result?.state).toBe("produced");
    expect(detail.outputs.digest?.state).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Address grammar
// ---------------------------------------------------------------------------

describe("run-level address grammar", () => {
  it("reads run.<name> as a run output, not a node called run", () => {
    expect(parseDeliverableAddress("run.result")).toEqual({
      runId: null,
      node: "run",
      port: "result",
      iteration: null,
      slot: null,
      runOutput: true,
    });
  });

  it("accepts the slash form and the run-id-prefixed form", () => {
    expect(parseDeliverableAddress("run/result")).toMatchObject({
      runId: null,
      port: "result",
      runOutput: true,
    });
    expect(parseDeliverableAddress("r7/run/result")).toMatchObject({
      runId: "r7",
      port: "result",
      runOutput: true,
    });
  });

  it("parses coordinates on a run-level address so the caller can be told off", () => {
    const parsed = parseDeliverableAddress("run.result.1");
    expect(parsed).toMatchObject({ runOutput: true, port: "result", iteration: 1 });
    expect(runOutputCoordinateError("result")).toMatch(/<node>\.<port>\.<n>/);
  });

  it("leaves node addresses unflagged", () => {
    expect(parseDeliverableAddress("work.result")?.runOutput).toBe(false);
    expect(parseDeliverableAddress("runner.result")?.runOutput).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

describe("run output failure taxonomy", () => {
  it("names the declared outputs when the name is not one of them", () => {
    const msg = unknownRunOutputError("reprot", ["result", "digest"]);
    expect(msg).toContain("reprot");
    expect(msg).toContain("digest, result");
  });

  it("says so plainly when the workflow declares none", () => {
    expect(unknownRunOutputError("result", [])).toContain(
      "this workflow declares no run outputs",
    );
  });

  it("keeps not_produced distinct from usage and from purge", () => {
    expect(EXIT_RUN_OUTPUT_NOT_PRODUCED).toBe(10);
    expect(CODE_RUN_OUTPUT_NOT_PRODUCED).toBe("not_produced");
  });
});

// ---------------------------------------------------------------------------
// The two iteration rules, side by side
// ---------------------------------------------------------------------------

describe("run-output rule vs node-address rule", () => {
  let home: string;
  let db: DatabaseHandle;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-388-"));
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

  it("disagree on a node mid-loop, and the address resolver keeps its answer", () => {
    // `work` completed iteration 1 and re-entered on iteration 2: a task row
    // exists at 2, the deliverable row does not. This is exactly where the two
    // rules part company.
    const runId = "r1";
    insertRun(db, {
      id: runId,
      workflow: "looping",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "work",
      state: "running",
    });
    db.prepare(`UPDATE runs SET iteration = 2 WHERE id = ?`).run(runId);
    insertDeliverable(db, {
      id: "d1",
      run_id: runId,
      node: "work",
      port: "result",
      iteration: 1,
      slot: null,
      task_id: null,
      kind: "inline",
      value: JSON.stringify("iteration one"),
    });
    insertTask(db, {
      id: "t2",
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      repo: null,
      cwd: "/tmp/scratch",
      prompt: "do work",
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
      run_id: runId,
      node: "work",
      iteration: 2,
    });

    const rows = listDeliverablesForRun(db, runId).map(deliverableRowToQuery);

    // Node-address rule: the highest iteration the node reached, any state.
    expect(latestNodeIteration(db, runId, "work")).toBe(2);
    // Run-output rule: the last iteration that actually produced this port.
    const resolved = resolveRunOutput("result", out("work.result"), rows);
    expect(resolved.iteration).toBe(1);
    expect(resolved.state).toBe("produced");
    expect(resolved.deliverable?.id).toBe("d1");
  });
});

// ---------------------------------------------------------------------------
// Resolution → exit code
// ---------------------------------------------------------------------------

describe("a purged run output renders as decay, exit 9", () => {
  it("hands the purged latest row to the renderer, never the older one", () => {
    const deliverables = [
      del({ id: "d1", node: "work", port: "result", iteration: 1 }),
      del({
        id: "d2",
        node: "work",
        port: "result",
        iteration: 2,
        value: null,
        purged_at: "2026-08-19T10:00:00Z",
      }),
    ];
    const resolved = resolveRunOutput("result", out("work.result"), deliverables);
    const rendered = renderDeliverableBare(
      resolveDeliverableValue({ deliverable: resolved.deliverable! }),
    );
    expect(rendered.exitCode).toBe(EXIT_DELIVERABLE_PURGED);
    expect(rendered.stdout).toBe("");
    expect(rendered.stderr).toContain("d2");
    expect(rendered.stderr).not.toContain("d1");
  });
});
