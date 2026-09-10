/**
 * Child-authored ignored artifacts (#401).
 *
 * A report-only task whose entire product is a gitignored draft used to read as
 * an untouched worktree (`git status --porcelain` never lists ignored files),
 * so auto-remove reclaimed it and the report's own paths pointed at nothing.
 * These tests pin the discriminator: an ignored entry counts as the child's
 * work unless it is parley's own plumbing, decided on two legs — known parley
 * exclude entries (leg 1) and exclude-source attribution (leg 2).
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  childAuthoredIgnoredPaths,
  createWorktree,
  excludeMaterializedFiles,
  isWorktreeModified,
  parleyExcludedPaths,
  worktreeDirt,
} from "../src/worktree.js";
import { makeGitRepo, writeFiles } from "./helpers.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

/** A parley worktree cut from `repo`, plumbing excluded as in production. */
function worktree(repo: string, taskId = "t1"): { path: string; baseSha: string } {
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-wts-"));
  temps.push(worktreesDir);
  const info = createWorktree({ repoRoot: repo, worktreesDir, taskId, name: "draft", baseRef: null });
  return { path: info.path, baseSha: info.baseSha };
}

function repoWith(files: Record<string, string>): string {
  const dir = makeGitRepo(files);
  temps.push(dir);
  return dir;
}

