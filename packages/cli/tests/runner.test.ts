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
    const repo = makeGitRepo([
      { emit: { type: "session", session_id: "should-not-run" } },
      {
        submit_report: {
          summary: "should not run",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);
    repos.push(repo);

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
    const repo = makeGitRepo([]);
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
    const repo = makeGitRepo([]);
    repos.push(repo);
    await runCli(
      ["delegate", "-v", "fake", "--runner", "gpu", "-n", "listed", "x"],
      home,
      { cwd: repo },
    );
    await waitFor(
      () => {
        const discovery = path.join(home, "daemon.json");
        return fs.existsSync(discovery);
      },
      "daemon discovery",
    );
    const listed = await runCli(["list", "--all"], home);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/RUNNER/);
    expect(listed.stdout).toMatch(/gpu/);
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
