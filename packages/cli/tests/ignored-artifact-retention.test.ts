/**
 * #401 — a completed report-only task whose entire product is a gitignored
 * draft keeps its worktree.
 *
 * `git status --porcelain` never lists ignored files, so such a worktree used
 * to read as untouched: auto-remove reclaimed it (silently, and before the
 * orchestrator could read it) while the task's own report still pointed at the
 * vanished paths. End-to-end coverage of the retain branch, its diagnostic,
 * and the matching `parley clean` refusal.
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
  waitFor,
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

/** The report a review-only task hands back: a summary, no declared files. */
const THIN_REPORT = { summary: "reviewed", outcome: "success", files_changed: [] as string[] };

/** Child writes only a gitignored draft, and never declares it. */
function draftOnlyActions(): FakeVendorAction[] {
  return [
    { write_file: { path: "out/DRAFT.md", contents: "the full 1350-line draft\n" } },
    { submit_report: THIN_REPORT },
  ];
}

function repo(actions: FakeVendorAction[], files: Record<string, string> = {}): string {
  const dir = makeGitRepo(actions, files);
  scratch.push(dir);
  return dir;
}

function worktreePath(id: string, repoDir: string): string {
  return path.join(home, "worktrees", path.basename(repoDir), id);
}

function taskDiag(id: string): string {
  const diagPath = path.join(home, "tasks", id, "diag.log");
  return fs.existsSync(diagPath) ? fs.readFileSync(diagPath, "utf8") : "";
}

describe("ignored-artifact retention (#401)", () => {
  it("retains a completed worktree whose only product is an undeclared gitignored draft", async () => {
    const src = repo(draftOnlyActions(), { ".gitignore": "out/\n" });
    await runCli(["delegate", "-v", "fake", "-n", "review", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");

    const wt = worktreePath("t1", src);
    // Auto-remove runs on child exit; give it the chance to (wrongly) fire.
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.readFileSync(path.join(wt, "out", "DRAFT.md"), "utf8")).toContain("1350-line");

    // The row still points the orchestrator at the artifact.
    const row = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout) as {
      worktree: string | null;
      cwd: string | null;
      report: { files_changed: string[] } | null;
    };
    expect(row.worktree).toBe(wt);
    expect(row.cwd).toBe(wt);
    // Retention does not depend on the report declaring the file.
    expect(row.report?.files_changed).toEqual([]);

    // Auto-remove is no longer silent about what it kept.
    await waitFor(() => /ignored/i.test(taskDiag("t1")), "retention diagnostic written");
    const diag = taskDiag("t1");
    expect(diag).toMatch(/worktree/i);
    expect(diag).toContain("out/");
  });

  it("still auto-removes a plumbing-only worktree when the repo gitignores .parley", async () => {
    // `.parley/` is ignored by both the repo's .gitignore and parley's own
    // worktree exclude file; git attributes such a path to .gitignore, so
    // source attribution alone would read parley's task context as the
    // child's work and retain every worktree in this repo forever.
    const src = repo([{ submit_report: THIN_REPORT }], { ".gitignore": ".parley/\n" });
    await runCli(["delegate", "-v", "fake", "-n", "plumbing", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");

    const wt = worktreePath("t1", src);
    await waitFor(() => !fs.existsSync(wt), "plumbing-only worktree auto-removed");
    const row = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout);
    expect(row.worktree).toBeNull();
    // Branch survives as always.
    expect(git(src, ["branch", "--list", "parley/t1-plumbing"])).toContain("parley/t1-plumbing");
  });

  it("refuses `clean` on a draft-only worktree with a reason; --force removes it", async () => {
    const src = repo(draftOnlyActions(), { ".gitignore": "out/\n" });
    await runCli(["delegate", "-v", "fake", "-n", "draft", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");
    const wt = worktreePath("t1", src);

    const refused = await runCli(["clean", "t1"], home);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/ignored/i);
    expect(refused.stderr).toContain("out/");
    expect(refused.stderr).toMatch(/--force/);
    expect(fs.existsSync(wt)).toBe(true);

    const forced = await runCli(["clean", "--force", "t1"], home);
    expect(forced.code).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("skips a draft-only worktree in `clean --all-terminal`, with a reason", async () => {
    const src = repo(draftOnlyActions(), { ".gitignore": "out/\n" });
    await runCli(["delegate", "-v", "fake", "-n", "draft", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");
    const wt = worktreePath("t1", src);

    const sweep = await runCli(["clean", "--all-terminal", "--json"], home);
    expect(sweep.code).toBe(0);
    const result = JSON.parse(sweep.stdout) as {
      cleaned: { task_id: string }[];
      skipped: { task_id: string; reason: string }[];
    };
    expect(result.cleaned).toEqual([]);
    expect(result.skipped.map((s) => s.task_id)).toEqual(["t1"]);
    expect(result.skipped[0]?.reason).toMatch(/ignored/i);
    expect(fs.existsSync(wt)).toBe(true);
  });
});
