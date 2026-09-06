/**
 * #388 / ADR-0035 — declared run outputs are readable at `run.<name>`.
 *
 * Against a **real detached daemon**, not a fixture. This is the load-bearing
 * half of the issue: the resolver was never wired up, and every unit test in
 * the world would have passed against a read path nothing reached. The bug was
 * unreachable until runs could complete (#381), so the run here genuinely
 * completes, and a gate in the middle gives the `blocked` and `not_produced`
 * cases their real states too.
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
          deep: { vendor: "fake", model: "fake-model", effort: "medium" },
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

/**
 * `first → approve (gate) → second`, `workspace: scratch`. Two declared
 * outputs straddling the gate so one is produced while the other is not.
 */
function gatedWorkflow(): Record<string, unknown> {
  return {
    id: "gated",
    version: 1,
    type: "other",
    workspace: "scratch",
    inputs: { brief: { type: "text" } },
    outputs: {
      early: { type: "text", from: "first.report" },
      final: { type: "text", from: "second.report" },
    },
    nodes: [
      {
        id: "first",
        kind: "step",
        profile: "deep",
        prompt: "prompts/step.md",
        in: { brief: { type: "text", from: "run.brief" } },
        out: { report: { type: "text" } },
      },
      {
        id: "approve",
        kind: "gate",
        question: "Ship it?",
        shows: {},
        on_reject: "finish",
      },
      {
        id: "second",
        kind: "step",
        profile: "deep",
        prompt: "prompts/step.md",
        in: { prev: { type: "text", from: "first.report" } },
        out: { report: { type: "text" } },
      },
    ],
  };
}

/** Local-layer workflow under `{dir}/.parley/workflows/<id>`. */
function installClientWorkflow(
  dir: string,
  id: string,
  body: Record<string, unknown>,
): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  writeFiles(path.join(dir, ".parley", "workflows", id), {
    "workflow.json": JSON.stringify(body, null, 2),
    "prompts/step.md": "STEP-PROMPT\n",
  });
}

const VENDOR_SCRIPT = [{ submit_report: { report: "the product" } }];

/**
 * Scratch workspaces start empty — write `.fake-vendor.json` into each new
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

interface RunOutputEntry {
  type: string;
  from: string;
  deliverable_id: string | null;
  address: string | null;
  state: string;
}

interface RunDetail {
  run: Record<string, unknown>;
  nodes: Array<{ node: string; state: string }>;
  outputs: Record<string, RunOutputEntry>;
  inputs: Record<string, unknown> | null;
}

async function runStatusJson(parleyHome: string, runId: string): Promise<RunDetail> {
  const res = await runCli(["run", "status", runId, "--json"], parleyHome, {
    cwd: parleyHome,
  });
  if (res.code !== 0) {
    throw new Error(`run status failed: ${res.stderr}\n${res.stdout}`);
  }
  return JSON.parse(res.stdout) as RunDetail;
}

async function waitForRunState(
  parleyHome: string,
  runId: string,
  state: string,
  timeoutMs = 20_000,
): Promise<RunDetail> {
  let last: RunDetail | null = null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      last = await runStatusJson(parleyHome, runId);
      if ((last.run as { state?: string }).state === state) return last;
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

/** Start a detached daemon plus a gated run held at its gate. */
async function gatedRunAtGate(): Promise<{
  parleyHome: string;
  runId: string;
  stopSeed: () => void;
}> {
  const parleyHome = home();
  const clientDir = tmpDir("parley-388-client-");
  installClientWorkflow(clientDir, "gated", gatedWorkflow());

  const started = await runCli(["daemon", "start"], parleyHome, { cwd: parleyHome });
  expect(started.code, started.stderr).toBe(0);
  const stopSeed = seedScratchVendorScripts(parleyHome);

  const ack = await runCli(
    ["run", "start", "gated", "--input", "brief=hello", "--json"],
    parleyHome,
    { cwd: clientDir },
  );
  expect(ack.code, `${ack.stderr}\n${ack.stdout}`).toBe(0);
  const runId = (JSON.parse(ack.stdout) as { run_id: string }).run_id;
  await waitForRunState(parleyHome, runId, "blocked");
  return { parleyHome, runId, stopSeed };
}

