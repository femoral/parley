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
    enforcement: {
      "read-only": { level: "enforced", via: "test" },
      workspace: { level: "enforced", via: "test" },
      full: { level: "enforced", via: "test" },
      "network:false": { level: "enforced", via: "test" },
    },
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

const emptyCaps = {
  vendors: [] as { id: string; models: never[] }[],
};

/** Host that never touches git or network — enough to finish execute. */
function noopHost(overrides: {
  prepareClaimRepo?: () => {
    repoLocal: string;
    baseRef: string;
    branch: string;
    pushToOrigin: boolean;
    source: "mirror" | "override" | "local";
  };
  createWorktree?: () => { path: string; branch: string; baseSha: string };
  pushBranch?: () => void;
  spawnExitCode?: number | null;
  /** When true, omit spawnAndStream so tests can assert it was never set/called. */
  noSpawn?: boolean;
} = {}) {
  const wt = tmp("parley-fake-wt-");
  const repo = tmp("parley-fake-repo-");
  const host: {
    prepareClaimRepo: () => {
      repoLocal: string;
      baseRef: string;
      branch: string;
      pushToOrigin: boolean;
      source: "mirror" | "override" | "local";
    };
    createWorktree: () => { path: string; branch: string; baseSha: string };
    removeWorktree: () => void;
    pushBranch: () => void;
    startHubProxy: () => Promise<{
      url: string;
      port: number;
      close: () => Promise<void>;
    }>;
    materializeContext: () => void;
    materializeChildHub: () => void;
    spawnAndStream?: () => Promise<number | null>;
  } = {
    prepareClaimRepo:
      overrides.prepareClaimRepo ??
      (() => ({
        repoLocal: repo,
        baseRef: "abc",
        branch: "parley/task-1",
        pushToOrigin: true,
        source: "mirror" as const,
      })),
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
  };
  if (!overrides.noSpawn) {
    host.spawnAndStream = async () => overrides.spawnExitCode ?? 0;
  }
  return host;
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

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForRegister(transport: FakeLeaseTransport): Promise<void> {
  await waitFor(
    () => transport.calls.some((c) => c.verb === "register"),
    "register call",
  );
}

function loopOpts(
  transport: FakeLeaseTransport,
  overrides: {
    config?: Partial<RunnerConfig>;
    host?: Parameters<typeof noopHost>[0];
    adapters?: Map<string, VendorAdapter>;
    fingerprint?: () => typeof emptyCaps | Promise<typeof emptyCaps>;
  } = {},
): ConstructorParameters<typeof RunnerLoop>[0] {
  return {
    config: baseConfig(overrides.config),
    transport,
    adapters: overrides.adapters ?? new Map([["fake", stubAdapter()]]),
    host: noopHost(overrides.host),
    fingerprint: overrides.fingerprint ?? (() => emptyCaps),
    log: () => {},
  };
}

describe("RunnerLoop registration (fake transport)", () => {
  it("registers before leasing", async () => {
    const transport = createFakeLeaseTransport({ leases: [] });
    const loop = new RunnerLoop(
      loopOpts(transport, {
        fingerprint: () => ({
          vendors: [
            {
              id: "fake",
              models: [
                { id: "fake-model", efforts: ["low"], default_effort: "low" },
              ],
            },
          ],
        }),
      }),
    );
    const runPromise = loop.run();
    await waitForRegister(transport);
    loop.stop();
    await runPromise;
    const reg = transport.calls.filter((c) => c.verb === "register");
    expect(reg.length).toBeGreaterThanOrEqual(1);
    const first = reg[0]!;
    expect(first.verb).toBe("register");
    if (first.verb === "register") {
      expect(first.request.runner).toBe("gpu");
      expect(first.request.protocol_version).toBe(1);
      expect(first.request.capabilities.vendors.map((v) => v.id)).toEqual(["fake"]);
    }
    // Lease is attempted only after register.
    const firstLeaseIdx = transport.calls.findIndex((c) => c.verb === "lease");
    const firstRegIdx = transport.calls.findIndex((c) => c.verb === "register");
    expect(firstRegIdx).toBeLessThan(firstLeaseIdx);
  });

  it("re-registers on the periodic timer with updated capabilities", async () => {
    process.env.PARLEY_RUNNER_REFINGERPRINT_MS = "50";
    try {
      let vendors = ["fake"];
      const transport = createFakeLeaseTransport({ leases: [] });
      const loop = new RunnerLoop(
        loopOpts(transport, {
          fingerprint: () => ({
            vendors: vendors.map((id) => ({ id, models: [] })),
          }),
        }),
      );
      const runPromise = loop.run();
      await waitForRegister(transport);
      vendors = ["fake", "codex"];
      await waitFor(
        () =>
          transport.calls.some(
            (c) =>
              c.verb === "register" &&
              c.request.capabilities.vendors.some((v) => v.id === "codex"),
          ),
        "re-fingerprint with codex",
        3_000,
      );
      loop.stop();
      await runPromise;
      const regCalls = transport.calls.filter((c) => c.verb === "register");
      expect(regCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.PARLEY_RUNNER_REFINGERPRINT_MS;
    }
  });
});

describe("RunnerLoop failure branches (fake transport)", () => {
  it("fails at claim time when prepareClaimRepo throws (vendor never spawned)", async () => {
    const lease = sampleLease({ repo: "/unknown/repo" });
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop(
      loopOpts(transport, {
        host: {
          prepareClaimRepo: () => {
            throw new Error("base_sha not resolvable from origin: deadbeef");
          },
          noSpawn: true,
          createWorktree: () => {
            throw new Error("should not create worktree");
          },
        },
      }),
    );
    await runUntilIdle(loop, transport);
    expect(
      failCalls(transport).some((e) => /base_sha not resolvable from origin/.test(e)),
    ).toBe(true);
    // Claim-time fail: no branch record, and noSpawn means vendor was not launched.
    expect(transport.calls.some((c) => c.verb === "branch")).toBe(false);
  });

  it("fails when repos override path does not exist", async () => {
    const missing = path.join(tmp("parley-missing-parent-"), "no-such-repo");
    const lease = sampleLease({
      repo: "/orch/repo",
      repo_key: "github.com/org/repo",
    });
    const transport = createFakeLeaseTransport({ leases: [lease] });
    // Use real prepareClaimRepo with override pointing at missing path.
    const loop = new RunnerLoop({
      config: baseConfig({
        repos: { "github.com/org/repo": missing },
      }),
      transport,
      adapters: new Map([["fake", stubAdapter()]]),
      fingerprint: () => emptyCaps,
      log: () => {},
      host: {
        // keep default prepareClaimRepo (real); stub only post-claim host bits
        createWorktree: () => {
          throw new Error("should not reach worktree");
        },
        removeWorktree: () => {},
        pushBranch: () => {},
        startHubProxy: async () => ({
          url: "http://127.0.0.1:1",
          port: 1,
          close: async () => {},
        }),
        materializeContext: () => {},
        materializeChildHub: () => {},
        spawnAndStream: async () => {
          throw new Error("vendor must not spawn");
        },
      },
    });
    await runUntilIdle(loop, transport);
    expect(
      failCalls(transport).some((e) => /repos override path does not exist/.test(e)),
    ).toBe(true);
    expect(transport.calls.some((c) => c.verb === "branch")).toBe(false);
  });

  it("fails on unknown vendor after successful claim-time prepare", async () => {
    const lease = sampleLease({ vendor: "nope" });
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop(loopOpts(transport, {}));
    await runUntilIdle(loop, transport);
    expect(failCalls(transport).some((e) => /unknown vendor on runner: nope/.test(e))).toBe(
      true,
    );
  });

  it("fails when worktree create throws", async () => {
    const lease = sampleLease();
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop(
      loopOpts(transport, {
        host: {
          createWorktree: () => {
            throw new Error("git worktree add failed");
          },
        },
      }),
    );
    await runUntilIdle(loop, transport);
    expect(
      failCalls(transport).some((e) =>
        /failed to create worktree: git worktree add failed/.test(e),
      ),
    ).toBe(true);
  });

  it("fails with branch handoff message when push throws", async () => {
    const lease = sampleLease();
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop(
      loopOpts(transport, {
        host: {
          pushBranch: () => {
            throw new Error("permission denied");
          },
        },
      }),
    );
    await runUntilIdle(loop, transport);
    expect(
      failCalls(transport).some((e) => /branch handoff failed: permission denied/.test(e)),
    ).toBe(true);
  });

  it("safety-net fails when child exits without a report", async () => {
    const lease = sampleLease();
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop(
      loopOpts(transport, {
        host: { spawnExitCode: 7 },
      }),
    );
    await runUntilIdle(loop, transport);
    expect(
      failCalls(transport).some((e) =>
        /vendor child exited \(code 7\) without submitting a report/.test(e),
      ),
    ).toBe(true);
    // Branch was still recorded on success path before safety-net fail.
    expect(transport.calls.some((c) => c.verb === "branch")).toBe(true);
  });

  it("claim-time failure ordering: fail before createWorktree and spawn", async () => {
    const order: string[] = [];
    const lease = sampleLease();
    const transport = createFakeLeaseTransport({ leases: [lease] });
    const loop = new RunnerLoop(
      loopOpts(transport, {
        host: {
          prepareClaimRepo: () => {
            order.push("prepare");
            throw new Error("push denied at claim time (branch parley/task-1): denied");
          },
          createWorktree: () => {
            order.push("worktree");
            return { path: tmp("x-"), branch: "parley/task-1", baseSha: "abc" };
          },
          noSpawn: true,
        },
      }),
    );
    await runUntilIdle(loop, transport);
    expect(order).toEqual(["prepare"]);
    expect(failCalls(transport).some((e) => /push denied at claim time/.test(e))).toBe(
      true,
    );
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
    const loop = new RunnerLoop(loopOpts(transport));
    running.loop = loop;
    await loop.run();
    expect(
      failCalls(transport).some((e) => /runner shutting down before execute/.test(e)),
    ).toBe(true);
  });
});
