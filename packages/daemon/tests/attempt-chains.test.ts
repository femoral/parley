/**
 * #152 — attempt-chain columns migration: parent_task_id, attempt, resumed,
 * cached_input_tokens. Existing rows backfill attempt=1.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import {
  insertTask,
  listTasks,
  openDatabase,
  openDatabaseUpTo,
  SCHEMA_VERSION,
  type DatabaseHandle,
} from "../src/db.js";

let home: string;
let db: DatabaseHandle;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-attempt-"));
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

describe("attempt-chain migration (#152)", () => {
  it("appends attempt columns and backfills attempt=1 on existing rows", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-attempt-mig-"));

    // Version 18 is the schema just before the attempt-chain migration (#152);
    // pinned absolute so later appended migrations don't shift this fixture.
    const prev = openDatabaseUpTo(homePaths(home), 18);
    const colsBefore = prev
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsBefore).not.toContain("parent_task_id");
    expect(colsBefore).not.toContain("attempt");
    expect(colsBefore).not.toContain("resumed");
    expect(colsBefore).not.toContain("cached_input_tokens");

    const now = new Date().toISOString();
    prev
      .prepare(
        `INSERT INTO tasks
           (id, name, vendor, model, effort, profile, runner, repo, state, created_at, updated_at,
            cwd, prompt, orchestrator_session_id, worktree, branch, base_sha, sandbox,
            network, answer_timeout_ms, report_schema, size, difficulty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    prev.close();

    db = openDatabase(homePaths(home));
    const colsAfter = db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsAfter).toContain("parent_task_id");
    expect(colsAfter).toContain("attempt");
    expect(colsAfter).toContain("resumed");
    expect(colsAfter).toContain("cached_input_tokens");
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);

    const row = db
      .prepare(
        `SELECT parent_task_id, attempt, resumed, cached_input_tokens FROM tasks WHERE id = ?`,
      )
      .get("t1") as {
      parent_task_id: string | null;
      attempt: number;
      resumed: number;
      cached_input_tokens: number | null;
    };
    expect(row.parent_task_id).toBeNull();
    expect(row.attempt).toBe(1);
    expect(row.resumed).toBe(0);
    expect(row.cached_input_tokens).toBeNull();
  });

  it("insertTask defaults first attempts to attempt=1, not resumed", () => {
    insertTask(db, {
      id: "t1",
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      repo: null,
      cwd: "/tmp",
      prompt: "hi",
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
      type: "other",
    });
    const tasks = listTasks(db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.attempt).toBe(1);
    expect(tasks[0]!.parent_task_id).toBeNull();
    expect(tasks[0]!.resumed).toBe(0);
    expect(tasks[0]!.cached_input_tokens).toBeNull();
  });
});
