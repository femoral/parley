/**
 * #157 — rubric load/resolve and scoring integration on the daemon side.
 * Pure scoring math lives in @useparley/core; these tests cover project
 * override, fallback, and the formula against a live loaded rubric.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getShippedRubric,
  scoreRubric,
  SHIPPED_RUBRIC_IDS,
  validateAnswers,
  type RubricAnswers,
} from "@useparley/core";
import { homePaths } from "@useparley/core";
import {
  insertTask,
  openDatabase,
  openDatabaseUpTo,
  SCHEMA_VERSION,
  updateTask,
  getTask,
  type DatabaseHandle,
} from "../src/db.js";
import { loadRubric, resolveRubricForTask } from "../src/rubrics.js";

let home: string;
let repo: string;
let db: DatabaseHandle;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-rubric-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "parley-repo-"));
  db = openDatabase(homePaths(home));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function answersFor(rubricId: string, positives: boolean, negatives: boolean): RubricAnswers {
  const r = getShippedRubric(rubricId)!;
  const out: RubricAnswers = {};
  for (const c of r.criteria) {
    out[c.id] = c.kind === "positive" ? positives : negatives;
  }
  return out;
}

describe("shipped rubric load (#157)", () => {
  it("loads all nine shipped rubrics", () => {
    for (const id of SHIPPED_RUBRIC_IDS) {
      const r = loadRubric(null, id);
      expect(r.id).toBe(id);
      expect(r.version).toBe(1);
    }
  });

  it("unknown id falls back to generic", () => {
    const r = loadRubric(null, "does-not-exist");
    expect(r.id).toBe("generic");
  });

  it("project override wins over shipped", () => {
    const dir = path.join(repo, ".parley", "rubrics");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "coding.json"),
      JSON.stringify({
        id: "coding",
        version: 9,
        criteria: [
          { id: "only-pos", kind: "positive", weight: 1, text: "Only" },
          { id: "only-neg", kind: "negative", weight: 1, text: "Neg" },
        ],
      }),
    );
    const r = loadRubric(repo, "coding");
    expect(r.version).toBe(9);
    expect(r.criteria).toHaveLength(2);
    expect(r.criteria[0]!.id).toBe("only-pos");
  });

  it("other / custom type resolves to generic", () => {
    expect(resolveRubricForTask(null, "other").id).toBe("generic");
    // Custom type with no taskTypes map entry → generic
    expect(resolveRubricForTask(null, "ops-runbook").id).toBe("generic");
  });

  it("taskTypes mapping selects the named rubric", () => {
    fs.mkdirSync(path.join(repo, ".parley"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".parley", "config.json"),
      JSON.stringify({
        taskTypes: {
          coding: { rubric: "coding" },
          "ops-runbook": { rubric: "generic" },
        },
      }),
    );
    expect(resolveRubricForTask(repo, "coding").id).toBe("coding");
    expect(resolveRubricForTask(repo, "ops-runbook").id).toBe("generic");
  });
});

describe("scoring math on loaded rubrics", () => {
  it("matches the spec formula for coding", () => {
    const rubric = loadRubric(null, "coding");
    const perfect = answersFor("coding", true, false);
    validateAnswers(rubric, perfect);
    const r = scoreRubric(rubric, perfect);
    expect(r.score).toBe(10);
    expect(r.baseline).toBe(5);
    expect(r.below_baseline).toBe(false);

    const worst = answersFor("coding", false, true);
    const w = scoreRubric(rubric, worst);
    expect(w.score).toBe(0);
    expect(w.below_baseline).toBe(true);
  });

  it("floors score at 0 and rounds baseline", () => {
    const rubric = loadRubric(null, "generic");
    // baseline_raw=13, positives=13, max=26
    const mid = answersFor("generic", false, false);
    const r = scoreRubric(rubric, mid);
    expect(r.score).toBe(5);
    expect(r.baseline).toBe(5);
  });
});

describe("eval columns migration (#157)", () => {
  it("appends eval_answers/rubric/version/baseline; historical score untouched", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-eval-mig-"));

    // Schema just before #157 eval columns (after #154 launch_command).
    // Pinned absolute so later appended migrations don't shift this fixture.
    const prev = openDatabaseUpTo(homePaths(home), 20);
    const colsBefore = prev
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsBefore).toContain("eval_score");
    expect(colsBefore).toContain("eval_feedback");
    expect(colsBefore).not.toContain("eval_answers");
    expect(colsBefore).not.toContain("eval_baseline");

    const now = new Date().toISOString();
    prev
      .prepare(
        `INSERT INTO tasks
           (id, name, vendor, model, effort, profile, runner, repo, state, created_at, updated_at,
            cwd, prompt, orchestrator_session_id, worktree, branch, base_sha, sandbox,
            network, answer_timeout_ms, report_schema, size, difficulty, type,
            parent_task_id, attempt, resumed, cached_input_tokens,
            launch_command, model_source, effort_source, eval_score, eval_feedback)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        null,
        null,
        "other",
        null,
        1,
        0,
        null,
        null,
        null,
        null,
        7,
        "old free score",
      );
    prev.close();

    db = openDatabase(homePaths(home));
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);

    const row = getTask(db, "t1")!;
    expect(row.eval_score).toBe(7);
    expect(row.eval_feedback).toBe("old free score");
    expect(row.eval_answers).toBeNull();
    expect(row.eval_rubric).toBeNull();
    expect(row.eval_rubric_version).toBeNull();
    expect(row.eval_baseline).toBeNull();
  });

  it("persists structured eval fields via updateTask", () => {
    insertTask(db, {
      id: "t2",
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      repo: repo,
      cwd: repo,
      prompt: "do it",
      orchestrator_session_id: "orch",
      worktree: null,
      branch: null,
      base_sha: null,
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "coding",
    });
    const rubric = resolveRubricForTask(repo, "coding");
    const a = answersFor("coding", true, false);
    const scored = scoreRubric(rubric, a);
    updateTask(db, "t2", {
      eval_score: scored.score,
      eval_baseline: scored.baseline,
      eval_feedback: "great",
      eval_answers: JSON.stringify(a),
      eval_rubric: rubric.id,
      eval_rubric_version: rubric.version,
    });
    const row = getTask(db, "t2")!;
    expect(row.eval_score).toBe(10);
    expect(row.eval_baseline).toBe(5);
    expect(row.eval_rubric).toBe("coding");
    expect(row.eval_rubric_version).toBe(1);
    expect(JSON.parse(row.eval_answers!)).toEqual(a);
    expect(row.eval_feedback).toBe("great");
  });
});
