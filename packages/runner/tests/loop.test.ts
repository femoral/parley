import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homePaths } from "@useparley/core";
import { startServer, type DaemonServer } from "@useparley/daemon/server.js";
import { RunnerLoop } from "../src/loop.js";

const FAKE_VENDOR_BIN = fileURLToPath(
  new URL("../../cli/tests/fake-vendor.mjs", import.meta.url),
);

const temps: string[] = [];
let server: DaemonServer | null = null;

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function makeGitRepo(actions: unknown[]): string {
  const dir = tmp("parley-runner-repo-");
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@parley.test"]);
  run(["config", "user.name", "parley test"]);
  // Bare origin so the runner can push the task branch.
  const origin = tmp("parley-runner-origin-");
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: origin, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, ".fake-vendor.json"), JSON.stringify(actions, null, 2));
  run(["add", "-A"]);
  run(["commit", "-m", "initial"]);
  run(["remote", "add", "origin", origin]);
  // Seed origin/main so push -u has a baseline.
  run(["push", "-u", "origin", "main"]);
  return dir;
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
    /* keep text */
  }
  return { status: res.status, body: parsed };
}

beforeEach(() => {
  // Plain decimal strings only — Number("2_000") is NaN.
  process.env.PARLEY_RUNNER_HEARTBEAT_MS = "30000";
  process.env.PARLEY_LONG_POLL_MS = "500";
  process.env.PARLEY_REPORT_ACCEPTED_FALLBACK_MS = "500";
  process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.PARLEY_RUNNER_HEARTBEAT_MS;
  delete process.env.PARLEY_LONG_POLL_MS;
  delete process.env.PARLEY_REPORT_ACCEPTED_FALLBACK_MS;
});

