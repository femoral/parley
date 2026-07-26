/**
 * #234 — run workspaces, repo mode (ADR-0018).
 *
 * Callable workspace units only: create, isolate, checkpoint, tmp handoff,
 * clean, terminal retention. No run engine.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatStepAddress } from "@useparley/core";
import {
  CHECKPOINT_AUTHOR,
  checkpointCommit,
  cleanRunCheckouts,
  createRunCheckout,
  createSiblingCheckout,
  ensureTmpHandoff,
  findChildHubOnDisk,
  isBranchProvablyEmpty,
  listRunBranches,
  listRunCheckoutPaths,
  materializeStepChildHub,
  materializeStepContext,
  needsIsolatedCheckout,
  pruneEmptyRunBranches,
  resolveStepWorkspace,
  retainRunCheckoutsAtTerminal,
  runBranchName,
  runCheckoutPath,
  SharedWorkspaceChildHubError,
  siblingBranchName,
  siblingCheckoutPath,
} from "../src/run-workspace.js";
import { isWorktreeModified, repoRoot } from "../src/worktree.js";
import { makeGitRepo } from "./helpers.js";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeHome(): { home: string; worktrees: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-run-ws-"));
  scratch.push(home);
  const worktrees = path.join(home, "worktrees");
  fs.mkdirSync(worktrees, { recursive: true });
  return { home, worktrees };
}

describe("naming (paths carry id, branches carry address)", () => {
  it("requires -<workflow> on the run branch (ref cannot also be a directory)", () => {
    expect(runBranchName("r1", "coding-2")).toBe("parley/r1-coding-2");
    // Sibling lives under parley/r1/… — without the suffix, the run ref would
    // collide with that directory namespace.
    expect(siblingBranchName("r1", "implement.1")).toBe("parley/r1/implement.1");
    expect(runBranchName("r1", "coding-2")).not.toBe("parley/r1");
  });

  it("places sibling checkouts beside the run checkout (worktrees cannot nest)", () => {
    const { worktrees } = makeHome();
    const repo = "/tmp/some-repo";
    const runPath = runCheckoutPath(worktrees, repo, "r3");
    const sibPath = siblingCheckoutPath(worktrees, repo, "r3", "t9");
    expect(path.dirname(runPath)).toBe(path.dirname(sibPath));
    expect(path.basename(runPath)).toBe("r3");
    expect(path.basename(sibPath)).toBe("r3--t9");
    expect(sibPath.startsWith(runPath + path.sep)).toBe(false);
  });

  it("retries append -r<n> on the address and thus the sibling branch", () => {
    const addr = formatStepAddress({
      node: "implement",
      iteration: 1,
      retry: 2,
    });
    expect(addr).toBe("implement.1-r2");
    expect(siblingBranchName("r1", addr)).toBe("parley/r1/implement.1-r2");
  });
});

describe("createRunCheckout", () => {
  it("creates a worktree on parley/<runId>-<workflow> from HEAD", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();

    const info = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r1",
      workflow: "coding-1",
    });

    expect(info.branch).toBe("parley/r1-coding-1");
    expect(fs.existsSync(info.path)).toBe(true);
    expect(repoRoot(info.path)).toBe(info.path);
    expect(git(info.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(info.branch);
    expect(git(info.path, ["rev-parse", "HEAD"])).toBe(info.baseSha);
    // .parley/ is worktree-excluded (not via .git/info/exclude).
    const exclude = path.join(
      git(info.path, ["rev-parse", "--absolute-git-dir"]),
      "parley-exclude",
    );
    expect(fs.readFileSync(exclude, "utf8")).toMatch(/\.parley/);
  });

  it("rolls back worktree + branch when finalize fails mid-flight", () => {
    // Covered implicitly by happy path + branch existence; a bad base-ref
    // fails before finalize and still leaves no half-built tree.
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    expect(() =>
      createRunCheckout({
        repoRoot: repo,
        worktreesDir: worktrees,
        runId: "r-bad",
        workflow: "coding-1",
        baseRef: "does-not-exist",
      }),
    ).toThrow();
    expect(listRunCheckoutPaths(worktrees, repo, "r-bad")).toEqual([]);
    expect(listRunBranches(repo, "r-bad")).toEqual([]);
  });
});

describe("isolation is read off the sandbox", () => {
  it("needsIsolatedCheckout is false only for read-only", () => {
    expect(needsIsolatedCheckout("read-only")).toBe(false);
    expect(needsIsolatedCheckout("workspace")).toBe(true);
    expect(needsIsolatedCheckout("full")).toBe(true);
  });

  it("linear steps always use the run checkout (even when writable)", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    const run = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r2",
      workflow: "coding-2",
    });

    const step = resolveStepWorkspace({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r2",
      runCheckoutPath: run.path,
      runBranch: run.branch,
      taskId: "t1",
      address: { node: "implement", iteration: 1 },
      sandbox: "workspace",
      fanOut: false,
    });
    expect(step.path).toBe(run.path);
    expect(step.shared).toBe(false);
    expect(step.branch).toBeNull();
    expect(listRunCheckoutPaths(worktrees, repo, "r2")).toEqual([run.path]);
  });

  it("read-only fan-out siblings share the run checkout (shared=true)", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    const run = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r3",
      workflow: "coding-2",
    });

    const a = resolveStepWorkspace({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r3",
      runCheckoutPath: run.path,
      runBranch: run.branch,
      taskId: "t1",
      address: { node: "review", iteration: 1, slot: "correctness" },
      sandbox: "read-only",
      fanOut: true,
    });
    const b = resolveStepWorkspace({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r3",
      runCheckoutPath: run.path,
      runBranch: run.branch,
      taskId: "t2",
      address: { node: "review", iteration: 1, slot: "security" },
      sandbox: "read-only",
      fanOut: true,
    });
    expect(a.path).toBe(run.path);
    expect(b.path).toBe(run.path);
    expect(a.shared).toBe(true);
    expect(b.shared).toBe(true);
    expect(a.address).toBe("review.1.correctness");
    expect(b.address).toBe("review.1.security");
  });

  it("writable fan-out siblings get isolated checkouts cut from run branch tip", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    const run = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r4",
      workflow: "coding-2",
    });
    // Advance the run branch so the cut point is visible.
    fs.writeFileSync(path.join(run.path, "advance.txt"), "x\n");
    git(run.path, ["add", "advance.txt"]);
    git(run.path, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "advance",
    ]);
    const tip = git(run.path, ["rev-parse", "HEAD"]);

    const sib = resolveStepWorkspace({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r4",
      runCheckoutPath: run.path,
      runBranch: run.branch,
      taskId: "t7",
      address: { node: "review", iteration: 1, slot: "sweep" },
      sandbox: "workspace",
      fanOut: true,
    });

    expect(sib.path).toBe(siblingCheckoutPath(worktrees, repo, "r4", "t7"));
    expect(sib.branch).toBe("parley/r4/review.1.sweep");
    expect(sib.shared).toBe(false);
    expect(sib.baseSha).toBe(tip);
    expect(git(sib.path, ["rev-parse", "HEAD"])).toBe(tip);
    expect(fs.existsSync(path.join(sib.path, "advance.txt"))).toBe(true);
    expect(listRunCheckoutPaths(worktrees, repo, "r4").sort()).toEqual(
      [run.path, sib.path].sort(),
    );
  });
});

describe("tmp handoff + step context under the address", () => {
  it("creates .parley/tmp/<address>/{in,out} and TASK.md", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    const run = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r5",
      workflow: "research",
    });
    const address = "search.1.q0";
    const paths = materializeStepContext(run.path, address, "find things", [
      { name: "notes.md", contents: "a\n" },
    ]);
    expect(fs.existsSync(paths.in)).toBe(true);
    expect(fs.existsSync(paths.out)).toBe(true);
    expect(fs.readFileSync(path.join(paths.root, "TASK.md"), "utf8")).toBe(
      "find things\n",
    );
    expect(
      fs.readFileSync(path.join(paths.root, "context", "notes.md"), "utf8"),
    ).toBe("a\n");
    // ensureTmpHandoff is idempotent.
    ensureTmpHandoff(run.path, address);
    expect(fs.existsSync(paths.in)).toBe(true);
  });
});

describe("child.json — shared checkout fails loudly", () => {
  it("does not write child.json for shared workspaces", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-shared-"));
    scratch.push(dir);
    materializeStepChildHub(dir, "http://127.0.0.1:9", "t1", true, "r9");
    expect(fs.existsSync(path.join(dir, ".parley", "child.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".parley", "shared-run-workspace"))).toBe(
      true,
    );
  });

  it("writes child.json for isolated / linear checkouts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-iso-"));
    scratch.push(dir);
    materializeStepChildHub(dir, "http://127.0.0.1:9/", "t2", false);
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, ".parley", "child.json"), "utf8"),
    );
    expect(raw).toEqual({ url: "http://127.0.0.1:9/", task_id: "t2" });
  });

  it("walk-up throws SharedWorkspaceChildHubError rather than guessing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-walk-"));
    scratch.push(dir);
    materializeStepChildHub(dir, "http://hub", "t1", true, "r42");
    // Nested cwd still walks up into the shared marker.
    const nested = path.join(dir, "src", "pkg");
    fs.mkdirSync(nested, { recursive: true });
    expect(() => findChildHubOnDisk(nested)).toThrow(SharedWorkspaceChildHubError);
    try {
      findChildHubOnDisk(nested);
    } catch (err) {
      expect(err).toBeInstanceOf(SharedWorkspaceChildHubError);
      expect((err as SharedWorkspaceChildHubError).message).toMatch(/r42/);
      expect((err as SharedWorkspaceChildHubError).message).toMatch(
        /cannot disambiguate/i,
      );
    }
  });

  it("walk-up returns child.json when present (isolated)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-walk-ok-"));
    scratch.push(dir);
    materializeStepChildHub(dir, "http://hub/", "t9", false);
    expect(findChildHubOnDisk(dir)).toEqual({ url: "http://hub", taskId: "t9" });
  });

  it("removes stale child.json when switching a path to shared", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-stale-"));
    scratch.push(dir);
    materializeStepChildHub(dir, "http://hub", "t-old", false);
    expect(fs.existsSync(path.join(dir, ".parley", "child.json"))).toBe(true);
    materializeStepChildHub(dir, "http://hub", "t-new", true, "r1");
    expect(fs.existsSync(path.join(dir, ".parley", "child.json"))).toBe(false);
    expect(() => findChildHubOnDisk(dir)).toThrow(SharedWorkspaceChildHubError);
  });
});

describe("checkpoint commits", () => {
  it("authors parley: <node>.<iteration> with fixed identity", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    const run = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r6",
      workflow: "coding-1",
    });

    fs.writeFileSync(path.join(run.path, "impl.ts"), "export {}\n");
    const result = checkpointCommit(run.path, "implement", 1);
    expect(result.committed).toBe(true);
    expect(result.message).toBe("parley: implement.1");
    expect(result.sha).toBe(git(run.path, ["rev-parse", "HEAD"]));
    expect(result.sha).not.toBe(run.baseSha);

    const log = git(run.path, [
      "log",
      "-1",
      "--format=%an<%ae>%n%s",
    ]);
    expect(log).toBe(
      `${CHECKPOINT_AUTHOR.name}<${CHECKPOINT_AUTHOR.email}>\nparley: implement.1`,
    );
    // Author is env-scoped on the commit only — never written as a
    // worktree-local user.* (parent repo may still have its own config).
    expect(() =>
      git(run.path, ["config", "--worktree", "--get", "user.email"]),
    ).toThrow();
  });

  it("skips empty-diff rather than creating an empty commit", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    const run = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r7",
      workflow: "coding-1",
    });
    const head = git(run.path, ["rev-parse", "HEAD"]);
    // Only parley plumbing under .parley/ — excluded, so nothing to commit.
    materializeStepContext(run.path, "implement.1", "brief");
    const result = checkpointCommit(run.path, "implement", 1);
    expect(result.committed).toBe(false);
    expect(result.sha).toBe(head);
    expect(git(run.path, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("checkpoints failed steps the same way (complete or failed)", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    const run = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r8",
      workflow: "coding-1",
    });
    fs.writeFileSync(path.join(run.path, "half.ts"), "broken\n");
    // Settling after failure still checkpoints so a retry does not inherit
    // the corpse uncommitted.
    const result = checkpointCommit(run.path, "implement", 2);
    expect(result.committed).toBe(true);
    expect(result.message).toBe("parley: implement.2");
  });
});

describe("nothing auto-removes at task settle; clean + terminal retention", () => {
  it("cleanRunCheckouts removes every checkout the run owns", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    const run = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r10",
      workflow: "coding-2",
    });
    const sib = createSiblingCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r10",
      runBranch: run.branch,
      taskId: "t3",
      address: "review.1.sweep",
    });
    // Dirty the sibling so "untouched" would keep it — clean still removes.
    fs.writeFileSync(path.join(sib.path, "dirty.txt"), "x\n");
    expect(isWorktreeModified(sib.path, sib.baseSha)).toBe(true);

    const result = cleanRunCheckouts({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r10",
      branchBases: {
        [run.branch]: run.baseSha,
        [sib.branch!]: sib.baseSha,
      },
    });
    expect(result.removed.sort()).toEqual([run.path, sib.path].sort());
    expect(fs.existsSync(run.path)).toBe(false);
    expect(fs.existsSync(sib.path)).toBe(false);
    // Sibling was empty of commits (tip == base) even with dirty worktree
    // removed — after worktree gone, branch tip still equals base → pruned.
    // Run branch also tip==base → pruned.
    expect(result.prunedBranches.sort()).toEqual(
      [run.branch, sib.branch!].sort(),
    );
    expect(listRunBranches(repo, "r10")).toEqual([]);
  });

  it("terminal retention keeps modified checkouts and non-empty branches", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    const run = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r11",
      workflow: "coding-1",
    });
    const untouchedSib = createSiblingCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r11",
      runBranch: run.branch,
      taskId: "t1",
      address: "review.1.a",
    });
    const dirtySib = createSiblingCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r11",
      runBranch: run.branch,
      taskId: "t2",
      address: "review.1.b",
    });
    fs.writeFileSync(path.join(dirtySib.path, "work.ts"), "x\n");
    const ck = checkpointCommit(dirtySib.path, "review", 1);
    expect(ck.committed).toBe(true);

    const result = retainRunCheckoutsAtTerminal({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r11",
      checkoutBases: {
        [run.path]: run.baseSha,
        [untouchedSib.path]: untouchedSib.baseSha,
        [dirtySib.path]: dirtySib.baseSha,
      },
      branchBases: {
        [run.branch]: run.baseSha,
        [untouchedSib.branch!]: untouchedSib.baseSha,
        [dirtySib.branch!]: dirtySib.baseSha,
      },
    });

    expect(result.removed.sort()).toEqual([run.path, untouchedSib.path].sort());
    expect(result.retained).toEqual([dirtySib.path]);
    expect(fs.existsSync(dirtySib.path)).toBe(true);
    // Dirty sibling has commits past base → kept; empty branches pruned.
    expect(result.keptBranches).toContain(dirtySib.branch!);
    expect(result.prunedBranches.sort()).toEqual(
      [run.branch, untouchedSib.branch!].sort(),
    );
  });

  it("prune only deletes tip==base branches; never invents a base", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { worktrees } = makeHome();
    const run = createRunCheckout({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r12",
      workflow: "coding-1",
    });
    // Without branchBases, nothing is pruned.
    const none = pruneEmptyRunBranches({
      repoRoot: repo,
      worktreesDir: worktrees,
      runId: "r12",
    });
    expect(none.prunedBranches).toEqual([]);
    expect(none.keptBranches).toContain(run.branch);

    expect(isBranchProvablyEmpty(repo, run.branch, run.baseSha)).toBe(true);
    // Advance past base → not empty.
    fs.writeFileSync(path.join(run.path, "x"), "1\n");
    checkpointCommit(run.path, "implement", 1);
    expect(isBranchProvablyEmpty(repo, run.branch, run.baseSha)).toBe(false);
  });
});