describe("childAuthoredIgnoredPaths (#401)", () => {
  it("reports a repo-gitignored draft the child wrote", () => {
    const repo = repoWith({ ".gitignore": "out/\n", "README.md": "hi\n" });
    const wt = worktree(repo);
    writeFiles(wt.path, { "out/DRAFT.md": "the full draft\n" });

    expect(childAuthoredIgnoredPaths(wt.path)).toEqual(["out/"]);
    expect(worktreeDirt(wt.path).reason).toBe("ignored-artifacts");
    expect(isWorktreeModified(wt.path, wt.baseSha)).toBe(true);
  });

  it("ignores parley plumbing registered in the worktree exclude file", () => {
    const repo = repoWith({ "CLAUDE.md": "# rules\n", "README.md": "hi\n" });
    const wt = worktree(repo);
    // `.parley/` (task context) is registered by finalizeWorktree; a vendor
    // config file is registered the way the engine registers one before spawn.
    writeFiles(wt.path, { ".parley/TASK.md": "brief\n", ".grok/config.toml": "x = 1\n" });
    excludeMaterializedFiles(wt.path, [".grok/config.toml"]);

    expect(childAuthoredIgnoredPaths(wt.path)).toEqual([]);
    expect(worktreeDirt(wt.path).dirty).toBe(false);
    expect(isWorktreeModified(wt.path, wt.baseSha)).toBe(false);
  });

  it("still reads plumbing as plumbing when the repo's own .gitignore covers it", () => {
    // Leg 1 (known parley paths) carries this case: git attributes a path
    // ignored by both files to `.gitignore`, so source attribution alone would
    // call parley's own vendor config the child's work.
    const repo = repoWith({ ".gitignore": ".grok/\n", "README.md": "hi\n" });
    const wt = worktree(repo);
    writeFiles(wt.path, { ".grok/config.toml": "x = 1\n" });
    excludeMaterializedFiles(wt.path, [".grok/config.toml"]);

    expect(childAuthoredIgnoredPaths(wt.path)).toEqual([]);
    expect(isWorktreeModified(wt.path, wt.baseSha)).toBe(false);
  });

  it("separates the child's draft from plumbing in the same worktree", () => {
    const repo = repoWith({ ".gitignore": "out/\n.grok/\n", "README.md": "hi\n" });
    const wt = worktree(repo);
    writeFiles(wt.path, {
      "out/DRAFT.md": "draft\n",
      ".grok/config.toml": "x = 1\n",
      ".parley/TASK.md": "brief\n",
    });
    excludeMaterializedFiles(wt.path, [".grok/config.toml"]);

    expect(childAuthoredIgnoredPaths(wt.path)).toEqual(["out/"]);
  });

  it("finds the child's file next to plumbing inside one collapsed ignored dir", () => {
    // The repo gitignores the whole vendor dir, so `git status --ignored`
    // reports `!! .grok/` and hides both files behind one entry. Parley
    // registers only its own config there: the child's note is still the
    // child's work, and auto-removing on the collapsed entry would destroy it.
    const repo = repoWith({ ".gitignore": ".grok/\n", "README.md": "hi\n" });
    const wt = worktree(repo);
    writeFiles(wt.path, { ".grok/config.toml": "x = 1\n", ".grok/NOTES.md": "child notes\n" });
    excludeMaterializedFiles(wt.path, [".grok/config.toml"]);

    expect(childAuthoredIgnoredPaths(wt.path)).toEqual([".grok/NOTES.md"]);
    expect(isWorktreeModified(wt.path, wt.baseSha)).toBe(true);
  });

  it("counts the run cross-step handoff as the child's work, not plumbing", () => {
    // `.parley/tmp/<address>/out` is the child's output surface (ADR-0018),
    // even though `/.parley/` is a parley exclude entry.
    const repo = repoWith({ "README.md": "hi\n" });
    const wt = worktree(repo);
    writeFiles(wt.path, {
      ".parley/TASK.md": "brief\n",
      ".parley/tmp/review.1/TASK.md": "step brief\n",
      ".parley/tmp/review.1/in/spec": "input\n",
      ".parley/tmp/review.1/out/result.json": "{}\n",
    });

    // Only `out/` is the child's: the step brief and the materialized inputs
    // under the same tmp dir are parley's own writes.
    expect(childAuthoredIgnoredPaths(wt.path)).toEqual([
      ".parley/tmp/review.1/out/result.json",
    ]);
    expect(isWorktreeModified(wt.path, wt.baseSha)).toBe(true);
  });

  it("does not count a step brief or materialized inputs as the child's work", () => {
    const repo = repoWith({ "README.md": "hi\n" });
    const wt = worktree(repo);
    writeFiles(wt.path, {
      ".parley/TASK.md": "brief\n",
      ".parley/tmp/impl.1/TASK.md": "step brief\n",
      ".parley/tmp/impl.1/in/spec": "input\n",
    });

    expect(childAuthoredIgnoredPaths(wt.path)).toEqual([]);
    expect(isWorktreeModified(wt.path, wt.baseSha)).toBe(false);
  });

  it("reports nothing for a worktree the child never wrote to", () => {
    const repo = repoWith({ "README.md": "hi\n" });
    const wt = worktree(repo);

    expect(childAuthoredIgnoredPaths(wt.path)).toEqual([]);
    expect(isWorktreeModified(wt.path, wt.baseSha)).toBe(false);
  });

  it("reads parley's own exclude registrations back (leg 1's source of truth)", () => {
    // Leg 1 compares against whatever the registration functions wrote. If the
    // exclude file's name or format drifts, this reader silently returns
    // nothing and every worktree in a repo with a vendor-covering .gitignore
    // is retained forever — so pin the round trip.
    const repo = repoWith({ "CLAUDE.md": "# rules\n", ".claude/skills/demo/SKILL.md": "s\n" });
    const wt = worktree(repo);
    excludeMaterializedFiles(wt.path, [".grok/config.toml"]);

    expect(parleyExcludedPaths(wt.path).sort()).toEqual(
      [".agents", ".grok/config.toml", ".parley", "AGENTS.md"].sort(),
    );
  });

  it("errs toward keeping the child's work when git fails", () => {
    const gone = path.join(os.tmpdir(), "parley-no-such-worktree-401");
    expect(() => childAuthoredIgnoredPaths(gone)).toThrow();
    expect(worktreeDirt(gone)).toMatchObject({ dirty: true, reason: "error" });
    expect(isWorktreeModified(gone, "0".repeat(40))).toBe(true);
  });
});
