import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createFakeAdapter } from "../src/daemon/adapters/fake.js";
import type { HubInfo, TaskSpec } from "../src/daemon/adapters/types.js";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  runCli,
  type FakeVendorAction,
} from "./helpers.js";

let home: string;
const taskDirs: string[] = [];

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of taskDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const REPORT = { summary: "ok", outcome: "success", files_changed: [] };

function taskDir(actions: FakeVendorAction[]): string {
  const dir = makeTaskDir(actions);
  taskDirs.push(dir);
  return dir;
}

/** The `hello` event the fake vendor emits, carrying the posture it received. */
function helloFrom(home: string, taskId: string): { sandbox: string; network: boolean } {
  const log = fs.readFileSync(path.join(home, "tasks", taskId, "vendor.jsonl"), "utf8");
  const line = log.split("\n").find((l) => l.includes('"hello"'));
  return JSON.parse(line!) as { sandbox: string; network: boolean };
}

describe("sandbox posture (spec §8)", () => {
  // 3 modes × network toggle — the matrix corners the adapters map (ADR-0006).
  const cases: { args: string[]; sandbox: string; network: boolean }[] = [
    { args: [], sandbox: "workspace", network: true }, // default
    { args: ["--sandbox", "read-only", "--no-network"], sandbox: "read-only", network: false },
    { args: ["--sandbox", "full"], sandbox: "full", network: true },
    { args: ["--sandbox", "workspace", "--no-network"], sandbox: "workspace", network: false },
  ];

  for (const { args, sandbox, network } of cases) {
    it(`delivers ${sandbox} + network:${network} to the adapter, envelope, and status`, async () => {
      const cwd = taskDir([{ submit_report: REPORT }]);
      const result = await runCli(
        ["delegate", "-v", "fake", "--cwd", cwd, ...args, "--wait", "go"],
        home,
      );

      expect(result.code).toBe(0);
      const envelope = JSON.parse(result.stdout);
      // Posture appears in the report envelope.
      expect(envelope.posture).toEqual({ sandbox, network });

      // The fake vendor received exactly this posture (proves delivery).
      expect(helloFrom(home, envelope.task_id)).toMatchObject({ sandbox, network });

      // Posture is persisted and visible in `status --json`.
      const rows = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout);
      expect(rows[0].sandbox).toBe(sandbox);
      expect(rows[0].network).toBe(network);
    });
  }

  it("rejects an unknown sandbox mode with exit 2", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const result = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--sandbox", "bogus", "--wait", "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/sandbox/);
  });
});

describe("posture survives resume", () => {
  // #18 builds stall/resume; here we prove the seam: resume() receives the same
  // posture as prepare(), so a resumed task keeps its delegated sandbox.
  it("hands prepare() and resume() the identical posture", async () => {
    const adapter = createFakeAdapter({ PARLEY_FAKE_VENDOR_BIN: "/fake/bin" });
    const hub: HubInfo = { url: "http://127.0.0.1:0/mcp", headers: {} };
    const spec: TaskSpec = {
      id: "t1",
      name: null,
      prompt: "p",
      vendor: "fake",
      model: null,
      cwd: "/tmp",
      sandbox: "read-only",
      network: false,
      answerTimeoutMs: 1_800_000,
      sessionId: "sess-1",
    };

    const prepared = await adapter.prepare(spec, hub);
    const resumed = await adapter.resume(spec, hub);

    for (const plan of [prepared, resumed]) {
      expect(plan.env.FAKE_SANDBOX).toBe("read-only");
      expect(plan.env.FAKE_NETWORK).toBe("0");
    }
    expect(resumed.env.FAKE_SANDBOX).toBe(prepared.env.FAKE_SANDBOX);
    expect(resumed.env.FAKE_NETWORK).toBe(prepared.env.FAKE_NETWORK);
  });
});
