/**
 * #243 / ADR-0020 — whole-run eval, evalTask ownership guard, run metrics.
 *
 * Run metrics and task metrics are two reports that are never joined.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getShippedRubric,
  homePaths,
  scoreRubric,
  type RubricAnswers,
} from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  getRun,
  insertRun,
  insertTask,
  openDatabase,
  openDatabaseUpTo,
  SCHEMA_VERSION,
  updateRun,
  updateTask,
  type DatabaseHandle,
  type NewTask,
  type RunRow,
} from "../src/db.js";
import { DelegateError, TaskEngine } from "../src/engine.js";
import {
  aggregateRunMetrics,
  indexTasksByRunId,
  isRunRubricEval,
  runMatchesFilters,
  workflowGroupKey,
} from "../src/metrics.js";
import { resolveRubricForRun } from "../src/rubrics.js";
import { withFakeAllowlist } from "./helpers.js";

let home: string;
let db: DatabaseHandle;
let engine: TaskEngine;

function baseTask(overrides: Partial<NewTask> & { id: string }): NewTask {
  return {
    name: null,
    vendor: "fake",
    model: "fake-model",
    effort: null,
    profile: null,
    repo: null,
    cwd: "/tmp",
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

function insertCompletedRun(
  overrides: Partial<{
    id: string;
    workflow: string;
    version: number;
    type: string;
    parent_run_id: string | null;
    size: string | null;
    difficulty: string | null;
    state: "completed" | "failed" | "cancelled" | "running" | "blocked";
  }> = {},
): RunRow {
  const id = overrides.id ?? `r-${Math.random().toString(36).slice(2, 8)}`;
  insertRun(db, {
    id,
    workflow: overrides.workflow ?? "coding-1",
    version: overrides.version ?? 1,
    type: overrides.type ?? "coding",
    workspace: "scratch",
    repo: null,
    state: overrides.state ?? "completed",
    current_node: null,
    parent_run_id: overrides.parent_run_id ?? null,
    attempt: overrides.parent_run_id ? 2 : 1,
    orchestrator_session_id: "orch-1",
    started_at: new Date().toISOString(),
  });
  if (overrides.state === undefined || overrides.state === "completed") {
    updateRun(db, id, { completed_at: new Date().toISOString(), state: "completed" });
  } else if (overrides.state === "failed" || overrides.state === "cancelled") {
    updateRun(db, id, { completed_at: new Date().toISOString(), state: overrides.state });
  } else if (overrides.state === "blocked" || overrides.state === "running") {
    updateRun(db, id, { state: overrides.state });
  }
  if (overrides.size !== undefined || overrides.difficulty !== undefined) {
    updateRun(db, id, {
      size: overrides.size ?? null,
      difficulty: overrides.difficulty ?? null,
    });
  }
  return getRun(db, id)!;
}

function answersFor(rubricId: string, positives: boolean, negatives: boolean): RubricAnswers {
  const r = getShippedRubric(rubricId)!;
  const out: RubricAnswers = {};
  for (const c of r.criteria) {
    out[c.id] = c.kind === "positive" ? positives : negatives;
  }
  return out;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-run-eval-"));
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(withFakeAllowlist({})),
  );
  db = openDatabase(homePaths(home));
  engine = new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("migration #243", () => {
  it("adds run eval and metrics columns", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-run-eval-mig-"));
    // Pre-#243 schema: migrations after #243 are #249 (base_ref/base_commit),
    // #314 (runners table), #313 (repo identity), and #315 routing columns
    // (queue_reason, deadline, placement), so the snapshot is SCHEMA_VERSION - 7.
    const prev = openDatabaseUpTo(homePaths(home), SCHEMA_VERSION - 7);
    const colsBefore = prev
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsBefore).not.toContain("eval_score");
    expect(colsBefore).not.toContain("size");
    prev.close();

    db = openDatabase(homePaths(home));
    const colsAfter = db
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsAfter).toContain("eval_score");
    expect(colsAfter).toContain("eval_baseline");
    expect(colsAfter).toContain("eval_rubric");
    expect(colsAfter).toContain("size");
    expect(colsAfter).toContain("difficulty");
    expect(colsAfter).toContain("orch_harness");
    expect(colsAfter).toContain("eval_harness");
    expect(colsAfter).toContain("base_ref");
    expect(colsAfter).toContain("base_commit");
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
  });
});

describe("evalTask ownership guard (#243 / ADR-0020)", () => {
  it("rejects a task whose run_id is non-null, pointing at parley run eval", () => {
    const run = insertCompletedRun({ id: "r-guard" });
    insertTask(
      db,
      baseTask({
        id: "t-owned",
        run_id: run.id,
        node: "review",
        iteration: 1,
        type: "coding",
      }),
    );

    expect(() =>
      engine.evalTask("t-owned", answersFor("coding", true, false), "looks good"),
    ).toThrow(DelegateError);

    try {
      engine.evalTask("t-owned", answersFor("coding", true, false), "looks good");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DelegateError);
      const msg = (err as Error).message;
      expect(msg).toContain("run r-guard");
      expect(msg).toMatch(/parley run eval/);
    }
  });

  it("still evaluates a free-standing task (run_id null)", () => {
    insertTask(db, baseTask({ id: "t-free", type: "coding" }));
    const answers = answersFor("coding", true, false);
    const row = engine.evalTask("t-free", answers, "ok");
    expect(row.eval_score).not.toBeNull();
    expect(row.eval_rubric).toBe("coding");
    expect(row.run_id).toBeNull();
  });
});

describe("evalRun (#243 / ADR-0020)", () => {
  it("scores a terminal completed run via existing rubric machinery", () => {
    const run = insertCompletedRun({ id: "r1", type: "coding" });
    const answers = answersFor("coding", true, false);
    const expected = scoreRubric(getShippedRubric("coding")!, answers);

    const scored = engine.evalRun("r1", answers, "pipeline looks solid");
    expect(scored.id).toBe(run.id);
    expect(scored.eval_score).toBe(expected.score);
    expect(scored.eval_baseline).toBe(expected.baseline);
    expect(scored.eval_rubric).toBe("coding");
    expect(scored.eval_rubric_version).toBe(1);
    expect(scored.eval_feedback).toBe("pipeline looks solid");
    expect(isRunRubricEval(scored)).toBe(true);
  });

  it("accepts failed and cancelled; rejects blocked and running", () => {
    const answers = answersFor("coding", true, false);
    const failed = insertCompletedRun({ id: "r-fail", state: "failed" });
    const cancelled = insertCompletedRun({ id: "r-cancel", state: "cancelled" });
    const blocked = insertCompletedRun({ id: "r-block", state: "blocked" });
    const running = insertCompletedRun({ id: "r-run", state: "running" });

    expect(engine.evalRun(failed.id, answers, "f").eval_score).not.toBeNull();
    expect(engine.evalRun(cancelled.id, answers, "c").eval_score).not.toBeNull();

    expect(() => engine.evalRun(blocked.id, answers, "b")).toThrow(/blocked/);
    expect(() => engine.evalRun(running.id, answers, "r")).toThrow(/running/);
    expect(() => engine.evalRun(blocked.id, answers, "b")).toThrow(
      /only terminal runs/,
    );
  });

  it("--type override selects a different rubric", () => {
    insertCompletedRun({ id: "r-type", type: "coding" });
    const answers = answersFor("research", true, false);
    const scored = engine.evalRun("r-type", answers, "research-shaped", {
      type: "research",
    });
    expect(scored.eval_rubric).toBe("research");
    // Stored run.type is unchanged — override is eval-time only.
    expect(scored.type).toBe("coding");
  });

  it("resolveRubricForRun delegates to the same type → rubric map", () => {
    expect(resolveRubricForRun(null, "coding").id).toBe("coding");
    expect(resolveRubricForRun(null, "other").id).toBe("generic");
  });

  it("unknown run throws", () => {
    expect(() =>
      engine.evalRun("r-missing", answersFor("coding", true, false), "x"),
    ).toThrow(/no such run/);
  });
});

describe("aggregateRunMetrics (#243 / ADR-0020)", () => {
  it("groups on workflow = id@version composite", () => {
    insertCompletedRun({ id: "r1", workflow: "coding-1", version: 1 });
    insertCompletedRun({ id: "r2", workflow: "coding-1", version: 2 });
    insertCompletedRun({ id: "r3", workflow: "coding-1", version: 1 });

    const runs = engine.listAllRuns();
    const result = aggregateRunMetrics(runs, new Map(), { groupBy: "workflow" });
    const keys = result.groups.map((g) => g.key).sort();
    expect(keys).toEqual(["coding-1@1", "coding-1@2"]);
    const g1 = result.groups.find((g) => g.key === "coding-1@1")!;
    expect(g1.runs.total).toBe(2);
    expect(g1.runs.completed).toBe(2);
  });

  it("workflowGroupKey mirrors rubricGroupKey shape", () => {
    const run = insertCompletedRun({ workflow: "research", version: 3 });
    expect(workflowGroupKey(run)).toBe("research@3");
  });

  it("filters workflow and workflow_version separately", () => {
    insertCompletedRun({ id: "a", workflow: "coding-1", version: 1 });
    insertCompletedRun({ id: "b", workflow: "coding-1", version: 2 });
    insertCompletedRun({ id: "c", workflow: "research", version: 1 });
    const runs = engine.listAllRuns();

    expect(
      aggregateRunMetrics(runs, new Map(), { workflow: "coding-1" }).groups.reduce(
        (n, g) => n + g.runs.total,
        0,
      ),
    ).toBe(2);
    expect(
      aggregateRunMetrics(runs, new Map(), {
        workflow: "coding-1",
        workflow_version: 2,
      }).groups.reduce((n, g) => n + g.runs.total, 0),
    ).toBe(1);
  });

  it("splits first_run / fork, never fix", () => {
    const parent = insertCompletedRun({ id: "r-parent" });
    const fork = insertCompletedRun({
      id: "r-fork",
      parent_run_id: parent.id,
    });
    const answers = answersFor("coding", true, false);
    engine.evalRun(parent.id, answers, "parent ok");
    // Lower score on the fork (fail one positive by using all-false positives).
    const weak = answersFor("coding", false, false);
    engine.evalRun(fork.id, weak, "fork weaker");

    const result = aggregateRunMetrics(engine.listAllRuns(), new Map(), {
      groupBy: "workflow",
    });
    const g = result.groups[0]!;
    expect(g.evals.first_run.count).toBe(1);
    expect(g.evals.fork.count).toBe(1);
    expect(g.evals).not.toHaveProperty("first_attempt");
    expect(g.evals).not.toHaveProperty("fix");
    expect(g.evals.first_run.avg).toBeGreaterThan(g.evals.fork.avg!);
  });

  it("cost_per_completed_run = (input+output tokens) / completed, not a lineage rollup", () => {
    const parent = insertCompletedRun({ id: "r-cost-p", state: "completed" });
    const fork = insertCompletedRun({
      id: "r-cost-f",
      parent_run_id: parent.id,
      state: "completed",
    });
    // Failed run also contributes tokens but not to the completed divisor.
    const failed = insertCompletedRun({ id: "r-cost-x", state: "failed" });

    insertTask(
      db,
      baseTask({
        id: "t-p",
        run_id: parent.id,
        node: "search",
        iteration: 1,
      }),
    );
    updateTask(db, "t-p", {
      usage: JSON.stringify({ input_tokens: 100, output_tokens: 50 }),
    });
    insertTask(
      db,
      baseTask({
        id: "t-f",
        run_id: fork.id,
        node: "search",
        iteration: 1,
      }),
    );
    updateTask(db, "t-f", {
      usage: JSON.stringify({ input_tokens: 40, output_tokens: 10 }),
    });
    insertTask(
      db,
      baseTask({
        id: "t-x",
        run_id: failed.id,
        node: "search",
        iteration: 1,
      }),
    );
    updateTask(db, "t-x", {
      usage: JSON.stringify({ input_tokens: 20, output_tokens: 5 }),
    });

    const tasksByRun = indexTasksByRunId(engine.list());
    const result = aggregateRunMetrics(engine.listAllRuns(), tasksByRun, {
      groupBy: "workflow",
    });
    const g = result.groups[0]!;
    // Total tokens = 100+50 + 40+10 + 20+5 = 225; completed = 2 → 112.5
    expect(g.runs.completed).toBe(2);
    expect(g.tokens.input).toBe(160);
    expect(g.tokens.output).toBe(65);
    expect(g.cost_per_completed_run).toBe(225 / 2);
  });

  it("includes blocked in state counts (pipeline health) but not in success_rate denom alone", () => {
    insertCompletedRun({ id: "ok", state: "completed" });
    insertCompletedRun({ id: "bad", state: "failed" });
    insertCompletedRun({ id: "wait", state: "blocked" });
    const g = aggregateRunMetrics(engine.listAllRuns(), new Map(), {
      groupBy: "workflow",
    }).groups[0]!;
    expect(g.runs.blocked).toBe(1);
    expect(g.runs.completed).toBe(1);
    expect(g.runs.failed).toBe(1);
    expect(g.success_rate).toBe(0.5);
  });

  it("runMatchesFilters: first_run and below_baseline", () => {
    const parent = insertCompletedRun({ id: "p" });
    const fork = insertCompletedRun({ id: "f", parent_run_id: parent.id });
    engine.evalRun(parent.id, answersFor("coding", true, false), "good");
    engine.evalRun(fork.id, answersFor("coding", false, true), "bad");

    const p = getRun(db, "p")!;
    const f = getRun(db, "f")!;
    expect(runMatchesFilters(p, { first_run: true })).toBe(true);
    expect(runMatchesFilters(f, { first_run: true })).toBe(false);
    expect(runMatchesFilters(f, { first_run: false })).toBe(true);
    expect(runMatchesFilters(f, { below_baseline: true })).toBe(true);
    expect(runMatchesFilters(p, { below_baseline: true })).toBe(false);
  });

  it("does not accept vendor as a group dimension (type-level)", () => {
    // Compile-time: RunMetricsGroupBy has no vendor. Runtime: aggregate defaults
    // to workflow and would not look up vendor even if forced.
    const runs = [insertCompletedRun()];
    const result = aggregateRunMetrics(runs, new Map());
    expect(result.groups[0]!.key).toMatch(/@/);
  });

  it("evals_by_size / evals_by_difficulty are free once size is set", () => {
    insertCompletedRun({ id: "s1", size: "S", difficulty: "easy" });
    insertCompletedRun({ id: "s2", size: "L", difficulty: "hard" });
    engine.evalRun("s1", answersFor("coding", true, false), "s");
    engine.evalRun("s2", answersFor("coding", true, false), "l");
    const g = aggregateRunMetrics(engine.listAllRuns(), new Map(), {
      groupBy: "workflow",
    }).groups[0]!;
    expect(g.evals_by_size.S?.count).toBe(1);
    expect(g.evals_by_size.L?.count).toBe(1);
    expect(g.evals_by_difficulty.easy?.count).toBe(1);
    expect(g.evals_by_difficulty.hard?.count).toBe(1);
  });
});
