/**
 * #118 — classification migration, normalizeUsage wiring, GET /metrics
 * aggregation (exact counts, tokens, p50/p95).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths, type MetricsResponse, type TaskState } from "@useparley/core";
import {
  insertTask,
  listTasks,
  openDatabase,
  openDatabaseUpTo,
  SCHEMA_VERSION,
  writeTaskState,
  type DatabaseHandle,
  type NewTask,
} from "../src/db.js";
import { aggregateMetrics, percentile } from "../src/metrics.js";
import { startServer, type DaemonServer } from "../src/server.js";
import { withFakeAllowlist } from "./helpers.js";

let home: string;
let db: DatabaseHandle;

function baseNewTask(overrides: Partial<NewTask> & Pick<NewTask, "id">): NewTask {
  return {
    name: overrides.id,
    vendor: "codex",
    model: "gpt-5",
    effort: null,
    profile: null,
    repo: null,
    cwd: "/tmp",
    prompt: "do it",
    orchestrator_session_id: "sess-a",
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-metrics-"));
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(withFakeAllowlist({})),
  );
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

describe("size/difficulty migration (#118)", () => {
  it("adds size and difficulty columns on open", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-metrics-mig-"));
    // Version 15 is the schema just before the size/difficulty migration (#118);
    // pinned absolute so later appended migrations don't shift this fixture.
    const prev = openDatabaseUpTo(homePaths(home), 15);
    const colsBefore = prev
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsBefore).not.toContain("size");
    expect(colsBefore).not.toContain("difficulty");
    prev.close();

    db = openDatabase(homePaths(home));
    const colsAfter = db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsAfter).toContain("size");
    expect(colsAfter).toContain("difficulty");
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
  });

  it("persists size and difficulty on insert", () => {
    insertTask(
      db,
      baseNewTask({ id: "t1", size: "M", difficulty: "hard" }),
    );
    const row = db.prepare("SELECT size, difficulty FROM tasks WHERE id = ?").get("t1") as {
      size: string;
      difficulty: string;
    };
    expect(row.size).toBe("M");
    expect(row.difficulty).toBe("hard");
  });
});

describe("type column migration (#151)", () => {
  it("adds type column and backfills other for existing rows", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-type-mig-"));
    // Version 17 is the schema just before the type migration (#151); pinned
    // absolute so later appended migrations don't shift this fixture.
    const prev = openDatabaseUpTo(homePaths(home), 17);
    const now = new Date().toISOString();
    prev
      .prepare(
        `INSERT INTO tasks
           (id, name, vendor, model, effort, profile, runner, repo, state, created_at, updated_at,
            cwd, prompt, orchestrator_session_id, worktree, branch, base_sha, sandbox,
            network, answer_timeout_ms, report_schema, size, difficulty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy",
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
        "old task",
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
      );
    const colsBefore = prev
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsBefore).not.toContain("type");
    prev.close();

    db = openDatabase(homePaths(home));
    const colsAfter = db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsAfter).toContain("type");
    const row = db.prepare("SELECT type FROM tasks WHERE id = ?").get("legacy") as {
      type: string;
    };
    expect(row.type).toBe("other");
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
  });

  it("persists type on insert", () => {
    insertTask(db, baseNewTask({ id: "t1", type: "coding" }));
    const row = db.prepare("SELECT type FROM tasks WHERE id = ?").get("t1") as { type: string };
    expect(row.type).toBe("coding");
  });
});

describe("percentile (nearest-rank)", () => {
  it("computes p50 and p95 for known series", () => {
    // 1..20 sorted; p50 nearest-rank = ceil(0.5*20)=10 → value 10
    // p95 nearest-rank = ceil(0.95*20)=19 → value 19
    const series = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(series, 50)).toBe(10);
    expect(percentile(series, 95)).toBe(19);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });
});

describe("aggregateMetrics (#118)", () => {
  /**
   * Seed a multi-vendor, multi-size fixture with mixed usage shapes and evals.
   *
   * Durations (ms) for completed tasks in vendor=codex group:
   *   t1: 1000, t2: 2000, t3: 3000, t4: 4000  → p50=2000, p95=4000, avg=2500
   * Tokens (normalized):
   *   t1 codex-style: in 100 out 50 cached 10
   *   t2 camelCase:   in 200 out 80 cached 20
   *   t3 no usage
   *   t4 codex-style: in 50 out 25 cached 0 (key present)
   *   t5 failed, no duration (no completed_at) but usage counted
   */
  function seed(): void {
    const t = (
      id: string,
      patch: {
        vendor?: string;
        model?: string | null;
        profile?: string | null;
        size?: string | null;
        difficulty?: string | null;
        state?: TaskState;
        session?: string;
        usage?: Record<string, number> | null;
        /** Structured rubric score; pairs with baseline=5 coding@1 by default. */
        eval?: number | null;
        /** When true, write score without rubric fields (legacy free score). */
        legacyEval?: boolean;
        baseline?: number;
        answers?: Record<string, boolean>;
        started?: string;
        completed?: string | null;
      },
    ): void => {
      insertTask(
        db,
        baseNewTask({
          id,
          vendor: patch.vendor ?? "codex",
          model: patch.model === undefined ? "gpt-5" : patch.model,
          profile: patch.profile ?? null,
          size: patch.size ?? null,
          difficulty: patch.difficulty ?? null,
          orchestrator_session_id: patch.session ?? "sess-a",
        }),
      );
      const evalPatch =
        patch.eval === undefined || patch.eval === null
          ? { eval_score: null as number | null }
          : patch.legacyEval
            ? { eval_score: patch.eval }
            : {
                eval_score: patch.eval,
                eval_baseline: patch.baseline ?? 5,
                eval_rubric: "coding",
                eval_rubric_version: 1,
                eval_answers: JSON.stringify(
                  patch.answers ?? {
                    "brief-implemented": true,
                    "broke-existing": false,
                  },
                ),
              };
      writeTaskState(db, id, patch.state ?? "completed", {
        usage: patch.usage === undefined || patch.usage === null ? null : JSON.stringify(patch.usage),
        ...evalPatch,
        started_at: patch.started ?? "2026-01-01T00:00:00.000Z",
        completed_at:
          patch.completed === undefined
            ? patch.state === "failed" || patch.state === "running"
              ? null
              : "2026-01-01T00:00:01.000Z"
            : patch.completed,
      });
    };

    // Fixed durations via started/completed pairs.
    t("t1", {
      size: "S",
      difficulty: "easy",
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 },
      eval: 8,
      started: "2026-01-01T00:00:00.000Z",
      completed: "2026-01-01T00:00:01.000Z", // 1000ms
    });
    t("t2", {
      size: "M",
      difficulty: "hard",
      usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 20 },
      eval: 6,
      started: "2026-01-01T00:00:00.000Z",
      completed: "2026-01-01T00:00:02.000Z", // 2000ms
    });
    t("t3", {
      size: "M",
      difficulty: "hard",
      usage: null,
      eval: 10,
      started: "2026-01-01T00:00:00.000Z",
      completed: "2026-01-01T00:00:03.000Z", // 3000ms
    });
    t("t4", {
      size: "L",
      difficulty: "extreme",
      usage: { input_tokens: 50, output_tokens: 25, cached_input_tokens: 0 },
      eval: null,
      started: "2026-01-01T00:00:00.000Z",
      completed: "2026-01-01T00:00:04.000Z", // 4000ms
    });
    t("t5", {
      state: "failed",
      size: "S",
      difficulty: "easy",
      usage: { input_tokens: 10, output_tokens: 5 },
      eval: 2,
      started: "2026-01-01T00:00:00.000Z",
      completed: null,
    });
    // Second vendor / session / profile
    t("t6", {
      vendor: "fake",
      model: "fake-1",
      profile: "deep",
      session: "sess-b",
      size: "XS",
      difficulty: "trivial",
      usage: { input: 5, output: 1, cache_read: 0 },
      eval: 9,
      started: "2026-01-01T00:00:00.000Z",
      completed: "2026-01-01T00:00:00.500Z", // 500ms
    });
    t("t7", {
      vendor: "fake",
      model: "fake-1",
      profile: "deep",
      session: "sess-b",
      state: "running",
      size: null,
      difficulty: null,
      usage: null,
      eval: null,
      started: "2026-01-01T00:00:00.000Z",
      completed: null,
    });
  }

  it("aggregates by vendor with exact task/eval/token/duration numbers", () => {
    seed();
    const { groups } = aggregateMetrics(listTasks(db), {
      session: "all",
      groupBy: "vendor",
    });

    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(Object.keys(byKey).sort()).toEqual(["codex", "fake"]);

    const codex = byKey.codex!;
    expect(codex.tasks).toEqual({
      total: 5,
      completed: 4,
      failed: 1,
      cancelled: 0,
      running: 0,
      other: 0,
    });
    expect(codex.success_rate).toBe(4 / 5);
    // rubric evals: t1=8, t2=6, t3=10, t5=2 → count 4, avg 6.5; baseline 5 each
    expect(codex.evals.count).toBe(4);
    expect(codex.evals.avg).toBe(6.5);
    expect(codex.evals.avg_baseline).toBe(5);
    expect(codex.evals.avg_delta).toBe(1.5); // (3 + 1 + 5 + -3) / 4
    // below baseline: only t5 (2 < 5) → 1/4
    expect(codex.evals.below_baseline_rate).toBe(0.25);
    expect(codex.evals_by_size.S?.count).toBe(2);
    expect(codex.evals_by_size.S?.avg).toBe(5);
    expect(codex.evals_by_size.M?.count).toBe(2);
    expect(codex.evals_by_size.M?.avg).toBe(8);
    expect(codex.evals_by_difficulty.easy?.avg).toBe(5);
    expect(codex.evals_by_difficulty.hard?.avg).toBe(8);
    // tokens: t1 100/50/10 + t2 200/80/20 + t4 50/25/0 + t5 10/5/0 = 360/160/30; 4 reporting
    expect(codex.tokens).toEqual({
      input: 360,
      output: 160,
      cached: 30,
      tasks_reporting: 4,
    });
    // durations 1000,2000,3000,4000 — only completed
    expect(codex.duration_ms.tasks_reporting).toBe(4);
    expect(codex.duration_ms.total).toBe(10_000);
    expect(codex.duration_ms.avg).toBe(2500);
    expect(codex.duration_ms.p50).toBe(2000);
    expect(codex.duration_ms.p95).toBe(4000);

    const fake = byKey.fake!;
    expect(fake.tasks).toEqual({
      total: 2,
      completed: 1,
      failed: 0,
      cancelled: 0,
      running: 1,
      other: 0,
    });
    // success_rate = 1/(1+0) = 1
    expect(fake.success_rate).toBe(1);
    expect(fake.evals.count).toBe(1);
    expect(fake.evals.avg).toBe(9);
    expect(fake.tokens).toEqual({
      input: 5,
      output: 1,
      cached: 0,
      tasks_reporting: 1,
    });
    expect(fake.duration_ms).toMatchObject({
      total: 500,
      avg: 500,
      p50: 500,
      p95: 500,
      tasks_reporting: 1,
    });
  });

  it("filters by session and groups by size", () => {
    seed();
    const { groups } = aggregateMetrics(listTasks(db), {
      session: "sess-a",
      groupBy: "size",
    });
    const keys = groups.map((g) => g.key).sort();
    // sess-a tasks: S (t1,t5), M (t2,t3), L (t4) — no null size in sess-a
    expect(keys).toEqual(["L", "M", "S"]);
    const s = groups.find((g) => g.key === "S")!;
    expect(s.tasks.total).toBe(2);
    expect(s.tasks.completed).toBe(1);
    expect(s.tasks.failed).toBe(1);
  });

  it("groups by profile and model including null key", () => {
    seed();
    const byProfile = aggregateMetrics(listTasks(db), { groupBy: "profile" });
    expect(
      byProfile.groups.map((g) => g.key).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["deep", null]);
    const byModel = aggregateMetrics(listTasks(db), { groupBy: "model" });
    expect(byModel.groups.map((g) => g.key).sort()).toEqual(["fake-1", "gpt-5"]);
  });

  it("success_rate is null when no completed or failed tasks", () => {
    insertTask(db, baseNewTask({ id: "t1", vendor: "codex" }));
    writeTaskState(db, "t1", "running");
    const { groups } = aggregateMetrics(listTasks(db), { groupBy: "vendor" });
    expect(groups[0]!.success_rate).toBeNull();
    expect(groups[0]!.tasks.running).toBe(1);
  });
});

