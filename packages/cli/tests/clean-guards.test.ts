/**
 * #336 — `parley clean` guards: refuse live-shared worktrees and dirty trees
 * unless `--force`; `--all-terminal` skips protected worktrees and reports why.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  git,
  makeGitRepo,
  makeHome,
  runCli,
  waitForState,
  type FakeVendorAction,
} from "./helpers.js";

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

const REPORT = { summary: "did the thing", outcome: "success", files_changed: ["a"] };

function repo(actions: FakeVendorAction[], files: Record<string, string> = {}): string {
  const dir = makeGitRepo(actions, files);
  scratch.push(dir);
  return dir;
}

function worktreePath(id: string, repoDir: string): string {
  return path.join(home, "worktrees", path.basename(repoDir), id);
}

/** Retained dirty completed worktree (auto-remove skipped). */
function dirtyCompleteActions(): FakeVendorAction[] {
  return [
    { write_file: { path: "dirty.txt", contents: "x" } },
    { submit_report: REPORT },
  ];
}

/** Long-running fix reattempt so parent clean races a live child. */
function slowFixResumeActions(): FakeVendorAction[] {
  return [
    { emit: { type: "session", session_id: "sess-parent" } },
    { sleep: 5000 },
    { submit_report: { summary: "fixed", outcome: "success", files_changed: [] } },
  ];
}

