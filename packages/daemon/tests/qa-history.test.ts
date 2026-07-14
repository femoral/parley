/**
 * #79 — durable per-task Q&A history: DB write/read, migration from the
 * previous schema version, and persistence across close/reopen.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import {
  answerQaTurn,
  insertQaTurn,
  insertTask,
  listQaTurns,
  openDatabase,
  openDatabaseUpTo,
  SCHEMA_VERSION,
  type DatabaseHandle,
} from "../src/db.js";

let home: string;
let db: DatabaseHandle;

function seedTask(id = "t1"): void {
  insertTask(db, {
    id,
    name: "qa-task",
    vendor: "fake",
    model: null,
    effort: null,
    repo: null,
    cwd: "/tmp",
    prompt: "do it",
    orchestrator_session_id: "orch",
    worktree: null,
    branch: null,
    base_sha: null,
    sandbox: "workspace",
    network: true,
    answer_timeout_ms: null,
    report_schema: null,
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-qa-hist-"));
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

describe("qa_turns table (#79)", () => {
  it("records a turn at ask time with answer null, then updates it in place", () => {
    seedTask();
    insertQaTurn(db, "t1", "q1", "which database?");
    expect(listQaTurns(db, "t1")).toEqual([
      expect.objectContaining({
        question_id: "q1",
        question: "which database?",
        answer: null,
        answered_at: null,
      }),
    ]);

    answerQaTurn(db, "t1", "q1", "postgres");
    const turns = listQaTurns(db, "t1");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      question_id: "q1",
      question: "which database?",
      answer: "postgres",
    });
    expect(turns[0]!.answered_at).not.toBeNull();
  });

  it("returns multiple turns in ask order", () => {
    seedTask();
    insertQaTurn(db, "t1", "q1", "first?");
    answerQaTurn(db, "t1", "q1", "one");
    insertQaTurn(db, "t1", "q2", "second?");
    answerQaTurn(db, "t1", "q2", "two");
    insertQaTurn(db, "t1", "q3", "third?");

    expect(listQaTurns(db, "t1").map((t) => t.question)).toEqual([
      "first?",
      "second?",
      "third?",
    ]);
    expect(listQaTurns(db, "t1").map((t) => t.answer)).toEqual(["one", "two", null]);
  });

  it("leaves an unanswered turn with answer null (no duplicate on re-answer skip)", () => {
    seedTask();
    insertQaTurn(db, "t1", "q1", "still open?");
    // Completing over the question never calls answerQaTurn — history stays null.
    expect(listQaTurns(db, "t1")).toEqual([
      expect.objectContaining({ question: "still open?", answer: null }),
    ]);
    // A second answerQaTurn after already answered is a no-op (WHERE answer IS NULL).
    answerQaTurn(db, "t1", "q1", "first");
    answerQaTurn(db, "t1", "q1", "second");
    expect(listQaTurns(db, "t1")).toEqual([
      expect.objectContaining({ question: "still open?", answer: "first" }),
    ]);
  });

  it("persists history across close/reopen of the database", () => {
    seedTask();
    insertQaTurn(db, "t1", "q1", "survive restart?");
    answerQaTurn(db, "t1", "q1", "yes");
    db.close();

    db = openDatabase(homePaths(home));
    expect(listQaTurns(db, "t1")).toEqual([
      expect.objectContaining({
        question: "survive restart?",
        answer: "yes",
        question_id: "q1",
      }),
    ]);
  });

  it("migrates a previous-schema DB cleanly; pre-existing tasks report empty history", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-qa-mig-"));

    // Build a DB at the schema version just before #79's qa_turns migration.
    const prev = openDatabaseUpTo(homePaths(home), SCHEMA_VERSION - 1);
    insertTask(prev, {
      id: "t1",
      name: "pre-migration",
      vendor: "fake",
      model: null,
      effort: null,
      repo: null,
      cwd: "/tmp",
      prompt: "legacy task",
      orchestrator_session_id: "orch",
      worktree: null,
      branch: null,
      base_sha: null,
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
    });
    const versionBefore = (
      prev.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    expect(versionBefore).toBe(SCHEMA_VERSION - 1);
    prev.close();

    // Full open applies the remaining migration.
    db = openDatabase(homePaths(home));
    const versionAfter = (
      db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    expect(versionAfter).toBe(SCHEMA_VERSION);
    // Pre-existing task has no history rows.
    expect(listQaTurns(db, "t1")).toEqual([]);
    // New turns can be written after migration.
    insertQaTurn(db, "t1", "q1", "post-migration?");
    expect(listQaTurns(db, "t1")).toHaveLength(1);
  });
});