describe("GET /metrics (#118)", () => {
  let server: DaemonServer | null = null;

  // The fixture tasks carry old completed_at timestamps; keep the retention
  // sweep (#153) from purging them at server startup.
  beforeEach(() => {
    process.env.PARLEY_GC_INTERVAL_MS = "0";
  });

  afterEach(async () => {
    delete process.env.PARLEY_GC_INTERVAL_MS;
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("serves aggregated metrics over the HTTP contract", async () => {
    insertTask(
      db,
      baseNewTask({
        id: "t1",
        vendor: "codex",
        size: "M",
        difficulty: "medium",
      }),
    );
    writeTaskState(db, "t1", "completed", {
      usage: JSON.stringify({ input_tokens: 10, output_tokens: 5, cached_input_tokens: 1 }),
      eval_score: 7,
      eval_baseline: 5,
      eval_rubric: "coding",
      eval_rubric_version: 1,
      eval_answers: JSON.stringify({ "brief-implemented": true, "broke-existing": false }),
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:02.000Z",
    });
    db.close();

    server = await startServer(homePaths(home));
    const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsResponse;
    expect(typeof body.generated_at).toBe("string");
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({
      key: "codex",
      tasks: { total: 1, completed: 1, failed: 0 },
      success_rate: 1,
      evals: { count: 1, avg: 7, avg_baseline: 5 },
      tokens: { input: 10, output: 5, cached: 1, tasks_reporting: 1 },
      duration_ms: { total: 2000, avg: 2000, p50: 2000, p95: 2000, tasks_reporting: 1 },
    });
    expect(body.groups[0]!.evals_by_size.M?.count).toBe(1);
    expect(body.groups[0]!.evals_by_size.M?.avg).toBe(7);
    expect(body.groups[0]!.evals_by_difficulty.medium?.avg).toBe(7);

    const bad = await fetch(`http://127.0.0.1:${server.port}/metrics?group_by=nope`);
    expect(bad.status).toBe(400);

    const filtered = await fetch(
      `http://127.0.0.1:${server.port}/metrics?session=missing&group_by=vendor`,
    );
    expect(filtered.status).toBe(200);
    const empty = (await filtered.json()) as MetricsResponse;
    expect(empty.groups).toEqual([]);

    db = openDatabase(homePaths(home));
  });

  it("POST /tasks accepts and validates size/difficulty", async () => {
    db.close();
    server = await startServer(homePaths(home));
    const ok = await fetch(`http://127.0.0.1:${server.port}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "hi",
        vendor: "fake",
        cwd: home,
        orchestrator_session_id: "s1",
        use_worktree: false,
        size: "XL",
        difficulty: "trivial",
      }),
    });
    expect(ok.status).toBe(201);

    const badSize = await fetch(`http://127.0.0.1:${server.port}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "hi",
        vendor: "fake",
        cwd: home,
        orchestrator_session_id: "s1",
        use_worktree: false,
        size: "huge",
      }),
    });
    expect(badSize.status).toBe(400);
    const badBody = (await badSize.json()) as { error: string };
    expect(badBody.error).toMatch(/invalid size/);

    const detail = await fetch(`http://127.0.0.1:${server.port}/tasks/t1`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      row: { size: string; difficulty: string };
      task: { size: string; difficulty: string };
    };
    expect(detailBody.row.size).toBe("XL");
    expect(detailBody.row.difficulty).toBe("trivial");
    expect(detailBody.task.size).toBe("XL");
    expect(detailBody.task.difficulty).toBe("trivial");

    db = openDatabase(homePaths(home));
  });
});

