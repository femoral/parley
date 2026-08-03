/**
 * #313 — repo key on every task: SSH/HTTPS key equivalence, no-origin local
 * path, and status detail visibility.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  cleanupHome,
  makeGitRepo,
  makeHome,
  runCli,
  waitForState,
} from "./helpers.js";

let home: string;
const repos: string[] = [];

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of repos.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const HAPPY = [
  { emit: { type: "session", session_id: "fake-sess-repo" } },
  {
    submit_report: {
      summary: "ok",
      outcome: "success",
      files_changed: [],
    },
  },
];

async function statusJson(taskId: string): Promise<Record<string, unknown>> {
  const result = await runCli(["status", taskId, "--json"], home);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("repo key on every task (#313)", () => {
  it("folds SSH and HTTPS origins of the same repo to one key", async () => {
    const sshRepo = makeGitRepo(HAPPY, {}, {
      origin: "git@github.com:Femoral/Parley.git",
    });
    const httpsRepo = makeGitRepo(HAPPY, {}, {
      origin: "https://github.com/femoral/parley.git",
    });
    repos.push(sshRepo, httpsRepo);

    const sshDel = await runCli(
      ["delegate", "-v", "fake", "-n", "ssh-clone", "--cwd", sshRepo, "do ssh"],
      home,
      { cwd: sshRepo },
    );
    expect(sshDel.code).toBe(0);
    const sshId = (JSON.parse(sshDel.stdout) as { task_id: string }).task_id;

    const httpsDel = await runCli(
      ["delegate", "-v", "fake", "-n", "https-clone", "--cwd", httpsRepo, "do https"],
      home,
      { cwd: httpsRepo },
    );
    expect(httpsDel.code).toBe(0);
    const httpsId = (JSON.parse(httpsDel.stdout) as { task_id: string }).task_id;

    await waitForState(home, sshId, "completed");
    await waitForState(home, httpsId, "completed");

    const sshStatus = await statusJson(sshId);
    const httpsStatus = await statusJson(httpsId);

    expect(sshStatus.repo_key).toBe("github.com/femoral/parley");
    expect(httpsStatus.repo_key).toBe(sshStatus.repo_key);
    expect(sshStatus.repo_fetch_url).toBe("git@github.com:Femoral/Parley.git");
    expect(httpsStatus.repo_fetch_url).toBe("https://github.com/femoral/parley.git");
    // Local path is still the create-time checkout (distinct clones).
    expect(sshStatus.repo).toBe(sshRepo);
    expect(httpsStatus.repo).toBe(httpsRepo);
  });

  it("records only the local path when the repo has no origin", async () => {
    const repo = makeGitRepo(HAPPY);
    repos.push(repo);

    const del = await runCli(
      ["delegate", "-v", "fake", "-n", "no-origin", "--cwd", repo, "do local"],
      home,
      { cwd: repo },
    );
    expect(del.code).toBe(0);
    const taskId = (JSON.parse(del.stdout) as { task_id: string }).task_id;
    await waitForState(home, taskId, "completed");

    const status = await statusJson(taskId);
    expect(status.repo).toBe(repo);
    expect(status.repo_key).toBeNull();
    expect(status.repo_fetch_url).toBeNull();
    expect(status.state).toBe("completed");
  });

  it("shows the repo key in human status detail", async () => {
    const repo = makeGitRepo(HAPPY, {}, {
      origin: "git@github.com:org/demo.git",
    });
    repos.push(repo);

    const del = await runCli(
      ["delegate", "-v", "fake", "-n", "show-key", "--cwd", repo, "brief"],
      home,
      { cwd: repo },
    );
    expect(del.code).toBe(0);
    const taskId = (JSON.parse(del.stdout) as { task_id: string }).task_id;
    await waitForState(home, taskId, "completed");

    const human = await runCli(["status", taskId], home);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/Repo/);
    expect(human.stdout).toMatch(/key:\s+github\.com\/org\/demo/);
    expect(human.stdout).toMatch(/fetch:\s+git@github\.com:org\/demo\.git/);
  });
});
