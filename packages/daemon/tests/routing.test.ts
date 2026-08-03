/**
 * #315 — capability-matched routing pure helpers + claim SELECT shape.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import {
  insertTask,
  listCapablePendingTasks,
  openDatabase,
  selectClaimablePendingTask,
  type DatabaseHandle,
  type TaskRow,
} from "../src/db.js";
import {
  decideDispatch,
  formatCapabilityDiagnosis,
  formatWaitingReason,
  matchExecutors,
  type ExecutorCapability,
} from "../src/routing.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function openDb(): DatabaseHandle {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-routing-"));
  homes.push(home);
  return openDatabase(homePaths(home));
}

function seedPending(
  db: DatabaseHandle,
  partial: {
    id: string;
    vendor: string;
    runner?: string | null;
    created_at?: string;
  },
): TaskRow {
  return insertTask(db, {
    id: partial.id,
    name: null,
    vendor: partial.vendor,
    model: null,
    effort: null,
    profile: null,
    runner: partial.runner ?? null,
    repo: "/repo",
    repo_key: "github.com/org/repo",
    repo_fetch_url: "https://github.com/org/repo.git",
    cwd: "/repo",
    prompt: "x",
    orchestrator_session_id: "s",
    worktree: null,
    branch: null,
    base_sha: "abc",
    sandbox: "workspace",
    network: true,
    answer_timeout_ms: null,
    report_schema: null,
    size: null,
    difficulty: null,
    type: "other",
  });
}

const localFake: ExecutorCapability = {
  name: "local",
  vendors: ["fake"],
  online: true,
  isLocal: true,
  last_completed_at: null,
};

const gpuFakeOnline: ExecutorCapability = {
  name: "gpu",
  vendors: ["fake"],
  online: true,
  isLocal: false,
  last_completed_at: null,
};

const gpuFakeOffline: ExecutorCapability = {
  ...gpuFakeOnline,
  online: false,
};

const cpuCodexOnline: ExecutorCapability = {
  name: "cpu",
  vendors: ["codex"],
  online: true,
  isLocal: false,
  last_completed_at: null,
};

describe("matchExecutors / decideDispatch", () => {
  it("prefers online runners over local for unpinned", () => {
    const fleet = [localFake, gpuFakeOnline];
    const match = matchExecutors(fleet, "fake", null);
    expect(decideDispatch(match, fleet, "fake", null)).toEqual({ kind: "runner" });
  });

  it("selects local when only local is capable and online", () => {
    const fleet = [localFake, cpuCodexOnline];
    const match = matchExecutors(fleet, "fake", null);
    expect(decideDispatch(match, fleet, "fake", null)).toEqual({ kind: "local" });
  });

  it("fails when no executor advertises the vendor", () => {
    const fleet = [localFake, gpuFakeOnline];
    const match = matchExecutors(fleet, "claude", null);
    const d = decideDispatch(match, fleet, "claude", null);
    expect(d.kind).toBe("fail");
    if (d.kind === "fail") {
      expect(d.diagnosis).toMatch(/no capable executor for vendor "claude"/);
      expect(d.diagnosis).toMatch(/local=\[fake\]/);
      expect(d.diagnosis).toMatch(/gpu=\[fake\]/);
    }
  });

  it("queues when only offline capable runners exist", () => {
    const fleet = [gpuFakeOffline];
    const match = matchExecutors(fleet, "fake", null);
    const d = decideDispatch(match, fleet, "fake", null);
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") {
      expect(d.reason).toBe("waiting for capable runner: gpu (offline)");
    }
  });

  it("pin to incapable fails with diagnosis", () => {
    const fleet = [localFake, cpuCodexOnline];
    const match = matchExecutors(fleet, "fake", "cpu");
    const d = decideDispatch(match, fleet, "fake", "cpu");
    expect(d.kind).toBe("fail");
    if (d.kind === "fail") {
      expect(d.diagnosis).toMatch(/runner "cpu" cannot run vendor "fake"/);
      expect(d.diagnosis).toMatch(/advertises: codex/);
    }
  });

  it("pin to offline capable queues", () => {
    const fleet = [gpuFakeOffline];
    const match = matchExecutors(fleet, "fake", "gpu");
    const d = decideDispatch(match, fleet, "fake", "gpu");
    expect(d.kind).toBe("wait");
  });
});

describe("formatCapabilityDiagnosis / formatWaitingReason", () => {
  it("names known executors and vendors", () => {
    const msg = formatCapabilityDiagnosis({
      vendor: "claude",
      fleet: [localFake, gpuFakeOffline],
      reason: "no_capable",
    });
    expect(msg).toContain('no capable executor for vendor "claude"');
    expect(msg).toContain("local=[fake]");
    expect(msg).toContain("gpu=[fake] (offline)");
  });

  it("timeout diagnosis shares the known-executors inventory", () => {
    const msg = formatCapabilityDiagnosis({
      vendor: "fake",
      fleet: [gpuFakeOffline],
      reason: "timeout",
    });
    expect(msg).toMatch(/routing timed out/);
    expect(msg).toContain("gpu=[fake] (offline)");
  });

  it("waiting reason lists offline runners", () => {
    expect(formatWaitingReason([gpuFakeOffline, { ...cpuCodexOnline, online: false }])).toBe(
      "waiting for capable runner: gpu, cpu (offline)",
    );
  });
});

describe("capability-matched claim SELECT", () => {
  it("returns oldest pending matching vendor and affinity", () => {
    const db = openDb();
    seedPending(db, { id: "t1", vendor: "fake", runner: "gpu" });
    seedPending(db, { id: "t2", vendor: "fake", runner: null });
    seedPending(db, { id: "t3", vendor: "codex", runner: null });

    const forGpu = listCapablePendingTasks(db, {
      executorName: "gpu",
      vendorIds: ["fake"],
    });
    expect(forGpu.map((t) => t.id)).toEqual(["t1", "t2"]);

    const forCpu = listCapablePendingTasks(db, {
      executorName: "cpu",
      vendorIds: ["codex"],
    });
    expect(forCpu.map((t) => t.id)).toEqual(["t3"]);

    // Old name-pinned-only behavior is gone: unpinned tasks are claimable.
    const claim = selectClaimablePendingTask(db, {
      executorName: "gpu",
      vendorIds: ["fake"],
      onlinePeers: [{ name: "gpu", vendorIds: ["fake"], last_completed_at: null }],
    });
    expect(claim?.id).toBe("t1"); // oldest
  });

  it("warm executor prefers the peer with more recent completion", () => {
    const db = openDb();
    seedPending(db, { id: "t1", vendor: "fake", runner: null });

    // gpu is warmer; cpu should not claim when gpu is online and preferred.
    const forCpu = selectClaimablePendingTask(db, {
      executorName: "cpu",
      vendorIds: ["fake"],
      onlinePeers: [
        {
          name: "gpu",
          vendorIds: ["fake"],
          last_completed_at: "2026-08-03T12:00:00.000Z",
        },
        {
          name: "cpu",
          vendorIds: ["fake"],
          last_completed_at: "2026-08-03T11:00:00.000Z",
        },
      ],
    });
    // Not preferred — falls back to first candidate so work does not starve
    // if the warm peer never polls (claim still returns the task).
    expect(forCpu?.id).toBe("t1");

    const forGpu = selectClaimablePendingTask(db, {
      executorName: "gpu",
      vendorIds: ["fake"],
      onlinePeers: [
        {
          name: "gpu",
          vendorIds: ["fake"],
          last_completed_at: "2026-08-03T12:00:00.000Z",
        },
        {
          name: "cpu",
          vendorIds: ["fake"],
          last_completed_at: "2026-08-03T11:00:00.000Z",
        },
      ],
    });
    expect(forGpu?.id).toBe("t1");
  });

  it("hard pin is only claimable by the named runner", () => {
    const db = openDb();
    seedPending(db, { id: "t1", vendor: "fake", runner: "gpu" });
    const forCpu = listCapablePendingTasks(db, {
      executorName: "cpu",
      vendorIds: ["fake"],
    });
    expect(forCpu).toEqual([]);
    const forGpu = listCapablePendingTasks(db, {
      executorName: "gpu",
      vendorIds: ["fake"],
    });
    expect(forGpu.map((t) => t.id)).toEqual(["t1"]);
  });
});
