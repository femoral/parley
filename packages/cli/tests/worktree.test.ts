import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanupHome,
  git,
  makeGitRepo,
  makeHome,
  runCli,
  waitFor,
  waitForState,
  watchJson,
  writeFiles,
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

/** A well-behaved run that touches nothing in the worktree. */
function happyActions(): FakeVendorAction[] {
  return [
    { emit: { type: "session", session_id: "sess-1" } },
    { submit_report: REPORT },
  ];
}

function repo(actions: FakeVendorAction[], files: Record<string, string> = {}): string {
  const dir = makeGitRepo(actions, files);
  scratch.push(dir);
  return dir;
}

/** The worktree parley creates for task `id` under a repo directory. */
function worktreePath(id: string, repoDir: string): string {
  return path.join(home, "worktrees", path.basename(repoDir), id);
}

describe("delegate creates an isolated worktree (default, no --cwd)", () => {
  it("cuts a worktree + branch from HEAD; child runs in it; envelope carries both", async () => {
    // Touch a file so auto-remove does not reclaim the worktree before
    // completed + auto-remove both land at stream close (#72).
    const src = repo([
      { write_file: { path: "keep.txt", contents: "x" } },
      { submit_report: REPORT },
    ]);
    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "fix-auth", "do it"],
      home,
      { cwd: src },
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    await waitForState(home, "t1", "completed");
    const env = (await watchJson(home, ["t1"])).task!;
    expect(env.state).toBe("completed");
    expect(env.repo).toBe(git(src, ["rev-parse", "--show-toplevel"]));
    expect(env.branch).toBe("parley/t1-fix-auth");
    expect(env.worktree).toBe(worktreePath("t1", src));

    // The branch exists in the source repo and started at the repo's HEAD.
    const branches = git(src, ["branch", "--list", "parley/t1-fix-auth"]);
    expect(branches).toContain("parley/t1-fix-auth");
    expect(git(src, ["rev-parse", "parley/t1-fix-auth"])).toBe(git(src, ["rev-parse", "HEAD"]));
  });

  it("respects --base-ref: the worktree branches from the named ref, not HEAD", async () => {
    const src = repo(happyActions());
    const base = git(src, ["rev-parse", "HEAD"]);
    // Advance HEAD past the base commit.
    writeFiles(src, { "later.txt": "second" });
    git(src, ["add", "-A"]);
    git(src, ["commit", "-m", "second"]);
    const head = git(src, ["rev-parse", "HEAD"]);
    expect(head).not.toBe(base);

    await runCli(["delegate", "-v", "fake", "-n", "b", "--base-ref", base, "x"], home, {
      cwd: src,
    });
    await waitForState(home, "t1", "completed");

    expect(git(src, ["rev-parse", "parley/t1-b"])).toBe(base);
  });

  it("errors (exit 2) when delegating outside a git repo without --cwd", async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "parley-plain-"));
    scratch.push(notRepo);
    const result = await runCli(["delegate", "-v", "fake", "x"], home, { cwd: notRepo });

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/git repositor/i);
  });
});

