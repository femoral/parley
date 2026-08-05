import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  git,
  makeGitRepo,
  makeHome,
  readDiscovery,
  runCli,
  waitFor,
  waitForState,
  withFakeAllowlist,
  type FakeVendorAction,
} from "./helpers.js";

/**
 * node:sqlite for backdating completed_at / seeding meta in setup. Behavior
 * assertions stay at the CLI seam; the row is only a test fixture.
 */
function openHomeDb(home: string): {
  run: (sql: string, ...params: unknown[]) => void;
  get: (sql: string, ...params: unknown[]) => Record<string, unknown> | undefined;
  close: () => void;
} {
  const DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync as new (
    path: string,
  ) => {
    prepare(sql: string): {
      run: (...params: unknown[]) => void;
      get: (...params: unknown[]) => unknown;
    };
    close(): void;
  };
  // Experimental warning is silenced the same way the daemon does in production
  // consumers; tests that assert quiet stderr already strip color conflicts.
  const db = new DatabaseSync(path.join(home, "parley.db"));
  return {
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    get: (sql, ...params) =>
      db.prepare(sql).get(...params) as Record<string, unknown> | undefined,
    close: () => db.close(),
  };
}

const REPORT = { summary: "done", outcome: "success", files_changed: [] as string[] };

function happyActions(): FakeVendorAction[] {
  return [
    { emit: { type: "session", session_id: "sess-gc" } },
    { submit_report: REPORT },
  ];
}

function worktreePath(home: string, id: string, repoDir: string): string {
  return path.join(home, "worktrees", path.basename(repoDir), id);
}

function writeRetention(home: string, days: number): void {
  fs.writeFileSync(
    path.join(home, "parley.json"),
    `${JSON.stringify(withFakeAllowlist({ retention: { days } }), null, 2)}\n`,
  );
}

function backdateCompleted(home: string, taskId: string, iso: string): void {
  const db = openHomeDb(home);
  try {
    db.run(`UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?`, iso, iso, taskId);
  } finally {
    db.close();
  }
}

function getMeta(home: string, key: string): string | null {
  const db = openHomeDb(home);
  try {
    const row = db.get(`SELECT value FROM meta WHERE key = ?`, key);
    return row === undefined ? null : String(row.value);
  } finally {
    db.close();
  }
}

