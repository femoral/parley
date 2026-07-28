/**
 * #265 — writable fan-out must create each sibling workspace exactly once,
 * under the real task id. Never under the provisional placeholder `"pending"`.
 *
 * The step-spawn path used to resolve twice: first with taskId `"pending"`
 * (side-effecting: cuts branch + worktree), then again with the real id
 * (collides on the same branch name derived from the step address).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  getRun,
  listTasksForRun,
  openDatabase,
  type DatabaseHandle,
} from "../src/db.js";
import { TaskEngine } from "../src/engine.js";
import {
  listRunBranches,
  listRunCheckoutPaths,
  runBranchName,
  siblingBranchName,
  siblingCheckoutPath,
} from "../src/run-workspace.js";
import { makeGitRepo, withFakeAllowlist } from "./helpers.js";

let home: string;
let db: DatabaseHandle;
let engine: TaskEngine;
const scratch: string[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-265-"));
  scratch.push(home);
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(
      withFakeAllowlist({
        profiles: {
          deep: {
            vendor: "fake",
            model: "fake-model",
            effort: "medium",
            sandbox: "workspace",
          },
        },
        defaults: { profile: "deep" },
      }),
    ),
  );
  process.env.PARLEY_HOME = home;
  db = openDatabase(homePaths(home));
  engine = new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
});

afterEach(() => {
  try {
    // Cancel any live tasks so vendor children do not outlive the fixture.
    for (const t of listTasksForRun(db, getLatestRunId() ?? "")) {
      try {
        engine.cancel(t.id);
      } catch {
        /* already terminal / gone */
      }
    }
  } catch {
    /* db may already be closed */
  }
  try {
    db.close();
  } catch {
    /* already closed */
  }
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.PARLEY_HOME;
});

function getLatestRunId(): string | null {
  try {
    const row = db.prepare(`SELECT id FROM runs ORDER BY created_at DESC LIMIT 1`).get() as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Install a local-layer workflow under `{repo}/.parley/workflows/<id>`. */
function installLocalWorkflow(
  repo: string,
  id: string,
  body: Record<string, unknown>,
): void {
  const dir = path.join(repo, ".parley", "workflows", id);
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "prompts", "plan.md"), "Plan the work.\n");
  fs.writeFileSync(path.join(dir, "prompts", "a.md"), "Slot A.\n");
  fs.writeFileSync(path.join(dir, "prompts", "b.md"), "Slot B.\n");
  fs.writeFileSync(path.join(dir, "prompts", "c.md"), "Slot C.\n");
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(body, null, 2));
}

