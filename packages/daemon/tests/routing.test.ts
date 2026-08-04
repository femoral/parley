/**
 * #315 — capability-matched routing pure helpers + claim SELECT shape +
 * durable deadline / workspace-binding / sweep review fixes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  getRunner,
  getTask,
  insertTask,
  listCapablePendingTasks,
  markRunnerUnreachable,
  openDatabase,
  parseUnreachableRepos,
  selectClaimablePendingTask,
  sweepInterruptedTasks,
  updateTask,
  upsertRunner,
  writeTaskState,
  type DatabaseHandle,
  type TaskRow,
} from "../src/db.js";
import { TaskEngine } from "../src/engine.js";
import { detectHarnesses } from "../src/fingerprint.js";
import {
  decideDispatch,
  formatCapabilityDiagnosis,
  formatRepoExclusion,
  formatWaitingReason,
  matchExecutors,
  partitionFleetForRepo,
  type ExecutorCapability,
} from "../src/routing.js";
import { startServer, type DaemonServer } from "../src/server.js";
import { withFakeAllowlist } from "./helpers.js";

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

function makeOriginRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "parley-repo-"));
  homes.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "i"], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    ["-C", repo, "remote", "add", "origin", "https://github.com/org/r.git"],
    { stdio: "ignore" },
  );
  return repo;
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

  it("warm reservation: only preferred runner claims within window (F5)", () => {
    const db = openDb();
    seedPending(db, { id: "t1", vendor: "fake", runner: null });
    const peers = [
      {
        name: "gpu",
        vendorIds: ["fake"] as string[],
        last_completed_at: "2026-08-03T12:00:00.000Z",
      },
      {
        name: "cpu",
        vendorIds: ["fake"] as string[],
        last_completed_at: "2026-08-03T11:00:00.000Z",
      },
    ];
    const created = Date.parse(getCreated(db, "t1"));

    // Within reservation: cooler peer cannot claim.
    const forCpu = selectClaimablePendingTask(db, {
      executorName: "cpu",
      vendorIds: ["fake"],
      onlinePeers: peers,
      nowMs: created + 100,
      reservationMs: 5_000,
    });
    expect(forCpu).toBeUndefined();

    // Preferred peer can claim.
    const forGpu = selectClaimablePendingTask(db, {
      executorName: "gpu",
      vendorIds: ["fake"],
      onlinePeers: peers,
      nowMs: created + 100,
      reservationMs: 5_000,
    });
    expect(forGpu?.id).toBe("t1");

    // After reservation window: any capable claimer.
    const forCpuLater = selectClaimablePendingTask(db, {
      executorName: "cpu",
      vendorIds: ["fake"],
      onlinePeers: peers,
      nowMs: created + 6_000,
      reservationMs: 5_000,
    });
    expect(forCpuLater?.id).toBe("t1");
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

  it("warm-clone: runner holding the mirror wins over warmer executor (#318)", () => {
    const db = openDb();
    seedPending(db, { id: "t1", vendor: "fake", runner: null });
    // cpu completed more recently (warm-executor favorite) but has no mirror.
    // gpu holds the mirror for the task's repo_key.
    const peers = [
      {
        name: "cpu",
        vendorIds: ["fake"] as string[],
        last_completed_at: "2026-08-03T14:00:00.000Z",
        heldMirrors: [] as string[],
      },
      {
        name: "gpu",
        vendorIds: ["fake"] as string[],
        last_completed_at: "2026-08-03T10:00:00.000Z",
        heldMirrors: ["github.com/org/repo"],
      },
    ];
    const created = Date.parse(getCreated(db, "t1"));

    // Within reservation: cold-but-recent cpu cannot claim.
    const forCpu = selectClaimablePendingTask(db, {
      executorName: "cpu",
      vendorIds: ["fake"],
      onlinePeers: peers,
      nowMs: created + 100,
      reservationMs: 5_000,
    });
    expect(forCpu).toBeUndefined();

    // Warm-clone peer claims.
    const forGpu = selectClaimablePendingTask(db, {
      executorName: "gpu",
      vendorIds: ["fake"],
      onlinePeers: peers,
      nowMs: created + 100,
      reservationMs: 5_000,
    });
    expect(forGpu?.id).toBe("t1");
  });

  it("warm-clone: excluded-but-warm does not hold reservation (#318/#317)", () => {
    const db = openDb();
    seedPending(db, { id: "t1", vendor: "fake", runner: null });
    // gpu holds the mirror but is excluded for this repo_key.
    // cpu is cold and has no mirror — still claimable because preferred is excluded.
    const peers = [
      {
        name: "gpu",
        vendorIds: ["fake"] as string[],
        last_completed_at: "2026-08-03T14:00:00.000Z",
        heldMirrors: ["github.com/org/repo"],
        unreachableRepoKeys: ["github.com/org/repo"],
      },
      {
        name: "cpu",
        vendorIds: ["fake"] as string[],
        last_completed_at: null as string | null,
        heldMirrors: [] as string[],
      },
    ];
    const created = Date.parse(getCreated(db, "t1"));
    const forCpu = selectClaimablePendingTask(db, {
      executorName: "cpu",
      vendorIds: ["fake"],
      onlinePeers: peers,
      nowMs: created + 100,
      reservationMs: 5_000,
    });
    expect(forCpu?.id).toBe("t1");
  });
});

function getCreated(db: DatabaseHandle, id: string): string {
  const row = db.prepare(`SELECT created_at FROM tasks WHERE id = ?`).get(id) as {
    created_at: string;
  };
  return row.created_at;
}

// ─── Integration: durable deadline, workspace binding, sweep (#315 review) ─

const FAKE_BIN = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../cli/tests/fake-vendor.mjs",
);

function writeConfig(home: string, body: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(withFakeAllowlist(body)),
  );
}

describe("durable routing deadline + restart (F1/F2)", () => {
  let home: string;
  let server: DaemonServer | null = null;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-route-dur-"));
    homes.push(home);
    writeConfig(home, {
      runners: { gpu: { token: "secret-gpu" } },
      daemon: { routing: { queueTimeoutMs: 500 } },
    });
    process.env.PARLEY_FAKE_VENDOR_BIN = "";
    process.env.PARLEY_ROUTING_QUEUE_TIMEOUT_MS = "400";
    process.env.PARLEY_RUNNER_PRESENCE_GRACE_MS = "50";
    process.env.PARLEY_LONG_POLL_MS = "200";
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    delete process.env.PARLEY_FAKE_VENDOR_BIN;
    delete process.env.PARLEY_ROUTING_QUEUE_TIMEOUT_MS;
    delete process.env.PARLEY_RUNNER_PRESENCE_GRACE_MS;
    delete process.env.PARLEY_LONG_POLL_MS;
  });

  async function boot(): Promise<string> {
    server = await startServer(homePaths(home));
    return `http://127.0.0.1:${server.port}`;
  }

  async function json(
    base: string,
    method: string,
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      /* keep */
    }
    return { status: res.status, body: parsed };
  }

  it("online-at-create never polls → fails after durable timeout (M7/F2)", async () => {
    const base = await boot();
    // Register so runner is online (within grace), then never lease-poll.
    const reg = await json(
      base,
      "POST",
      "/runner/register",
      {
        runner: "gpu",
        protocol_version: 1,
        build_version: "t",
        capabilities: { vendors: [{ id: "fake", models: [] }] },
      },
      { authorization: "Bearer secret-gpu" },
    );
    expect(reg.status).toBe(200);

    const repo = makeOriginRepo();
    const created = await json(base, "POST", "/tasks", {
      prompt: "x",
      vendor: "fake",
      cwd: repo,
      use_worktree: true,
      orchestrator_session_id: "s",
    });
    expect(created.status).toBe(201);
    const taskId = (created.body as { task_id: string }).task_id;

    const mid = await json(base, "GET", `/tasks/${taskId}`);
    const midRow = (mid.body as { row: { state: string; routing_deadline_at: string | null } })
      .row;
    expect(midRow.state).toBe("pending");
    expect(midRow.routing_deadline_at).not.toBeNull();

    // Wait for timeout.
    const deadline = Date.now() + 5_000;
    let state = "pending";
    let error: string | null = null;
    while (Date.now() < deadline) {
      const st = await json(base, "GET", `/tasks/${taskId}`);
      const row = (st.body as { row: { state: string; error: string | null } }).row;
      state = row.state;
      error = row.error;
      if (state === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state).toBe("failed");
    expect(error).toMatch(/routing timed out|known executors/);
  });

  it("restart re-arms and expires durable deadline (M4/F1)", async () => {
    const base = await boot();
    const reg = await json(
      base,
      "POST",
      "/runner/register",
      {
        runner: "gpu",
        protocol_version: 1,
        build_version: "t",
        capabilities: { vendors: [{ id: "fake", models: [] }] },
      },
      { authorization: "Bearer secret-gpu" },
    );
    expect(reg.status).toBe(200);

    // Force offline: wait past presence grace without poll.
    await new Promise((r) => setTimeout(r, 120));

    const repo = makeOriginRepo();

    const created = await json(base, "POST", "/tasks", {
      prompt: "x",
      vendor: "fake",
      cwd: repo,
      use_worktree: true,
      orchestrator_session_id: "s",
    });
    expect(created.status).toBe(201);
    const taskId = (created.body as { task_id: string }).task_id;
    const mid = await json(base, "GET", `/tasks/${taskId}`);
    const midRow = (
      mid.body as {
        row: { queue_reason: string | null; routing_deadline_at: string | null };
      }
    ).row;
    expect(midRow.queue_reason).toMatch(/waiting for capable runner/);
    expect(midRow.routing_deadline_at).not.toBeNull();

    // Close server (kill timers) and reopen — rearmRoutingDeadlines should
    // fail the already-near-expired or re-arm and fail shortly.
    await server!.close();
    server = null;
    // Backdate deadline so restart fails immediately.
    const db = openDatabase(homePaths(home));
    updateTask(db, taskId, {
      routing_deadline_at: new Date(Date.now() - 1_000).toISOString(),
    });
    db.close();

    server = await startServer(homePaths(home));
    const base2 = `http://127.0.0.1:${server.port}`;
    // Give construction a tick to run rearm.
    await new Promise((r) => setTimeout(r, 50));
    const after = await json(base2, "GET", `/tasks/${taskId}`);
    const row = (after.body as { row: { state: string; error: string | null } }).row;
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/routing timed out|known executors/);
  });

  it("rejects register as reserved name local (F2)", async () => {
    writeConfig(home, {
      runners: { local: { token: "secret-local" } },
    });
    const base = await boot();
    const reg = await json(
      base,
      "POST",
      "/runner/register",
      {
        runner: "local",
        protocol_version: 1,
        build_version: "t",
        capabilities: { vendors: [{ id: "fake", models: [] }] },
      },
      { authorization: "Bearer secret-local" },
    );
    expect(reg.status).toBe(400);
    expect(JSON.stringify(reg.body)).toMatch(/reserved/);
  });
});

