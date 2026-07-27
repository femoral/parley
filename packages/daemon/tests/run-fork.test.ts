/**
 * #242 / ADR-0017 — fork a dead run, cancel a live one; redirect stays live-only.
 *
 * Redirect rewinds nothing and is exempt from the loop budget (covered with
 * gate verbs). Fork is a new run with parent_run_id + attempt; never a
 * task-level fix chain.
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
  listChildRuns,
  listDeliverablesForRun,
  nextDeliverableId,
  nextRunId,
  openDatabase,
  updateRun,
  type DatabaseHandle,
  type RunRow,
} from "../src/db.js";
import {
  applyFork,
  cancelRunRow,
  forkRun,
  planFork,
  selectInheritedDeliverables,
  SKIPPED_GATE_PORT,
  type ForkHost,
  type RunDrainHost,
} from "../src/run-engine.js";
import {
  createRunScratchWorkspace,
  readRunInputs,
  writeRunInputs,
} from "../src/run-workspace.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let home: string;
let db: DatabaseHandle;
let runsDir: string;
let worktreesDir: string;

function codingDef(overrides?: { reentry?: string; workspace?: "repo" | "scratch" }): WorkflowDefinition {
  return parseWorkflowDefinition(
    {
      id: "coding-1",
      version: 1,
      type: "coding",
      workspace: overrides?.workspace ?? "scratch",
      reentry: overrides?.reentry ?? "implement",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "implement.report" } },
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
          in: { plan: { type: "text", from: "plan.plan" } },
          out: { report: { type: "text" } },
        },
      ],
    },
    { dir: "/tmp/coding-1", expectedId: "coding-1", typeCheck: true },
  ).definition;
}

function fileOutDef(): WorkflowDefinition {
  return parseWorkflowDefinition(
    {
      id: "files",
      version: 1,
      type: "other",
      workspace: "repo",
      reentry: "consume",
      inputs: { brief: { type: "text" } },
      outputs: { artifact: { type: "file", from: "produce.artifact" } },
      nodes: [
        {
          id: "produce",
          kind: "step",
          prompt: "p.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { artifact: { type: "file" } },
        },
        {
          id: "consume",
          kind: "step",
          prompt: "c.md",
          in: { artifact: { type: "file", from: "produce.artifact" } },
          out: { report: { type: "text" } },
        },
      ],
    },
    { dir: "/tmp/files", expectedId: "files", typeCheck: true },
  ).definition;
}

function insertTerminalParent(opts?: {
  state?: "completed" | "failed" | "cancelled";
  workspace?: "repo" | "scratch";
  repo?: string | null;
  workflow?: string;
}): RunRow {
  const id = nextRunId(db);
  const workspace = opts?.workspace ?? "scratch";
  const row = insertRun(db, {
    id,
    workflow: opts?.workflow ?? "coding-1",
    version: 1,
    type: "coding",
    workspace,
    repo: workspace === "scratch" ? null : (opts?.repo ?? "/repos/x"),
    current_node: "implement",
    iteration: 1,
    state: "running",
    orchestrator_session_id: "orch-1",
  });
  updateRun(db, row.id, {
    state: opts?.state ?? "failed",
    completed_at: new Date().toISOString(),
    error: "blocked (spawn implement): vendor blew up",
  });
  return getRun(db, row.id)!;
}

function drainHost(def: WorkflowDefinition): RunDrainHost {
  return {
    loadDefinition: () => def,
    runInputs: () => ({ brief: "port the proxy" }),
  };
}

function forkHost(
  def: WorkflowDefinition,
  workspaces: Map<string, string> = new Map(),
): ForkHost {
  return {
    ...drainHost(def),
    worktreesDir,
    runsDir,
    resolveWorkspaceRoot: (run) => workspaces.get(run.id) ?? null,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-fork-"));
  const paths = homePaths(home);
  db = openDatabase(paths);
  runsDir = paths.runs;
  worktreesDir = paths.worktrees;
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// planFork — pure guards
// ---------------------------------------------------------------------------

describe("planFork", () => {
  it("refuses a live (non-terminal) run — cancel first", () => {
    const def = codingDef();
    const live = insertRun(db, {
      id: nextRunId(db),
      workflow: "coding-1",
      version: 1,
      type: "coding",
      workspace: "scratch",
      repo: null,
      current_node: "plan",
      state: "running",
    });
    const r = planFork(db, def, { parentRunId: live.id });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toMatch(/terminal/);
      expect(r.message).toMatch(/cancel/);
    }
  });

  it("defaults --to to definition reentry", () => {
    const def = codingDef({ reentry: "implement" });
    const parent = insertTerminalParent();
    const r = planFork(db, def, { parentRunId: parent.id });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.plan.entryNode).toBe("implement");
      expect(r.plan.attempt).toBe(2);
      expect(r.plan.skippedGates).toEqual(["approve-plan"]);
    }
  });

  it("honours explicit --to over reentry", () => {
    const def = codingDef({ reentry: "implement" });
    const parent = insertTerminalParent();
    const r = planFork(db, def, { parentRunId: parent.id, to: "plan" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.plan.entryNode).toBe("plan");
      expect(r.plan.skippedGates).toEqual([]);
      expect(r.plan.nodesBefore).toHaveLength(0);
    }
  });

  it("hard-errors forking past a file/dir output in repo mode", () => {
    const def = fileOutDef();
    const parent = insertTerminalParent({
      workspace: "repo",
      repo: "/repos/x",
      workflow: "files",
    });
    insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: parent.id,
      node: "produce",
      port: "artifact",
      iteration: 1,
      slot: null,
      task_id: null,
      kind: "file",
      value: "out/artifact.bin",
    });
    const r = planFork(db, def, { parentRunId: parent.id, to: "consume" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toMatch(/file output/);
      expect(r.message).toMatch(/died with the parent's worktree/);
    }
  });

  it("allows file/dir inheritance planning in scratch mode (copy later)", () => {
    const def = parseWorkflowDefinition(
      {
        id: "scratch-files",
        version: 1,
        type: "other",
        workspace: "scratch",
        reentry: "consume",
        inputs: { brief: { type: "text" } },
        outputs: { artifact: { type: "file", from: "produce.artifact" } },
        nodes: [
          {
            id: "produce",
            kind: "step",
            prompt: "p.md",
            in: { brief: { type: "text", from: "run.brief" } },
            out: { artifact: { type: "file" } },
          },
          {
            id: "consume",
            kind: "step",
            prompt: "c.md",
            in: { artifact: { type: "file", from: "produce.artifact" } },
            out: { report: { type: "text" } },
          },
        ],
      },
      { dir: "/tmp/sf", expectedId: "scratch-files", typeCheck: true },
    ).definition;
    const parent = insertTerminalParent({
      workspace: "scratch",
      workflow: "scratch-files",
    });
    insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: parent.id,
      node: "produce",
      port: "artifact",
      iteration: 1,
      slot: null,
      task_id: null,
      kind: "file",
      value: "out/a.txt",
    });
    const r = planFork(db, def, { parentRunId: parent.id });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.plan.inherit).toHaveLength(1);
      expect(r.plan.inherit[0]!.kind).toBe("file");
    }
  });
});

describe("selectInheritedDeliverables", () => {
  it("picks the most recent iteration per (node, port, slot)", () => {
    const parent = insertTerminalParent();
    const older = {
      id: nextDeliverableId(db),
      run_id: parent.id,
      node: "plan",
      port: "plan",
      iteration: 1,
      slot: null as string | null,
      task_id: null as string | null,
      kind: "inline" as const,
      value: JSON.stringify("old"),
      created_at: new Date().toISOString(),
      purged_at: null as string | null,
    };
    const newer = {
      ...older,
      id: nextDeliverableId(db),
      iteration: 2,
      value: JSON.stringify("new"),
    };
    // Insert via insertDeliverable so DB is consistent if needed later.
    insertDeliverable(db, {
      id: older.id,
      run_id: parent.id,
      node: "plan",
      port: "plan",
      iteration: 1,
      task_id: null,
      kind: "inline",
      value: JSON.stringify("old"),
    });
    insertDeliverable(db, {
      id: newer.id,
      run_id: parent.id,
      node: "plan",
      port: "plan",
      iteration: 2,
      task_id: null,
      kind: "inline",
      value: JSON.stringify("new"),
    });
    const rows = listDeliverablesForRun(db, parent.id);
    const picked = selectInheritedDeliverables(rows, new Set(["plan"]));
    expect(picked).toHaveLength(1);
    expect(JSON.parse(picked[0]!.value!)).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// applyFork — inheritance data + workspace
// ---------------------------------------------------------------------------

describe("applyFork / forkRun", () => {
  it("creates a new run with parent_run_id and attempt; copies deliverables at iteration 0", () => {
    const def = codingDef();
    const parent = insertTerminalParent({ state: "failed" });
    const parentWs = createRunScratchWorkspace({
      runsDir,
      runId: parent.id,
    }).path;
    writeRunInputs(parentWs, { brief: "port the proxy" });
    insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: parent.id,
      node: "plan",
      port: "plan",
      iteration: 1,
      task_id: null,
      kind: "inline",
      value: JSON.stringify("the plan text"),
    });

    const workspaces = new Map<string, string>([[parent.id, parentWs]]);
    const host = forkHost(def, workspaces);
    let enteredNote: string | null | undefined;
    host.onEnter = (args) => {
      enteredNote = args.note ?? null;
      workspaces.set(args.run.id, path.join(runsDir, args.run.id));
    };

    const result = forkRun(db, host, {
      parentRunId: parent.id,
      note: "preserve retry semantics",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const child = result.result.run;
    expect(child.id).not.toBe(parent.id);
    expect(child.parent_run_id).toBe(parent.id);
    expect(child.attempt).toBe(2);
    expect(child.current_node).toBe("implement");
    expect(child.iteration).toBe(1);
    expect(listChildRuns(db, parent.id).map((r) => r.id)).toEqual([child.id]);

    const inherited = listDeliverablesForRun(db, child.id);
    const planRow = inherited.find((d) => d.node === "plan" && d.port === "plan");
    expect(planRow).toBeDefined();
    expect(planRow!.iteration).toBe(0);
    expect(planRow!.task_id).toBeNull();
    expect(JSON.parse(planRow!.value!)).toBe("the plan text");

    const skip = inherited.find(
      (d) => d.node === "approve-plan" && d.port === SKIPPED_GATE_PORT,
    );
    expect(skip).toBeDefined();
    expect(skip!.iteration).toBe(0);
    expect(skip!.value).toBeNull();

    // Inherited vs skipped are distinguishable in the data.
    expect(planRow!.port).not.toBe(SKIPPED_GATE_PORT);
    expect(skip!.port).toBe(SKIPPED_GATE_PORT);

    // Inputs frozen by copy.
    const childWs = path.join(runsDir, child.id);
    expect(readRunInputs(childWs)).toEqual({ brief: "port the proxy" });
    expect(enteredNote).toBe("preserve retry semantics");
  });

  it("copies scratch file/dir bytes into the child workspace", () => {
    const def = parseWorkflowDefinition(
      {
        id: "scratch-files",
        version: 1,
        type: "other",
        workspace: "scratch",
        reentry: "consume",
        inputs: { brief: { type: "text" } },
        outputs: { artifact: { type: "file", from: "produce.artifact" } },
        nodes: [
          {
            id: "produce",
            kind: "step",
            prompt: "p.md",
            in: { brief: { type: "text", from: "run.brief" } },
            out: { artifact: { type: "file" } },
          },
          {
            id: "consume",
            kind: "step",
            prompt: "c.md",
            in: { artifact: { type: "file", from: "produce.artifact" } },
            out: { report: { type: "text" } },
          },
        ],
      },
      { dir: "/tmp/sf2", expectedId: "scratch-files", typeCheck: true },
    ).definition;

    const parent = insertTerminalParent({
      workspace: "scratch",
      workflow: "scratch-files",
    });
    const parentWs = createRunScratchWorkspace({
      runsDir,
      runId: parent.id,
    }).path;
    const artifactRel = "out/a.txt";
    fs.mkdirSync(path.join(parentWs, "out"), { recursive: true });
    fs.writeFileSync(path.join(parentWs, artifactRel), "bytes-from-parent\n");
    insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: parent.id,
      node: "produce",
      port: "artifact",
      iteration: 1,
      task_id: null,
      kind: "file",
      value: artifactRel,
    });

    const host = forkHost(def, new Map([[parent.id, parentWs]]));
    const result = forkRun(db, host, { parentRunId: parent.id });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const child = result.result.run;
    const rows = listDeliverablesForRun(db, child.id);
    const art = rows.find((d) => d.port === "artifact");
    expect(art).toBeDefined();
    expect(art!.iteration).toBe(0);
    expect(art!.kind).toBe("file");
    const childPath = path.join(path.join(runsDir, child.id), art!.value!);
    expect(fs.existsSync(childPath)).toBe(true);
    expect(fs.readFileSync(childPath, "utf8")).toBe("bytes-from-parent\n");
  });

  it("bumps attempt across successive forks of the same parent", () => {
    const def = codingDef();
    const parent = insertTerminalParent();
    const parentWs = createRunScratchWorkspace({
      runsDir,
      runId: parent.id,
    }).path;
    const host = forkHost(def, new Map([[parent.id, parentWs]]));

    const first = forkRun(db, host, { parentRunId: parent.id });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    expect(first.result.run.attempt).toBe(2);

    const second = forkRun(db, host, { parentRunId: parent.id });
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.result.run.attempt).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe("cancelRunRow", () => {
  it("marks a live run cancelled", () => {
    const live = insertRun(db, {
      id: nextRunId(db),
      workflow: "coding-1",
      version: 1,
      type: "coding",
      workspace: "scratch",
      repo: null,
      current_node: "plan",
      state: "blocked",
      error: "blocked (gate approve-plan)",
    });
    const r = cancelRunRow(db, live.id);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.run.state).toBe("cancelled");
    expect(r.run.completed_at).not.toBeNull();
  });

  it("refuses an already-terminal run", () => {
    const parent = insertTerminalParent({ state: "completed" });
    const r = cancelRunRow(db, parent.id);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toMatch(/already completed/);
    }
  });

  it("after cancel, planFork accepts the run", () => {
    const def = codingDef();
    const live = insertRun(db, {
      id: nextRunId(db),
      workflow: "coding-1",
      version: 1,
      type: "coding",
      workspace: "scratch",
      repo: null,
      current_node: "plan",
      state: "running",
    });
    expect(planFork(db, def, { parentRunId: live.id }).kind).toBe("error");
    expect(cancelRunRow(db, live.id).kind).toBe("ok");
    expect(planFork(db, def, { parentRunId: live.id }).kind).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// applyFork entry without onEnter (plan only path used in isolation)
// ---------------------------------------------------------------------------

describe("applyFork entry gate", () => {
  it("blocks when entry node is a gate", () => {
    const def = codingDef({ reentry: "approve-plan" });
    const parent = insertTerminalParent();
    const parentWs = createRunScratchWorkspace({
      runsDir,
      runId: parent.id,
    }).path;
    const planned = planFork(db, def, {
      parentRunId: parent.id,
      to: "approve-plan",
    });
    expect(planned.kind).toBe("ok");
    if (planned.kind !== "ok") return;
    const host = forkHost(def, new Map([[parent.id, parentWs]]));
    const applied = applyFork(db, host, planned.plan, {
      parentRunId: parent.id,
    });
    expect(applied.run.state).toBe("blocked");
    expect(applied.run.current_node).toBe("approve-plan");
    expect(applied.run.error).toMatch(/gate approve-plan/);
  });
});
