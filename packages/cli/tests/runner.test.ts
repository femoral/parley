import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  makeGitRepo,
  makeHome,
  runCli,
  waitFor,
  withFakeAllowlist,
} from "./helpers.js";

let home: string;
const repos: string[] = [];

beforeEach(() => {
  home = makeHome();
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(
      withFakeAllowlist({ runners: { gpu: { token: "secret-gpu" } } }),
    ),
  );
});

afterEach(() => {
  cleanupHome(home);
  for (const repo of repos.splice(0)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

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