describe("workspace-bound routing (F3)", () => {
  let home: string;
  let db: DatabaseHandle;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ws-bound-"));
    homes.push(home);
    writeConfig(home, {
      runners: {
        gpu: { token: "secret-gpu" },
        cpu: { token: "secret-cpu" },
      },
    });
    process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_BIN;
    db = openDatabase(homePaths(home));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* */
    }
    delete process.env.PARLEY_FAKE_VENDOR_BIN;
  });

  it("fix of local parent stays local even with capable online runner", () => {
    // Seed a completed local parent with a worktree; insert a runner that
    // advertises fake; fix must not set runner or leave for lease.
    upsertRunner(db, {
      name: "gpu",
      capabilities: JSON.stringify({ vendors: [{ id: "fake", models: [] }] }),
      protocol_version: 1,
      build_version: "t",
    });
    const parent = insertTask(db, {
      id: "t1",
      name: null,
      vendor: "fake",
      model: "fake-model",
      effort: "medium",
      profile: null,
      runner: null,
      repo: home,
      repo_key: "github.com/org/r",
      repo_fetch_url: "https://github.com/org/r.git",
      cwd: path.join(home, "wt"),
      prompt: "parent",
      orchestrator_session_id: "s",
      worktree: path.join(home, "wt"),
      branch: "parley/t1",
      base_sha: "abc",
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "other",
      placement: "local",
    });
    writeTaskState(db, parent.id, "completed", {
      completed_at: new Date().toISOString(),
      report: JSON.stringify({
        summary: "ok",
        outcome: "success",
        files_changed: [],
      }),
    });

    const engine = new TaskEngine(
      db,
      homePaths(home),
      createAdapterRegistrySync(process.env),
    );
    engine.setRunnerOnlineProbe(() => true);

    // isWorkspaceBoundLocal for a synthetic fix row with parent_task_id
    const fixRow = insertTask(db, {
      id: "t2",
      name: null,
      vendor: "fake",
      model: "fake-model",
      effort: "medium",
      profile: null,
      runner: null,
      repo: home,
      repo_key: "github.com/org/r",
      repo_fetch_url: "https://github.com/org/r.git",
      cwd: path.join(home, "wt2"),
      prompt: "fix brief",
      orchestrator_session_id: "s",
      worktree: path.join(home, "wt2"),
      branch: "parley/t2",
      base_sha: "abc",
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "other",
      parent_task_id: "t1",
      attempt: 2,
      placement: "local",
    });
    // Invoke private dispatch via public surface: offer path after insert
    // by calling fix would need more setup — assert isWorkspaceBound via
    // dispatchClaim side-effect: runner stays null and task is not pending
    // for lease. Use engine.list after a manual dispatch via fix is heavy;
    // instead check getTask after engine.delegate-style is not available.
    // Direct: worktree-bound row → dispatchClaim keeps runner null.
    (engine as unknown as { dispatchClaim: (t: typeof fixRow) => void }).dispatchClaim(
      getTask(db, "t2")!,
    );
    const after = getTask(db, "t2")!;
    // Either admitted/running/queued (local) or still pending without remote deadline.
    expect(after.runner).toBeNull();
    expect(after.routing_deadline_at).toBeNull();
    expect(after.placement).toBe("local");
  });

  it("run-owned step stays local", () => {
    const row = insertTask(db, {
      id: "t1",
      name: null,
      vendor: "fake",
      model: "fake-model",
      effort: "medium",
      profile: null,
      runner: null,
      repo: home,
      cwd: home,
      prompt: "step",
      orchestrator_session_id: "s",
      worktree: null,
      branch: null,
      base_sha: null,
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "other",
      run_id: "r1",
      node: "n1",
      iteration: 1,
      slot: null,
      placement: "local",
    });
    const engine = new TaskEngine(
      db,
      homePaths(home),
      createAdapterRegistrySync(process.env),
    );
    engine.setRunnerOnlineProbe(() => true);
    (engine as unknown as { dispatchClaim: (t: typeof row) => void }).dispatchClaim(row);
    const after = getTask(db, "t1")!;
    expect(after.runner).toBeNull();
    expect(after.routing_deadline_at).toBeNull();
    expect(after.placement).toBe("local");
  });

  it("--cwd + capable online runner runs locally (G2); runner lease 204", async () => {
    let server: DaemonServer | null = null;
    try {
      db.close();
      process.env.PARLEY_LONG_POLL_MS = "100";
      writeConfig(home, {
        runners: { gpu: { token: "secret-gpu" } },
      });
      server = await startServer(homePaths(home));
      const base = `http://127.0.0.1:${server.port}`;
      const auth = { authorization: "Bearer secret-gpu" };

      const reg = await fetch(`${base}/runner/register`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          runner: "gpu",
          protocol_version: 1,
          build_version: "t",
          capabilities: { vendors: [{ id: "fake", models: [] }] },
        }),
      });
      expect(reg.status).toBe(200);

      const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-cwd-"));
      homes.push(cwdDir);
      // --cwd: omit use_worktree (false). Local is capable via FAKE_BIN.
      const created = await fetch(`${base}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "cwd local",
          vendor: "fake",
          cwd: cwdDir,
          orchestrator_session_id: "s",
        }),
      });
      expect(created.status).toBe(201);
      const taskId = ((await created.json()) as { task_id: string }).task_id;

      const detail = await fetch(`${base}/tasks/${taskId}`);
      expect(detail.status).toBe(200);
      const row = ((await detail.json()) as { row: TaskRow }).row;
      expect(row.placement).toBe("local");
      expect(row.runner).toBeNull();
      expect(row.routing_deadline_at).toBeNull();
      expect(row.cwd).toBe(path.resolve(cwdDir));
      // Context materializes under the given cwd, not a worktree.
      expect(fs.existsSync(path.join(cwdDir, ".parley"))).toBe(true);

      const lease = await fetch(`${base}/runner/lease`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ runner: "gpu" }),
      });
      expect(lease.status).toBe(204);
    } finally {
      if (server) await server.close();
      delete process.env.PARLEY_LONG_POLL_MS;
      // Restore a db handle so afterEach can close safely.
      try {
        db = openDatabase(homePaths(home));
      } catch {
        /* */
      }
    }
  });

  it("remote placement never flips to local when runner goes offline (G1)", () => {
    upsertRunner(db, {
      name: "gpu",
      capabilities: JSON.stringify({ vendors: [{ id: "fake", models: [] }] }),
      protocol_version: 1,
      build_version: "t",
    });
    const repo = makeOriginRepo();
    // Simulate remote-routed row: worktree deliberately not cut (cwd = repo root).
    const row = insertTask(db, {
      id: "t-remote",
      name: null,
      vendor: "fake",
      model: "fake-model",
      effort: "medium",
      profile: null,
      runner: null,
      repo,
      repo_key: "github.com/org/r",
      repo_fetch_url: "https://github.com/org/r.git",
      cwd: repo,
      prompt: "remote",
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
      placement: "remote",
    });
    updateTask(db, row.id, {
      routing_deadline_at: new Date(Date.now() + 60_000).toISOString(),
      queue_reason: "waiting for capable runner: gpu (offline)",
    });

    const engine = new TaskEngine(
      db,
      homePaths(home),
      createAdapterRegistrySync(process.env),
    );
    // Original runner offline; local is still capable via FAKE_BIN.
    engine.setRunnerOnlineProbe(() => false);
    (engine as unknown as { dispatchClaim: (t: TaskRow) => void }).dispatchClaim(
      getTask(db, "t-remote")!,
    );

    let after = getTask(db, "t-remote")!;
    expect(after.placement).toBe("remote");
    expect(after.runner).toBeNull();
    expect(after.routing_deadline_at).not.toBeNull();
    // Must NOT have started locally in the user's checkout.
    expect(["pending"]).toContain(after.state);
    expect(fs.existsSync(path.join(repo, ".parley"))).toBe(false);

    // A different capable runner registers online → still remote (claimable), never local.
    upsertRunner(db, {
      name: "cpu",
      capabilities: JSON.stringify({ vendors: [{ id: "fake", models: [] }] }),
      protocol_version: 1,
      build_version: "t",
    });
    engine.setRunnerOnlineProbe((name) => name === "cpu");
    engine.redispatchRoutingWaits();
    after = getTask(db, "t-remote")!;
    expect(after.placement).toBe("remote");
    expect(after.state).toBe("pending");
    expect(fs.existsSync(path.join(repo, ".parley"))).toBe(false);
    // Now claimable by the new online runner.
    const claim = selectClaimablePendingTask(db, {
      executorName: "cpu",
      vendorIds: ["fake"],
      onlinePeers: [{ name: "cpu", vendorIds: ["fake"], last_completed_at: null }],
    });
    expect(claim?.id).toBe("t-remote");
  });

  it("placement survives daemon restart (remote stays remote after rearm)", async () => {
    let server: DaemonServer | null = null;
    try {
      db.close();
      process.env.PARLEY_FAKE_VENDOR_BIN = ""; // local cannot run fake
      process.env.PARLEY_ROUTING_QUEUE_TIMEOUT_MS = "60000";
      writeConfig(home, {
        runners: { gpu: { token: "secret-gpu" } },
        daemon: { routing: { queueTimeoutMs: 60000 } },
      });
      server = await startServer(homePaths(home));
      const base = `http://127.0.0.1:${server.port}`;
      const auth = { authorization: "Bearer secret-gpu" };

      await fetch(`${base}/runner/register`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          runner: "gpu",
          protocol_version: 1,
          build_version: "t",
          capabilities: { vendors: [{ id: "fake", models: [] }] },
        }),
      });
      const repo = makeOriginRepo();
      const created = await fetch(`${base}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "remote durable",
          vendor: "fake",
          cwd: repo,
          use_worktree: true,
          orchestrator_session_id: "s",
        }),
      });
      expect(created.status).toBe(201);
      const taskId = ((await created.json()) as { task_id: string }).task_id;

      let detail = await fetch(`${base}/tasks/${taskId}`);
      let row = ((await detail.json()) as { row: TaskRow }).row;
      expect(row.placement).toBe("remote");
      expect(row.routing_deadline_at).not.toBeNull();

      await server.close();
      server = null;

      // Restart: rearm must keep placement remote (not flip to local).
      server = await startServer(homePaths(home));
      const base2 = `http://127.0.0.1:${server.port}`;
      await new Promise((r) => setTimeout(r, 30));
      detail = await fetch(`${base2}/tasks/${taskId}`);
      row = ((await detail.json()) as { row: TaskRow }).row;
      expect(row.placement).toBe("remote");
      expect(row.state).toBe("pending");
      expect(row.worktree).toBeNull();
      expect(fs.existsSync(path.join(repo, ".parley"))).toBe(false);
    } finally {
      if (server) await server.close();
      delete process.env.PARLEY_ROUTING_QUEUE_TIMEOUT_MS;
      try {
        db = openDatabase(homePaths(home));
      } catch {
        /* */
      }
    }
  });

  it("rejects --runner local at delegate (G4)", async () => {
    let server: DaemonServer | null = null;
    try {
      db.close();
      writeConfig(home, {
        runners: { local: { token: "secret-local" } },
      });
      server = await startServer(homePaths(home));
      const base = `http://127.0.0.1:${server.port}`;
      const repo = makeOriginRepo();
      const created = await fetch(`${base}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "pin local",
          vendor: "fake",
          cwd: repo,
          use_worktree: true,
          runner: "local",
          orchestrator_session_id: "s",
        }),
      });
      expect(created.status).toBe(400);
      const bodyText = await created.text();
      expect(bodyText).toMatch(/omit --runner to run locally|reserved/i);
    } finally {
      if (server) await server.close();
      try {
        db = openDatabase(homePaths(home));
      } catch {
        /* */
      }
    }
  });
});

describe("crash sweep preserves routing-wait pending (F8)", () => {
  it("pending routing-wait survives; local running is stalled", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-sweep-"));
    homes.push(home);
    const db = openDatabase(homePaths(home));
    insertTask(db, {
      id: "t-wait",
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      runner: null,
      repo: home,
      cwd: home,
      prompt: "wait",
      orchestrator_session_id: "s",
      worktree: null,
      branch: null,
      base_sha: null,
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "other",
    });
    updateTask(db, "t-wait", {
      queue_reason: "waiting for capable runner: gpu (offline)",
      routing_deadline_at: new Date(Date.now() + 60_000).toISOString(),
    });
    insertTask(db, {
      id: "t-run",
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      runner: null,
      repo: home,
      cwd: home,
      prompt: "run",
      orchestrator_session_id: "s",
      worktree: path.join(home, "wt"),
      branch: "b",
      base_sha: "a",
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "other",
    });
    writeTaskState(db, "t-run", "running", {
      started_at: new Date().toISOString(),
    });

    const n = sweepInterruptedTasks(db);
    expect(n).toBe(1);
    expect(getTask(db, "t-wait")!.state).toBe("pending");
    expect(getTask(db, "t-wait")!.queue_reason).toMatch(/waiting/);
    expect(getTask(db, "t-run")!.state).toBe("stalled");
    db.close();
  });
});

describe("detectHarnesses env bin overrides (F9)", () => {
  it("advertises a vendor when PARLEY_<VENDOR>_BIN points at an existing binary on empty PATH", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "parley-bin-"));
    homes.push(bin);
    const fakePath = path.join(bin, "openhands-bin");
    fs.writeFileSync(fakePath, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    const found = detectHarnesses(
      {},
      {
        ...process.env,
        PATH: "",
        PARLEY_OPENHANDS_BIN: fakePath,
        PARLEY_FAKE_VENDOR_BIN: undefined,
      },
    );
    expect(found).toContain("openhands");
  });
});

describe("git-auth fail-once-then-avoid (#317)", () => {
  it("partitionFleetForRepo excludes runners with recorded unreachability", () => {
    const fleet: ExecutorCapability[] = [
      localFake,
      {
        ...gpuFakeOnline,
        unreachable_repos: {
          "github.com/org/repo": { code: "push_denied", at: "2026-01-01T00:00:00.000Z" },
        },
      },
      cpuCodexOnline,
    ];
    const { eligible, excluded } = partitionFleetForRepo(fleet, "github.com/org/repo");
    expect(eligible.map((e) => e.name).sort()).toEqual(["cpu", "local"]);
    expect(excluded).toEqual([
      {
        name: "gpu",
        repo_key: "github.com/org/repo",
        code: "push_denied",
      },
    ]);
    // No-origin tasks exclude nobody.
    expect(partitionFleetForRepo(fleet, null).excluded).toEqual([]);
  });

  it("formatRepoExclusion names runner, repo, and human code", () => {
    expect(
      formatRepoExclusion({
        name: "gpu",
        repo_key: "github.com/org/repo",
        code: "push_denied",
      }),
    ).toBe("gpu excluded: cannot reach github.com/org/repo (push denied)");
  });

  it("no-match diagnosis appends exclusion notes", () => {
    const fleet = [localFake, gpuFakeOnline];
    const exclusions = [
      {
        name: "gpu",
        repo_key: "github.com/org/repo",
        code: "push_denied" as const,
      },
    ];
    // After excluding gpu, only local remains — but for a remote-only fail:
    const msg = formatCapabilityDiagnosis({
      vendor: "fake",
      fleet,
      reason: "no_capable",
      exclusions,
    });
    expect(msg).toMatch(/gpu excluded: cannot reach github.com\/org\/repo \(push denied\)/);
  });

  it("decideDispatch fails pin when pinned runner is repo-excluded", () => {
    const fleet: ExecutorCapability[] = [
      {
        ...gpuFakeOnline,
        unreachable_repos: {
          "github.com/org/repo": { code: "push_denied", at: "t" },
        },
      },
    ];
    const { eligible, excluded } = partitionFleetForRepo(fleet, "github.com/org/repo");
    const match = matchExecutors(eligible, "fake", "gpu");
    const d = decideDispatch(match, fleet, "fake", "gpu", excluded);
    expect(d.kind).toBe("fail");
    if (d.kind === "fail") {
      expect(d.diagnosis).toMatch(/runner "gpu" cannot reach github.com\/org\/repo/);
      expect(d.diagnosis).toMatch(/push denied/);
      // LOW-6: exclusion stated once, not duplicated by withExclusions.
      const hits = d.diagnosis.match(/cannot reach github\.com\/org\/repo/g) ?? [];
      expect(hits.length).toBe(1);
      expect(d.diagnosis).not.toMatch(/gpu excluded:/);
    }
  });

  it("claim SELECT skips tasks whose repo_key is unreachable for the claimer", () => {
    const db = openDb();
    seedPending(db, { id: "t1", vendor: "fake", runner: null });
    seedPending(db, { id: "t2", vendor: "fake", runner: null });
    // t1 is for github.com/org/repo (seed default); mark it unreachable.
    const blocked = listCapablePendingTasks(db, {
      executorName: "gpu",
      vendorIds: ["fake"],
      unreachableRepoKeys: ["github.com/org/repo"],
    });
    expect(blocked).toEqual([]);

    const open = listCapablePendingTasks(db, {
      executorName: "gpu",
      vendorIds: ["fake"],
      unreachableRepoKeys: ["github.com/other"],
    });
    expect(open.map((t) => t.id)).toEqual(["t1", "t2"]);

    const claim = selectClaimablePendingTask(db, {
      executorName: "gpu",
      vendorIds: ["fake"],
      unreachableRepoKeys: ["github.com/org/repo"],
      onlinePeers: [{ name: "gpu", vendorIds: ["fake"], last_completed_at: null }],
    });
    expect(claim).toBeUndefined();
  });

  it("markRunnerUnreachable + upsertRunner clear restores eligibility", () => {
    const db = openDb();
    upsertRunner(db, {
      name: "gpu",
      capabilities: JSON.stringify({ vendors: [{ id: "fake", models: [] }] }),
      protocol_version: 1,
      build_version: "t",
    });
    markRunnerUnreachable(db, "gpu", "github.com/org/repo", {
      code: "push_denied",
      at: new Date().toISOString(),
      operation: "push",
    });
    let row = getRunner(db, "gpu")!;
    expect(parseUnreachableRepos(row.unreachable_repos)["github.com/org/repo"]?.code).toBe(
      "push_denied",
    );

    // Re-register clears the map.
    upsertRunner(db, {
      name: "gpu",
      capabilities: JSON.stringify({ vendors: [{ id: "fake", models: [] }] }),
      protocol_version: 1,
      build_version: "t2",
    });
    row = getRunner(db, "gpu")!;
    expect(row.unreachable_repos).toBeNull();
    expect(parseUnreachableRepos(row.unreachable_repos)).toEqual({});
  });

  it("failRunnerTask with git_auth category records memory and error_category", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-git-auth-"));
    homes.push(home);
    const db = openDatabase(homePaths(home));
    upsertRunner(db, {
      name: "gpu",
      capabilities: JSON.stringify({ vendors: [{ id: "fake", models: [] }] }),
      protocol_version: 1,
      build_version: "t",
    });
    const task = insertTask(db, {
      id: "t-fail",
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      runner: "gpu",
      repo: "/repo",
      repo_key: "github.com/org/repo",
      repo_fetch_url: "https://github.com/org/repo.git",
      cwd: "/repo",
      prompt: "x",
      orchestrator_session_id: "s",
      worktree: null,
      branch: "parley/t-fail",
      base_sha: "abc",
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "other",
      placement: "remote",
    });
    writeTaskState(db, task.id, "running", {
      started_at: new Date().toISOString(),
    });

    const engine = new TaskEngine(
      db,
      homePaths(home),
      createAdapterRegistrySync(process.env),
    );
    // Wire only needs kind/operation/code — engine fills identity.
    engine.failRunnerTask("t-fail", "gpu", "push denied at claim time (branch x): DENIED", {
      kind: "git_auth",
      operation: "push",
      code: "push_denied",
    });

    const failed = getTask(db, "t-fail")!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/push denied/);
    expect(failed.error_category).toMatch(/"kind":"git_auth"/);
    expect(failed.error_category).toMatch(/push_denied/);
    // Daemon-owned identity on the stored category.
    const cat = JSON.parse(failed.error_category!) as {
      repo_key: string;
      runner: string;
    };
    expect(cat.repo_key).toBe("github.com/org/repo");
    expect(cat.runner).toBe("gpu");

    const runner = getRunner(db, "gpu")!;
    const map = parseUnreachableRepos(runner.unreachable_repos);
    expect(map["github.com/org/repo"]?.code).toBe("push_denied");
    expect(map["github.com/org/repo"]?.operation).toBe("push");

    // Second claim for same repo is skipped.
    seedPending(db, { id: "t-next", vendor: "fake", runner: null });
    const claim = selectClaimablePendingTask(db, {
      executorName: "gpu",
      vendorIds: ["fake"],
      unreachableRepoKeys: Object.keys(map),
      onlinePeers: [{ name: "gpu", vendorIds: ["fake"], last_completed_at: null }],
    });
    expect(claim).toBeUndefined();
  });

  it("failRunnerTask ignores spoofed wire repo_key / runner (daemon owns identity)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-git-auth-spoof-"));
    homes.push(home);
    const db = openDatabase(homePaths(home));
    upsertRunner(db, {
      name: "gpu",
      capabilities: JSON.stringify({ vendors: [{ id: "fake", models: [] }] }),
      protocol_version: 1,
      build_version: "t",
    });
    insertTask(db, {
      id: "t-spoof",
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      runner: "gpu",
      repo: "/repo",
      repo_key: "github.com/real/repo",
      repo_fetch_url: "https://github.com/real/repo.git",
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
      placement: "remote",
    });
    writeTaskState(db, "t-spoof", "running", {
      started_at: new Date().toISOString(),
    });

    const engine = new TaskEngine(
      db,
      homePaths(home),
      createAdapterRegistrySync(process.env),
    );
    // Engine API only accepts kind/operation/code — identity is daemon-owned.
    engine.failRunnerTask("t-spoof", "gpu", "denied", {
      kind: "git_auth",
      operation: "push",
      code: "push_denied",
    });

    const failed = getTask(db, "t-spoof")!;
    const cat = JSON.parse(failed.error_category!) as {
      repo_key: string;
      runner: string;
    };
    expect(cat.repo_key).toBe("github.com/real/repo");
    expect(cat.runner).toBe("gpu");
    const map = parseUnreachableRepos(getRunner(db, "gpu")!.unreachable_repos);
    expect(map["github.com/real/repo"]?.code).toBe("push_denied");
    expect(map["evil.com/other/repo"]).toBeUndefined();
  });

  it("excluded warm peer does not hold warm reservation (cpu claims immediately)", () => {
    const db = openDb();
    // Unpinned task for github.com/org/repo (seed default).
    seedPending(db, {
      id: "t-warm",
      vendor: "fake",
      runner: null,
      created_at: new Date().toISOString(),
    });
    // gpu is warmer (recent completion) but excluded for this repo.
    // cpu is colder / never completed. Without exclusion filtering, gpu would
    // hold the 5s reservation and cpu could not claim immediately.
    const claim = selectClaimablePendingTask(db, {
      executorName: "cpu",
      vendorIds: ["fake"],
      nowMs: Date.now(), // well within reservation window
      reservationMs: 5_000,
      onlinePeers: [
        {
          name: "gpu",
          vendorIds: ["fake"],
          last_completed_at: new Date().toISOString(),
          unreachableRepoKeys: ["github.com/org/repo"],
        },
        {
          name: "cpu",
          vendorIds: ["fake"],
          last_completed_at: null,
          unreachableRepoKeys: [],
        },
      ],
    });
    expect(claim?.id).toBe("t-warm");
  });

  it("queue_reason is refreshed when exclusions change on re-dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-qreason-"));
    homes.push(home);
    writeConfig(home, {
      runners: { gpu: { token: "secret-gpu" }, cpu: { token: "secret-cpu" } },
    });
    process.env.PARLEY_FAKE_VENDOR_BIN = ""; // local cannot run fake
    process.env.PARLEY_ROUTING_QUEUE_TIMEOUT_MS = "60000";
    const db = openDatabase(homePaths(home));
    // Only offline capable → wait with base reason.
    upsertRunner(db, {
      name: "gpu",
      capabilities: JSON.stringify({ vendors: [{ id: "fake", models: [] }] }),
      protocol_version: 1,
      build_version: "t",
    });
    markRunnerUnreachable(db, "gpu", "github.com/org/r", {
      code: "push_denied",
      at: new Date().toISOString(),
      operation: "push",
    });
    const row = insertTask(db, {
      id: "t-q",
      name: null,
      vendor: "fake",
      model: null,
      effort: null,
      profile: null,
      runner: null,
      repo: home,
      repo_key: "github.com/org/r",
      repo_fetch_url: "https://github.com/org/r.git",
      cwd: home,
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
      placement: "remote",
    });
    // Seed a stale queue_reason without exclusion notes.
    updateTask(db, row.id, {
      queue_reason: "waiting for capable runner: gpu (offline)",
      routing_deadline_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const engine = new TaskEngine(
      db,
      homePaths(home),
      createAdapterRegistrySync(process.env),
    );
    engine.setRunnerOnlineProbe(() => false);
    engine.redispatchRoutingWaits();

    const after = getTask(db, "t-q")!;
    expect(after.queue_reason ?? "").toMatch(/excluded|cannot reach|push denied/);
    delete process.env.PARLEY_ROUTING_QUEUE_TIMEOUT_MS;
    delete process.env.PARLEY_FAKE_VENDOR_BIN;
  });
});