describe("config translation and git hygiene", () => {
  it("symlinks the canonical AGENTS.md surface and keeps it out of git", async () => {
    // The child writes a file so the worktree is retained (untouched ones are
    // auto-removed), letting us inspect the translated surface after completion.
    const src = repo([{ write_file: { path: "keep.txt", contents: "x" } }, { submit_report: REPORT }], {
      "CLAUDE.md": "# project rules\n",
      ".claude/skills/demo/SKILL.md": "skill body\n",
    });
    await runCli(["delegate", "-v", "fake", "-n", "t", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");
    const wt = worktreePath("t1", src);
    expect(fs.existsSync(wt)).toBe(true);

    expect(fs.lstatSync(path.join(wt, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(wt, "AGENTS.md"))).toBe("CLAUDE.md");
    expect(fs.readFileSync(path.join(wt, "AGENTS.md"), "utf8")).toBe("# project rules\n");
    expect(fs.lstatSync(path.join(wt, ".agents", "skills")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(wt, ".agents", "skills", "demo", "SKILL.md"), "utf8")).toBe(
      "skill body\n",
    );

    // The generated symlinks never show up in `git status` (local exclude), so
    // the only dirty entry is the file the child deliberately wrote.
    const status = git(wt, ["status", "--porcelain"]);
    expect(status).toContain("keep.txt");
    expect(status).not.toContain("AGENTS.md");
    expect(status).not.toContain(".agents");

    // The exclusion is scoped to the parley worktree only: a real AGENTS.md
    // created later in the SOURCE repo must still be visible to git there (a
    // shared info/exclude entry would have silently ignored it).
    writeFiles(src, { "AGENTS.md": "user's own new file\n" });
    expect(git(src, ["status", "--porcelain"])).toContain("AGENTS.md");
  });

  it("skips translation when the repo already tracks AGENTS.md / .agents", async () => {
    const src = repo([{ write_file: { path: "keep.txt", contents: "x" } }, { submit_report: REPORT }], {
      "CLAUDE.md": "# claude\n",
      "AGENTS.md": "# the repo's own agents file\n",
      ".claude/skills/demo/SKILL.md": "s\n",
      ".agents/keep.md": "repo owns .agents\n",
    });
    await runCli(["delegate", "-v", "fake", "-n", "t", "x"], home, { cwd: src });
    await waitForState(home, "t1", "completed");

    const wt = worktreePath("t1", src);
    expect(fs.existsSync(wt)).toBe(true);
    // AGENTS.md is the repo's committed regular file, not a parley symlink.
    expect(fs.lstatSync(path.join(wt, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(wt, "AGENTS.md"), "utf8")).toBe("# the repo's own agents file\n");
    // No skills symlink was planted under the repo-owned .agents dir.
    expect(fs.existsSync(path.join(wt, ".agents", "skills"))).toBe(false);
    // Worktree stays clean of plumbing.
    const status = git(wt, ["status", "--porcelain"]);
    expect(status).not.toContain("AGENTS.md");
  });
});

describe("worktree lifecycle on completion", () => {
  it("auto-removes an untouched worktree; branch is kept", async () => {
    const src = repo(happyActions());
    await runCli(["delegate", "-v", "fake", "-n", "clean", "x"], home, { cwd: src });

    const wt = worktreePath("t1", src);
    await waitFor(() => !fs.existsSync(wt), "untouched worktree auto-removed");
    // The branch survives even though the worktree is gone.
    expect(git(src, ["branch", "--list", "parley/t1-clean"])).toContain("parley/t1-clean");

    // Status reflects the removal: worktree null.
    const row = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout);
    expect(row.worktree).toBeNull();
  });

  it("retains a modified worktree and the child's commits survive", async () => {
    const src = repo([
      { write_file: { path: "src/new.ts", contents: "export const x = 1;\n" } },
      { git_commit: { message: "child work" } },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "-n", "work", "x"], home, { cwd: src });

    // Give the completion path time to run its (no-op) retention check.
    await waitForState(home, "t1", "completed");
    const wt = worktreePath("t1", src);
    // Retained: still present, still non-null in status.
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(wt)).toBe(true);
    const row = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout);
    expect(row.worktree).toBe(wt);

    // The child's commit lives on the branch, past the base commit.
    const log = git(src, ["log", "--format=%s", "parley/t1-work"]);
    expect(log.split("\n")[0]).toBe("child work");
  });
});

describe("parley clean", () => {
  it("removes a terminal task's clean worktree but keeps its branch", async () => {
    // Committed work (porcelain empty, HEAD advanced) — auto-remove retains;
    // clean must still remove without --force (#336 porcelain-only dirty).
    const src = repo([
      { write_file: { path: "keep.txt", contents: "x" } },
      { git_commit: { message: "child work" } },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "-n", "keep", "x"], home, { cwd: src });
    const wt = worktreePath("t1", src);
    await waitForState(home, "t1", "completed");
    expect(fs.existsSync(wt)).toBe(true);

    const clean = await runCli(["clean", "t1"], home);
    expect(clean.code).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    // Branch kept with the child's commit.
    expect(git(src, ["branch", "--list", "parley/t1-keep"])).toContain("parley/t1-keep");
    expect(git(src, ["log", "--format=%s", "parley/t1-keep"]).split("\n")[0]).toBe("child work");
  });

  it("refuses a dirty worktree without --force; --force removes it", async () => {
    const src = repo([
      { write_file: { path: "dirty.txt", contents: "x" } },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "-n", "dirty", "x"], home, { cwd: src });
    const wt = worktreePath("t1", src);
    await waitForState(home, "t1", "completed");
    expect(fs.existsSync(wt)).toBe(true); // dirty → retained

    const refused = await runCli(["clean", "t1"], home);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/uncommitted|untracked/i);
    expect(fs.existsSync(wt)).toBe(true);

    const forced = await runCli(["clean", "--force", "t1"], home);
    expect(forced.code).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(src, ["branch", "--list", "parley/t1-dirty"])).toContain("parley/t1-dirty");
  });

  it("refuses to clean a task that is still running (exit 2)", async () => {
    const src = repo([{ sleep: 2000 }, ...happyActions()]);
    const ack = JSON.parse(
      (await runCli(["delegate", "-v", "fake", "-n", "slow", "run"], home, { cwd: src })).stdout,
    );
    await waitForState(home, ack.task_id, "running");

    const clean = await runCli(["clean", ack.task_id], home);
    expect(clean.code).toBe(2);
    expect(clean.stderr).toMatch(/running/);
    // Worktree untouched by the refused clean.
    expect(fs.existsSync(worktreePath(ack.task_id, src))).toBe(true);
  });

  it("--all-terminal sweeps terminal tasks only, leaving running ones", async () => {
    // A finished clean-failed task (retained; not dirty so sweep does not skip).
    const doneRepo = repo([
      { emit: { type: "session", session_id: "s-done" } },
      { exit: 1 },
    ]);
    await runCli(["delegate", "-v", "fake", "-n", "done", "x"], home, { cwd: doneRepo });
    await waitForState(home, "t1", "failed");
    const doneWt = worktreePath("t1", doneRepo);
    expect(fs.existsSync(doneWt)).toBe(true);

    // A still-running task.
    const liveRepo = repo([{ sleep: 3000 }, ...happyActions()]);
    await runCli(["delegate", "-v", "fake", "-n", "live", "run"], home, { cwd: liveRepo });
    await waitForState(home, "t2", "running");
    const liveWt = worktreePath("t2", liveRepo);

    const sweep = await runCli(["clean", "--all-terminal"], home);
    expect(sweep.code).toBe(0);

    expect(fs.existsSync(doneWt)).toBe(false); // terminal → swept
    expect(fs.existsSync(liveWt)).toBe(true); // running → untouched
  });
});

describe("--cwd still bypasses worktree creation", () => {
  it("runs the child directly in --cwd; no worktree, repo is the cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-cwd-"));
    scratch.push(dir);
    fs.writeFileSync(path.join(dir, ".fake-vendor.json"), JSON.stringify(happyActions()));

    const result = await runCli(["delegate", "-v", "fake", "--cwd", dir, "x"], home);
    expect(result.code).toBe(0);
    await waitForState(home, "t1", "completed");
    const env = (await watchJson(home, ["t1"])).task!;
    expect(env.repo).toBe(dir);
    expect(env.worktree).toBeNull();
    expect(env.branch).toBeNull();
    // Nothing created under the parley worktrees dir.
    expect(fs.existsSync(path.join(home, "worktrees"))).toBe(false);
  });
});
