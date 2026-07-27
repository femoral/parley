import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpawnPlan, VendorAdapter } from "@useparley/core";
import { RunnerLoop } from "../src/loop.js";
import type { RunnerConfig } from "../src/config.js";
import {
  createFakeLeaseTransport,
  sampleLease,
  type FakeLeaseTransport,
} from "./lease-transport.fake.js";

const temps: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function baseConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    daemonUrl: "http://127.0.0.1:9",
    name: "gpu",
    token: "secret",
    repos: {},
    worktreesDir: tmp("parley-runner-wt-"),
    ...overrides,
  };
}

function failCalls(transport: FakeLeaseTransport): string[] {
  return transport.calls
    .filter((c): c is Extract<typeof c, { verb: "fail" }> => c.verb === "fail")
    .map((c) => c.error);
}

function stubAdapter(id = "fake"): VendorAdapter {
  return {
    id,
    childChannel: "mcp",
    async prepare(spec, _hub): Promise<SpawnPlan> {
      return {
        argv: ["true"],
        env: {},
        files: [],
        cwd: spec.cwd,
      };
    },
    async resume(spec, hub) {
      return this.prepare(spec, hub);
    },
    parseEvent() {
      return [];
    },
    sessionId() {
      return undefined;
    },
  };
}

/** Host that never touches git or network — enough to finish execute. */
function noopHost(overrides: {
  createWorktree?: () => { path: string; branch: string; baseSha: string };
  pushBranch?: () => void;
  spawnExitCode?: number | null;
} = {}) {
  const wt = tmp("parley-fake-wt-");
  return {
    createWorktree:
      overrides.createWorktree ??
      (() => ({
        path: wt,
        branch: "parley/task-1",
        baseSha: "abc",
      })),
    removeWorktree: () => {
      /* noop */
    },
    pushBranch:
      overrides.pushBranch ??
      (() => {
        /* noop */
      }),
    startHubProxy: async () => ({
      url: "http://127.0.0.1:1",
      port: 1,
      close: async () => {
        /* noop */
      },
    }),
    materializeContext: () => {
      /* noop */
    },
    materializeChildHub: () => {
      /* noop */
    },
    spawnAndStream: async () => overrides.spawnExitCode ?? 0,
  };
}

/** Drain one lease (or shutdown fail) then stop when transport is idle. */
async function runUntilIdle(loop: RunnerLoop, transport: FakeLeaseTransport): Promise<void> {
  const runPromise = loop.run();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (transport.calls.some((c) => c.verb === "fail" || c.verb === "branch")) {
      // Let execute's finally run, then stop leasing.
      await new Promise((r) => setTimeout(r, 5));
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  loop.stop();
  await runPromise;
}

describe("RunnerLoop failure branches (fake transport)", () => {
  it("fails when repo mapping is missing", async () => {
    const lease = sampleLease({ repo: "/unknown/repo" });
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop({
      config: baseConfig({ repos: {} }),
      transport,
      adapters: new Map([["fake", stubAdapter()]]),
      log: () => {},
    });
    await runUntilIdle(loop, transport);
    expect(failCalls(transport).some((e) => /no local repo mapping/.test(e))).toBe(
      true,
    );
  });

  it("fails when mapped repo path does not exist", async () => {
    const missing = path.join(tmp("parley-missing-parent-"), "no-such-repo");
    const lease = sampleLease({ repo: "/orch/repo" });
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop({
      config: baseConfig({ repos: { "/orch/repo": missing } }),
      transport,
      adapters: new Map([["fake", stubAdapter()]]),
      log: () => {},
    });
    await runUntilIdle(loop, transport);
    expect(
      failCalls(transport).some((e) => /mapped repo path does not exist/.test(e)),
    ).toBe(true);
  });

  it("fails on unknown vendor", async () => {
    const repo = tmp("parley-repo-");
    const lease = sampleLease({ vendor: "nope", repo: "/orch/repo" });
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop({
      config: baseConfig({ repos: { "/orch/repo": repo } }),
      transport,
      adapters: new Map([["fake", stubAdapter()]]),
      log: () => {},
    });
    await runUntilIdle(loop, transport);
    expect(failCalls(transport).some((e) => /unknown vendor on runner: nope/.test(e))).toBe(
      true,
    );
  });

  it("fails when worktree create throws", async () => {
    const repo = tmp("parley-repo-");
    const lease = sampleLease({ repo: "/orch/repo" });
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop({
      config: baseConfig({ repos: { "/orch/repo": repo } }),
      transport,
      adapters: new Map([["fake", stubAdapter()]]),
      host: {
        ...noopHost(),
        createWorktree: () => {
          throw new Error("git worktree add failed");
        },
      },
      log: () => {},
    });
    await runUntilIdle(loop, transport);
    expect(
      failCalls(transport).some((e) =>
        /failed to create worktree: git worktree add failed/.test(e),
      ),
    ).toBe(true);
  });

  it("fails with branch handoff message when push throws", async () => {
    const repo = tmp("parley-repo-");
    const lease = sampleLease({ repo: "/orch/repo" });
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop({
      config: baseConfig({ repos: { "/orch/repo": repo } }),
      transport,
      adapters: new Map([["fake", stubAdapter()]]),
      host: {
        ...noopHost({
          pushBranch: () => {
            throw new Error("permission denied");
          },
        }),
      },
      log: () => {},
    });
    await runUntilIdle(loop, transport);
    expect(
      failCalls(transport).some((e) => /branch handoff failed: permission denied/.test(e)),
    ).toBe(true);
  });

  it("safety-net fails when child exits without a report", async () => {
    const repo = tmp("parley-repo-");
    const lease = sampleLease({ repo: "/orch/repo" });
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop({
      config: baseConfig({ repos: { "/orch/repo": repo } }),
      transport,
      adapters: new Map([["fake", stubAdapter()]]),
      host: noopHost({ spawnExitCode: 7 }),
      log: () => {},
    });
    await runUntilIdle(loop, transport);
    expect(
      failCalls(transport).some((e) =>
        /vendor child exited \(code 7\) without submitting a report/.test(e),
      ),
    ).toBe(true);
    // Branch was still recorded on success path before safety-net fail.
    expect(transport.calls.some((c) => c.verb === "branch")).toBe(true);
  });

  it("fails a claimed lease when shutting down before execute", async () => {
    const lease = sampleLease();
    // The transport closes over the loop it stops, so the loop can only be
    // constructed after it — hand the callback a box to read through.
    const running: { loop: RunnerLoop | null } = { loop: null };
    const transport = createFakeLeaseTransport({
      leases: [
        () => {
          running.loop!.stop();
          return lease;
        },
      ],
    });
    const loop = new RunnerLoop({
      config: baseConfig(),
      transport,
      adapters: new Map([["fake", stubAdapter()]]),
      log: () => {},
    });
    running.loop = loop;
    await loop.run();
    expect(
      failCalls(transport).some((e) => /runner shutting down before execute/.test(e)),
    ).toBe(true);
  });
});
