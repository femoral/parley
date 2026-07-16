import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { startServer, type DaemonServer } from "../src/server.js";
import { makeGitRepo } from "./helpers.js";

const homes: string[] = [];
const repos: string[] = [];
let server: DaemonServer | null = null;

function makeHome(config: Record<string, unknown> = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-runner-api-"));
  homes.push(home);
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify({
      runners: { gpu: { token: "secret-gpu" } },
      ...config,
    }),
  );
  return home;
}

async function boot(home: string): Promise<{ base: string; port: number }> {
  server = await startServer(homePaths(home));
  return { base: `http://127.0.0.1:${server.port}`, port: server.port };
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
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return { status: 204, body: null };
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, body: parsed };
}

const auth = { authorization: "Bearer secret-gpu" };

async function createRunnerTask(
  base: string,
  repo: string,
  overrides: Record<string, unknown> = {},
): Promise<{ task_id: string }> {
  const res = await json(base, "POST", "/tasks", {
    prompt: "do the remote thing",
    vendor: "fake",
    orchestrator_session_id: "orch-1",
    cwd: repo,
    use_worktree: true,
    runner: "gpu",
    contexts: [{ name: "notes.md", contents: "context body\n" }],
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body as { task_id: string };
}

beforeEach(() => {
  // Fast heartbeat for sweep tests.
  process.env.PARLEY_RUNNER_HEARTBEAT_MS = "200";
  process.env.PARLEY_LONG_POLL_MS = "300";
  process.env.PARLEY_FAKE_VENDOR_BIN = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../cli/tests/fake-vendor.mjs",
  );
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
  for (const repo of repos.splice(0)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
  delete process.env.PARLEY_RUNNER_HEARTBEAT_MS;
  delete process.env.PARLEY_LONG_POLL_MS;
});

describe("runner API auth", () => {
  it("returns 401 without bearer token", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const res = await json(base, "POST", "/runner/lease", { runner: "gpu" });
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const res = await json(
      base,
      "POST",
      "/runner/lease",
      { runner: "gpu" },
      { authorization: "Bearer wrong" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token does not match the named runner", async () => {
    const home = makeHome({
      runners: {
        gpu: { token: "secret-gpu" },
        cpu: { token: "secret-cpu" },
      },
    });
    const { base } = await boot(home);
    const res = await json(
      base,
      "POST",
      "/runner/lease",
      { runner: "gpu" },
      { authorization: "Bearer secret-cpu" },
    );
    expect(res.status).toBe(401);
  });
});

describe("runner lease", () => {
  it("rejects unknown runner on delegate with 400", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const repo = makeGitRepo();
    repos.push(repo);
    const res = await json(base, "POST", "/tasks", {
      prompt: "x",
      vendor: "fake",
      orchestrator_session_id: "o",
      cwd: repo,
      use_worktree: true,
      runner: "nope",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/unknown runner/);
  });

  it("leases oldest pending task and transitions to running", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const repo = makeGitRepo();
    repos.push(repo);
    const { task_id } = await createRunnerTask(base, repo);

    // Still pending until leased.
    const before = await json(base, "GET", `/tasks/${task_id}`);
    expect((before.body as { row: { state: string; runner: string } }).row.state).toBe(
      "pending",
    );
    expect((before.body as { row: { runner: string } }).row.runner).toBe("gpu");
    expect((before.body as { task: { worktree: string | null } }).task.worktree).toBeNull();

    const lease = await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);
    expect(lease.status).toBe(200);
    const spec = lease.body as {
      task_id: string;
      prompt: string;
      vendor: string;
      repo: string;
      contexts: { name: string; contents: string }[];
      extra_args: string[];
      base_sha: string | null;
    };
    expect(spec.task_id).toBe(task_id);
    expect(spec.vendor).toBe("fake");
    expect(spec.prompt).toBe("do the remote thing");
    expect(spec.repo).toBe(repo);
    expect(spec.contexts).toEqual([{ name: "notes.md", contents: "context body\n" }]);
    expect(spec.base_sha).toMatch(/^[0-9a-f]{40}$/);

    const after = await json(base, "GET", `/tasks/${task_id}`);
    expect((after.body as { row: { state: string } }).row.state).toBe("running");
  });

  it("long-poll returns 204 when no task is pending", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const started = Date.now();
    const res = await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);
    expect(res.status).toBe(204);
    // Window is 300ms in tests; allow some slack.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it("never locally spawns a runner-affine task (stays pending)", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const repo = makeGitRepo();
    repos.push(repo);
    const { task_id } = await createRunnerTask(base, repo);
    await new Promise((r) => setTimeout(r, 400));
    const status = await json(base, "GET", `/tasks/${task_id}`);
    expect((status.body as { row: { state: string } }).row.state).toBe("pending");
    // No vendor log from a local child.
    const logPath = path.join(home, "tasks", task_id, "vendor.jsonl");
    expect(fs.existsSync(logPath)).toBe(false);
  });
});