describe("writable fan-out spawn (#265)", () => {
  it("spawns two+ writable slots with isolated checkouts; no pending orphan", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);
    // Advance HEAD so sibling baseSha is a known tip.
    fs.writeFileSync(path.join(repo, "advance.txt"), "x\n");
    git(repo, ["add", "advance.txt"]);
    git(repo, ["commit", "-m", "advance"]);
    const tip = git(repo, ["rev-parse", "HEAD"]);

    const workflowId = "fan-writable";
    installLocalWorkflow(repo, workflowId, {
      id: workflowId,
      version: 1,
      type: "coding",
      workspace: "repo",
      inputs: { brief: { type: "text" } },
      // Fan-out notes collect as dict — run output type must match.
      outputs: { out: { type: "dict<string, text>", from: "plan.notes" } },
      nodes: [
        {
          id: "plan",
          kind: "step",
          task_type: "other",
          sandbox: "workspace",
          prompt: "prompts/plan.md",
          slots: {
            structure: {
              profile: "deep",
              prompt_append: "prompts/a.md",
            },
            risks: {
              profile: "deep",
              prompt_append: "prompts/b.md",
            },
            approach: {
              profile: "deep",
              prompt_append: "prompts/c.md",
            },
          },
          in: { brief: { type: "text", from: "run.brief" } },
          out: { notes: { type: "text" } },
        },
      ],
    });

    const result = engine.startRun({
      workflow: workflowId,
      flagInputs: [{ name: "brief", value: "ship it" }],
      cwd: repo,
    });

    if (result.kind !== "ok") {
      expect.fail(`startRun failed: ${JSON.stringify(result)}`);
    }

    const run = getRun(db, result.run.id)!;
    // Spawn must not block on sibling workspace creation.
    expect(run.state).toBe("running");
    expect(run.error).toBeNull();

    const tasks = listTasksForRun(db, run.id);
    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.slot).sort()).toEqual([
      "approach",
      "risks",
      "structure",
    ]);

    const paths = homePaths(home);
    const runBranch = runBranchName(run.id, run.workflow);
    const checkouts = listRunCheckoutPaths(paths.worktrees, repo, run.id);
    const branches = listRunBranches(repo, run.id);

    // No provisional checkout or branch under the placeholder id.
    expect(checkouts.some((p) => path.basename(p).endsWith("--pending"))).toBe(
      false,
    );
    expect(branches.some((b) => b.includes("pending"))).toBe(false);
    expect(
      checkouts.map((p) => path.basename(p)).filter((b) => b.includes("pending")),
    ).toEqual([]);

    // Each sibling: real task id in path, address-derived branch, tip base.
    for (const task of tasks) {
      expect(task.slot).toBeTruthy();
      expect(task.worktree).toBeNull(); // run-owned (ADR-0018)
      expect(task.branch).toBeNull();
      expect(task.base_sha).toBe(tip);

      const address = `plan.1.${task.slot}`;
      const expectedPath = siblingCheckoutPath(
        paths.worktrees,
        repo,
        run.id,
        task.id,
      );
      const expectedBranch = siblingBranchName(run.id, address);

      expect(task.cwd).toBe(expectedPath);
      expect(fs.existsSync(expectedPath)).toBe(true);
      expect(checkouts).toContain(expectedPath);
      expect(branches).toContain(expectedBranch);
      expect(git(expectedPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
        expectedBranch,
      );
      expect(git(expectedPath, ["rev-parse", "HEAD"])).toBe(tip);
      // Cut from run branch tip (includes advance commit).
      expect(fs.existsSync(path.join(expectedPath, "advance.txt"))).toBe(true);
    }

    // Run checkout remains; three isolated siblings beside it.
    expect(checkouts).toHaveLength(4);
    expect(branches).toContain(runBranch);
  });

  it("read-only fan-out siblings still share the run checkout and cut no branch", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);

    const workflowId = "fan-ro";
    installLocalWorkflow(repo, workflowId, {
      id: workflowId,
      version: 1,
      type: "coding",
      workspace: "repo",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "dict<string, text>", from: "review.notes" } },
      nodes: [
        {
          id: "review",
          kind: "step",
          task_type: "review",
          sandbox: "read-only",
          prompt: "prompts/plan.md",
          slots: {
            a: { profile: "deep", prompt_append: "prompts/a.md" },
            b: { profile: "deep", prompt_append: "prompts/b.md" },
          },
          in: { brief: { type: "text", from: "run.brief" } },
          out: { notes: { type: "text" } },
        },
      ],
    });

    const result = engine.startRun({
      workflow: workflowId,
      flagInputs: [{ name: "brief", value: "review" }],
      cwd: repo,
    });
    if (result.kind !== "ok") {
      expect.fail(`startRun failed: ${JSON.stringify(result)}`);
    }

    const run = getRun(db, result.run.id)!;
    expect(run.state).toBe("running");

    const paths = homePaths(home);
    const tasks = listTasksForRun(db, run.id);
    expect(tasks).toHaveLength(2);

    const checkouts = listRunCheckoutPaths(paths.worktrees, repo, run.id);
    // Only the run checkout — no sibling trees.
    expect(checkouts).toHaveLength(1);
    const runCheckout = checkouts[0]!;
    for (const task of tasks) {
      expect(task.cwd).toBe(runCheckout);
      expect(task.worktree).toBeNull();
      expect(task.branch).toBeNull();
    }
    // Only the run branch; no address branches.
    const branches = listRunBranches(repo, run.id);
    expect(branches).toEqual([runBranchName(run.id, run.workflow)]);
    expect(checkouts.some((p) => path.basename(p).includes("pending"))).toBe(
      false,
    );
  });

  it("linear writable step uses the run checkout (no sibling branch)", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    scratch.push(repo);

    const workflowId = "linear-w";
    installLocalWorkflow(repo, workflowId, {
      id: workflowId,
      version: 1,
      type: "coding",
      workspace: "repo",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "plan.plan" } },
      nodes: [
        {
          id: "plan",
          kind: "step",
          task_type: "other",
          sandbox: "workspace",
          prompt: "prompts/plan.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { plan: { type: "text" } },
        },
      ],
    });

    const result = engine.startRun({
      workflow: workflowId,
      flagInputs: [{ name: "brief", value: "one step" }],
      cwd: repo,
    });
    if (result.kind !== "ok") {
      expect.fail(`startRun failed: ${JSON.stringify(result)}`);
    }

    const run = getRun(db, result.run.id)!;
    const tasks = listTasksForRun(db, run.id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;

    const paths = homePaths(home);
    const checkouts = listRunCheckoutPaths(paths.worktrees, repo, run.id);
    expect(checkouts).toHaveLength(1);
    expect(task.cwd).toBe(checkouts[0]);
    expect(task.worktree).toBeNull();
    expect(task.branch).toBeNull();
    expect(listRunBranches(repo, run.id)).toEqual([
      runBranchName(run.id, run.workflow),
    ]);
  });
});
