/**
 * #381 — a run snapshots its definition at start so advance does not re-resolve
 * from the daemon's own cwd (typically `~/.parley`, which has no workflows).
 *
 * Load-bearing: a real detached daemon whose cwd cannot see the authoring
 * directory, plus a two-step scratch workflow under the *client* cwd.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanupHome,
  makeHome,
  runCli,
  withFakeAllowlist,
  writeFiles,
} from "./helpers.js";

const homes: string[] = [];
const temps: string[] = [];

afterEach(() => {
  for (const h of homes.splice(0)) cleanupHome(h);
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function home(): string {
  const h = makeHome();
  homes.push(h);
  fs.writeFileSync(
    path.join(h, "parley.json"),
    JSON.stringify(
      withFakeAllowlist({
        profiles: {
          deep: {
            vendor: "fake",
            model: "fake-model",
            effort: "medium",
          },
        },
        defaults: { profile: "deep" },
      }),
    ),
  );
  return h;
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Two chained step nodes, `workspace: scratch`. Same out-port name so one
 * fake-vendor script completes both. */
function chainWorkflow(id = "chain"): Record<string, unknown> {
  return {
    id,
    version: 1,
    type: "other",
    workspace: "scratch",
    inputs: { brief: { type: "text" } },
    outputs: { report: { type: "text", from: "second.report" } },
    nodes: [
      {
        id: "first",
        kind: "step",
        profile: "deep",
        prompt: "prompts/first.md",
        in: { brief: { type: "text", from: "run.brief" } },
        out: { report: { type: "text" } },
      },
      {
        id: "second",
        kind: "step",
        profile: "deep",
        prompt: "prompts/second.md",
        in: { prev: { type: "text", from: "first.report" } },
        out: { report: { type: "text" } },
      },
    ],
  };
}

/** Local-layer workflow under `{dir}/.parley/workflows/<id>`. Git-init so
 * findRepoRoot does not walk into a parent `/tmp/.git`. */
function installClientWorkflow(
  dir: string,
  id: string,
  body: Record<string, unknown>,
  prompts: Record<string, string> = {},
): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  const wfDir = path.join(dir, ".parley", "workflows", id);
  writeFiles(wfDir, {
    "workflow.json": JSON.stringify(body, null, 2),
    "prompts/first.md": "FIRST-NODE-PROMPT\n",
    "prompts/second.md": "SECOND-NODE-PROMPT\n",
    ...prompts,
  });
}

const VENDOR_SCRIPT = [
  { submit_report: { report: "from-step" } },
];

/**
 * Scratch workspaces start empty. Write `.fake-vendor.json` into each new
 * `runs/<id>/` as soon as it appears so the first spawn finds a script.
 */
function seedScratchVendorScripts(parleyHome: string): () => void {
  const runsDir = path.join(parleyHome, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const payload = JSON.stringify(VENDOR_SCRIPT);
  const write = (): void => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(runsDir);
    } catch {
      return;
    }
    for (const name of names) {
      const dest = path.join(runsDir, name, ".fake-vendor.json");
      try {
        if (!fs.statSync(path.join(runsDir, name)).isDirectory()) continue;
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, payload);
      } catch {
        /* mkdir race */
      }
    }
  };
  const timer = setInterval(write, 10);
  const watcher = fs.watch(runsDir, write);
  write();
  return () => {
    clearInterval(timer);
    watcher.close();
  };
}

async function startDetachedDaemon(parleyHome: string): Promise<void> {
  // Daemon cwd is the home — no local workflows live there.
  const res = await runCli(["daemon", "start"], parleyHome, { cwd: parleyHome });
  expect(res.code, res.stderr).toBe(0);
}

async function startChainRun(
  parleyHome: string,
  clientDir: string,
  id = "chain",
): Promise<{ run_id: string; state: string }> {
  const res = await runCli(
    ["run", "start", id, "--input", "brief=hello", "--json"],
    parleyHome,
    { cwd: clientDir },
  );
  expect(res.code, `${res.stderr}\n${res.stdout}`).toBe(0);
  return JSON.parse(res.stdout) as { run_id: string; state: string };
}