describe("runner heartbeat / events / branch / fail", () => {
  it("fails a silent leased task when heartbeat window elapses", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const repo = makeGitRepo();
    repos.push(repo);
    const { task_id } = await createRunnerTask(base, repo);
    const lease = await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);
    expect(lease.status).toBe(200);

    // Wait past the 200ms heartbeat window without heartbeating.
    await new Promise((r) => setTimeout(r, 500));
    const status = await json(base, "GET", `/tasks/${task_id}`);
    const row = (status.body as { row: { state: string; error: string | null } }).row;
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/runner lost/);
  });

  it("heartbeat refreshes the lease", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const repo = makeGitRepo();
    repos.push(repo);
    const { task_id } = await createRunnerTask(base, repo);
    await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);

    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const hb = await json(
        base,
        "POST",
        `/runner/tasks/${task_id}/heartbeat`,
        {},
        auth,
      );
      expect(hb.status).toBe(200);
    }
    const status = await json(base, "GET", `/tasks/${task_id}`);
    expect((status.body as { row: { state: string } }).row.state).toBe("running");
  });

  it("events append JSONL and extract usage/session", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const repo = makeGitRepo();
    repos.push(repo);
    const { task_id } = await createRunnerTask(base, repo);
    await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);

    const events = await json(
      base,
      "POST",
      `/runner/tasks/${task_id}/events`,
      {
        lines: [
          JSON.stringify({ type: "session", session_id: "sess-remote-1" }),
          JSON.stringify({ type: "usage", input_tokens: 11, output_tokens: 7 }),
          "not json noise",
        ],
      },
      auth,
    );
    expect(events.status).toBe(200);

    const status = await json(base, "GET", `/tasks/${task_id}`);
    const row = (
      status.body as {
        row: { session_id: string | null; usage: string | null };
      }
    ).row;
    expect(row.session_id).toBe("sess-remote-1");
    expect(JSON.parse(row.usage!)).toEqual({ input_tokens: 11, output_tokens: 7 });

    const logPath = path.join(home, "tasks", task_id, "vendor.jsonl");
    const log = fs.readFileSync(logPath, "utf8");
    expect(log).toContain("sess-remote-1");
    expect(log).toContain("not json noise");
  });

  it("branch records the branch name with worktree null", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const repo = makeGitRepo();
    repos.push(repo);
    const { task_id } = await createRunnerTask(base, repo);
    await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);

    const br = await json(
      base,
      "POST",
      `/runner/tasks/${task_id}/branch`,
      { branch: "parley/t1-remote" },
      auth,
    );
    expect(br.status).toBe(200);

    const status = await json(base, "GET", `/tasks/${task_id}`);
    const row = (
      status.body as { row: { branch: string | null; worktree: string | null } }
    ).row;
    expect(row.branch).toBe("parley/t1-remote");
    expect(row.worktree).toBeNull();
  });

  it("fail endpoint marks the task failed", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const repo = makeGitRepo();
    repos.push(repo);
    const { task_id } = await createRunnerTask(base, repo);
    await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);

    const fail = await json(
      base,
      "POST",
      `/runner/tasks/${task_id}/fail`,
      { error: "no local repo mapping" },
      auth,
    );
    expect(fail.status).toBe(200);
    expect((fail.body as { state: string }).state).toBe("failed");

    const status = await json(base, "GET", `/tasks/${task_id}`);
    expect((status.body as { row: { error: string } }).row.error).toBe(
      "no local repo mapping",
    );
  });
});