describe("runner loop integration", () => {
  it("zero-config: managed mirror, worktree, push branch, complete via report", async () => {
    const home = tmp("parley-runner-home-");
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify({
        runners: { gpu: { token: "secret-gpu" } },
        vendors: {
          fake: {
            models: {
              "fake-model": {
                efforts: ["low", "medium", "high"],
                default: "medium",
              },
            },
          },
        },
      }),
    );

    const repo = makeGitRepo([
      { emit: { type: "session", session_id: "remote-sess" } },
      { emit: { type: "usage", input_tokens: 5, output_tokens: 3 } },
      {
        submit_report: {
          summary: "remote done",
          outcome: "success",
          files_changed: ["README.md"],
        },
      },
    ]);
    // Origin is a local bare (file path) — lease carries repo_fetch_url.
    const origin = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim();

    server = await startServer(homePaths(home));
    const base = `http://127.0.0.1:${server.port}`;

    // #315: pin requires a registered runner that advertises the vendor.
    const reg = await json(
      base,
      "POST",
      "/runner/register",
      {
        runner: "gpu",
        protocol_version: 1,
        build_version: "test",
        capabilities: { vendors: [{ id: "fake", models: [] }] },
      },
      { authorization: "Bearer secret-gpu" },
    );
    expect(reg.status).toBe(200);

    const created = await json(base, "POST", "/tasks", {
      prompt: "run remotely",
      vendor: "fake",
      orchestrator_session_id: "orch-remote",
      cwd: repo,
      use_worktree: true,
      runner: "gpu",
      contexts: [{ name: "hint.md", contents: "be thorough\n" }],
    });
    expect(created.status).toBe(201);
    const taskId = (created.body as { task_id: string }).task_id;

    const worktreesDir = tmp("parley-runner-wts-");
    const loop = new RunnerLoop({
      config: {
        daemonUrl: base,
        name: "gpu",
        token: "secret-gpu",
        repos: {}, // zero-config — managed mirror
        worktreesDir,
      },
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_FAKE_VENDOR_BIN: FAKE_VENDOR_BIN,
      },
      log: () => {
        /* quiet in tests */
      },
    });

    const runPromise = loop.run();
    // Wait until the task completes (or fails).
    const deadline = Date.now() + 20_000;
    let row: {
      state: string;
      report: string | null;
      branch: string | null;
      usage: string | null;
      error: string | null;
    } | null = null;
    while (Date.now() < deadline) {
      const status = await json(base, "GET", `/tasks/${taskId}`);
      row = (status.body as { row: typeof row }).row;
      if (row && (row.state === "completed" || row.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    loop.stop();
    await runPromise;

    expect(row).not.toBeNull();
    expect(row!.state).toBe("completed");
    expect(JSON.parse(row!.report!)).toMatchObject({
      summary: "remote done",
      outcome: "success",
    });
    expect(row!.branch).toMatch(/^parley\//);
    expect(JSON.parse(row!.usage!)).toEqual({ input_tokens: 5, output_tokens: 3 });

    // Managed mirror was created under parley home clones/.
    const clonesDir = homePaths(home).clones;
    expect(fs.existsSync(clonesDir)).toBe(true);
    const mirrors = fs.readdirSync(clonesDir);
    expect(mirrors.length).toBeGreaterThanOrEqual(1);

    // Branch was pushed to the bare origin.
    const remoteBranches = execFileSync("git", ["-C", origin, "branch"], {
      encoding: "utf8",
    });
    expect(remoteBranches).toMatch(/parley\//);

    // Events landed in the daemon log.
    const logPath = path.join(home, "tasks", taskId, "vendor.jsonl");
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf8")).toContain("remote-sess");
  }, 30_000);

  it("repos override still routes to an operator-managed clone", async () => {
    const home = tmp("parley-runner-home-");
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify({
        runners: { gpu: { token: "secret-gpu" } },
        vendors: {
          fake: {
            models: {
              "fake-model": {
                efforts: ["low", "medium", "high"],
                default: "medium",
              },
            },
          },
        },
      }),
    );

    const repo = makeGitRepo([
      {
        submit_report: {
          summary: "override done",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);
    // Force a network-style repo_key via insteadOf is heavy; map by path id
    // (resolveRepoPath matches lease.repo when key is null for path origins).
    const runnerClone = tmp("parley-runner-clone-");
    execFileSync("git", ["clone", repo, runnerClone], { stdio: "ignore" });
    execFileSync("git", ["-C", runnerClone, "config", "user.email", "test@parley.test"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", runnerClone, "config", "user.name", "parley test"], {
      stdio: "ignore",
    });
    // Point clone's origin at the same bare as the seed repo.
    const origin = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["-C", runnerClone, "remote", "set-url", "origin", origin], {
      stdio: "ignore",
    });

    server = await startServer(homePaths(home));
    const base = `http://127.0.0.1:${server.port}`;

    const created = await json(base, "POST", "/tasks", {
      prompt: "run with override",
      vendor: "fake",
      orchestrator_session_id: "orch-remote",
      cwd: repo,
      use_worktree: true,
      runner: "gpu",
    });
    expect(created.status).toBe(201);
    const taskId = (created.body as { task_id: string }).task_id;

    const loop = new RunnerLoop({
      config: {
        daemonUrl: base,
        name: "gpu",
        token: "secret-gpu",
        // Override by orchestrator path (basename match also works).
        repos: { [repo]: runnerClone },
        worktreesDir: tmp("parley-runner-wts-"),
      },
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_FAKE_VENDOR_BIN: FAKE_VENDOR_BIN,
      },
      log: () => {},
    });

    const runPromise = loop.run();
    const deadline = Date.now() + 20_000;
    let row: { state: string; branch: string | null } | null = null;
    while (Date.now() < deadline) {
      const status = await json(base, "GET", `/tasks/${taskId}`);
      row = (status.body as { row: typeof row }).row;
      if (row && (row.state === "completed" || row.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    loop.stop();
    await runPromise;

    expect(row?.state).toBe("completed");
    expect(row?.branch).toMatch(/^parley\//);
    // Override path: no managed mirror required.
    const clonesDir = homePaths(home).clones;
    if (fs.existsSync(clonesDir)) {
      expect(fs.readdirSync(clonesDir)).toEqual([]);
    }
  }, 30_000);
});
