import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cleanupHome,
  FAKE_VENDOR_BIN,
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
});
