/**
 * #233 — runs / deliverables / run-owned task persistence (ADR-0016, 0017, 0018).
 *
 * Schema, migrations, row types, and read/write helpers only. No engine.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import {
  deleteRun,
  deleteTask,
  getDeliverable,
  getDeliverableByAddress,
  getRun,
  getTask,
  insertDeliverable,
  insertRun,
  insertTask,
  listChildRuns,
  listDeliverablesForRun,
  listDeliverablesForTask,
  listRuns,
  listRunsForSession,
  listTasksForRun,
  listTasksForRunNode,
  nextDeliverableId,
  nextRunId,
  nextTaskId,
  openDatabase,
  openDatabaseUpTo,
  purgeDeliverable,
  purgeRun,
  SCHEMA_VERSION,
  updateRun,
  type DatabaseHandle,
  type NewTask,
} from "../src/db.js";

let home: string;
let db: DatabaseHandle;

function baseTask(overrides: Partial<NewTask> & { id: string }): NewTask {
  return {
    name: null,
    vendor: "fake",
    model: null,
    effort: null,
    profile: null,
    repo: null,
    cwd: "/tmp/run-workspace",
    prompt: "do work",
    orchestrator_session_id: "orch-1",
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
    ...overrides,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-runs-"));
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

describe("migration (#233)", () => {
  it("creates runs + deliverables and adds run address columns on tasks", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-runs-mig-"));

    // Pre-#233 schema: every migration before the runs/deliverables entry.
    // Six migrations now follow #233 — #244 (deliverables.task_id nullable),
    // #240 (sessions.panicked / event_acks / run_seqs / event_deliveries),
    // #243 (run eval / metrics columns), #249 (base_ref / base_commit),
    // #314 (runners table), and #313 (repo_key / repo_fetch_url) — so the
    // pre-runs snapshot is SCHEMA_VERSION - 9 (#315 routing durability + prior).
    // Keep this in step when appending further entries.
    const prev = openDatabaseUpTo(homePaths(home), SCHEMA_VERSION - 9);
    const tablesBefore = prev
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tablesBefore).not.toContain("runs");
    expect(tablesBefore).not.toContain("deliverables");
    // No steps table ever — deliberate ADR-0017 decision.
    expect(tablesBefore).not.toContain("steps");

    const taskColsBefore = prev
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(taskColsBefore).not.toContain("run_id");
    expect(taskColsBefore).not.toContain("node");
    expect(taskColsBefore).not.toContain("iteration");
    expect(taskColsBefore).not.toContain("slot");

    const now = new Date().toISOString();
    prev
      .prepare(
        `INSERT INTO tasks
           (id, name, vendor, model, effort, profile, runner, repo, state, created_at, updated_at,
            cwd, prompt, orchestrator_session_id, worktree, branch, base_sha, sandbox,
            network, answer_timeout_ms, report_schema, size, difficulty, type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "t1",
        "legacy",
        "fake",
        null,
        null,
        null,
        null,
        null,
        now,
        now,
        "/tmp",
        "legacy brief",
        "orch",
        null,
        null,
        null,
        "workspace",
        1,
        null,
        null,
        "M",
        "easy",
        "other",
      );
    prev.close();

    db = openDatabase(homePaths(home));
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);

    const tablesAfter = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tablesAfter).toContain("runs");
    expect(tablesAfter).toContain("deliverables");
    expect(tablesAfter).not.toContain("steps");

    const taskColsAfter = db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const col of ["run_id", "node", "iteration", "slot"]) {
      expect(taskColsAfter).toContain(col);
    }

    const legacy = getTask(db, "t1")!;
    expect(legacy.run_id).toBeNull();
    expect(legacy.node).toBeNull();
    expect(legacy.iteration).toBeNull();
    expect(legacy.slot).toBeNull();
  });
});

describe("runs", () => {
  it("inserts and reads a run with definition fields and cursor", () => {
    const id = nextRunId(db);
    expect(id).toBe("r1");

    const row = insertRun(db, {
      id,
      workflow: "research",
      version: 1,
      type: "research",
      workspace: "repo",
      repo: "/repos/parley",
      current_node: "scope",
      iteration: 1,
      orchestrator_session_id: "sess-a",
    });

    expect(row.id).toBe("r1");
    expect(row.workflow).toBe("research");
    expect(row.version).toBe(1);
    expect(row.type).toBe("research");
    expect(row.workspace).toBe("repo");
    expect(row.repo).toBe("/repos/parley");
    expect(row.state).toBe("running");
    expect(row.current_node).toBe("scope");
    expect(row.iteration).toBe(1);
    expect(row.parent_run_id).toBeNull();
    expect(row.attempt).toBe(1);
    expect(row.purged_at).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(getRun(db, "r1")).toEqual(row);
  });

  it("records repo null for a scratch run even when a repo path is available", () => {
    // ADR-0018: scratch started inside a repo ignores it and records repo null.
    const row = insertRun(db, {
      id: nextRunId(db),
      workflow: "research",
      version: 2,
      type: "research",
      workspace: "scratch",
      repo: null,
      current_node: "scope",
    });
    expect(row.workspace).toBe("scratch");
    expect(row.repo).toBeNull();
  });

  it("stores parent_run_id and run-level attempt for forks (ADR-0017)", () => {
    const parent = insertRun(db, {
      id: nextRunId(db),
      workflow: "coding-1",
      version: 1,
      type: "coding",
      workspace: "repo",
      repo: "/repos/x",
      current_node: null,
      state: "failed",
    });
    updateRun(db, parent.id, {
      state: "failed",
      completed_at: new Date().toISOString(),
      error: "workspace gone",
    });

    const fork = insertRun(db, {
      id: nextRunId(db),
      workflow: "coding-1",
      version: 1,
      type: "coding",
      workspace: "repo",
      repo: "/repos/x",
      current_node: "implement",
      parent_run_id: parent.id,
      attempt: 2,
    });

    expect(fork.parent_run_id).toBe(parent.id);
    expect(fork.attempt).toBe(2);
    expect(listChildRuns(db, parent.id).map((r) => r.id)).toEqual([fork.id]);
  });

  it("lists runs by session and updates cursor/state", () => {
    insertRun(db, {
      id: nextRunId(db),
      workflow: "a",
      version: 1,
      type: "other",
      workspace: "repo",
      repo: null,
      current_node: "n1",
      orchestrator_session_id: "s1",
    });
    insertRun(db, {
      id: nextRunId(db),
      workflow: "b",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "n1",
      orchestrator_session_id: "s2",
    });
    insertRun(db, {
      id: nextRunId(db),
      workflow: "c",
      version: 1,
      type: "other",
      workspace: "repo",
      repo: null,
      current_node: "n1",
      orchestrator_session_id: "s1",
    });

    expect(listRunsForSession(db, "s1")).toHaveLength(2);
    expect(listRuns(db)).toHaveLength(3);

    updateRun(db, "r1", {
      state: "blocked",
      current_node: "gate-1",
      iteration: 2,
      error: "loop budget exhausted",
    });
    const blocked = getRun(db, "r1")!;
    expect(blocked.state).toBe("blocked");
    expect(blocked.current_node).toBe("gate-1");
    expect(blocked.iteration).toBe(2);
    expect(blocked.error).toBe("loop budget exhausted");
  });

  it("represents purged as a stamp, not a sixth runtime state", () => {
    const run = insertRun(db, {
      id: nextRunId(db),
      workflow: "research",
      version: 1,
      type: "research",
      workspace: "scratch",
      repo: null,
      current_node: null,
      state: "completed",
    });
    const at = "2026-06-24T00:00:00.000Z";
    purgeRun(db, run.id, at);
    const purged = getRun(db, run.id)!;
    expect(purged.state).toBe("completed");
    expect(purged.purged_at).toBe(at);
  });
});

describe("run-owned tasks (ADR-0018)", () => {
  it("carries run_id + address and is shaped like a --cwd task", () => {
    const run = insertRun(db, {
      id: nextRunId(db),
      workflow: "coding-1",
      version: 1,
      type: "coding",
      workspace: "repo",
      repo: "/repos/x",
      current_node: "implement",
    });

    const task = insertTask(
      db,
      baseTask({
        id: nextTaskId(db),
        // Run-owned: working directory set, worktree/branch null.
        cwd: "/home/u/.parley/worktrees/x/r1",
        worktree: null,
        branch: null,
        run_id: run.id,
        node: "implement",
        iteration: 1,
        slot: null,
      }),
    );

    expect(task.run_id).toBe(run.id);
    expect(task.node).toBe("implement");
    expect(task.iteration).toBe(1);
    expect(task.slot).toBeNull();
    expect(task.worktree).toBeNull();
    expect(task.branch).toBeNull();
    expect(task.cwd).toBe("/home/u/.parley/worktrees/x/r1");

    const fanout = insertTask(
      db,
      baseTask({
        id: nextTaskId(db),
        run_id: run.id,
        node: "review",
        iteration: 1,
        slot: "adversarial",
        worktree: null,
        branch: null,
      }),
    );
    expect(fanout.slot).toBe("adversarial");

    expect(listTasksForRun(db, run.id).map((t) => t.id)).toEqual([
      task.id,
      fanout.id,
    ]);
    expect(
      listTasksForRunNode(db, run.id, "review", 1, "adversarial").map((t) => t.id),
    ).toEqual([fanout.id]);
    expect(listTasksForRunNode(db, run.id, "implement", 1, null)).toHaveLength(1);
  });

  it("leaves ordinary tasks with null run address", () => {
    const task = insertTask(db, baseTask({ id: "t-plain" }));
    expect(task.run_id).toBeNull();
    expect(task.node).toBeNull();
    expect(task.iteration).toBeNull();
    expect(task.slot).toBeNull();
  });
});

describe("deliverables", () => {
  function seedRunAndTask(): { runId: string; taskId: string } {
    const runId = nextRunId(db);
    insertRun(db, {
      id: runId,
      workflow: "research",
      version: 1,
      type: "research",
      workspace: "scratch",
      repo: null,
      current_node: "search",
    });
    const taskId = nextTaskId(db);
    insertTask(
      db,
      baseTask({
        id: taskId,
        run_id: runId,
        node: "search",
        iteration: 1,
        slot: "scale-100m",
        worktree: null,
        branch: null,
      }),
    );
    return { runId, taskId };
  }

  it("stores opaque id plus address, kind, and producing task", () => {
    const { runId, taskId } = seedRunAndTask();
    const id = nextDeliverableId(db);
    expect(id).toBe("d1");

    const inline = insertDeliverable(db, {
      id,
      run_id: runId,
      node: "search",
      port: "sources",
      iteration: 1,
      slot: "scale-100m",
      task_id: taskId,
      kind: "inline",
      value: JSON.stringify([{ url: "https://example.org" }]),
    });

    expect(inline.id).toBe("d1");
    expect(inline.run_id).toBe(runId);
    expect(inline.node).toBe("search");
    expect(inline.port).toBe("sources");
    expect(inline.iteration).toBe(1);
    expect(inline.slot).toBe("scale-100m");
    expect(inline.task_id).toBe(taskId);
    expect(inline.kind).toBe("inline");
    expect(inline.purged_at).toBeNull();
    expect(JSON.parse(inline.value!)).toEqual([{ url: "https://example.org" }]);

    expect(
      getDeliverableByAddress(db, runId, "search", "sources", 1, "scale-100m")?.id,
    ).toBe("d1");
  });

  it("supports file and dir kinds as path references", () => {
    const { runId, taskId } = seedRunAndTask();
    const file = insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: runId,
      node: "bundle",
      port: "report",
      iteration: 1,
      task_id: taskId,
      kind: "file",
      value: ".parley/tmp/bundle.1/out/report.pdf",
    });
    const dir = insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: runId,
      node: "bundle",
      port: "artifacts",
      iteration: 1,
      task_id: taskId,
      kind: "dir",
      value: ".parley/tmp/bundle.1/out/artifacts",
    });
    expect(file.kind).toBe("file");
    expect(file.value).toBe(".parley/tmp/bundle.1/out/report.pdf");
    expect(dir.kind).toBe("dir");
  });

  it("makes purged a renderable state: address survives, value clears", () => {
    const { runId, taskId } = seedRunAndTask();
    const d = insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: runId,
      node: "search",
      port: "sources",
      iteration: 1,
      slot: "hybrid-search",
      task_id: taskId,
      kind: "inline",
      value: "[1,2,3]",
    });
    const at = "2026-06-24T00:00:00.000Z";
    purgeDeliverable(db, d.id, at);

    const purged = getDeliverable(db, d.id)!;
    expect(purged.value).toBeNull();
    expect(purged.purged_at).toBe(at);
    expect(purged.node).toBe("search");
    expect(purged.port).toBe("sources");
    expect(purged.slot).toBe("hybrid-search");
    // Still addressable after purge.
    expect(
      getDeliverableByAddress(db, runId, "search", "sources", 1, "hybrid-search")
        ?.purged_at,
    ).toBe(at);
  });

  it("enforces unique address per run (slot null coalesces)", () => {
    const { runId, taskId } = seedRunAndTask();
    insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: runId,
      node: "scope",
      port: "queries",
      iteration: 1,
      slot: null,
      task_id: taskId,
      kind: "inline",
      value: "[]",
    });
    expect(() =>
      insertDeliverable(db, {
        id: nextDeliverableId(db),
        run_id: runId,
        node: "scope",
        port: "queries",
        iteration: 1,
        slot: null,
        task_id: taskId,
        kind: "inline",
        value: "[1]",
      }),
    ).toThrow();
  });

  it("lists by run and by producing task", () => {
    const { runId, taskId } = seedRunAndTask();
    insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: runId,
      node: "search",
      port: "sources",
      iteration: 1,
      slot: "a",
      task_id: taskId,
      kind: "inline",
      value: "1",
    });
    insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: runId,
      node: "search",
      port: "summary",
      iteration: 1,
      slot: "a",
      task_id: taskId,
      kind: "inline",
      value: "\"hi\"",
    });
    expect(listDeliverablesForRun(db, runId)).toHaveLength(2);
    expect(listDeliverablesForTask(db, taskId).map((d) => d.port).sort()).toEqual([
      "sources",
      "summary",
    ]);
  });

  it("deleteTask keeps run-owned deliverables (ON DELETE SET NULL); deleteRun removes the rest", () => {
    const { runId, taskId } = seedRunAndTask();
    const dId = nextDeliverableId(db);
    insertDeliverable(db, {
      id: dId,
      run_id: runId,
      node: "search",
      port: "sources",
      iteration: 1,
      task_id: taskId,
      kind: "inline",
      value: "[]",
    });
    deleteTask(db, taskId);
    // #244: run-owned deliverable rows survive task expiry; task_id nulls out.
    const kept = getDeliverable(db, dId)!;
    expect(kept).toBeDefined();
    expect(kept.task_id).toBeNull();
    expect(kept.value).toBe("[]");
    expect(getTask(db, taskId)).toBeUndefined();
    expect(getRun(db, runId)).toBeDefined();

    deleteRun(db, runId);
    expect(getRun(db, runId)).toBeUndefined();
    expect(listDeliverablesForRun(db, runId)).toHaveLength(0);
  });

  it("deleteTask still hard-deletes deliverables for standalone (non-run) tasks", () => {
    // Deliverables always carry a run_id FK; the standalone branch is keyed
    // off task.run_id === null at delete time. Detach the task from its run
    // first so deleteTask takes the hard-delete path.
    const run = insertRun(db, {
      id: nextRunId(db),
      workflow: "x",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: null,
      state: "completed",
    });
    const taskId = nextTaskId(db);
    insertTask(
      db,
      baseTask({
        id: taskId,
        run_id: run.id,
        node: "n",
        iteration: 1,
      }),
    );
    db.prepare(`UPDATE tasks SET run_id = NULL WHERE id = ?`).run(taskId);
    const dId = nextDeliverableId(db);
    insertDeliverable(db, {
      id: dId,
      run_id: run.id,
      node: "n",
      port: "out",
      iteration: 1,
      task_id: taskId,
      kind: "inline",
      value: "\"x\"",
    });
    deleteTask(db, taskId);
    expect(getDeliverable(db, dId)).toBeUndefined();
    expect(getTask(db, taskId)).toBeUndefined();
  });
});