function setMeta(home: string, key: string, value: string): void {
  const db = openHomeDb(home);
  try {
    db.run(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  } finally {
    db.close();
  }
}

function taskCount(home: string): number {
  const db = openHomeDb(home);
  try {
    const row = db.get(`SELECT COUNT(*) AS n FROM tasks`);
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

function taskExists(home: string, id: string): boolean {
  const db = openHomeDb(home);
  try {
    return db.get(`SELECT id FROM tasks WHERE id = ?`, id) !== undefined;
  } finally {
    db.close();
  }
}

describe("parley gc (#153)", () => {
  let home: string;
  const scratch: string[] = [];

  beforeEach(() => {
    home = makeHome();
  });

  afterEach(() => {
    cleanupHome(home);
    for (const dir of scratch.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("purges expired terminal tasks: row, logs, worktree; keeps branch", async () => {
    writeRetention(home, 30);
    const src = makeGitRepo([
      { write_file: { path: "dirty.txt", contents: "keep me dirty so worktree is retained" } },
      ...happyActions(),
    ]);
    scratch.push(src);

    await runCli(["delegate", "-v", "fake", "-n", "old", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");
    const wt = worktreePath(home, "t1", src);
    expect(fs.existsSync(wt)).toBe(true);
    const logs = path.join(home, "tasks", "t1");
    expect(fs.existsSync(logs)).toBe(true);
    expect(git(src, ["branch", "--list", "parley/t1-old"])).toContain("parley/t1-old");

    // 31 days past the retention window.
    backdateCompleted(home, "t1", new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString());

    const gc = await runCli(["gc", "--json"], home);
    expect(gc.code).toBe(0);
    const body = JSON.parse(gc.stdout) as {
      dry_run: boolean;
      removed: number;
      freed_bytes: number;
      tasks: { task_id: string }[];
    };
    expect(body.dry_run).toBe(false);
    expect(body.removed).toBe(1);
    expect(body.tasks.map((t) => t.task_id)).toEqual(["t1"]);
    expect(body.freed_bytes).toBeGreaterThan(0);

    expect(taskExists(home, "t1")).toBe(false);
    expect(fs.existsSync(logs)).toBe(false);
    expect(fs.existsSync(wt)).toBe(false);
    // Branch is the surviving artifact — never deleted.
    expect(git(src, ["branch", "--list", "parley/t1-old"])).toContain("parley/t1-old");
  });

  it("--dry-run lists expired tasks without deleting", async () => {
    writeRetention(home, 0);
    const src = makeGitRepo(happyActions());
    scratch.push(src);
    await runCli(["delegate", "-v", "fake", "-n", "soon", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");

    const dry = await runCli(["gc", "--dry-run", "--json"], home);
    expect(dry.code).toBe(0);
    const body = JSON.parse(dry.stdout) as {
      dry_run: boolean;
      removed: number;
      tasks: { task_id: string }[];
    };
    expect(body.dry_run).toBe(true);
    expect(body.removed).toBe(1);
    expect(body.tasks[0]?.task_id).toBe("t1");

    // Still present after dry-run.
    expect(taskExists(home, "t1")).toBe(true);
    const status = await runCli(["status", "t1", "--json"], home);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).state).toBe("completed");

    // Human dry-run output.
    const text = await runCli(["gc", "--dry-run"], home);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/Would remove 1 task/);
  });

  it("respects retention boundary: recent terminal tasks are kept", async () => {
    writeRetention(home, 30);
    const src = makeGitRepo(happyActions());
    scratch.push(src);
    await runCli(["delegate", "-v", "fake", "-n", "fresh", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");
    // Completed ~1 day ago — inside the 30-day window.
    backdateCompleted(home, "t1", new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString());

    const gc = await runCli(["gc", "--json"], home);
    expect(gc.code).toBe(0);
    const body = JSON.parse(gc.stdout) as { removed: number };
    expect(body.removed).toBe(0);
    expect(taskExists(home, "t1")).toBe(true);
  });

  it("never touches non-terminal tasks even with retention.days = 0", async () => {
    writeRetention(home, 0);
    const done = makeGitRepo(happyActions());
    const live = makeGitRepo([{ sleep: 30_000 }, ...happyActions()]);
    scratch.push(done, live);

    await runCli(["delegate", "-v", "fake", "-n", "done", "x"], home, { cwd: done });
    await waitForState(home, "t1", "completed");

    await runCli(["delegate", "-v", "fake", "-n", "live", "run"], home, { cwd: live });
    await waitForState(home, "t2", "running");
    const liveWt = worktreePath(home, "t2", live);
    expect(fs.existsSync(liveWt)).toBe(true);

    const gc = await runCli(["gc", "--json"], home);
    expect(gc.code).toBe(0);
    const body = JSON.parse(gc.stdout) as { removed: number; tasks: { task_id: string }[] };
    expect(body.removed).toBe(1);
    expect(body.tasks.map((t) => t.task_id)).toEqual(["t1"]);

    expect(taskExists(home, "t1")).toBe(false);
    expect(taskExists(home, "t2")).toBe(true);
    expect(fs.existsSync(liveWt)).toBe(true);
    const status = JSON.parse((await runCli(["status", "t2", "--json"], home)).stdout);
    expect(status.state).toBe("running");
  });

  it("parley clean remains targeted worktree-only (task row kept)", async () => {
    const src = makeGitRepo([
      { write_file: { path: "d.txt", contents: "x" } },
      ...happyActions(),
    ]);
    scratch.push(src);
    await runCli(["delegate", "-v", "fake", "-n", "keep-row", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");
    const wt = worktreePath(home, "t1", src);
    expect(fs.existsSync(wt)).toBe(true);

    // Dirty worktree requires --force (#336); still only drops the worktree.
    const clean = await runCli(["clean", "--force", "t1"], home);
    expect(clean.code).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    // Branch kept.
    expect(git(src, ["branch", "--list", "parley/t1-keep-row"])).toContain("parley/t1-keep-row");
    // Row still there — clean ≠ gc.
    expect(taskExists(home, "t1")).toBe(true);
    expect(fs.existsSync(path.join(home, "tasks", "t1"))).toBe(true);
  });

  it("scheduled sweep logs to diag and respects last_gc_at across restarts", async () => {
    writeRetention(home, 0);
    // Short interval for the schedule; idle timeout long enough that the
    // daemon stays up for the test (default idle is 5m; leave it).
    const start = await runCli(["daemon", "start"], home, {
      extraEnv: { PARLEY_GC_INTERVAL_MS: "60000" },
    });
    expect(start.code).toBe(0);

    // First sweep runs shortly after startup (no last_gc_at yet).
    const diagPath = path.join(home, "diag.log");
    await waitFor(() => fs.existsSync(diagPath), "diag.log from first scheduled gc", 10_000);
    await waitFor(
      () => fs.readFileSync(diagPath, "utf8").includes("gc: removed"),
      "gc line in diag.log",
      10_000,
    );
    const firstDiag = fs.readFileSync(diagPath, "utf8");
    const firstGcLines = firstDiag.split("\n").filter((l) => l.includes("gc: removed"));
    expect(firstGcLines.length).toBe(1);
    const lastAt = getMeta(home, "last_gc_at");
    expect(lastAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Restart: last_gc_at is recent and interval is 60s → must not resweep early.
    expect((await runCli(["daemon", "stop"], home)).code).toBe(0);
    await waitFor(() => readDiscovery(home) === null, "daemon stopped", 10_000);

    expect(
      (
        await runCli(["daemon", "start"], home, {
          extraEnv: { PARLEY_GC_INTERVAL_MS: "60000" },
        })
      ).code,
    ).toBe(0);

    // Give the restart's immediate-if-due path time; it should wait ~60s.
    await new Promise((r) => setTimeout(r, 400));
    const afterRestart = fs.readFileSync(diagPath, "utf8");
    const afterLines = afterRestart.split("\n").filter((l) => l.includes("gc: removed"));
    expect(afterLines.length).toBe(1);
    expect(getMeta(home, "last_gc_at")).toBe(lastAt);

    // Force last_gc_at into the past and restart → due immediately.
    expect((await runCli(["daemon", "stop"], home)).code).toBe(0);
    await waitFor(() => readDiscovery(home) === null, "daemon stopped again", 10_000);
    setMeta(home, "last_gc_at", new Date(Date.now() - 120_000).toISOString());

    expect(
      (
        await runCli(["daemon", "start"], home, {
          extraEnv: { PARLEY_GC_INTERVAL_MS: "60000" },
        })
      ).code,
    ).toBe(0);

    await waitFor(() => {
      const lines = fs
        .readFileSync(diagPath, "utf8")
        .split("\n")
        .filter((l) => l.includes("gc: removed"));
      return lines.length >= 2;
    }, "second scheduled gc after stale last_gc_at", 10_000);

    expect(taskCount(home)).toBe(0);
  });
});
