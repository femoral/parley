/**
 * #235 — run workspaces, scratch mode (ADR-0018).
 *
 * Callable workspace units only: create, isolate (nested address-named
 * siblings), tmp handoff (reused), clean. No checkpoints. No auto-removal.
 * No run engine.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatStepAddress, homePaths } from "@useparley/core";
import {
  cleanRunScratch,
  createRunScratchWorkspace,
  createSiblingScratchDir,
  ensureTmpHandoff,
  listScratchSiblingPaths,
  listRunScratchPath,
  materializeStepChildHub,
  materializeStepContext,
  needsIsolatedCheckout,
  preflightRepoRun,
  preflightScratchRun,
  RepoModeRequiresRepoError,
  resolveScratchStepWorkspace,
  runScratchPath,
  ScratchBaseRefNotAllowedError,
  siblingScratchPath,
} from "../src/run-workspace.js";
import { makeGitRepo } from "./helpers.js";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): { home: string; runs: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-scratch-ws-"));
  scratch.push(home);
  const paths = homePaths(home);
  fs.mkdirSync(paths.runs, { recursive: true });
  return { home, runs: paths.runs };
}

// ---------------------------------------------------------------------------
// Naming — paths carry the address (no branch)
// ---------------------------------------------------------------------------

describe("scratch naming (paths carry address)", () => {
  it("places the run workspace at runs/<runId>", () => {
    const { runs } = makeHome();
    expect(runScratchPath(runs, "r1")).toBe(path.join(runs, "r1"));
  });

  it("nests isolated siblings under the run workspace, named by address", () => {
    const { runs } = makeHome();
    const runPath = runScratchPath(runs, "r3");
    const sibPath = siblingScratchPath(runs, "r3", "review.1.sweep");
    // Nested — unlike repo mode, where worktrees cannot nest.
    expect(sibPath.startsWith(runPath + path.sep)).toBe(true);
    expect(path.basename(sibPath)).toBe("review.1.sweep");
    // Named by address, not by task id (repo mode uses <runId>--<taskId>).
    expect(path.basename(sibPath)).not.toMatch(/^r3--/);
  });

  it("retries append -r<n> on the address and thus the sibling path", () => {
    const { runs } = makeHome();
    const addr = formatStepAddress({
      node: "search",
      iteration: 1,
      slot: "q0",
      retry: 2,
    });
    expect(addr).toBe("search.1.q0-r2");
    expect(siblingScratchPath(runs, "r1", addr)).toBe(
      path.join(runs, "r1", "search.1.q0-r2"),
    );
  });

  it("rejects path-like runIds and addresses", () => {
    const { runs } = makeHome();
    expect(() => runScratchPath(runs, "../escape")).toThrow(/invalid/i);
    expect(() => siblingScratchPath(runs, "r1", "a/b")).toThrow(/invalid/i);
    expect(() => siblingScratchPath(runs, "r1", "")).toThrow(/invalid/i);
  });
});

// ---------------------------------------------------------------------------
// Create + preflight
// ---------------------------------------------------------------------------

describe("createRunScratchWorkspace + preflight", () => {
  it("creates an empty directory with no git and records repo null", () => {
    const { runs } = makeHome();
    const info = createRunScratchWorkspace({ runsDir: runs, runId: "r1" });

    expect(info.path).toBe(path.join(runs, "r1"));
    expect(info.runId).toBe("r1");
    expect(info.repo).toBeNull();
    expect(fs.statSync(info.path).isDirectory()).toBe(true);
    // No .git — plain directory.
    expect(fs.existsSync(path.join(info.path, ".git"))).toBe(false);
    // Empty (no auto-scaffolding beyond the directory itself).
    expect(fs.readdirSync(info.path)).toEqual([]);
  });

  it("ignores an ambient git repo — still records repo null", () => {
    // ADR-0018: a scratch workflow started inside a repo ignores it.
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    const { runs } = makeHome();

    // Creating from "inside" a repo is a caller concern; the unit only ever
    // returns repo: null and never peeks at cwd.
    const info = createRunScratchWorkspace({ runsDir: runs, runId: "r-in-repo" });
    expect(info.repo).toBeNull();
    expect(fs.existsSync(path.join(info.path, ".git"))).toBe(false);
  });

  it("refuses --base / baseRef", () => {
    const { runs } = makeHome();
    expect(() =>
      createRunScratchWorkspace({
        runsDir: runs,
        runId: "r-base",
        baseRef: "main",
      }),
    ).toThrow(ScratchBaseRefNotAllowedError);
    expect(() => preflightScratchRun({ baseRef: "HEAD" })).toThrow(
      ScratchBaseRefNotAllowedError,
    );
    // Absent / null / empty is fine.
    expect(() => preflightScratchRun({})).not.toThrow();
    expect(() => preflightScratchRun({ baseRef: null })).not.toThrow();
    expect(() => preflightScratchRun({ baseRef: "" })).not.toThrow();
    // Nothing created when preflight fails.
    expect(listRunScratchPath(runs, "r-base")).toBeNull();
  });

  it("refuses a second create on the same runId", () => {
    const { runs } = makeHome();
    createRunScratchWorkspace({ runsDir: runs, runId: "r-dup" });
    expect(() =>
      createRunScratchWorkspace({ runsDir: runs, runId: "r-dup" }),
    ).toThrow(/already exists/i);
  });

  it("repo-mode preflight fails outside a repo (symmetric clause)", () => {
    expect(() => preflightRepoRun({ repoRoot: null })).toThrow(
      RepoModeRequiresRepoError,
    );
    expect(() => preflightRepoRun({ repoRoot: undefined })).toThrow(
      RepoModeRequiresRepoError,
    );
    expect(() => preflightRepoRun({ repoRoot: "" })).toThrow(
      RepoModeRequiresRepoError,
    );
    expect(() => preflightRepoRun({ repoRoot: "/some/repo" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Isolation is read off the sandbox (same rule as repo, noun = directory)
// ---------------------------------------------------------------------------

describe("scratch isolation is read off the sandbox", () => {
  it("needsIsolatedCheckout is shared with repo mode", () => {
    expect(needsIsolatedCheckout("read-only")).toBe(false);
    expect(needsIsolatedCheckout("workspace")).toBe(true);
    expect(needsIsolatedCheckout("full")).toBe(true);
  });

  it("linear steps always use the run workspace (even when writable)", () => {
    const { runs } = makeHome();
    const run = createRunScratchWorkspace({ runsDir: runs, runId: "r2" });

    const step = resolveScratchStepWorkspace({
      runsDir: runs,
      runId: "r2",
      runWorkspacePath: run.path,
      address: { node: "scope", iteration: 1 },
      sandbox: "workspace",
      fanOut: false,
    });
    expect(step.path).toBe(run.path);
    expect(step.shared).toBe(false);
    expect(step.branch).toBeNull();
    expect(step.address).toBe("scope.1");
    expect(listScratchSiblingPaths(runs, "r2")).toEqual([]);
  });

  it("read-only fan-out siblings share the run workspace (shared=true)", () => {
    const { runs } = makeHome();
    const run = createRunScratchWorkspace({ runsDir: runs, runId: "r3" });

    const a = resolveScratchStepWorkspace({
      runsDir: runs,
      runId: "r3",
      runWorkspacePath: run.path,
      address: { node: "search", iteration: 1, slot: "q0" },
      sandbox: "read-only",
      fanOut: true,
    });
    const b = resolveScratchStepWorkspace({
      runsDir: runs,
      runId: "r3",
      runWorkspacePath: run.path,
      address: { node: "search", iteration: 1, slot: "q1" },
      sandbox: "read-only",
      fanOut: true,
    });
    expect(a.path).toBe(run.path);
    expect(b.path).toBe(run.path);
    expect(a.shared).toBe(true);
    expect(b.shared).toBe(true);
    expect(a.address).toBe("search.1.q0");
    expect(b.address).toBe("search.1.q1");
    expect(listScratchSiblingPaths(runs, "r3")).toEqual([]);
  });

  it("writable fan-out siblings get empty nested directories named by address", () => {
    const { runs } = makeHome();
    const run = createRunScratchWorkspace({ runsDir: runs, runId: "r4" });
    // Pollute the run workspace so we can prove the sibling starts empty
    // (no copy from parent).
    fs.writeFileSync(path.join(run.path, "parent-only.txt"), "stay\n");

    const sib = resolveScratchStepWorkspace({
      runsDir: runs,
      runId: "r4",
      runWorkspacePath: run.path,
      address: { node: "search", iteration: 1, slot: "q0" },
      sandbox: "workspace",
      fanOut: true,
    });

    expect(sib.path).toBe(siblingScratchPath(runs, "r4", "search.1.q0"));
    expect(sib.path.startsWith(run.path + path.sep)).toBe(true);
    expect(sib.branch).toBeNull();
    expect(sib.shared).toBe(false);
    expect(sib.address).toBe("search.1.q0");
    // Starts empty — no inheritance from the run workspace.
    expect(fs.readdirSync(sib.path)).toEqual([]);
    expect(fs.existsSync(path.join(sib.path, "parent-only.txt"))).toBe(false);
    expect(listScratchSiblingPaths(runs, "r4")).toEqual([sib.path]);
  });

  it("retry address -r<n> is a fresh sibling directory", () => {
    const { runs } = makeHome();
    const run = createRunScratchWorkspace({ runsDir: runs, runId: "r5" });

    const first = resolveScratchStepWorkspace({
      runsDir: runs,
      runId: "r5",
      runWorkspacePath: run.path,
      address: { node: "search", iteration: 1, slot: "q0" },
      sandbox: "full",
      fanOut: true,
    });
    fs.writeFileSync(path.join(first.path, "half-done.md"), "wip\n");

    const retry = resolveScratchStepWorkspace({
      runsDir: runs,
      runId: "r5",
      runWorkspacePath: run.path,
      address: { node: "search", iteration: 1, slot: "q0", retry: 1 },
      sandbox: "full",
      fanOut: true,
    });

    expect(retry.address).toBe("search.1.q0-r1");
    expect(retry.path).toBe(siblingScratchPath(runs, "r5", "search.1.q0-r1"));
    expect(retry.path).not.toBe(first.path);
    // Fresh — does not inherit the failed attempt's half-finished files.
    expect(fs.readdirSync(retry.path)).toEqual([]);
    expect(fs.existsSync(path.join(first.path, "half-done.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tmp handoff stays addressed (deliberate redundancy inside per-sibling dir)
// ---------------------------------------------------------------------------

describe("scratch tmp handoff stays addressed", () => {
  it("materializes .parley/tmp/<address>/{in,out} under the run workspace", () => {
    const { runs } = makeHome();
    const run = createRunScratchWorkspace({ runsDir: runs, runId: "r6" });
    const address = "scope.1";
    const paths = materializeStepContext(run.path, address, "research brief", [
      { name: "seed.md", contents: "q\n" },
    ]);
    expect(paths.root).toBe(path.join(run.path, ".parley", "tmp", address));
    expect(fs.existsSync(paths.in)).toBe(true);
    expect(fs.existsSync(paths.out)).toBe(true);
    expect(fs.readFileSync(path.join(paths.root, "TASK.md"), "utf8")).toBe(
      "research brief\n",
    );
    expect(
      fs.readFileSync(path.join(paths.root, "context", "seed.md"), "utf8"),
    ).toBe("q\n");
  });

  it("keeps the addressed tmp layout inside an isolated sibling (redundant)", () => {
    // Deliberate: same prompt sentence in both modes even when the sibling
    // dir already encodes the address.
    const { runs } = makeHome();
    const run = createRunScratchWorkspace({ runsDir: runs, runId: "r7" });
    const address = "search.1.q0";
    const sib = createSiblingScratchDir({
      runsDir: runs,
      runId: "r7",
      address,
    });
    const paths = ensureTmpHandoff(sib.path, address);
    expect(paths.root).toBe(path.join(sib.path, ".parley", "tmp", address));
    expect(paths.root.startsWith(sib.path + path.sep)).toBe(true);
    // Address appears twice in the absolute path: once as the sibling
    // basename, once under .parley/tmp/.
    const rel = path.relative(run.path, paths.root);
    expect(rel).toBe(path.join(address, ".parley", "tmp", address));
  });
});

// ---------------------------------------------------------------------------
// No checkpoints — do not invent a commit-like mechanism
// ---------------------------------------------------------------------------

describe("scratch has no checkpoints", () => {
  it("workspace has no .git so nothing can be checkpoint-committed", () => {
    const { runs } = makeHome();
    const run = createRunScratchWorkspace({ runsDir: runs, runId: "r8" });
    const sib = createSiblingScratchDir({
      runsDir: runs,
      runId: "r8",
      address: "search.1.q0",
    });
    fs.writeFileSync(path.join(sib.path, "notes.md"), "findings\n");
    expect(fs.existsSync(path.join(run.path, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(sib.path, ".git"))).toBe(false);
    // Shared hub helpers still work (mode-independent).
    materializeStepChildHub(sib.path, "http://hub/", "t1", false);
    expect(fs.existsSync(path.join(sib.path, ".parley", "child.json"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// No auto-removal — clean is on-demand; gc owns scheduled deletion (#244)
// ---------------------------------------------------------------------------

describe("scratch: no auto-removal; clean removes the whole subtree", () => {
  it("cleanRunScratch removes the run workspace and every nested sibling", () => {
    const { runs } = makeHome();
    const run = createRunScratchWorkspace({ runsDir: runs, runId: "r10" });
    const a = createSiblingScratchDir({
      runsDir: runs,
      runId: "r10",
      address: "search.1.q0",
    });
    const b = createSiblingScratchDir({
      runsDir: runs,
      runId: "r10",
      address: "search.1.q1-r1",
    });
    // Dirty siblings still go — there is no "untouched" predicate.
    fs.writeFileSync(path.join(a.path, "dirty.txt"), "x\n");
    fs.writeFileSync(path.join(run.path, "also.txt"), "y\n");

    const result = cleanRunScratch({ runsDir: runs, runId: "r10" });
    expect(result.removed).toEqual([run.path]);
    expect(fs.existsSync(run.path)).toBe(false);
    expect(fs.existsSync(a.path)).toBe(false);
    expect(fs.existsSync(b.path)).toBe(false);
    expect(listRunScratchPath(runs, "r10")).toBeNull();
  });

  it("cleanRunScratch is a no-op when the run workspace is absent", () => {
    const { runs } = makeHome();
    expect(cleanRunScratch({ runsDir: runs, runId: "never" })).toEqual({
      removed: [],
    });
  });

  it("does not invent terminal auto-removal (gc owns deletion)", () => {
    // Contract: this module exports no retainScratch* / terminal-retention
    // helper. Leaving the dirty tree in place after "settle" is the point —
    // only cleanRunScratch and future gc (#244) delete it.
    const { runs } = makeHome();
    const run = createRunScratchWorkspace({ runsDir: runs, runId: "r11" });
    const sib = createSiblingScratchDir({
      runsDir: runs,
      runId: "r11",
      address: "search.1.q0",
    });
    fs.writeFileSync(path.join(sib.path, "product.md"), "keep me\n");
    // Simulate "step settled" with no further calls — tree must survive.
    expect(fs.existsSync(run.path)).toBe(true);
    expect(fs.readFileSync(path.join(sib.path, "product.md"), "utf8")).toBe(
      "keep me\n",
    );
  });
});
