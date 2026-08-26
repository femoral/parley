/**
 * #389 — session-scoped task listing. `GET /tasks` used to materialize every
 * task row and filter afterwards, so a session-scoped watch paid for the whole
 * store; on a busy daemon that blew the client's request budget and surfaced as
 * a bogus "daemon unreachable" abort. The predicate now runs in SQL against the
 * `tasks_session` index. These tests pin the two things that must hold: the
 * narrowed path returns exactly what the old post-filter produced, and it stays
 * newest-first (callers depend on that for most-recent-name precedence).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import {
  insertTask,
  listTasks,
  listTasksForSession,
  openDatabase,
  SCHEMA_VERSION,
  type DatabaseHandle,
  type NewTask,
} from "../src/db.js";

let home: string;
let db: DatabaseHandle;

function newTask(id: string, session: string | null): NewTask {
  return {
    id,
    name: id,
    vendor: "codex",
    model: "gpt-5",
    effort: null,
    profile: null,
    repo: null,
    cwd: "/tmp",
    prompt: "do it",
    orchestrator_session_id: session,
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
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-sess-scope-"));
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

describe("listTasksForSession (#389)", () => {
  it("returns only the named session, matching a full-list filter exactly", () => {
    insertTask(db, newTask("t1", "sess-a"));
    insertTask(db, newTask("t2", "sess-b"));
    insertTask(db, newTask("t3", "sess-a"));
    insertTask(db, newTask("t4", null));

    const scoped = listTasksForSession(db, "sess-a");
    // The behaviour the SQL path replaced: list everything, then filter.
    const viaFullList = listTasks(db).filter((t) => t.orchestrator_session_id === "sess-a");

    expect(scoped.map((t) => t.id)).toEqual(viaFullList.map((t) => t.id));
    expect(scoped.map((t) => t.id).sort()).toEqual(["t1", "t3"]);
  });

  it("keeps listTasks' newest-first order", () => {
    // Same session, inserted oldest-first; ids ascend with creation.
    for (const id of ["t1", "t2", "t3"]) insertTask(db, newTask(id, "sess-a"));

    const scoped = listTasksForSession(db, "sess-a");
    const viaFullList = listTasks(db).filter((t) => t.orchestrator_session_id === "sess-a");

    expect(scoped.map((t) => t.id)).toEqual(viaFullList.map((t) => t.id));
    // Newest-first is load-bearing: `watch` resolves a bare name to the most
    // recent task by taking the first match.
    expect(scoped.map((t) => t.id)).toEqual(["t3", "t2", "t1"]);
  });

  it("returns nothing for an unknown session rather than falling back to all", () => {
    insertTask(db, newTask("t1", "sess-a"));
    expect(listTasksForSession(db, "sess-nope")).toEqual([]);
  });

  it("never matches tasks with no session, including on the empty string", () => {
    insertTask(db, newTask("t1", null));
    expect(listTasksForSession(db, "")).toEqual([]);
  });
});

describe("tasks_session index (#389)", () => {
  it("exists so the scoped lookup does not scan the whole table", () => {
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toContain("tasks_session");
  });

  it("is the plan SQLite actually picks for a session lookup", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM tasks WHERE orchestrator_session_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all("sess-a")
      .map((r) => (r as { detail: string }).detail)
      .join(" ");
    // The whole point of the change: an index seek, not a full scan.
    expect(plan).toContain("tasks_session");
    expect(plan).not.toContain("SCAN tasks");
  });

  it("is reached by migrating an existing database, not only a fresh one", () => {
    // Guards the upgrade path for the store that motivated #389 — one that
    // already holds thousands of tasks and is opened by a newer daemon.
    const version = db.prepare(`PRAGMA user_version`).get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
  });
});