describe("aggregateMetrics eval aggregations (#164)", () => {
  function seedEvalTask(
    id: string,
    patch: {
      score: number;
      baseline?: number;
      answers?: Record<string, boolean>;
      attempt?: number;
      parent?: string | null;
      type?: string;
      vendor?: string;
      orch_harness?: string | null;
      orch_model?: string | null;
      orch_effort?: string | null;
      eval_harness?: string | null;
      eval_model?: string | null;
      eval_effort?: string | null;
      rubric?: string;
      rubric_version?: number;
      legacy?: boolean;
      session?: string;
    },
  ): void {
    insertTask(
      db,
      baseNewTask({
        id,
        type: patch.type ?? "coding",
        vendor: patch.vendor ?? "codex",
        orchestrator_session_id: patch.session ?? "sess-a",
        parent_task_id: patch.parent ?? null,
        attempt: patch.attempt ?? 1,
        orch_harness: patch.orch_harness ?? null,
        orch_model: patch.orch_model ?? null,
        orch_effort: patch.orch_effort ?? null,
      }),
    );
    if (patch.legacy) {
      writeTaskState(db, id, "completed", {
        eval_score: patch.score,
        completed_at: "2026-01-01T00:00:01.000Z",
        started_at: "2026-01-01T00:00:00.000Z",
      });
      return;
    }
    writeTaskState(db, id, "completed", {
      eval_score: patch.score,
      eval_baseline: patch.baseline ?? 5,
      eval_rubric: patch.rubric ?? "coding",
      eval_rubric_version: patch.rubric_version ?? 1,
      eval_answers: JSON.stringify(
        patch.answers ?? {
          "brief-implemented": true,
          "broke-existing": false,
        },
      ),
      eval_harness: patch.eval_harness ?? null,
      eval_model: patch.eval_model ?? null,
      eval_effort: patch.eval_effort ?? null,
      completed_at: "2026-01-01T00:00:01.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
    });
  }

  it("computes avg score/baseline/delta and below-baseline rate", () => {
    // scores 8, 4, 10 with baseline 5 → deltas +3, -1, +5; below = 1/3
    seedEvalTask("a", { score: 8, baseline: 5 });
    seedEvalTask("b", { score: 4, baseline: 5 });
    seedEvalTask("c", { score: 10, baseline: 5 });
    const { groups } = aggregateMetrics(listTasks(db), { groupBy: "vendor" });
    const g = groups[0]!;
    expect(g.evals.count).toBe(3);
    expect(g.evals.avg).toBeCloseTo((8 + 4 + 10) / 3);
    expect(g.evals.avg_baseline).toBe(5);
    expect(g.evals.avg_delta).toBeCloseTo((3 + -1 + 5) / 3);
    expect(g.evals.below_baseline_rate).toBeCloseTo(1 / 3);
  });

  it("excludes legacy free scores from rubric aggregations", () => {
    seedEvalTask("rubric", { score: 8, baseline: 5 });
    seedEvalTask("legacy", { score: 2, legacy: true });
    const { groups } = aggregateMetrics(listTasks(db), { groupBy: "vendor" });
    const g = groups[0]!;
    // Only the structured eval counts.
    expect(g.evals.count).toBe(1);
    expect(g.evals.avg).toBe(8);
    expect(g.evals.avg_baseline).toBe(5);
    // Legacy score is still on the task row (visible via status), not here.
    const rows = listTasks(db);
    expect(rows.find((t) => t.id === "legacy")!.eval_score).toBe(2);
    expect(rows.find((t) => t.id === "legacy")!.eval_rubric).toBeNull();
  });

  it("tracks per-criterion failure frequency (positives and negatives)", () => {
    // Task 1: positive fail, negative ok
    seedEvalTask("t1", {
      score: 6,
      answers: { "brief-implemented": false, "broke-existing": false },
    });
    // Task 2: positive ok, negative triggered (fail)
    seedEvalTask("t2", {
      score: 3,
      answers: { "brief-implemented": true, "broke-existing": true },
    });
    // Task 3: both ok
    seedEvalTask("t3", {
      score: 10,
      answers: { "brief-implemented": true, "broke-existing": false },
    });
    const { groups } = aggregateMetrics(listTasks(db), { groupBy: "vendor" });
    const cf = groups[0]!.evals.criterion_failures;
    // brief-implemented fails once of three
    expect(cf["brief-implemented"]).toEqual({ failures: 1, count: 3, rate: 1 / 3 });
    // broke-existing fails once of three (triggered true)
    expect(cf["broke-existing"]).toEqual({ failures: 1, count: 3, rate: 1 / 3 });
  });

  it("splits first-attempt vs fix rubric evals", () => {
    seedEvalTask("root", { score: 4, attempt: 1 });
    seedEvalTask("fix1", { score: 8, attempt: 2, parent: "root" });
    seedEvalTask("solo", { score: 10, attempt: 1 });
    const { groups } = aggregateMetrics(listTasks(db), { groupBy: "vendor" });
    const e = groups[0]!.evals;
    expect(e.first_attempt.count).toBe(2);
    expect(e.first_attempt.avg).toBe(7); // (4+10)/2
    expect(e.fix.count).toBe(1);
    expect(e.fix.avg).toBe(8);
    expect(e.first_attempt.below_baseline_rate).toBe(0.5); // 4 < 5
    expect(e.fix.below_baseline_rate).toBe(0);
  });

  it("groups by type, orch provenance, judge provenance, and rubric", () => {
    seedEvalTask("a", {
      score: 8,
      type: "coding",
      orch_harness: "claude",
      orch_model: "sonnet",
      orch_effort: "high",
      eval_harness: "claude",
      eval_model: "opus",
      eval_effort: "max",
      rubric: "coding",
      rubric_version: 1,
    });
    seedEvalTask("b", {
      score: 6,
      type: "design",
      orch_harness: "codex",
      orch_model: "gpt-5",
      orch_effort: "low",
      eval_harness: "grok",
      eval_model: "grok-4",
      eval_effort: "default",
      rubric: "design",
      rubric_version: 2,
    });

    const byType = aggregateMetrics(listTasks(db), { groupBy: "type" });
    expect(byType.groups.map((g) => g.key).sort()).toEqual(["coding", "design"]);

    const byOrch = aggregateMetrics(listTasks(db), { groupBy: "orch_harness" });
    expect(byOrch.groups.map((g) => g.key).sort()).toEqual(["claude", "codex"]);

    const byJudge = aggregateMetrics(listTasks(db), { groupBy: "eval_model" });
    expect(byJudge.groups.map((g) => g.key).sort()).toEqual(["grok-4", "opus"]);

    // Null provenance lands in the explicit "unknown" bucket (#190).
    seedEvalTask("c", {
      score: 5,
      type: "coding",
      orch_harness: null,
      orch_model: null,
      orch_effort: null,
      eval_harness: null,
      eval_model: null,
      eval_effort: null,
      rubric: "coding",
      rubric_version: 1,
    });
    const byOrchUnknown = aggregateMetrics(listTasks(db), { groupBy: "orch_harness" });
    expect(byOrchUnknown.groups.map((g) => g.key).sort()).toEqual([
      "claude",
      "codex",
      "unknown",
    ]);
    expect(byOrchUnknown.groups.find((g) => g.key === "unknown")!.tasks.total).toBe(1);

    const byRubric = aggregateMetrics(listTasks(db), { groupBy: "rubric" });
    expect(byRubric.groups.map((g) => g.key).sort()).toEqual(["coding@1", "design@2"]);
  });

  it("filters by type, provenance, rubric, first_attempt, below_baseline", () => {
    seedEvalTask("a", {
      score: 8,
      type: "coding",
      orch_harness: "claude",
      eval_harness: "claude",
      rubric: "coding",
      rubric_version: 1,
      attempt: 1,
    });
    seedEvalTask("b", {
      score: 3,
      type: "design",
      orch_harness: "codex",
      eval_harness: "grok",
      rubric: "design",
      rubric_version: 1,
      attempt: 2,
      parent: "a",
      baseline: 5,
    });

    expect(
      aggregateMetrics(listTasks(db), { type: "coding", groupBy: "vendor" }).groups[0]!.tasks
        .total,
    ).toBe(1);

    expect(
      aggregateMetrics(listTasks(db), { orch_harness: "claude", groupBy: "vendor" }).groups[0]!
        .tasks.total,
    ).toBe(1);

    expect(
      aggregateMetrics(listTasks(db), { eval_harness: "grok", groupBy: "vendor" }).groups[0]!
        .tasks.total,
    ).toBe(1);

    expect(
      aggregateMetrics(listTasks(db), {
        rubric: "coding",
        rubric_version: 1,
        groupBy: "vendor",
      }).groups[0]!.tasks.total,
    ).toBe(1);

    expect(
      aggregateMetrics(listTasks(db), { first_attempt: true, groupBy: "vendor" }).groups[0]!
        .tasks.total,
    ).toBe(1);

    // b is below baseline (3 < 5)
    expect(
      aggregateMetrics(listTasks(db), { below_baseline: true, groupBy: "vendor" }).groups[0]!
        .tasks.total,
    ).toBe(1);
    expect(
      aggregateMetrics(listTasks(db), { below_baseline: true, groupBy: "vendor" }).groups[0]!
        .evals.avg,
    ).toBe(3);
  });

  it("handles empty groups and zero-eval edges", () => {
    insertTask(db, baseNewTask({ id: "bare", vendor: "fake" }));
    writeTaskState(db, "bare", "running");
    const { groups } = aggregateMetrics(listTasks(db), { groupBy: "vendor" });
    expect(groups[0]!.evals.count).toBe(0);
    expect(groups[0]!.evals.avg).toBeNull();
    expect(groups[0]!.evals.avg_baseline).toBeNull();
    expect(groups[0]!.evals.avg_delta).toBeNull();
    expect(groups[0]!.evals.below_baseline_rate).toBeNull();
    expect(groups[0]!.evals.criterion_failures).toEqual({});
    expect(groups[0]!.evals.first_attempt.count).toBe(0);
    expect(groups[0]!.evals.fix.count).toBe(0);
  });
});

