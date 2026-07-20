/**
 * #180 — fix after cleaned/missing worktree must recreate a real git checkout
 * (or fail fast), never spawn into a silently mkdir'd empty directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import { getTask, openDatabase, updateTask, type DatabaseHandle } from "../src/db.js";
import { DelegateError, TaskEngine } from "../src/engine.js";
import { makeGitRepo } from "./helpers.js";

const FAKE_VENDOR_BIN = fileURLToPath(
  new URL("../../cli/tests/fake-vendor.mjs", import.meta.url),
);

let home: string;
let db: DatabaseHandle;
const scratch: string[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-fix-ws-"));
  scratch.push(home);
  db = openDatabase(homePaths(home));
  process.env.PARLEY_HOME = home;
  process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.PARLEY_FAKE_VENDOR_BIN;
  delete process.env.PARLEY_HOME;
});

function engine(): TaskEngine {
  return new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function isGitCheckout(dir: string): boolean {
  try {
    git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Seed a terminal worktree task that leaves dirt so auto-remove keeps the wt. */
function delegateRetainedWorktree(eng: TaskEngine, repo: string): {
  taskId: string;
  worktree: string;
  branch: string;
} {
  fs.writeFileSync(
    path.join(repo, ".fake-vendor.json"),
    JSON.stringify([
      { write_file: { path: "keep.txt", contents: "x" } },
      {
        submit_report: {
          summary: "done",
          outcome: "success",
          files_changed: ["keep.txt"],
        },
      },
    ]),
  );
  const row = eng.delegate({
    prompt: "do the thing",
    vendor: "fake",
    profile: null,
    model: null,
    effort: null,
    name: "keep",
    orchestratorSessionId: "orch",
    cwd: repo,
    useWorktree: true,
    baseRef: null,
    sandbox: null,
    network: null,
    answerTimeoutMs: null,
    reportSchema: null,
    contexts: [],
    runner: null,
    size: null,
    difficulty: null,
    type: null,
  });
  // Force terminal so clean/fix can run without waiting on the child.
  updateTask(db, row.id, {
    state: "completed",
    completed_at: new Date().toISOString(),
    report: JSON.stringify({
      summary: "done",
      outcome: "success",
      files_changed: ["keep.txt"],
    }),
  });
  const task = getTask(db, row.id)!;
  expect(task.worktree).toBeTruthy();
  expect(task.branch).toBeTruthy();
  expect(fs.existsSync(task.worktree!)).toBe(true);
  expect(isGitCheckout(task.worktree!)).toBe(true);
  return { taskId: task.id, worktree: task.worktree!, branch: task.branch! };
}

describe("fix workspace validation (#180)", () => {
  it("recreates a git checkout after clean + fix --fresh", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const eng = engine();
    const parent = delegateRetainedWorktree(eng, repo);

    const cleaned = eng.clean(parent.taskId);
    expect(cleaned.removed).toBe(true);
    expect(fs.existsSync(parent.worktree)).toBe(false);

    // After clean, the parent must not look like a live --cwd path.
    const parentRow = getTask(db, parent.taskId)!;
    expect(parentRow.worktree).toBeNull();
    expect(parentRow.cwd).toBeNull();
    expect(parentRow.branch).toBe(parent.branch);
    expect(parentRow.base_sha).toBeTruthy();

    const fixed = eng.fix({
      parentRef: parent.taskId,
      prompt: "please fix",
      fresh: true,
      orchestratorSessionId: "orch",
    });

    expect(fixed.branch).toBe(parent.branch);
    expect(fixed.worktree).toBeTruthy();
    expect(fixed.cwd).toBe(fixed.worktree);
    expect(fs.existsSync(fixed.cwd!)).toBe(true);
    expect(isGitCheckout(fixed.cwd!)).toBe(true);
    expect(git(fixed.cwd!, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(parent.branch);
    // Context lands in a real checkout, not a bare empty dir.
    expect(fs.existsSync(path.join(fixed.cwd!, ".parley", "TASK.md"))).toBe(true);
    expect(fs.existsSync(path.join(fixed.cwd!, ".git"))).toBe(true);

    eng.cancel(fixed.id);
  });

  it("reuses an existing worktree when it is still present", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const eng = engine();
    const parent = delegateRetainedWorktree(eng, repo);

    const fixed = eng.fix({
      parentRef: parent.taskId,
      prompt: "please fix",
      fresh: true,
      orchestratorSessionId: "orch",
    });

    expect(fixed.worktree).toBe(parent.worktree);
    expect(fixed.cwd).toBe(parent.worktree);
    expect(isGitCheckout(fixed.cwd!)).toBe(true);

    eng.cancel(fixed.id);
  });

  it("fails fast when a --cwd task's directory is gone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-cwd-gone-"));
    scratch.push(dir);
    fs.writeFileSync(
      path.join(dir, ".fake-vendor.json"),
      JSON.stringify([
        {
          submit_report: {
            summary: "done",
            outcome: "success",
            files_changed: [],
          },
        },
      ]),
    );
    const eng = engine();
    const row = eng.delegate({
      prompt: "do the thing",
      vendor: "fake",
      profile: null,
      model: null,
      effort: null,
      name: null,
      orchestratorSessionId: "orch",
      cwd: dir,
      useWorktree: false,
      baseRef: null,
      sandbox: null,
      network: null,
      answerTimeoutMs: null,
      reportSchema: null,
      contexts: [],
      runner: null,
      size: null,
      difficulty: null,
      type: null,
    });
    updateTask(db, row.id, {
      state: "completed",
      completed_at: new Date().toISOString(),
      report: JSON.stringify({
        summary: "done",
        outcome: "success",
        files_changed: [],
      }),
    });

    fs.rmSync(dir, { recursive: true, force: true });

    expect(() =>
      eng.fix({
        parentRef: row.id,
        prompt: "please fix",
        fresh: true,
        orchestratorSessionId: "orch",
      }),
    ).toThrow(DelegateError);

    try {
      eng.fix({
        parentRef: row.id,
        prompt: "please fix",
        fresh: true,
        orchestratorSessionId: "orch",
      });
      expect.unreachable("expected fix to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DelegateError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/missing|does not exist|not a directory/i);
      expect(msg).toContain(dir);
      // Never recreate the deleted --cwd path as an empty shell.
      expect(fs.existsSync(dir)).toBe(false);
    }
  });

  it("does not treat a leftover empty dir as a valid worktree after clean", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const eng = engine();
    const parent = delegateRetainedWorktree(eng, repo);

    eng.clean(parent.taskId);
    // Simulate the pre-fix residue: recursive mkdir of the stale cwd leaves
    // an empty non-git directory (what materializeContext used to create).
    fs.mkdirSync(parent.worktree, { recursive: true });
    expect(isGitCheckout(parent.worktree)).toBe(false);

    // Even if a legacy row still points cwd at the empty path, fix must not
    // spawn there — recreate a real checkout instead.
    updateTask(db, parent.taskId, { cwd: parent.worktree });

    const fixed = eng.fix({
      parentRef: parent.taskId,
      prompt: "please fix",
      fresh: true,
      orchestratorSessionId: "orch",
    });

    expect(fixed.cwd).not.toBe(parent.worktree);
    expect(isGitCheckout(fixed.cwd!)).toBe(true);
    expect(git(fixed.cwd!, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(parent.branch);

    eng.cancel(fixed.id);
  });
});