describe("run outputs resolve at run.<name> (#388)", () => {
  it("returns the producing node's value on a completed run", async () => {
    const { parleyHome, runId, stopSeed } = await gatedRunAtGate();
    try {
      const approved = await runCli(["run", "approve", runId], parleyHome, {
        cwd: parleyHome,
      });
      expect(approved.code, approved.stderr).toBe(0);
      await waitForRunState(parleyHome, runId, "completed");

      const viaNode = await runCli(
        ["run", "get", "second.report", "--run", runId],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(viaNode.code, viaNode.stderr).toBe(0);

      const viaRun = await runCli(
        ["run", "get", "run.final", "--run", runId],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(viaRun.code, viaRun.stderr).toBe(0);
      expect(viaRun.stdout).toBe(viaNode.stdout);
      expect(viaRun.stdout).toContain("the product");
    } finally {
      stopSeed();
    }
  });

  it("accepts the slash and run-id-prefixed spellings", async () => {
    const { parleyHome, runId, stopSeed } = await gatedRunAtGate();
    try {
      await runCli(["run", "approve", runId], parleyHome, { cwd: parleyHome });
      await waitForRunState(parleyHome, runId, "completed");

      const slash = await runCli(
        ["run", "get", `${runId}/run/final`],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(slash.code, slash.stderr).toBe(0);
      expect(slash.stdout).toContain("the product");

      const twoPositional = await runCli(
        ["run", "get", runId, "run.final"],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(twoPositional.code, twoPositional.stderr).toBe(0);
      expect(twoPositional.stdout).toContain("the product");
    } finally {
      stopSeed();
    }
  });

  it("serves a produced output on a blocked run and exits 10 for an unproduced one", async () => {
    const { parleyHome, runId, stopSeed } = await gatedRunAtGate();
    try {
      const early = await runCli(
        ["run", "get", "run.early", "--run", runId],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(early.code, early.stderr).toBe(0);
      expect(early.stdout).toContain("the product");

      const final = await runCli(
        ["run", "get", "run.final", "--run", runId],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(final.code).toBe(10);
      expect(final.stderr).toMatch(/not been produced yet/);
    } finally {
      stopSeed();
    }
  });

  it("still serves a produced output after the run is cancelled", async () => {
    const { parleyHome, runId, stopSeed } = await gatedRunAtGate();
    try {
      const cancelled = await runCli(["run", "cancel", runId], parleyHome, {
        cwd: parleyHome,
      });
      expect(cancelled.code, cancelled.stderr).toBe(0);
      await waitForRunState(parleyHome, runId, "cancelled");

      const early = await runCli(
        ["run", "get", "run.early", "--run", runId],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(early.code, early.stderr).toBe(0);
      expect(early.stdout).toContain("the product");
    } finally {
      stopSeed();
    }
  });

  it("exits 2 on an undeclared name and lists the declared outputs", async () => {
    const { parleyHome, runId, stopSeed } = await gatedRunAtGate();
    try {
      const res = await runCli(
        ["run", "get", "run.reprot", "--run", runId],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(res.code).toBe(2);
      expect(res.stderr).toMatch(/no run output named "reprot"/);
      expect(res.stderr).toMatch(/early, final/);
    } finally {
      stopSeed();
    }
  });

  it("treats a prototype-chain name as undeclared, not as a crash", async () => {
    const { parleyHome, runId, stopSeed } = await gatedRunAtGate();
    try {
      for (const name of ["toString", "constructor", "__proto__"]) {
        const res = await runCli(
          ["run", "get", `run.${name}`, "--run", runId],
          parleyHome,
          { cwd: parleyHome },
        );
        expect(res.code, `${name}: ${res.stderr}`).toBe(2);
        expect(res.stderr).toMatch(/no run output named/);
      }
    } finally {
      stopSeed();
    }
  });

  it("names the declared outputs before complaining about coordinates", async () => {
    const { parleyHome, runId, stopSeed } = await gatedRunAtGate();
    try {
      // A typo'd name plus --iteration must not assert the name is declared.
      const res = await runCli(
        ["run", "get", "run.reprot", "--run", runId, "--iteration", "1"],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(res.code).toBe(2);
      expect(res.stderr).toMatch(/no run output named "reprot"/);
      expect(res.stderr).toMatch(/early, final/);
      expect(res.stderr).not.toMatch(/takes no iteration or slot/);
    } finally {
      stopSeed();
    }
  });

  it("rejects --iteration and --slot on a run-level address", async () => {
    const { parleyHome, runId, stopSeed } = await gatedRunAtGate();
    try {
      const iter = await runCli(
        ["run", "get", "run.early", "--run", runId, "--iteration", "1"],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(iter.code).toBe(2);
      expect(iter.stderr).toMatch(/takes no iteration or slot/);
      expect(iter.stderr).toMatch(/<node>\.<port>\.<n>/);

      const slot = await runCli(
        ["run", "get", "run.early", "--run", runId, "--slot", "a"],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(slot.code).toBe(2);
      expect(slot.stderr).toMatch(/takes no iteration or slot/);

      // The coordinate baked into the address is rejected by the daemon too.
      const inline = await runCli(
        ["run", "get", "run.early.1", "--run", runId],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(inline.code).toBe(2);
      expect(inline.stderr).toMatch(/takes no iteration or slot/);
    } finally {
      stopSeed();
    }
  });

  it("indexes outputs on run detail with no values, leaving the list response alone", async () => {
    const { parleyHome, runId, stopSeed } = await gatedRunAtGate();
    try {
      const held = await runStatusJson(parleyHome, runId);
      expect(held.outputs.early).toMatchObject({
        type: "text",
        from: "first.report",
        state: "produced",
      });
      expect(held.outputs.early?.deliverable_id).toMatch(/^d\d+$/);
      expect(held.outputs.early?.address).toBe("first.report.1");
      expect(held.outputs.final).toEqual({
        type: "text",
        from: "second.report",
        deliverable_id: null,
        address: null,
        state: "pending",
      });
      // Values-free by contract (ADR-0021's budget).
      for (const entry of Object.values(held.outputs)) {
        expect(Object.keys(entry).sort()).toEqual([
          "address",
          "deliverable_id",
          "from",
          "state",
          "type",
        ]);
      }

      await runCli(["run", "approve", runId], parleyHome, { cwd: parleyHome });
      const done = await waitForRunState(parleyHome, runId, "completed");
      expect(done.outputs.final?.state).toBe("produced");
      expect(done.outputs.final?.address).toBe("second.report.1");

      // The all-runs list response is untouched.
      const list = await runCli(["run", "status", "--all", "--json"], parleyHome, {
        cwd: parleyHome,
      });
      expect(list.code, list.stderr).toBe(0);
      const runs = JSON.parse(list.stdout) as Record<string, unknown>[];
      expect(runs.length).toBeGreaterThan(0);
      for (const summary of runs) {
        expect(summary).not.toHaveProperty("outputs");
      }
    } finally {
      stopSeed();
    }
  });

  it("resolves a fork's inherited outputs", async () => {
    const { parleyHome, runId, stopSeed } = await gatedRunAtGate();
    try {
      await runCli(["run", "approve", runId], parleyHome, { cwd: parleyHome });
      await waitForRunState(parleyHome, runId, "completed");

      const forked = await runCli(
        ["run", "fork", runId, "--to", "second", "--json"],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(forked.code, `${forked.stderr}\n${forked.stdout}`).toBe(0);
      const childId = (JSON.parse(forked.stdout) as { run_id: string }).run_id;
      const child = await waitForRunState(parleyHome, childId, "completed");
      expect(child.inputs).toEqual({ brief: "hello" });

      // `first` was inherited at iteration 0; its output resolves with no
      // special case, and the child's own `second` run resolves too.
      expect(child.outputs.early?.state).toBe("produced");
      expect(child.outputs.early?.address).toBe("first.report.0");
      const early = await runCli(
        ["run", "get", "run.early", "--run", childId],
        parleyHome,
        { cwd: parleyHome },
      );
      expect(early.code, early.stderr).toBe(0);
      expect(early.stdout).toContain("the product");
    } finally {
      stopSeed();
    }
  });
});
