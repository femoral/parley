/**
 * #244 — run retention: pure planning + effectful decay against SQLite.
 *
 * Covers the issue edge cases by name: declared outputs retained, scaffolding
 * purged, scratch deleted, branches never touched, file/dir path strings kept,
 * live/blocked runs skipped, definition-missing over-retains.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import {
  getDeliverable,
  getRun,
  insertDeliverable,
  insertRun,
  insertTask,
  listExpiredRuns,
  nextDeliverableId,
  nextRunId,
  nextTaskId,
  openDatabase,
  openDatabaseUpTo,
  SCHEMA_VERSION,
  type DatabaseHandle,
  type NewTask,
} from "../src/db.js";
import {
  createRunCheckout,
  createRunScratchWorkspace,
  listRunBranches as listBranchesOnDisk,
  runBranchName,
  runScratchPath,
} from "../src/run-workspace.js";
import {
  declaredOutputKeys,
  decayTaskDeliverables,
  isRunEligibleForPurge,
  isRetainedDeliverable,
  planDeliverableDecay,
  resolveDeclaredOutputKeys,
  shouldSkipRunOwnedTaskExpiry,
  sweepRunRetention,
} from "../src/run-retention.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function seedTerminalRun(opts: {
  workspace: "repo" | "scratch";
  completedAt: string;
  workflow?: string;
  repo?: string | null;
  state?: "completed" | "failed" | "cancelled";
}): { runId: string; taskId: string } {
  const runId = nextRunId(db);
  insertRun(db, {
    id: runId,
    workflow: opts.workflow ?? "research",
    version: 1,
    type: "research",
    workspace: opts.workspace,
    repo: opts.repo ?? null,
    current_node: null,
    state: opts.state ?? "completed",
  });
  // Stamp completed_at / updated_at past the cutoff via update (insert sets now).
  db.prepare(
    `UPDATE runs SET completed_at = ?, updated_at = ?, state = ? WHERE id = ?`,
  ).run(opts.completedAt, opts.completedAt, opts.state ?? "completed", runId);

  const taskId = nextTaskId(db);
  insertTask(
    db,
    baseTask({
      id: taskId,
      run_id: runId,
      node: "write",
      iteration: 1,
      repo: opts.repo ?? null,
      cwd: opts.repo ?? "/tmp/scratch",
    }),
  );
  db.prepare(
    `UPDATE tasks SET state = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(opts.completedAt, opts.completedAt, taskId);

  return { runId, taskId };
}

function writeWorkflow(
  dir: string,
  body: Record<string, unknown>,
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(body, null, 2));
}

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ret-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README"), "x\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

const OLD = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
const CUTOFF = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const RECENT = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ret-"));
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

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

describe("declaredOutputKeys / planDeliverableDecay", () => {
  it("resolves outputs.from as node.port across all iterations and slots", () => {
    const keys = declaredOutputKeys({
      report: { from: "adversarial-review.report" },
      coverage: { from: "adversarial-review.coverage" },
    });
    expect([...keys].sort()).toEqual([
      "adversarial-review.coverage",
      "adversarial-review.report",
    ]);

    const rows = [
      {
        id: "d1",
        run_id: "r1",
        node: "adversarial-review",
        port: "report",
        iteration: 1,
        slot: null,
        task_id: "t1",
        kind: "inline" as const,
        value: "\"final\"",
        created_at: OLD,
        purged_at: null,
      },
      {
        id: "d2",
        run_id: "r1",
        node: "adversarial-review",
        port: "report",
        iteration: 2,
        slot: null,
        task_id: "t2",
        kind: "inline" as const,
        value: "\"earlier\"",
        created_at: OLD,
        purged_at: null,
      },
      {
        id: "d3",
        run_id: "r1",
        node: "search",
        port: "sources",
        iteration: 1,
        slot: "a",
        task_id: "t3",
        kind: "inline" as const,
        value: "[]",
        created_at: OLD,
        purged_at: null,
      },
    ];
    const plan = planDeliverableDecay(rows, keys);
    // Product survives (all iterations); scaffolding decays.
    expect(plan.toRetain.sort()).toEqual(["d1", "d2"]);
    expect(plan.toPurge).toEqual(["d3"]);
  });

  it("over-retains every payload when declared is null (definition missing)", () => {
    const rows = [
      {
        id: "d1",
        run_id: "r1",
        node: "search",
        port: "sources",
        iteration: 1,
        slot: null,
        task_id: "t1",
        kind: "inline" as const,
        value: "[]",
        created_at: OLD,
        purged_at: null,
      },
    ];
    const plan = planDeliverableDecay(rows, null);
    expect(plan.toRetain).toEqual(["d1"]);
    expect(plan.toPurge).toEqual([]);
  });

  it("file/dir declared outputs are retained (value kept, not purged)", () => {
    const keys = declaredOutputKeys({
      artifact: { from: "bundle.report" },
    });
    const d = {
      id: "d1",
      run_id: "r1",
      node: "bundle",
      port: "report",
      iteration: 1,
      slot: null,
      task_id: "t1",
      kind: "file" as const,
      value: ".parley/tmp/bundle.1/out/report.pdf",
      created_at: OLD,
      purged_at: null,
    };
    expect(isRetainedDeliverable(d, keys)).toBe(true);
    const plan = planDeliverableDecay([d], keys);
    expect(plan.toRetain).toEqual(["d1"]);
    expect(plan.toPurge).toEqual([]);
  });
});

describe("isRunEligibleForPurge / shouldSkipRunOwnedTaskExpiry", () => {
  it("requires terminal + past cutoff + not already purged", () => {
    expect(
      isRunEligibleForPurge(
        {
          state: "completed",
          completed_at: OLD,
          updated_at: OLD,
          purged_at: null,
        },
        CUTOFF,
      ),
    ).toBe(true);
    expect(
      isRunEligibleForPurge(
        {
          state: "blocked",
          completed_at: OLD,
          updated_at: OLD,
          purged_at: null,
        },
        CUTOFF,
      ),
    ).toBe(false);
    expect(
      isRunEligibleForPurge(
        {
          state: "running",
          completed_at: null,
          updated_at: OLD,
          purged_at: null,
        },
        CUTOFF,
      ),
    ).toBe(false);
    expect(
      isRunEligibleForPurge(
        {
          state: "completed",
          completed_at: RECENT,
          updated_at: RECENT,
          purged_at: null,
        },
        CUTOFF,
      ),
    ).toBe(false);
    expect(
      isRunEligibleForPurge(
        {
          state: "completed",
          completed_at: OLD,
          updated_at: OLD,
          purged_at: OLD,
        },
        CUTOFF,
      ),
    ).toBe(false);
  });

  it("skips run-owned task expiry while the run is live or blocked", () => {
    expect(
      shouldSkipRunOwnedTaskExpiry({ run_id: "r1" }, { state: "running" }),
    ).toBe(true);
    expect(
      shouldSkipRunOwnedTaskExpiry({ run_id: "r1" }, { state: "blocked" }),
    ).toBe(true);
    expect(
      shouldSkipRunOwnedTaskExpiry({ run_id: "r1" }, { state: "completed" }),
    ).toBe(false);
    expect(
      shouldSkipRunOwnedTaskExpiry({ run_id: null }, { state: "running" }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Effectful: deliverable decay
// ---------------------------------------------------------------------------

describe("decayTaskDeliverables", () => {
  it("purges scaffolding and retains declared outputs (including file path strings)", () => {
    const { runId, taskId } = seedTerminalRun({
      workspace: "scratch",
      completedAt: OLD,
    });

    // Declared: write.report (inline product) + write.artifact (file path).
    // Scaffolding: write.notes.
    const report = insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: runId,
      node: "write",
      port: "report",
      iteration: 1,
      task_id: taskId,
      kind: "inline",
      value: JSON.stringify("the product"),
    });
    const artifact = insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: runId,
      node: "write",
      port: "artifact",
      iteration: 1,
      task_id: taskId,
      kind: "file",
      value: ".parley/tmp/write.1/out/a.pdf",
    });
    const notes = insertDeliverable(db, {
      id: nextDeliverableId(db),
      run_id: runId,
      node: "write",
      port: "notes",
      iteration: 1,
      task_id: taskId,
      kind: "inline",
      value: JSON.stringify("scratch notes"),
    });

    const declared = declaredOutputKeys({
      report: { from: "write.report" },
      artifact: { from: "write.artifact" },
    });
    const at = "2026-07-01T00:00:00.000Z";
    const result = decayTaskDeliverables(db, taskId, declared, at);

    expect(result.retained.sort()).toEqual([artifact.id, report.id].sort());
    expect(result.purged).toEqual([notes.id]);

    const reportRow = getDeliverable(db, report.id)!;
    expect(reportRow.value).toBe(JSON.stringify("the product"));
    expect(reportRow.purged_at).toBeNull();

    const artifactRow = getDeliverable(db, artifact.id)!;
    expect(artifactRow.value).toBe(".parley/tmp/write.1/out/a.pdf");
    expect(artifactRow.purged_at).toBeNull();
    expect(artifactRow.kind).toBe("file");

    const notesRow = getDeliverable(db, notes.id)!;
    expect(notesRow.value).toBeNull();
    expect(notesRow.purged_at).toBe(at);
    // Address survives the value.
    expect(notesRow.node).toBe("write");
    expect(notesRow.port).toBe("notes");
  });
});

// ---------------------------------------------------------------------------
// Effectful: run sweep (scratch delete, no branches)
// ---------------------------------------------------------------------------

describe("sweepRunRetention", () => {
  it("deletes scratch subtrees and stamps purged_at", () => {
    const paths = homePaths(home);
    const { runId } = seedTerminalRun({
      workspace: "scratch",
      completedAt: OLD,
    });
    createRunScratchWorkspace({ runsDir: paths.runs, runId });
    const scratch = runScratchPath(paths.runs, runId);
    fs.writeFileSync(path.join(scratch, "product.md"), "hello\n");
    expect(fs.existsSync(scratch)).toBe(true);

    const result = sweepRunRetention({
      db,
      cutoffIso: CUTOFF,
      dryRun: false,
      runsDir: paths.runs,
      purgedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(result.runs.map((r) => r.run_id)).toEqual([runId]);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(getRun(db, runId)!.purged_at).toBe("2026-07-01T00:00:00.000Z");
    // Run row survives (decay, not expire).
    expect(getRun(db, runId)!.state).toBe("completed");
  });

  it("never deletes a repo-mode run's branch", () => {
    const paths = homePaths(home);
    const repo = makeGitRepo();
    try {
      const { runId } = seedTerminalRun({
        workspace: "repo",
        completedAt: OLD,
        workflow: "coding-1",
        repo,
      });
      createRunCheckout({
        worktreesDir: paths.worktrees,
        repoRoot: repo,
        runId,
        workflow: "coding-1",
        baseRef: "main",
      });
      const branch = runBranchName(runId, "coding-1");
      expect(listBranchesOnDisk(repo, runId)).toContain(branch);

      const result = sweepRunRetention({
        db,
        cutoffIso: CUTOFF,
        dryRun: false,
        runsDir: paths.runs,
        purgedAt: "2026-07-01T00:00:00.000Z",
      });

      expect(result.runs.map((r) => r.run_id)).toEqual([runId]);
      expect(getRun(db, runId)!.purged_at).toBe("2026-07-01T00:00:00.000Z");
      // Branch is the surviving artifact — gc never deletes branches.
      expect(listBranchesOnDisk(repo, runId)).toContain(branch);
      const listed = execFileSync("git", ["-C", repo, "branch", "--list", branch], {
        encoding: "utf8",
      });
      expect(listed).toContain(branch);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("dry-run lists without deleting scratch or stamping purged_at", () => {
    const paths = homePaths(home);
    const { runId } = seedTerminalRun({
      workspace: "scratch",
      completedAt: OLD,
    });
    createRunScratchWorkspace({ runsDir: paths.runs, runId });
    const scratch = runScratchPath(paths.runs, runId);

    const result = sweepRunRetention({
      db,
      cutoffIso: CUTOFF,
      dryRun: true,
      runsDir: paths.runs,
    });

    expect(result.dry_run).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.run_id).toBe(runId);
    expect(fs.existsSync(scratch)).toBe(true);
    expect(getRun(db, runId)!.purged_at).toBeNull();
  });

  it("skips non-terminal and recent runs", () => {
    const paths = homePaths(home);
    const blockedId = nextRunId(db);
    insertRun(db, {
      id: blockedId,
      workflow: "research",
      version: 1,
      type: "research",
      workspace: "scratch",
      repo: null,
      current_node: "gate",
      state: "blocked",
    });
    db.prepare(`UPDATE runs SET updated_at = ? WHERE id = ?`).run(OLD, blockedId);

    seedTerminalRun({ workspace: "scratch", completedAt: RECENT });

    const result = sweepRunRetention({
      db,
      cutoffIso: CUTOFF,
      dryRun: false,
      runsDir: paths.runs,
    });
    expect(result.runs).toEqual([]);
    expect(getRun(db, blockedId)!.purged_at).toBeNull();
  });
});

describe("listExpiredRuns", () => {
  it("mirrors listExpiredTasks clock with terminal + purged_at IS NULL", () => {
    seedTerminalRun({ workspace: "scratch", completedAt: OLD });
    seedTerminalRun({ workspace: "scratch", completedAt: RECENT });
    const blockedId = nextRunId(db);
    insertRun(db, {
      id: blockedId,
      workflow: "research",
      version: 1,
      type: "research",
      workspace: "scratch",
      repo: null,
      current_node: "g",
      state: "blocked",
    });
    db.prepare(`UPDATE runs SET updated_at = ? WHERE id = ?`).run(OLD, blockedId);

    const expired = listExpiredRuns(db, CUTOFF);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.completed_at).toBe(OLD);
  });
});

describe("resolveDeclaredOutputKeys", () => {
  it("loads keys from the global workflow layer", () => {
    writeWorkflow(path.join(home, "workflows", "research"), {
      id: "research",
      version: 1,
      type: "research",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: {
        report: { type: "text", from: "write.report" },
      },
      nodes: [
        {
          id: "write",
          kind: "step",
          prompt: "prompts/write.md",
          in: {},
          out: { report: { type: "text" } },
        },
      ],
    });
    // Minimal prompt file so load does not care (prompt is a path string).
    fs.mkdirSync(path.join(home, "workflows", "research", "prompts"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(home, "workflows", "research", "prompts", "write.md"),
      "write\n",
    );

    const keys = resolveDeclaredOutputKeys("research", {
      home,
      cwd: home,
    });
    expect(keys).not.toBeNull();
    expect([...keys!]).toEqual(["write.report"]);
  });

  it("returns null when the workflow is missing (over-retain)", () => {
    expect(
      resolveDeclaredOutputKeys("no-such-workflow", { home, cwd: home }),
    ).toBeNull();
  });
});

describe("migration #244", () => {
  it("rebuilds deliverables with nullable task_id and ON DELETE SET NULL", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ret-mig-"));

    // Pre-#244 schema: every migration before the deliverables rebuild.
    const prev = openDatabaseUpTo(homePaths(home), SCHEMA_VERSION - 1);
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
        null,
        "fake",
        null,
        null,
        null,
        null,
        null,
        now,
        now,
        "/tmp",
        "brief",
        "orch",
        null,
        null,
        null,
        "workspace",
        1,
        null,
        null,
        null,
        null,
        "other",
      );
    prev
      .prepare(
        `INSERT INTO runs
           (id, workflow, version, type, workspace, repo, state, current_node, iteration,
            parent_run_id, attempt, orchestrator_session_id, created_at, updated_at,
            started_at, completed_at, error, purged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "r1",
        "research",
        1,
        "research",
        "scratch",
        null,
        "completed",
        null,
        1,
        null,
        1,
        null,
        now,
        now,
        now,
        now,
        null,
        null,
      );
    prev
      .prepare(
        `INSERT INTO deliverables
           (id, run_id, node, port, iteration, slot, task_id, kind, value, created_at, purged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d1", "r1", "write", "report", 1, null, "t1", "inline", "\"hi\"", now, null);
    prev.close();

    db = openDatabase(homePaths(home));
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);

    // Row preserved through rebuild.
    expect(getDeliverable(db, "d1")?.value).toBe("\"hi\"");

    // ON DELETE SET NULL: deleting the task nulls task_id, keeps the row.
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run("t1");
    const d = getDeliverable(db, "d1")!;
    expect(d.task_id).toBeNull();
    expect(d.value).toBe("\"hi\"");
  });
});
