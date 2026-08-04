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
    const logPath = path.join(home, "tasks", taskId, "vendor.jsonl");
    if (fs.existsSync(logPath)) {
      expect(fs.readFileSync(logPath, "utf8")).not.toMatch(/hello|should not run/);
    }
  }, 40_000);

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
    expect(Array.isArray(detail.recent_tasks)).toBe(true);

    const text = await runCli(["runners", "show", "gpu"], home);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/name:\s+gpu/);
    expect(text.stdout).toMatch(/models:/);
    expect(text.stdout).toMatch(/not advertised/);
    expect(text.stdout).toMatch(/recent_tasks:/);

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
