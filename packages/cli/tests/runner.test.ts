import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homePaths } from "@useparley/core";
import {
  cleanupHome,
  FAKE_VENDOR_BIN,
  git,
  makeGitRepo,
  makeHome,
  runCli,
  waitFor,
  withFakeAllowlist,
} from "./helpers.js";

const RUNNER_ENTRY = fileURLToPath(
  new URL("../../runner/src/main.ts", import.meta.url),
);
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

let home: string;
const repos: string[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  home = makeHome();
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(
      withFakeAllowlist({ runners: { gpu: { token: "secret-gpu" } } }),
    ),
  );
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* gone */
          }
          resolve();
        }, 2_000).unref();
      });
    }
  }
  cleanupHome(home);
  for (const repo of repos.splice(0)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function startRunner(opts: {
  home: string;
  name: string;
  token: string;
  daemonUrl: string;
  repos?: Record<string, string>;
  worktreesDir?: string;
  extraEnv?: NodeJS.ProcessEnv;
}): ChildProcess {
  const configPath = path.join(opts.home, `runner-${opts.name}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      daemonUrl: opts.daemonUrl,
      name: opts.name,
      token: opts.token,
      repos: opts.repos ?? {},
      worktreesDir: opts.worktreesDir ?? path.join(opts.home, "runner-worktrees"),
    }),
  );
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, RUNNER_ENTRY, "--config", configPath],
    {
      env: {
        ...process.env,
        PARLEY_HOME: opts.home,
        PARLEY_FAKE_VENDOR_BIN: FAKE_VENDOR_BIN,
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
        PARLEY_RUNNER_REFINGERPRINT_MS: "300",
        PARLEY_DAEMON_ID: `test-${path.basename(opts.home)}`,
        ...opts.extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  return child;
}

async function waitForRunnerOnline(
  runnerHome: string,
  name: string,
  timeoutMs = 15_000,
): Promise<{ name: string; status: string; vendors: string[] }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listed = await runCli(["runners", "list", "--json"], runnerHome);
    if (listed.code === 0) {
      try {
        const body = JSON.parse(listed.stdout) as {
          runners: { name: string; status: string; vendors: string[] }[];
        };
        const row = body.runners.find((r) => r.name === name);
        if (row && row.status === "online") return row;
      } catch {
        /* retry */
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for runner ${name} online; last list: ${listed.stdout} ${listed.stderr}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("delegate --runner affinity", () => {
  it("creates a pending runner-affine task that is never locally spawned", async () => {
    const repo = makeGitRepo(
      [
        { emit: { type: "session", session_id: "should-not-run" } },
        {
          submit_report: {
            summary: "should not run",
            outcome: "success",
            files_changed: [],
          },
        },
      ],
      {},
      { origin: "https://github.com/org/parley.git" },
    );
    repos.push(repo);

    // #315: pin requires a registered capable runner (capabilities from register).
    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;
    // Register without starting a long-lived lease loop — register only.
    const reg = await fetch(`${daemonUrl}/runner/register`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-gpu",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runner: "gpu",
        protocol_version: 1,
        build_version: "test",
        capabilities: {
          vendors: [{ id: "fake", models: [] }],
        },
      }),
    });
    expect(reg.status).toBe(200);

    const result = await runCli(
      [
        "delegate",
        "-v",
        "fake",
        "--runner",
        "gpu",
        "-n",
        "remote-job",
        "do it remotely",
      ],
      home,
      { cwd: repo },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const ack = JSON.parse(result.stdout) as { task_id: string; state: string };
    expect(ack.task_id).toBe("t1");
    expect(ack.state).toBe("pending");

    // Give the local engine time to pick up pending tasks if it wrongly would.
    await new Promise((r) => setTimeout(r, 500));

    const status = await runCli(["status", "t1", "--json"], home);
    expect(status.code).toBe(0);
    const row = JSON.parse(status.stdout) as {
      state: string;
      runner: string | null;
      worktree: string | null;
      branch: string | null;
    };
    expect(row.state).toBe("pending");
    expect(row.runner).toBe("gpu");
    expect(row.worktree).toBeNull();
    expect(row.branch).toBeNull();

    // No local vendor log — child never spawned.
    const logPath = path.join(home, "tasks", "t1", "vendor.jsonl");
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("rejects unknown --runner with exit 2", async () => {
    const repo = makeGitRepo([], {}, { origin: "https://github.com/org/parley.git" });
    repos.push(repo);
    const result = await runCli(
      ["delegate", "-v", "fake", "--runner", "nope", "x"],
      home,
      { cwd: repo },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown runner/);
  });

  it("surfaces runner on list/status table", async () => {
    const repo = makeGitRepo([], {}, { origin: "https://github.com/org/parley.git" });
    repos.push(repo);
    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;
    const reg = await fetch(`${daemonUrl}/runner/register`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-gpu",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runner: "gpu",
        protocol_version: 1,
        build_version: "test",
        capabilities: { vendors: [{ id: "fake", models: [] }] },
      }),
    });
    expect(reg.status).toBe(200);

    await runCli(
      ["delegate", "-v", "fake", "--runner", "gpu", "-n", "listed", "x"],
      home,
      { cwd: repo },
    );
    const listed = await runCli(["list", "--all"], home);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/RUNNER/);
    expect(listed.stdout).toMatch(/gpu/);
  });
});

describe("capability-matched routing (#315)", () => {
  async function bootDaemon(extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "200",
        ...extraEnv,
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    return discovery.url ?? `http://127.0.0.1:${discovery.port}`;
  }

  async function registerViaHttp(
    daemonUrl: string,
    name: string,
    token: string,
    vendors: string[],
    heldMirrors: string[] = [],
  ): Promise<void> {
    const res = await fetch(`${daemonUrl}/runner/register`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runner: name,
        protocol_version: 1,
        build_version: "test",
        capabilities: {
          vendors: vendors.map((id) => ({ id, models: [] })),
          ...(heldMirrors.length > 0 ? { held_mirrors: heldMirrors } : {}),
        },
      }),
    });
    expect(res.status).toBe(200);
  }

  it("unpinned: vendor only on runner routes to that runner (not local)", async () => {
    // Daemon without fake; real runner process advertises fake and claims.
    const repo = makeGitRepo(
      [
        { emit: { type: "session", session_id: "remote-sess" } },
        {
          submit_report: {
            summary: "ran on runner",
            outcome: "success",
            files_changed: [],
          },
        },
      ],
      {},
      { origin: "https://github.com/org/parley.git" },
    );
    repos.push(repo);

    const daemonUrl = await bootDaemon({ PARLEY_FAKE_VENDOR_BIN: "" });
    startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
      repos: { [repo]: repo },
      extraEnv: { PARLEY_FAKE_VENDOR_BIN: FAKE_VENDOR_BIN },
    });
    await waitForRunnerOnline(home, "gpu");

    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "auto-route", "route me"],
      home,
      {
        cwd: repo,
        extraEnv: { PARLEY_FAKE_VENDOR_BIN: "" },
      },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const ack = JSON.parse(result.stdout) as { task_id: string; state: string };
    expect(ack.state).toBe("pending");

    // Poll until the runner claims (runner field set) or completes.
    const deadline = Date.now() + 20_000;
    let body: { state: string; runner: string | null; worktree: string | null } | null =
      null;
    while (Date.now() < deadline) {
      const status = await runCli(["status", ack.task_id, "--json"], home);
      if (status.code === 0) {
        body = JSON.parse(status.stdout) as {
          state: string;
          runner: string | null;
          worktree: string | null;
        };
        if (body.runner === "gpu" || body.state === "completed" || body.state === "running") {
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(body).not.toBeNull();
    expect(body!.runner).toBe("gpu");
    expect(body!.worktree).toBeNull();
  });

  it("unpinned: vendor only on daemon executes locally", async () => {
    // Register a runner that only advertises a different vendor.
    const daemonUrl = await bootDaemon();
    await registerViaHttp(daemonUrl, "gpu", "secret-gpu", ["codex"]);

    const repo = makeGitRepo([
      { emit: { type: "session", session_id: "local-sess" } },
      {
        submit_report: {
          summary: "local run",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);
    repos.push(repo);

    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "local-only", "run local"],
      home,
      { cwd: repo },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const ack = JSON.parse(result.stdout) as { task_id: string; state: string };

    const deadline = Date.now() + 15_000;
    let body: { state: string; runner: string | null; worktree: string | null } | null =
      null;
    while (Date.now() < deadline) {
      const status = await runCli(["status", ack.task_id, "--json"], home);
      if (status.code === 0) {
        body = JSON.parse(status.stdout) as {
          state: string;
          runner: string | null;
          worktree: string | null;
        };
        if (body.state === "completed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(body?.state).toBe("completed");
    // Local path: never assigned to a runner (affinity / claimer stays null).
    expect(body?.runner).toBeNull();
  });

  it("warm-clone preference: mirror holder claims within reservation (#318)", async () => {
    // Two registered runners; cpu is warmer by last_completed but cold for the
    // repo; gpu advertises held_mirrors → only gpu may claim within the window.
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify(
        withFakeAllowlist({
          runners: {
            gpu: { token: "secret-gpu" },
            cpu: { token: "secret-cpu" },
          },
        }),
      ),
    );
    // Long presence grace so both peers stay online for warm ranking without
    // open lease polls (bootDaemon default is 200ms).
    const daemonUrl = await bootDaemon({
      PARLEY_FAKE_VENDOR_BIN: "",
      PARLEY_RUNNER_PRESENCE_GRACE_MS: "30_000".replace("_", ""),
    });
    await registerViaHttp(daemonUrl, "cpu", "secret-cpu", ["fake"], []);
    await registerViaHttp(
      daemonUrl,
      "gpu",
      "secret-gpu",
      ["fake"],
      ["github.com/org/parley"],
    );
    // Stamp warmth via the daemon DB (node:sqlite; vitest cannot static-import it).
    const DatabaseSync = createRequire(import.meta.url)("node:sqlite")
      .DatabaseSync as new (path: string) => {
      prepare(sql: string): { run(...args: unknown[]): void };
      close(): void;
    };
    const db = new DatabaseSync(path.join(home, "parley.db"));
    try {
      db.prepare(
        `UPDATE runners SET last_completed_at = ? WHERE name = ?`,
      ).run("2099-01-01T00:00:00.000Z", "cpu");
      db.prepare(
        `UPDATE runners SET last_completed_at = ? WHERE name = ?`,
      ).run("2000-01-01T00:00:00.000Z", "gpu");
    } finally {
      db.close();
    }

    const repo = makeGitRepo([], {}, { origin: "https://github.com/org/parley.git" });
    repos.push(repo);

    const del = await runCli(
      ["delegate", "-v", "fake", "-n", "warm-clone", "prefer mirror"],
      home,
      {
        cwd: repo,
        extraEnv: { PARLEY_FAKE_VENDOR_BIN: "" },
      },
    );
    expect(del.code).toBe(0);
    const { task_id: taskId } = JSON.parse(del.stdout) as { task_id: string };

    // Refresh last_seen so both stay online, then re-assert held_mirrors.
    await registerViaHttp(daemonUrl, "cpu", "secret-cpu", ["fake"], []);
    await registerViaHttp(
      daemonUrl,
      "gpu",
      "secret-gpu",
      ["fake"],
      ["github.com/org/parley"],
    );
    // Re-stamp warmth (re-register preserves it, but be explicit).
    {
      const db2 = new DatabaseSync(path.join(home, "parley.db"));
      try {
        db2
          .prepare(`UPDATE runners SET last_completed_at = ? WHERE name = ?`)
          .run("2099-01-01T00:00:00.000Z", "cpu");
        db2
          .prepare(`UPDATE runners SET last_completed_at = ? WHERE name = ?`)
          .run("2000-01-01T00:00:00.000Z", "gpu");
      } finally {
        db2.close();
      }
    }

    // Cold peer lease within reservation → empty (204).
    const coldLease = await fetch(`${daemonUrl}/runner/lease`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-cpu",
        "content-type": "application/json",
      },
      body: JSON.stringify({ runner: "cpu", timeout_ms: 50 }),
    });
    expect(coldLease.status).toBe(204);

    // Warm-clone peer claims.
    const warmLease = await fetch(`${daemonUrl}/runner/lease`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-gpu",
        "content-type": "application/json",
      },
      body: JSON.stringify({ runner: "gpu", timeout_ms: 200 }),
    });
    expect(warmLease.status).toBe(200);
    const lease = (await warmLease.json()) as { task_id: string };
    expect(lease.task_id).toBe(taskId);

    const status = await runCli(["status", taskId, "--json"], home);
    expect(status.code).toBe(0);
    const body = JSON.parse(status.stdout) as { runner: string | null };
    expect(body.runner).toBe("gpu");
  });

  it("pin to incapable runner fails with capability diagnosis", async () => {
    const daemonUrl = await bootDaemon();
    await registerViaHttp(daemonUrl, "gpu", "secret-gpu", ["codex"]);

    const repo = makeGitRepo([], {}, { origin: "https://github.com/org/parley.git" });
    repos.push(repo);

    const result = await runCli(
      ["delegate", "-v", "fake", "--runner", "gpu", "x"],
      home,
      { cwd: repo },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/cannot run vendor "fake"/);
    expect(result.stderr).toMatch(/advertises: codex/);
    expect(result.stderr).toMatch(/known executors/);
  });

  it("no capable executor fails immediately naming executors and vendors", async () => {
    const daemonUrl = await bootDaemon({ PARLEY_FAKE_VENDOR_BIN: "" });
    await registerViaHttp(daemonUrl, "gpu", "secret-gpu", ["codex"]);

    const repo = makeGitRepo([], {}, { origin: "https://github.com/org/parley.git" });
    repos.push(repo);

    const result = await runCli(
      ["delegate", "-v", "fake", "x"],
      home,
      {
        cwd: repo,
        extraEnv: { PARLEY_FAKE_VENDOR_BIN: "" },
      },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no capable executor for vendor "fake"/);
    expect(result.stderr).toMatch(/known executors/);
    expect(result.stderr).toMatch(/gpu=\[codex\]/);
  });

  it("capable-but-offline queues with visible reason and fails on timeout", async () => {
    // Register runner with fake, then wait past presence grace so it is offline.
    // Daemon has no fake so only the offline runner is capable.
    const daemonUrl = await bootDaemon({
      PARLEY_FAKE_VENDOR_BIN: "",
      PARLEY_RUNNER_PRESENCE_GRACE_MS: "50",
      PARLEY_ROUTING_QUEUE_TIMEOUT_MS: "800",
    });
    await registerViaHttp(daemonUrl, "gpu", "secret-gpu", ["fake"]);
    // Wait past grace — no open poll, so offline.
    await new Promise((r) => setTimeout(r, 150));

    const repo = makeGitRepo([], {}, { origin: "https://github.com/org/parley.git" });
    repos.push(repo);

    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "wait-runner", "wait"],
      home,
      {
        cwd: repo,
        extraEnv: {
          PARLEY_FAKE_VENDOR_BIN: "",
          PARLEY_ROUTING_QUEUE_TIMEOUT_MS: "800",
        },
      },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const ack = JSON.parse(result.stdout) as { task_id: string; state: string };
    expect(ack.state).toBe("pending");

    const mid = await runCli(["status", ack.task_id, "--json"], home);
    expect(mid.code).toBe(0);
    const midBody = JSON.parse(mid.stdout) as {
      state: string;
      queue_reason: string | null;
    };
    expect(midBody.state).toBe("pending");
    expect(midBody.queue_reason).toMatch(/waiting for capable runner: gpu \(offline\)/);

    // Table surface also shows the reason.
    const table = await runCli(["status", ack.task_id], home);
    expect(table.stdout).toMatch(/waiting for capable runner/);

    const failDeadline = Date.now() + 10_000;
    let failBody: { state: string; error: string | null } | null = null;
    while (Date.now() < failDeadline) {
      const failed = await runCli(["status", ack.task_id, "--json"], home);
      if (failed.code === 0) {
        failBody = JSON.parse(failed.stdout) as {
          state: string;
          error: string | null;
        };
        if (failBody.state === "failed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(failBody?.state).toBe("failed");
    expect(failBody?.error).toMatch(/routing timed out/);
    expect(failBody?.error).toMatch(/known executors/);
    expect(failBody?.error).toMatch(/gpu=\[fake\]/);
  });

  it("no-origin + --runner fails at delegate with a clear explanation", async () => {
    const repo = makeGitRepo([]); // no origin
    repos.push(repo);
    const result = await runCli(
      ["delegate", "-v", "fake", "--runner", "gpu", "x"],
      home,
      { cwd: repo },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--runner requires a git remote/);
    expect(result.stderr).toMatch(/no origin/);
  });

  it("no-origin + automatic remote path fails (F4)", async () => {
    // Local incapable; capable runner online → would be remote, but no origin.
    const daemonUrl = await bootDaemon({ PARLEY_FAKE_VENDOR_BIN: "" });
    await registerViaHttp(daemonUrl, "gpu", "secret-gpu", ["fake"]);
    const repo = makeGitRepo([]); // no origin
    repos.push(repo);
    const result = await runCli(
      ["delegate", "-v", "fake", "x"],
      home,
      {
        cwd: repo,
        extraEnv: { PARLEY_FAKE_VENDOR_BIN: "" },
      },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/remote routing requires a git remote/);
    expect(result.stderr).not.toMatch(/Remove --runner/);
  });

  it("--cwd stays local even when a capable runner is online (F3)", async () => {
    const daemonUrl = await bootDaemon();
    await registerViaHttp(daemonUrl, "gpu", "secret-gpu", ["fake"]);
    const repo = makeGitRepo([
      { emit: { type: "session", session_id: "cwd-sess" } },
      {
        submit_report: {
          summary: "cwd local",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);
    repos.push(repo);

    const result = await runCli(
      ["delegate", "-v", "fake", "--cwd", repo, "-n", "cwd-job", "run here"],
      home,
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const ack = JSON.parse(result.stdout) as { task_id: string };

    const deadline = Date.now() + 15_000;
    let body: { state: string; runner: string | null; worktree: string | null } | null =
      null;
    while (Date.now() < deadline) {
      const status = await runCli(["status", ack.task_id, "--json"], home);
      if (status.code === 0) {
        body = JSON.parse(status.stdout) as {
          state: string;
          runner: string | null;
          worktree: string | null;
        };
        if (body.state === "completed" || body.state === "failed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(body?.state).toBe("completed");
    expect(body?.runner).toBeNull();
  });
});

describe("runner registration + parley runners list", () => {
  it("registers with fake vendor, lists online, goes offline after grace", async () => {
    // Daemon must inherit presence/grace knobs (status is derived server-side).
    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;

    const runner = startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
    });

    const online = await waitForRunnerOnline(home, "gpu");
    expect(online.vendors).toContain("fake");

    const table = await runCli(["runners", "list"], home);
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/gpu/);
    expect(table.stdout).toMatch(/online/);
    expect(table.stdout).toMatch(/fake/);

    // Pin /info runner wiring (#321 H1): must go through handleInfo → listRunners(db).
    // Hardwiring runners: [] in the route leaves pure buildInfoConfig unit tests green.
    const infoJson = await runCli(["info", "--json"], home, { cwd: home });
    expect(infoJson.code).toBe(0);
    const infoConfig = JSON.parse(infoJson.stdout) as {
      executors: { name: string; status: string; vendors: string[] }[];
    };
    const gpuExec = infoConfig.executors.find((e) => e.name === "gpu");
    expect(gpuExec).toBeDefined();
    expect(gpuExec!.status).toBe("online");
    expect(gpuExec!.vendors).toContain("fake");
    const infoProse = await runCli(["info"], home, { cwd: home });
    expect(infoProse.code).toBe(0);
    expect(infoProse.stdout).toMatch(/`gpu` \(online\):.*fake/);

    // Kill the runner and wait past the presence grace for offline.
    runner.kill("SIGTERM");
    const offlineDeadline = Date.now() + 10_000;
    let offlineStatus = "";
    while (Date.now() < offlineDeadline) {
      const listed = await runCli(["runners", "list", "--json"], home);
      if (listed.code === 0) {
        try {
          const body = JSON.parse(listed.stdout) as {
            runners: { name: string; status: string }[];
          };
          const row = body.runners.find((r) => r.name === "gpu");
          if (row) {
            offlineStatus = row.status;
            if (row.status === "offline") break;
          }
        } catch {
          /* retry */
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(offlineStatus).toBe("offline");

    // Rows survive daemon restart.
    await runCli(["daemon", "stop"], home);
    await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
      },
    });
    const afterRestart = await runCli(["runners", "list", "--json"], home);
    expect(afterRestart.code).toBe(0);
    const body = JSON.parse(afterRestart.stdout) as {
      runners: { name: string; vendors: string[] }[];
    };
    expect(body.runners.some((r) => r.name === "gpu" && r.vendors.includes("fake"))).toBe(
      true,
    );
  });

  it("zero-config managed mirror: completes, pushes branch, reuses warm mirror", async () => {
    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
        PARLEY_REPORT_ACCEPTED_FALLBACK_MS: "500",
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;

    // Local bare origin + working tree with fake-vendor script committed.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "parley-bare-origin-"));
    repos.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: bare,
      stdio: "ignore",
    });
    const repo = makeGitRepo(
      [
        { emit: { type: "session", session_id: "mirror-sess" } },
        {
          submit_report: {
            summary: "mirror e2e",
            outcome: "success",
            files_changed: [],
          },
        },
      ],
      {},
      { origin: bare },
    );
    repos.push(repo);
    git(repo, ["push", "-u", "origin", "main"]);

    startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
      // zero repos — managed mirror path
      repos: {},
    });
    await waitForRunnerOnline(home, "gpu");

    const del = await runCli(
      [
        "delegate",
        "-v",
        "fake",
        "--runner",
        "gpu",
        "-n",
        "mirror-job",
        "implement via mirror",
      ],
      home,
      { cwd: repo },
    );
    expect(del.code).toBe(0);
    const { task_id: taskId } = JSON.parse(del.stdout) as { task_id: string };

    const deadline = Date.now() + 25_000;
    let state = "";
    let branch: string | null = null;
    while (Date.now() < deadline) {
      const status = await runCli(["status", taskId, "--json"], home);
      if (status.code === 0) {
        const row = JSON.parse(status.stdout) as {
          state: string;
          branch: string | null;
          error: string | null;
        };
        state = row.state;
        branch = row.branch;
        if (row.state === "completed" || row.state === "failed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(state).toBe("completed");
    expect(branch).toMatch(/^parley\//);

    // Mirror under parley home.
    const clonesDir = homePaths(home).clones;
    expect(fs.existsSync(clonesDir)).toBe(true);
    const mirrors = fs.readdirSync(clonesDir);
    expect(mirrors.length).toBe(1);
    const mirrorPath = path.join(clonesDir, mirrors[0]!);
    const mirrorIno = fs.statSync(mirrorPath).ino;

    // Branch on bare origin.
    const remoteBranches = execFileSync("git", ["-C", bare, "branch"], {
      encoding: "utf8",
    });
    expect(remoteBranches).toContain(branch!);

    // Second task reuses the same mirror directory (warm — no re-clone).
    const del2 = await runCli(
      ["delegate", "-v", "fake", "--runner", "gpu", "-n", "mirror-2", "again"],
      home,
      { cwd: repo },
    );
    expect(del2.code).toBe(0);
    const task2 = (JSON.parse(del2.stdout) as { task_id: string }).task_id;
    const deadline2 = Date.now() + 25_000;
    let state2 = "";
    while (Date.now() < deadline2) {
      const status = await runCli(["status", task2, "--json"], home);
      if (status.code === 0) {
        const row = JSON.parse(status.stdout) as { state: string };
        state2 = row.state;
        if (row.state === "completed" || row.state === "failed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(state2).toBe("completed");
    expect(fs.statSync(mirrorPath).ino).toBe(mirrorIno);
    expect(fs.readdirSync(clonesDir).length).toBe(1);
  }, 60_000);

  it("unresolvable base_sha fails at claim time without spawning vendor", async () => {
    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "parley-bare-origin-"));
    repos.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: bare,
      stdio: "ignore",
    });
    const repo = makeGitRepo(
      [
        {
          submit_report: {
            summary: "should not run",
            outcome: "success",
            files_changed: [],
          },
        },
      ],
      {},
      { origin: bare },
    );
    repos.push(repo);
    git(repo, ["push", "-u", "origin", "main"]);

    startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
      repos: {},
    });
    await waitForRunnerOnline(home, "gpu");

    // Delegate with a base ref that will not exist on the runner's fetch of origin.
    // Use a non-existent base_ref so base_sha resolution at create may fail OR
    // we force an impossible sha via a branch that is never pushed.
    // Create a local-only commit sha, record it as base, but never push it to bare.
    fs.writeFileSync(path.join(repo, "only-local.txt"), "local\n");
    git(repo, ["add", "only-local.txt"]);
    git(repo, ["commit", "-m", "local only"]);
    const localOnlySha = git(repo, ["rev-parse", "HEAD"]);
    // Reset origin/main knowledge: the bare still has the previous commit only.

    const del = await runCli(
      [
        "delegate",
        "-v",
        "fake",
        "--runner",
        "gpu",
        "--base-ref",
        localOnlySha,
        "unreachable base",
      ],
      home,
      { cwd: repo },
    );
    expect(del.code).toBe(0);
    const taskId = (JSON.parse(del.stdout) as { task_id: string }).task_id;

    const deadline = Date.now() + 20_000;
    let row: { state: string; error: string | null } | null = null;
    while (Date.now() < deadline) {
      const status = await runCli(["status", taskId, "--json"], home);
      if (status.code === 0) {
        row = JSON.parse(status.stdout) as { state: string; error: string | null };
        if (row.state === "failed" || row.state === "completed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(row?.state).toBe("failed");
    expect(row?.error ?? "").toMatch(/base_sha not resolvable from origin/);
    // Vendor never spawned — no vendor log with hello/session.
    const logPath = path.join(home, "tasks", taskId, "vendor.jsonl");
    if (fs.existsSync(logPath)) {
      expect(fs.readFileSync(logPath, "utf8")).not.toMatch(/hello|should not run|session/);
    }
  }, 40_000);

  it("denied push fails at claim time without spawning vendor", async () => {
    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "parley-bare-origin-"));
    repos.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: bare,
      stdio: "ignore",
    });
    const repo = makeGitRepo(
      [
        {
          submit_report: {
            summary: "should not run",
            outcome: "success",
            files_changed: [],
          },
        },
      ],
      {},
      { origin: bare },
    );
    repos.push(repo);
    // Seed main before installing a deny hook (and pin hooksPath — global
    // core.hooksPath would otherwise ignore the bare's hooks/).
    git(repo, ["push", "-u", "origin", "main"]);
    git(bare, ["config", "core.hooksPath", path.join(bare, "hooks")]);
    const hooks = path.join(bare, "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\necho DENIED_BY_HOOK >&2\nexit 1\n");
    fs.chmodSync(hook, 0o755);

    startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
      repos: {},
    });
    await waitForRunnerOnline(home, "gpu");

    const del = await runCli(
      ["delegate", "-v", "fake", "--runner", "gpu", "push will fail"],
      home,
      { cwd: repo },
    );
    expect(del.code).toBe(0);
    const taskId = (JSON.parse(del.stdout) as { task_id: string }).task_id;

    const deadline = Date.now() + 20_000;
    let row: { state: string; error: string | null } | null = null;
    while (Date.now() < deadline) {
      const status = await runCli(["status", taskId, "--json"], home);
      if (status.code === 0) {
        row = JSON.parse(status.stdout) as { state: string; error: string | null };
        if (row.state === "failed" || row.state === "completed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(row?.state).toBe("failed");
    expect(row?.error ?? "").toMatch(/push denied at claim time/);
    // #317: structured git-auth category (distinct from vendor failures).
    const cat = (
      row as {
        error_category?: {
          kind: string;
          operation: string;
          code: string;
          runner: string;
          repo_key: string | null;
        } | null;
      }
    ).error_category;
    expect(cat?.kind).toBe("git_auth");
    expect(cat?.operation).toBe("push");
    expect(cat?.code).toBe("push_denied");
    expect(cat?.runner).toBe("gpu");
    // Local bare path origins yield null repo_key (#313); category still lands.
    const logPath = path.join(home, "tasks", taskId, "vendor.jsonl");
    if (fs.existsSync(logPath)) {
      expect(fs.readFileSync(logPath, "utf8")).not.toMatch(/hello|should not run/);
    }

    // Human status/detail distinguishes git-auth from vendor.
    const human = await runCli(["status", taskId], home);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/failed \[git-auth:push\]/);
    expect(human.stdout).toMatch(/category:\s*git-auth \(push\)/);
    expect(human.stdout).toMatch(/code:\s*push denied/);
  }, 40_000);

  it("git-auth fail-once-then-avoid: second task skips runner until re-register (#317)", async () => {
    // Load-bearing avoidance:
    // 1. Disable re-fingerprint for the test window so the exclusion sticks.
    // 2. Make gpu warm-preferred (a prior completion) so without exclusion it
    //    would claim task 2 during the 5s reservation — only avoidance explains
    //    cpu winning.
    // 3. Assert unconditionally: task2 completed on cpu.
    const ORIGIN = "https://github.com/org/denied-repo.git";
    const REPO_KEY = "github.com/org/denied-repo";
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify(
        withFakeAllowlist({
          runners: {
            gpu: { token: "secret-gpu" },
            cpu: { token: "secret-cpu" },
          },
        }),
      ),
    );

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "parley-bare-deny-"));
    repos.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: bare,
      stdio: "ignore",
    });
    const bareUrl = pathToFileURL(bare).href;
    const insteadEnv: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${bareUrl}.insteadOf`,
      GIT_CONFIG_VALUE_0: ORIGIN,
      // vitest/env may keep underscores; use a pure integer ms string.
      PARLEY_RUNNER_REFINGERPRINT_MS: "3600000",
    };

    // Working repo: push HEAD to bare first (no deny hook yet).
    const repo = makeGitRepo(
      [
        {
          submit_report: {
            summary: "ok",
            outcome: "success",
            files_changed: [],
          },
        },
      ],
      {},
      { origin: ORIGIN },
    );
    repos.push(repo);
    execFileSync("git", ["-C", repo, "push", "-u", "origin", "HEAD:main"], {
      stdio: "ignore",
      env: { ...process.env, ...insteadEnv },
    });

    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
        // Local has no fake → remote-only routing.
        PARLEY_FAKE_VENDOR_BIN: "",
        ...insteadEnv,
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;

    // gpu only first — complete a task so it is warm-preferred over later cpu.
    startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
      repos: {},
      // insteadEnv carries PARLEY_RUNNER_REFINGERPRINT_MS=3600000 (overrides
      // startRunner default of 300ms so exclusion is not wiped mid-test).
      extraEnv: insteadEnv,
    });
    await waitForRunnerOnline(home, "gpu");

    type StatusSnap = {
      state: string;
      error: string | null;
      runner?: string | null;
      repo_key?: string | null;
      error_category?: {
        kind?: string;
        repo_key?: string | null;
        runner?: string;
        operation?: string;
        code?: string;
      } | null;
    };

    async function waitTerminal(taskId: string, ms = 40_000): Promise<StatusSnap> {
      const deadline = Date.now() + ms;
      let row: StatusSnap | null = null;
      while (Date.now() < deadline) {
        const status = await runCli(["status", taskId, "--json"], home);
        if (status.code === 0) {
          row = JSON.parse(status.stdout) as StatusSnap;
          if (row.state === "failed" || row.state === "completed") return row;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      throw new Error(`task ${taskId} did not terminate: ${JSON.stringify(row)}`);
    }

    const warmDel = await runCli(
      ["delegate", "-v", "fake", "--runner", "gpu", "warm completion for gpu"],
      home,
      { cwd: repo, extraEnv: insteadEnv },
    );
    expect(warmDel.code).toBe(0);
    const warmId = (JSON.parse(warmDel.stdout) as { task_id: string }).task_id;
    const warmRow = await waitTerminal(warmId);
    expect(warmRow.state).toBe("completed");
    expect(warmRow.runner).toBe("gpu");

    // Install deny hook — next claim-time preflight on this origin fails.
    git(bare, ["config", "core.hooksPath", path.join(bare, "hooks")]);
    const hooks = path.join(bare, "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, "pre-receive"),
      "#!/bin/sh\necho DENIED_BY_HOOK >&2\nexit 1\n",
    );
    fs.chmodSync(path.join(hooks, "pre-receive"), 0o755);

    const del1 = await runCli(
      ["delegate", "-v", "fake", "--runner", "gpu", "first fail git-auth"],
      home,
      { cwd: repo, extraEnv: insteadEnv },
    );
    expect(del1.code).toBe(0);
    const task1 = (JSON.parse(del1.stdout) as { task_id: string }).task_id;
    const row1 = await waitTerminal(task1);
    expect(row1.state).toBe("failed");
    expect(row1.error ?? "").toMatch(/push denied at claim time/);
    expect(row1.repo_key).toBe(REPO_KEY);
    expect(row1.error_category?.kind).toBe("git_auth");
    expect(row1.error_category?.repo_key).toBe(REPO_KEY);
    expect(row1.error_category?.runner).toBe("gpu");

    // Surface: runners show lists the recorded unreachability.
    const shown = await runCli(["runners", "show", "gpu"], home);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toMatch(/unreachable \(recorded\)/);
    expect(shown.stdout).toMatch(new RegExp(REPO_KEY));
    expect(shown.stdout).toMatch(/push denied/i);

    // Remove deny hook so cpu can complete; gpu still excluded until re-register.
    fs.unlinkSync(path.join(hooks, "pre-receive"));

    startRunner({
      home,
      name: "cpu",
      token: "secret-cpu",
      daemonUrl,
      repos: {},
      extraEnv: insteadEnv,
    });
    await waitForRunnerOnline(home, "cpu");

    // Unpinned: gpu is warmer (prior completion) but excluded for this repo →
    // only avoidance lets cpu claim immediately.
    const del2 = await runCli(
      ["delegate", "-v", "fake", "second must land on cpu via exclusion"],
      home,
      { cwd: repo, extraEnv: insteadEnv },
    );
    expect(del2.code).toBe(0);
    const task2 = (JSON.parse(del2.stdout) as { task_id: string }).task_id;
    const row2 = await waitTerminal(task2, 45_000);
    expect(row2.state).toBe("completed");
    expect(row2.runner).toBe("cpu");

    // Kill all runners; restart only gpu (re-register clears unreachability).
    for (const child of children.splice(0)) {
      if (!child.killed) child.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 500));
    startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
      repos: {},
      extraEnv: insteadEnv,
    });
    await waitForRunnerOnline(home, "gpu");

    // After re-register, exclusion is gone.
    const cleared = await runCli(["runners", "show", "gpu", "--json"], home);
    expect(cleared.code).toBe(0);
    const clearBody = JSON.parse(cleared.stdout) as {
      unreachable_repos: unknown[];
    };
    expect(clearBody.unreachable_repos).toEqual([]);

    const del3 = await runCli(
      ["delegate", "-v", "fake", "--runner", "gpu", "after re-register"],
      home,
      { cwd: repo, extraEnv: insteadEnv },
    );
    expect(del3.code).toBe(0);
    const task3 = (JSON.parse(del3.stdout) as { task_id: string }).task_id;
    const row3 = await waitTerminal(task3);
    expect(row3.state).toBe("completed");
    expect(row3.runner).toBe("gpu");
  }, 120_000);

  it("re-fingerprint reflects vendor capability changes without restart", async () => {
    // Unit-level re-fingerprint is covered in runner/tests; here exercise the
    // live path: a runner with fake on env stays advertised across periodic
    // re-register cycles (install-without-restart uses the same register upsert).
    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;

    startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
      extraEnv: { PARLEY_RUNNER_REFINGERPRINT_MS: "200" },
    });
    const first = await waitForRunnerOnline(home, "gpu");
    expect(first.vendors).toContain("fake");
    await new Promise((r) => setTimeout(r, 500));
    const listed = await runCli(["runners", "list", "--json"], home);
    expect(listed.code).toBe(0);
    const body = JSON.parse(listed.stdout) as {
      runners: { name: string; status: string; vendors: string[] }[];
    };
    const row = body.runners.find((r) => r.name === "gpu");
    expect(row?.status).toBe("online");
    expect(row?.vendors).toContain("fake");
  });

  it("runners show renders advertisement; remove drops row + config", async () => {
    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;

    startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
    });
    await waitForRunnerOnline(home, "gpu");

    const shown = await runCli(["runners", "show", "gpu", "--json"], home);
    expect(shown.code).toBe(0);
    const detail = JSON.parse(shown.stdout) as {
      name: string;
      vendors: { id: string; models: unknown[] }[];
      build_version: string;
      last_contact_age_ms: number;
      repo_reachability: unknown;
      recent_tasks: unknown[];
    };
    expect(detail.name).toBe("gpu");
    expect(detail.vendors.some((v) => v.id === "fake")).toBe(true);
    expect(detail.last_contact_age_ms).toBeGreaterThanOrEqual(0);
    // Reachability is not on the wire yet from packages/runner — graceful null.
    expect(detail.repo_reachability).toBeNull();
    expect(
      (detail as { unreachable_repos?: unknown[] }).unreachable_repos ?? [],
    ).toEqual([]);
    expect(Array.isArray(detail.recent_tasks)).toBe(true);

    const text = await runCli(["runners", "show", "gpu"], home);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/name:\s+gpu/);
    expect(text.stdout).toMatch(/models:/);
    expect(text.stdout).toMatch(/not advertised/);
    expect(text.stdout).toMatch(/recent_tasks:/);
    // #329: advertisement age alongside last-contact age.
    expect(text.stdout).toMatch(/last_contact:\s+\S+/);
    expect(text.stdout).toMatch(/advertisement:\s+\S+/);
    expect(detail).toMatchObject({
      capabilities_updated_at: expect.stringMatching(/^\d{4}-/),
      advertisement_age_ms: expect.any(Number),
    });

    const removed = await runCli(["runners", "remove", "gpu", "--json"], home);
    expect(removed.code).toBe(0);
    const rm = JSON.parse(removed.stdout) as {
      ok: boolean;
      deleted_row: boolean;
      deleted_config: boolean;
    };
    expect(rm.ok).toBe(true);
    expect(rm.deleted_row).toBe(true);
    expect(rm.deleted_config).toBe(true);

    const listed = await runCli(["runners", "list", "--json"], home);
    expect(listed.code).toBe(0);
    const body = JSON.parse(listed.stdout) as { runners: unknown[] };
    expect(body.runners).toHaveLength(0);

    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, "parley.json"), "utf8"),
    ) as { runners?: Record<string, unknown> };
    expect(cfg.runners?.gpu).toBeUndefined();
  });
});

describe("lost-runner failures carry actionable state (#319)", () => {
  async function bootWithShortHeartbeat(): Promise<string> {
    const boot = await runCli(["daemon", "start"], home, {
      extraEnv: {
        PARLEY_LONG_POLL_MS: "300",
        PARLEY_RUNNER_PRESENCE_GRACE_MS: "400",
        // Fail quickly once the runner stops heartbeating.
        PARLEY_RUNNER_HEARTBEAT_MS: "400",
      },
    });
    expect(boot.code).toBe(0);
    await waitFor(
      () => fs.existsSync(path.join(home, "daemon.json")),
      "daemon discovery",
    );
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    return discovery.url ?? `http://127.0.0.1:${discovery.port}`;
  }

  it("kill mid-task after events: failure names runner, phase, last-event age; no requeue", async () => {
    const daemonUrl = await bootWithShortHeartbeat();

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "parley-bare-lost-"));
    repos.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: bare,
      stdio: "ignore",
    });
    // Emit session + long sleep so the runner is mid-task when killed.
    const repo = makeGitRepo(
      [
        { emit: { type: "session", session_id: "lost-sess" } },
        { emit: { type: "text", text: "still working" } },
        { sleep: 60_000 },
        {
          submit_report: {
            summary: "should not finish",
            outcome: "success",
            files_changed: [],
          },
        },
      ],
      {},
      { origin: bare },
    );
    repos.push(repo);
    git(repo, ["push", "-u", "origin", "main"]);

    const runner = startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
      repos: {},
      extraEnv: {
        // Heartbeat faster than the 400ms daemon window while alive.
        PARLEY_RUNNER_HEARTBEAT_INTERVAL_MS: "80",
      },
    });
    await waitForRunnerOnline(home, "gpu");

    const del = await runCli(
      [
        "delegate",
        "-v",
        "fake",
        "--runner",
        "gpu",
        "-n",
        "lost-mid",
        "work then die",
      ],
      home,
      { cwd: repo },
    );
    expect(del.code).toBe(0);
    const taskId = (JSON.parse(del.stdout) as { task_id: string }).task_id;

    // Wait until vendor events have been streamed to the daemon.
    const eventsDeadline = Date.now() + 20_000;
    let sawEvents = false;
    while (Date.now() < eventsDeadline) {
      const logPath = path.join(home, "tasks", taskId, "vendor.jsonl");
      if (fs.existsSync(logPath)) {
        const log = fs.readFileSync(logPath, "utf8");
        if (log.includes("lost-sess") || log.includes("still working")) {
          sawEvents = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sawEvents).toBe(true);

    runner.kill("SIGKILL");

    const failDeadline = Date.now() + 15_000;
    let row: {
      state: string;
      error: string | null;
      attempt?: number;
      runner?: string | null;
    } | null = null;
    while (Date.now() < failDeadline) {
      const status = await runCli(["status", taskId, "--json"], home);
      if (status.code === 0) {
        row = JSON.parse(status.stdout) as {
          state: string;
          error: string | null;
          attempt?: number;
          runner?: string | null;
        };
        if (row.state === "failed" || row.state === "completed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(row?.state).toBe("failed");
    expect(row?.error ?? "").toMatch(/runner lost/);
    expect(row?.error ?? "").toMatch(/runner=gpu/);
    // After events streamed, phase is at least events_streamed (or later).
    expect(row?.error ?? "").toMatch(
      /phase=(events_streamed|branch_pushed|worktree_created)/,
    );
    expect(row?.error ?? "").toMatch(/last_event_age_ms=\d+/);
    expect(row?.attempt ?? 1).toBe(1);

    // Human status surfaces the enriched error (#319 CLI detail).
    const human = await runCli(["status", taskId], home);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/Error/);
    expect(human.stdout).toMatch(/runner lost/);

    // No automatic requeue: state stays failed after another heartbeat window.
    await new Promise((r) => setTimeout(r, 600));
    const again = await runCli(["status", taskId, "--json"], home);
    expect(again.code).toBe(0);
    const row2 = JSON.parse(again.stdout) as {
      state: string;
      error: string | null;
      attempt?: number;
    };
    expect(row2.state).toBe("failed");
    expect(row2.error).toBe(row?.error);
    expect(row2.attempt ?? 1).toBe(1);

    const listed = await runCli(["list", "--all", "--json"], home);
    expect(listed.code).toBe(0);
    const tasks = JSON.parse(listed.stdout) as { task_id: string }[];
    expect(tasks.filter((t) => t.task_id === taskId)).toHaveLength(1);
  }, 60_000);

  it("kill after branch push: failure includes branch name (#319)", async () => {
    const daemonUrl = await bootWithShortHeartbeat();

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "parley-bare-lost-br-"));
    repos.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: bare,
      stdio: "ignore",
    });
    // Hang mid-vendor so we can land a branch record then kill the runner.
    // Real branch handoff is after child exit; here we POST /branch once the
    // task is mid-execute (events flowing) to simulate a push that landed
    // before loss — same daemon bookkeeping as the real path.
    const repo = makeGitRepo(
      [
        { emit: { type: "session", session_id: "lost-br-sess" } },
        { emit: { type: "text", text: "before branch loss" } },
        { sleep: 60_000 },
      ],
      {},
      { origin: bare },
    );
    repos.push(repo);
    git(repo, ["push", "-u", "origin", "main"]);

    const runner = startRunner({
      home,
      name: "gpu",
      token: "secret-gpu",
      daemonUrl,
      repos: {},
      extraEnv: {
        PARLEY_RUNNER_HEARTBEAT_INTERVAL_MS: "80",
      },
    });
    await waitForRunnerOnline(home, "gpu");

    const del = await runCli(
      [
        "delegate",
        "-v",
        "fake",
        "--runner",
        "gpu",
        "-n",
        "lost-branch",
        "stream then hang",
      ],
      home,
      { cwd: repo },
    );
    expect(del.code).toBe(0);
    const taskId = (JSON.parse(del.stdout) as { task_id: string }).task_id;

    // Wait until events have streamed (task mid-execute, heartbeats alive).
    const eventsDeadline = Date.now() + 25_000;
    let sawEvents = false;
    while (Date.now() < eventsDeadline) {
      const logPath = path.join(home, "tasks", taskId, "vendor.jsonl");
      if (fs.existsSync(logPath)) {
        const log = fs.readFileSync(logPath, "utf8");
        if (log.includes("lost-br-sess") || log.includes("before branch loss")) {
          sawEvents = true;
          break;
        }
      }
      const status = await runCli(["status", taskId, "--json"], home);
      if (status.code === 0) {
        const row = JSON.parse(status.stdout) as {
          state: string;
          error: string | null;
        };
        if (row.state === "failed" || row.state === "completed") {
          throw new Error(
            `task ended before events: state=${row.state} error=${row.error}`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sawEvents).toBe(true);

    // Branch handoff that landed before the runner was lost.
    const br = await fetch(
      `${daemonUrl}/runner/tasks/${encodeURIComponent(taskId)}/branch`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer secret-gpu",
          "content-type": "application/json",
        },
        body: JSON.stringify({ branch: "parley/lost-branch-cli" }),
      },
    );
    expect(br.status).toBe(200);

    runner.kill("SIGKILL");

    const failDeadline = Date.now() + 15_000;
    let row: { state: string; error: string | null; branch: string | null } | null =
      null;
    while (Date.now() < failDeadline) {
      const status = await runCli(["status", taskId, "--json"], home);
      if (status.code === 0) {
        row = JSON.parse(status.stdout) as {
          state: string;
          error: string | null;
          branch: string | null;
        };
        if (row.state === "failed" || row.state === "completed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(row?.state).toBe("failed");
    expect(row?.branch).toBe("parley/lost-branch-cli");
    expect(row?.error ?? "").toMatch(/runner lost/);
    expect(row?.error ?? "").toMatch(/runner=gpu/);
    expect(row?.error ?? "").toMatch(/phase=branch_pushed/);
    expect(row?.error ?? "").toMatch(/branch=parley\/lost-branch-cli/);
    expect(row?.error ?? "").toMatch(/last_event_age_ms=/);
  }, 60_000);
});

describe("runners show advertisement age formatting (#329)", () => {
  it("renders finite advertisement age and unknown for pre-migration null", async () => {
    const { formatAdvertisementAge, formatShow } = await import(
      "../src/commands/runners.js"
    );
    expect(formatAdvertisementAge(5_000)).toMatch(/5s|s/);
    expect(formatAdvertisementAge(null)).toBe("unknown");
    expect(formatAdvertisementAge(undefined)).toBe("unknown");

    const rendered = formatShow({
      name: "gpu",
      status: "online",
      last_seen: "2026-08-03T00:00:00.000Z",
      registered_at: "2026-08-03T00:00:00.000Z",
      protocol_version: 1,
      build_version: "test",
      last_contact_age_ms: 1_000,
      capabilities_updated_at: null,
      advertisement_age_ms: null,
      vendors: [],
      repo_reachability: null,
      unreachable_repos: [],
      recent_tasks: [],
    });
    expect(rendered).toMatch(/last_contact:\s+1s/);
    expect(rendered).toMatch(/advertisement:\s+unknown/);
  });
});
