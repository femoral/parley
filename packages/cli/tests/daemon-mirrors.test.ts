/**
 * #318 — daemon local-mirror execution, same-host fast path, clones list/prune.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

let home: string;
const repos: string[] = [];

beforeEach(() => {
  home = makeHome();
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(withFakeAllowlist({})),
  );
});

afterEach(async () => {
  cleanupHome(home);
  for (const repo of repos.splice(0)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

async function bootDaemon(): Promise<void> {
  const boot = await runCli(["daemon", "start"], home, {
    extraEnv: {
      PARLEY_LONG_POLL_MS: "300",
      PARLEY_REPORT_ACCEPTED_FALLBACK_MS: "500",
    },
  });
  expect(boot.code).toBe(0);
  await waitFor(
    () => fs.existsSync(path.join(home, "daemon.json")),
    "daemon discovery",
  );
}

async function waitTerminal(
  taskId: string,
  timeoutMs = 25_000,
): Promise<{ state: string; branch: string | null; error: string | null; worktree: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let last = {
    state: "",
    branch: null as string | null,
    error: null as string | null,
    worktree: null as string | null,
  };
  while (Date.now() < deadline) {
    const status = await runCli(["status", taskId, "--json"], home);
    if (status.code === 0) {
      last = JSON.parse(status.stdout) as typeof last;
      if (last.state === "completed" || last.state === "failed") return last;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

describe("daemon mirror execution (#318)", () => {
  it("remote-daemon case: missing path + fetch URL → mirror + branch on origin", async () => {
    await bootDaemon();

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "parley-bare-origin-"));
    repos.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: bare,
      stdio: "ignore",
    });
    const repo = makeGitRepo(
      [
        { emit: { type: "session", session_id: "daemon-mirror-sess" } },
        {
          submit_report: {
            summary: "daemon mirror e2e",
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
    const baseSha = git(repo, ["rev-parse", "HEAD"]);

    // Fabricated path: does not exist on the daemon host.
    const fabricated = path.join(os.tmpdir(), `parley-missing-${Date.now()}`);
    expect(fs.existsSync(fabricated)).toBe(false);

    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;

    const res = await fetch(`${daemonUrl}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "run via daemon mirror",
        vendor: "fake",
        name: "daemon-mirror",
        cwd: fabricated,
        use_worktree: true,
        repo_fetch_url: bare,
        base_sha: baseSha,
        ancestry_chain: [],
        workspace_root: fabricated,
        contexts: [],
      }),
    });
    expect(res.status).toBe(201);
    const ack = (await res.json()) as { task_id: string };
    const row = await waitTerminal(ack.task_id);
    expect(row.state).toBe("completed");
    expect(row.branch).toMatch(/^parley\//);

    // Managed mirror was created under the daemon home.
    const clonesDir = homePaths(home).clones;
    expect(fs.existsSync(clonesDir)).toBe(true);
    const mirrors = fs
      .readdirSync(clonesDir)
      .filter((n) => !n.startsWith(".") && !n.endsWith(".lock"));
    expect(mirrors.length).toBeGreaterThanOrEqual(1);

    // Branch on bare origin.
    const remoteBranches = execFileSync("git", ["-C", bare, "branch"], {
      encoding: "utf8",
    });
    expect(remoteBranches).toContain(row.branch!);
  }, 60_000);

  it("same-host fast path: no clones dir entry, branch in local repo", async () => {
    await bootDaemon();

    const repo = makeGitRepo([
      { emit: { type: "session", session_id: "fast-path-sess" } },
      {
        submit_report: {
          summary: "fast path",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);
    repos.push(repo);

    const del = await runCli(
      ["delegate", "-v", "fake", "-n", "fast-local", "run local"],
      home,
      { cwd: repo },
    );
    expect(del.code).toBe(0);
    const { task_id: taskId } = JSON.parse(del.stdout) as { task_id: string };
    const row = await waitTerminal(taskId);
    expect(row.state).toBe("completed");
    expect(row.branch).toMatch(/^parley\//);
    expect(row.error).toBeNull();

    // Fast path: no managed clones created (no origin push either).
    const clonesDir = homePaths(home).clones;
    if (fs.existsSync(clonesDir)) {
      const mirrors = fs
        .readdirSync(clonesDir)
        .filter((n) => !n.startsWith(".") && !n.endsWith(".lock"));
      expect(mirrors).toEqual([]);
    }

    // Branch exists in the local repo (not pushed — no origin on this fixture).
    const localBranches = execFileSync("git", ["-C", repo, "branch"], {
      encoding: "utf8",
    });
    expect(localBranches).toContain(row.branch!);
  }, 45_000);

  it("clones list reports sizes; prune removes only unused", async () => {
    await bootDaemon();

    // Seed a real mirror via the remote-daemon path, then leave it unused.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "parley-bare-prune-"));
    repos.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: bare,
      stdio: "ignore",
    });
    const repo = makeGitRepo(
      [
        { emit: { type: "session", session_id: "prune-sess" } },
        {
          submit_report: {
            summary: "seed mirror",
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
    const baseSha = git(repo, ["rev-parse", "HEAD"]);
    const fabricated = path.join(os.tmpdir(), `parley-missing-prune-${Date.now()}`);

    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number; url?: string };
    const daemonUrl =
      discovery.url ?? `http://127.0.0.1:${discovery.port}`;

    const res = await fetch(`${daemonUrl}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "seed",
        vendor: "fake",
        name: "seed-mirror",
        cwd: fabricated,
        use_worktree: true,
        repo_fetch_url: bare,
        base_sha: baseSha,
        ancestry_chain: [],
        workspace_root: fabricated,
        contexts: [],
      }),
    });
    expect(res.status).toBe(201);
    const ack = (await res.json()) as { task_id: string };
    const row = await waitTerminal(ack.task_id);
    expect(row.state).toBe("completed");

    const listed = await runCli(["clones", "list", "--json"], home);
    expect(listed.code).toBe(0);
    const listBody = JSON.parse(listed.stdout) as {
      clones: { name: string; size_bytes: number; used: boolean }[];
    };
    expect(listBody.clones.length).toBeGreaterThanOrEqual(1);
    expect(listBody.clones[0]!.size_bytes).toBeGreaterThan(0);
    // Task is terminal → unused.
    expect(listBody.clones.every((c) => c.used === false)).toBe(true);

    const pruned = await runCli(["clones", "prune", "--json"], home);
    expect(pruned.code).toBe(0);
    const pruneBody = JSON.parse(pruned.stdout) as {
      removed: { name: string }[];
      kept: { name: string }[];
    };
    expect(pruneBody.removed.length).toBeGreaterThanOrEqual(1);
    expect(pruneBody.kept).toEqual([]);

    const after = await runCli(["clones", "list", "--json"], home);
    expect(after.code).toBe(0);
    const afterBody = JSON.parse(after.stdout) as { clones: unknown[] };
    expect(afterBody.clones).toEqual([]);
  }, 60_000);
});

// Silence unused import when FAKE_VENDOR_BIN is only needed via env defaults.
void FAKE_VENDOR_BIN;
