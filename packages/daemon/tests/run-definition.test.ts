/**
 * #381 — definition snapshot: capture, persist, missing → blocked,
 * fork inherit-by-copy, finish without a snapshot.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths, parseWorkflowDefinition } from "@useparley/core";
import {
  copyRunDefinition,
  deleteRunDefinition,
  getRun,
  getRunBlockReason,
  getRunDefinitionRaw,
  insertRun,
  nextRunId,
  openDatabase,
  openDatabaseUpTo,
  updateRun,
  type DatabaseHandle,
} from "../src/db.js";
import {
  actionRunVerb,
  advanceRun,
  forkRun,
  type ForkHost,
} from "../src/run-engine.js";
import {
  captureRunDefinitionSnapshot,
  loadRunDefinition,
  parseRunDefinitionSnapshot,
  saveRunDefinition,
} from "../src/run-definition.js";
import {
  createRunScratchWorkspace,
  writeRunInputs,
} from "../src/run-workspace.js";

let home: string;
let db: DatabaseHandle;
let runsDir: string;
let worktreesDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-def-snap-"));
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

function writeLinearWorkflow(dir: string): ReturnType<typeof parseWorkflowDefinition>["definition"] {
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "PROMPT.md"), "WORKFLOW-BODY\n");
  fs.writeFileSync(path.join(dir, "prompts", "a.md"), "NODE-A\n");
  fs.writeFileSync(path.join(dir, "prompts", "b.md"), "NODE-B\n");
  fs.writeFileSync(path.join(dir, "prompts", "slot.md"), "SLOT-APPEND\n");
  return parseWorkflowDefinition(
    {
      id: "linear",
      version: 1,
      type: "other",
      workspace: "scratch",
      reentry: "b",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "dict<string, text>", from: "b.report" } },
      nodes: [
        {
          id: "a",
          kind: "step",
          prompt: "prompts/a.md",
          slots: { review: { prompt_append: "prompts/slot.md" } },
          in: { brief: { type: "text", from: "run.brief" } },
          out: { report: { type: "text" } },
        },
        {
          id: "b",
          kind: "step",
          prompt: "prompts/b.md",
          in: { prev: { type: "dict<string, text>", from: "a.report" } },
          out: { report: { type: "dict<string, text>" } },
        },
      ],
    },
    { dir, expectedId: "linear", typeCheck: true },
  ).definition;
}

describe("capture + persist", () => {
  it("captures workflow, node, and slot prompt bodies", () => {
    const dir = path.join(home, "wf");
    const def = writeLinearWorkflow(dir);
    const snap = captureRunDefinitionSnapshot(def);
    expect(snap.prompts.workflow).toBe("WORKFLOW-BODY");
    expect(snap.prompts.nodes.a).toBe("NODE-A");
    expect(snap.prompts.nodes.b).toBe("NODE-B");
    expect(snap.prompts.slots["a/review"]).toBe("SLOT-APPEND");

    const runId = nextRunId(db);
    insertRun(db, {
      id: runId,
      workflow: "linear",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "a",
      state: "running",
    });
    saveRunDefinition(db, runId, snap);
    const loaded = loadRunDefinition(db, runId);
    expect(loaded?.definition.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(loaded?.prompts.nodes.a).toBe("NODE-A");
  });

  it("ignores later disk edits when loading the stored snapshot", () => {
    const dir = path.join(home, "wf-edit");
    const def = writeLinearWorkflow(dir);
    const snap = captureRunDefinitionSnapshot(def);
    fs.writeFileSync(path.join(dir, "prompts", "b.md"), "EDITED-B\n");
    const runId = nextRunId(db);
    insertRun(db, {
      id: runId,
      workflow: "linear",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "a",
      state: "running",
    });
    saveRunDefinition(db, runId, snap);
    expect(loadRunDefinition(db, runId)!.prompts.nodes.b).toBe("NODE-B");
  });

  it("returns null for missing or corrupt snapshot JSON", () => {
    expect(loadRunDefinition(db, "r-missing")).toBeNull();
    expect(parseRunDefinitionSnapshot("{not json")).toBeNull();
    expect(parseRunDefinitionSnapshot(JSON.stringify({ definition: {} }))).toBeNull();
  });
});

describe("advance + verbs", () => {
  it("blocks a running run whose snapshot is missing", () => {
    const run = insertRun(db, {
      id: nextRunId(db),
      workflow: "linear",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "a",
      state: "running",
    });
    const result = advanceRun(db, run.id, {
      loadDefinition: (r) => loadRunDefinition(db, r.id)?.definition ?? null,
    });
    expect(result?.changed).toBe(true);
    expect(getRun(db, run.id)!.state).toBe("blocked");
    expect(getRunBlockReason(db, run.id)).toBe("unloadable_definition");
    expect(getRun(db, run.id)!.error).toMatch(/unloadable definition snapshot/);
  });

  it("finish completes a blocked run even when the snapshot is gone", () => {
    const run = insertRun(db, {
      id: nextRunId(db),
      workflow: "linear",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "a",
      state: "blocked",
    });
    updateRun(db, run.id, { error: "blocked (unloadable definition snapshot)" });
    const result = actionRunVerb(
      db,
      run.id,
      { loadDefinition: () => null },
      { verb: "finish" },
    );
    expect(result?.changed).toBe(true);
    expect(result?.decision.kind).toBe("complete");
    expect(getRun(db, run.id)!.state).toBe("completed");
  });
});

describe("fork inherit-by-copy", () => {
  it("copies the parent snapshot onto the child even when the authoring dir is gone", () => {
    const dir = path.join(home, "wf-fork");
    const def = writeLinearWorkflow(dir);
    const parent = insertRun(db, {
      id: nextRunId(db),
      workflow: "linear",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "b",
      state: "running",
    });
    saveRunDefinition(db, parent.id, captureRunDefinitionSnapshot(def));
    updateRun(db, parent.id, {
      state: "failed",
      completed_at: new Date().toISOString(),
      error: "blocked (spawn b): boom",
    });
    createRunScratchWorkspace({ runsDir, runId: parent.id });
    writeRunInputs(path.join(runsDir, parent.id), { brief: "x" });
    fs.rmSync(dir, { recursive: true, force: true });

    const host: ForkHost = {
      loadDefinition: (run) => loadRunDefinition(db, run.id)?.definition ?? null,
      worktreesDir,
      runsDir,
      resolveWorkspaceRoot: (run) => path.join(runsDir, run.id),
    };
    const result = forkRun(db, host, { parentRunId: parent.id, to: "b" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const childId = result.result.run.id;
    const childSnap = loadRunDefinition(db, childId);
    expect(childSnap).not.toBeNull();
    expect(childSnap!.prompts.nodes.b).toBe("NODE-B");
    expect(getRunDefinitionRaw(db, childId)).toBe(getRunDefinitionRaw(db, parent.id));
  });

  it("copyRunDefinition returns false when the parent has no row", () => {
    const parent = insertRun(db, {
      id: nextRunId(db),
      workflow: "linear",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "a",
      state: "failed",
    });
    const child = insertRun(db, {
      id: nextRunId(db),
      workflow: "linear",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "a",
      state: "running",
    });
    expect(copyRunDefinition(db, parent.id, child.id)).toBe(false);
  });
});

describe("migration #381", () => {
  it("creates run_definitions and leaves pre-migration runs without a snapshot", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-def-mig-"));
    const prevDb = openDatabaseUpTo(homePaths(home), 36);
    const now = new Date().toISOString();
    prevDb
      .prepare(
        `INSERT INTO runs
           (id, workflow, version, type, workspace, repo, state, current_node, iteration,
            parent_run_id, attempt, orchestrator_session_id, created_at, updated_at,
            started_at, completed_at, error, purged_at, base_ref, base_commit)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 1, NULL, 1, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run("r1", "legacy", 1, "other", "scratch", null, "a", now, now, now);
    const tablesBefore = prevDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tablesBefore).not.toContain("run_definitions");
    prevDb.close();

    db = openDatabase(homePaths(home));
    const tablesAfter = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tablesAfter).toContain("run_definitions");
    expect(getRun(db, "r1")?.workflow).toBe("legacy");
    expect(getRunDefinitionRaw(db, "r1")).toBeUndefined();
    deleteRunDefinition(db, "r1");
  });
});