async function runStatusJson(
  parleyHome: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const res = await runCli(["run", "status", runId, "--json"], parleyHome, {
    cwd: parleyHome,
  });
  if (res.code !== 0) {
    throw new Error(`run status failed: ${res.stderr}\n${res.stdout}`);
  }
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

async function waitForRunState(
  parleyHome: string,
  runId: string,
  state: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> | null = null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      last = await runStatusJson(parleyHome, runId);
      const run = last.run as { state?: string } | undefined;
      if (run?.state === state) return last;
    } catch {
      /* status not ready */
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `run ${runId} did not reach ${state} within ${timeoutMs}ms ` +
          `(last: ${JSON.stringify(last)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("run definition snapshot (#381)", () => {
  it("advances a scratch run to completed when the daemon cwd cannot see the workflow", async () => {
    const parleyHome = home();
    const clientDir = tmpDir("parley-381-client-");
    installClientWorkflow(clientDir, "chain", chainWorkflow());

    await startDetachedDaemon(parleyHome);
    const stopSeed = seedScratchVendorScripts(parleyHome);
    try {
      const ack = await startChainRun(parleyHome, clientDir);
      expect(ack.run_id).toMatch(/^r\d+$/);
      const detail = await waitForRunState(parleyHome, ack.run_id, "completed");
      const run = detail.run as {
        state: string;
        current_node: string | null;
        track_bound: number | null;
      };
      expect(run.state).toBe("completed");
      expect(run.current_node).toBeNull();
      // Status reads the snapshot (null track_bound was the pre-#381 tell).
      expect(run.track_bound).toBe(2);
    } finally {
      stopSeed();
    }
  });

  it("keeps advancing after the authoring directory is deleted", async () => {
    const parleyHome = home();
    const clientDir = tmpDir("parley-381-gone-");
    installClientWorkflow(clientDir, "chain", chainWorkflow());

    await startDetachedDaemon(parleyHome);
    const stopSeed = seedScratchVendorScripts(parleyHome);
    try {
      const ack = await startChainRun(parleyHome, clientDir);
      // Remove the authoring dir before the second node is entered.
      fs.rmSync(clientDir, { recursive: true, force: true });
      const detail = await waitForRunState(parleyHome, ack.run_id, "completed");
      expect((detail.run as { state: string }).state).toBe("completed");
    } finally {
      stopSeed();
    }
  });

  it("ignores mid-run edits to workflow.json and prompt files", async () => {
    const parleyHome = home();
    const clientDir = tmpDir("parley-381-edit-");
    installClientWorkflow(clientDir, "chain", chainWorkflow());

    await startDetachedDaemon(parleyHome);
    const stopSeed = seedScratchVendorScripts(parleyHome);
    try {
      const ack = await startChainRun(parleyHome, clientDir);

      const wfDir = path.join(clientDir, ".parley", "workflows", "chain");
      const edited = chainWorkflow();
      (edited.nodes as unknown[]).push({
        id: "third",
        kind: "step",
        profile: "deep",
        prompt: "prompts/second.md",
        in: { prev: { type: "text", from: "second.report" } },
        out: { report: { type: "text" } },
      });
      (edited.outputs as { report: { from: string } }).report.from = "third.report";
      fs.writeFileSync(path.join(wfDir, "workflow.json"), JSON.stringify(edited, null, 2));
      fs.writeFileSync(path.join(wfDir, "prompts", "second.md"), "EDITED-SECOND-PROMPT\n");

      const detail = await waitForRunState(parleyHome, ack.run_id, "completed");
      expect((detail.run as { state: string }).state).toBe("completed");
      const nodes = detail.nodes as Array<{ node: string }>;
      expect(nodes.map((n) => n.node)).not.toContain("third");

      const tasksRes = await runCli(
        ["run", "status", ack.run_id, "--node", "second", "--json"],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(tasksRes.code).toBe(0);
      const nodeDetail = JSON.parse(tasksRes.stdout) as {
        tasks: Array<{ task_id: string }>;
      };
      const taskId = nodeDetail.tasks[0]?.task_id;
      expect(taskId).toBeTruthy();
      const taskStatus = await runCli(["status", taskId!, "--json"], parleyHome);
      expect(taskStatus.code).toBe(0);
      const task = JSON.parse(taskStatus.stdout) as { prompt?: string };
      expect(task.prompt ?? "").toContain("SECOND-NODE-PROMPT");
      expect(task.prompt ?? "").not.toContain("EDITED-SECOND-PROMPT");
    } finally {
      stopSeed();
    }
  });

  it("forks the parent snapshot after the authoring directory is gone", async () => {
    const parleyHome = home();
    const clientDir = tmpDir("parley-381-fork-");
    installClientWorkflow(clientDir, "chain", chainWorkflow());

    await startDetachedDaemon(parleyHome);
    const stopSeed = seedScratchVendorScripts(parleyHome);
    try {
      const ack = await startChainRun(parleyHome, clientDir);
      await waitForRunState(parleyHome, ack.run_id, "completed");
      fs.rmSync(clientDir, { recursive: true, force: true });

      const fork = await runCli(
        ["run", "fork", ack.run_id, "--to", "second", "--json"],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(fork.code, `${fork.stderr}\n${fork.stdout}`).toBe(0);
      const child = JSON.parse(fork.stdout) as { run_id: string; state: string };
      const detail = await waitForRunState(parleyHome, child.run_id, "completed");
      expect((detail.run as { state: string }).state).toBe("completed");
      expect((detail.run as { parent_run_id: string }).parent_run_id).toBe(
        ack.run_id,
      );
    } finally {
      stopSeed();
    }
  });
});
