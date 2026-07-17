/**
 * #118 — classification migration, normalizeUsage wiring, GET /metrics
 * aggregation (exact counts, tokens, p50/p95).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths, type MetricsResponse } from "@useparley/core";
import {
  insertTask,
  listTasks,
  openDatabase,
  openDatabaseUpTo,
  SCHEMA_VERSION,
  updateTask,
  type DatabaseHandle,
  type NewTask,
} from "../src/db.js";
import { aggregateMetrics, percentile } from "../src/metrics.js";
import { startServer, type DaemonServer } from "../src/server.js";

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
    ...overrides,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-metrics-"));
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
        state?: string;
        session?: string;
        usage?: Record<string, number> | null;
        eval?: number | null;
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
      updateTask(db, id, {
        state: patch.state ?? "completed",
        usage: patch.usage === undefined || patch.usage === null ? null : JSON.stringify(patch.usage),
        eval_score: patch.eval === undefined ? null : patch.eval,
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
    // evals: t1=8, t2=6, t3=10, t5=2 → count 4, avg 6.5
    expect(codex.evals).toEqual({ count: 4, avg: 6.5 });
    expect(codex.evals_by_size).toEqual({
      S: { count: 2, avg: 5 }, // 8 and 2
      M: { count: 2, avg: 8 }, // 6 and 10
    });
    expect(codex.evals_by_difficulty).toEqual({
      easy: { count: 2, avg: 5 },
      hard: { count: 2, avg: 8 },
    });
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
    expect(fake.evals).toEqual({ count: 1, avg: 9 });
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
    updateTask(db, "t1", { state: "running" });
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
    updateTask(db, "t1", {
      state: "completed",
      usage: JSON.stringify({ input_tokens: 10, output_tokens: 5, cached_input_tokens: 1 }),
      eval_score: 7,
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
      evals: { count: 1, avg: 7 },
      tokens: { input: 10, output: 5, cached: 1, tasks_reporting: 1 },
      duration_ms: { total: 2000, avg: 2000, p50: 2000, p95: 2000, tasks_reporting: 1 },
    });
    expect(body.groups[0]!.evals_by_size).toEqual({ M: { count: 1, avg: 7 } });
    expect(body.groups[0]!.evals_by_difficulty).toEqual({ medium: { count: 1, avg: 7 } });

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