describe("parley clean guards (#336)", () => {
  it("refuses cleaning a terminal parent whose worktree a live linked reattempt uses", async () => {
    // Dirty parent so the worktree is retained after completion (shared path).
    // Resume script is committed so the worktree checkout sees it for `fix`.
    const src = repo(
      [
        { emit: { type: "session", session_id: "sess-parent" } },
        { write_file: { path: "keep.txt", contents: "x" } },
        { submit_report: REPORT },
      ],
      { ".fake-vendor.resume.json": JSON.stringify(slowFixResumeActions()) },
    );

    const parentAck = JSON.parse(
      (
        await runCli(["delegate", "-v", "fake", "-n", "shared", "parent work"], home, {
          cwd: src,
        })
      ).stdout,
    ) as { task_id: string };
    await waitForState(home, parentAck.task_id, "completed");
    const parentWt = worktreePath(parentAck.task_id, src);
    expect(fs.existsSync(parentWt)).toBe(true);

    const fix = await runCli(["fix", parentAck.task_id, "please fix"], home, { cwd: src });
    expect(fix.code).toBe(0);
    const childAck = JSON.parse(fix.stdout) as { task_id: string };
    await waitForState(home, childAck.task_id, "running");

    // Child reuses parent's worktree path.
    const childStatus = JSON.parse(
      (await runCli(["status", childAck.task_id, "--json"], home)).stdout,
    ) as { worktree: string | null };
    expect(childStatus.worktree).toBe(parentWt);

    const refused = await runCli(["clean", parentAck.task_id, "--json"], home);
    expect(refused.code).toBe(2);
    const body = JSON.parse(refused.stdout) as {
      refused: boolean;
      status: string;
      error: string;
    };
    expect(body.refused).toBe(true);
    expect(body.status).toBe("refused");
    expect(body.error).toMatch(new RegExp(childAck.task_id));
    expect(body.error).toMatch(/non-terminal|in use/i);
    expect(fs.existsSync(parentWt)).toBe(true);

    // --force overrides the live-sharer refusal.
    const forced = await runCli(["clean", "--force", parentAck.task_id], home);
    expect(forced.code).toBe(0);
    expect(fs.existsSync(parentWt)).toBe(false);
  });

  it("refuses a dirty worktree without --force; --force removes it", async () => {
    const src = repo(dirtyCompleteActions());
    await runCli(["delegate", "-v", "fake", "-n", "dirt", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");
    const wt = worktreePath("t1", src);
    expect(fs.existsSync(wt)).toBe(true);

    const refused = await runCli(["clean", "t1", "--json"], home);
    expect(refused.code).toBe(2);
    const body = JSON.parse(refused.stdout) as {
      refused: boolean;
      status: string;
      error: string;
    };
    expect(body.refused).toBe(true);
    expect(body.status).toBe("refused");
    expect(body.error).toMatch(/uncommitted|untracked/i);
    expect(fs.existsSync(wt)).toBe(true);

    const forced = await runCli(["clean", "--force", "t1", "--json"], home);
    expect(forced.code).toBe(0);
    const ok = JSON.parse(forced.stdout) as { removed: boolean; status: string };
    expect(ok.removed).toBe(true);
    expect(ok.status).toBe("removed");
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("--all-terminal skips protected worktrees and reports reasons; --force removes them", async () => {
    // Dirty terminal — protected without force.
    const dirtyRepo = repo(dirtyCompleteActions());
    await runCli(["delegate", "-v", "fake", "-n", "dirty-term", "x"], home, {
      cwd: dirtyRepo,
    });
    await waitForState(home, "t1", "completed");
    const dirtyWt = worktreePath("t1", dirtyRepo);
    expect(fs.existsSync(dirtyWt)).toBe(true);

    // Clean failed terminal — safe to sweep.
    const cleanRepo = repo([
      { emit: { type: "session", session_id: "s-clean" } },
      { exit: 1 },
    ]);
    await runCli(["delegate", "-v", "fake", "-n", "clean-term", "x"], home, {
      cwd: cleanRepo,
    });
    await waitForState(home, "t2", "failed");
    const cleanWt = worktreePath("t2", cleanRepo);
    expect(fs.existsSync(cleanWt)).toBe(true);

    // Parent + live fix reattempt sharing a worktree.
    const sharedRepo = repo(
      [
        { emit: { type: "session", session_id: "sess-share" } },
        { write_file: { path: "keep.txt", contents: "x" } },
        { submit_report: REPORT },
      ],
      { ".fake-vendor.resume.json": JSON.stringify(slowFixResumeActions()) },
    );
    const parentAck = JSON.parse(
      (
        await runCli(["delegate", "-v", "fake", "-n", "share", "parent"], home, {
          cwd: sharedRepo,
        })
      ).stdout,
    ) as { task_id: string };
    await waitForState(home, parentAck.task_id, "completed");
    const sharedWt = worktreePath(parentAck.task_id, sharedRepo);
    const fix = await runCli(["fix", parentAck.task_id, "fix me"], home, {
      cwd: sharedRepo,
    });
    expect(fix.code).toBe(0);
    const childId = (JSON.parse(fix.stdout) as { task_id: string }).task_id;
    await waitForState(home, childId, "running");

    const sweep = await runCli(["clean", "--all-terminal", "--json"], home);
    expect(sweep.code).toBe(0);
    const result = JSON.parse(sweep.stdout) as {
      cleaned: { task_id: string; worktree: string }[];
      skipped: { task_id: string; worktree: string; reason: string }[];
      failed: { task_id: string; worktree: string; error: string }[];
    };

    const cleanedIds = result.cleaned.map((c) => c.task_id);
    expect(cleanedIds).toContain("t2");
    expect(fs.existsSync(cleanWt)).toBe(false);

    const skippedById = Object.fromEntries(result.skipped.map((s) => [s.task_id, s.reason]));
    expect(skippedById["t1"]).toMatch(/uncommitted|untracked/i);
    expect(skippedById[parentAck.task_id]).toMatch(new RegExp(childId));
    expect(fs.existsSync(dirtyWt)).toBe(true);
    expect(fs.existsSync(sharedWt)).toBe(true);
    expect(result.failed).toEqual([]);

    // Force sweep removes the previously protected dirty tree.
    const forced = await runCli(["clean", "--all-terminal", "--force", "--json"], home);
    expect(forced.code).toBe(0);
    const forcedResult = JSON.parse(forced.stdout) as {
      cleaned: { task_id: string }[];
      skipped: { task_id: string }[];
    };
    expect(forcedResult.skipped).toEqual([]);
    const forcedIds = forcedResult.cleaned.map((c) => c.task_id);
    expect(forcedIds).toContain("t1");
    expect(forcedIds).toContain(parentAck.task_id);
    expect(fs.existsSync(dirtyWt)).toBe(false);
    expect(fs.existsSync(sharedWt)).toBe(false);
  });

  it("identity: clean committed worktree with no live sharers removes without --force", async () => {
    // Real committed work: HEAD != base_sha, porcelain empty. Commits live on
    // the kept branch — clean must not treat that as dirty (#336).
    const src = repo([
      { emit: { type: "session", session_id: "s-id" } },
      { write_file: { path: "done.txt", contents: "committed work" } },
      { git_commit: { message: "child committed work" } },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "-n", "identity", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");
    const wt = worktreePath("t1", src);
    expect(fs.existsSync(wt)).toBe(true); // committed → auto-remove skipped
    // Sanity: tree is porcelain-clean while branch advanced past base.
    expect(git(wt, ["status", "--porcelain"])).toBe("");

    const clean = await runCli(["clean", "t1", "--json"], home);
    expect(clean.code).toBe(0);
    const body = JSON.parse(clean.stdout) as { removed: boolean; status: string };
    expect(body.removed).toBe(true);
    expect(body.status).toBe("removed");
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(src, ["branch", "--list", "parley/t1-identity"])).toContain("parley/t1-identity");
    // Branch still carries the child's commit.
    expect(git(src, ["log", "--format=%s", "parley/t1-identity"]).split("\n")[0]).toBe(
      "child committed work",
    );
  });
});