describe("GET /tasks detail enrichment (#164)", () => {
  let server: DaemonServer | null = null;

  beforeEach(() => {
    process.env.PARLEY_GC_INTERVAL_MS = "0";
  });

  afterEach(async () => {
    delete process.env.PARLEY_GC_INTERVAL_MS;
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("returns attempts, session, and eval_detail on GET /tasks/:ref", async () => {
    insertTask(
      db,
      baseNewTask({
        id: "root",
        orch_harness: "claude",
        orch_model: "sonnet",
        orch_effort: "high",
      }),
    );
    writeTaskState(db, "root", "completed", {
      eval_score: 4,
      eval_baseline: 5,
      eval_rubric: "coding",
      eval_rubric_version: 1,
      eval_answers: JSON.stringify({
        "brief-implemented": false,
        "broke-existing": false,
        "fabricated-claim": false,
        "scope-creep": false,
        "change-verified": false,
        "tests-pass": true,
        "readable-diff": true,
        "scope-honored": true,
      }),
      eval_harness: "claude",
      eval_model: "opus",
      eval_effort: "max",
      eval_session_id: "judge-sess",
      completed_at: "2026-01-01T00:00:01.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
    });
    insertTask(
      db,
      baseNewTask({
        id: "fix1",
        parent_task_id: "root",
        attempt: 2,
        resumed: true,
        orch_harness: "claude",
        orch_model: "sonnet",
        orch_effort: "high",
      }),
    );
    writeTaskState(db, "fix1", "completed", {
      eval_score: 9,
      eval_baseline: 5,
      eval_rubric: "coding",
      eval_rubric_version: 1,
      eval_answers: JSON.stringify({ "brief-implemented": true, "broke-existing": false }),
      cached_input_tokens: 100,
      completed_at: "2026-01-01T00:00:02.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
    });
    db.close();

    server = await startServer(homePaths(home));
    const res = await fetch(`http://127.0.0.1:${server.port}/tasks/fix1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attempts: { id: string; attempt: number; resumed: boolean; cache_hit: boolean | null }[];
      session: { harness: string | null; model: string | null };
      eval_detail: {
        score: number;
        baseline: number;
        delta: number;
        below_baseline: boolean;
        legacy: boolean;
        criteria: { id: string; pass: boolean }[] | null;
        judge: { harness: string | null } | null;
      };
    };
    expect(body.attempts.map((a) => a.id)).toEqual(["root", "fix1"]);
    expect(body.attempts[1]!.resumed).toBe(true);
    expect(body.attempts[1]!.cache_hit).toBe(true);
    expect(body.session.harness).toBe("claude");
    expect(body.session.model).toBe("sonnet");
    expect(body.eval_detail.score).toBe(9);
    expect(body.eval_detail.baseline).toBe(5);
    expect(body.eval_detail.delta).toBe(4);
    expect(body.eval_detail.below_baseline).toBe(false);
    expect(body.eval_detail.legacy).toBe(false);
    expect(body.eval_detail.criteria).not.toBeNull();

    db = openDatabase(homePaths(home));
  });

  it("filters GET /tasks by type and first_attempt", async () => {
    insertTask(db, baseNewTask({ id: "a", type: "coding" }));
    insertTask(
      db,
      baseNewTask({ id: "b", type: "design", parent_task_id: "a", attempt: 2 }),
    );
    db.close();
    server = await startServer(homePaths(home));

    const byType = await fetch(`http://127.0.0.1:${server.port}/tasks?type=coding`);
    const typeBody = (await byType.json()) as { tasks: { id: string }[] };
    expect(typeBody.tasks.map((t) => t.id)).toEqual(["a"]);

    const first = await fetch(`http://127.0.0.1:${server.port}/tasks?first_attempt=true`);
    const firstBody = (await first.json()) as { tasks: { id: string }[] };
    expect(firstBody.tasks.map((t) => t.id)).toEqual(["a"]);

    db = openDatabase(homePaths(home));
  });
});
