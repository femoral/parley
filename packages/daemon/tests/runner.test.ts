import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { startServer, type DaemonServer } from "../src/server.js";
import { makeGitRepo, withFakeAllowlist } from "./helpers.js";

const homes: string[] = [];
const repos: string[] = [];
let server: DaemonServer | null = null;

function makeHome(config: Record<string, unknown> = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-runner-api-"));
  homes.push(home);
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(
      withFakeAllowlist({
        runners: { gpu: { token: "secret-gpu" } },
        ...config,
      }),
    ),
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

/** Minimal successful register body for tests (ADR-0029). */
function registerBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runner: "gpu",
    protocol_version: 1,
    build_version: "0.0.4-test",
    capabilities: {
      vendors: [
        {
          id: "fake",
          models: [
            {
              id: "fake-model",
              efforts: ["low", "medium", "high"],
              default_effort: "medium",
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

async function registerRunner(
  base: string,
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = auth,
): Promise<{ status: number; body: unknown }> {
  return json(base, "POST", "/runner/register", registerBody(overrides), headers);
}

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
  process.env.PARLEY_RUNNER_PRESENCE_GRACE_MS = "200";
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
  delete process.env.PARLEY_RUNNER_PRESENCE_GRACE_MS;
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

describe("runner registration", () => {
  it("registers with capabilities and appears in GET /runners", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const reg = await registerRunner(base);
    expect(reg.status).toBe(200);
    const body = reg.body as {
      ok: true;
      name: string;
      registered_at: string;
      last_seen: string;
    };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("gpu");
    expect(body.registered_at).toMatch(/^\d{4}-/);

    const listed = await json(base, "GET", "/runners");
    expect(listed.status).toBe(200);
    const runners = (listed.body as { runners: { name: string; vendors: string[]; status: string }[] })
      .runners;
    expect(runners).toHaveLength(1);
    expect(runners[0]!.name).toBe("gpu");
    expect(runners[0]!.vendors).toEqual(["fake"]);
    expect(runners[0]!.status).toBe("online"); // within grace of register
  });

  it("rejects wrong protocol version with a precise error", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const reg = await registerRunner(base, { protocol_version: 0 });
    expect(reg.status).toBe(400);
    expect(JSON.stringify(reg.body)).toMatch(/incompatible runner protocol version/);
    expect(JSON.stringify(reg.body)).toMatch(/protocol_version_mismatch/);
  });

  it("rejects unknown runner name on register (401)", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const reg = await registerRunner(base, { runner: "nope" });
    expect(reg.status).toBe(401);
  });

  it("rejects lease without prior registration", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const lease = await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);
    expect(lease.status).toBe(403);
    expect(JSON.stringify(lease.body)).toMatch(/not registered/);
    expect(JSON.stringify(lease.body)).toMatch(/runner_not_registered/);
  });

  it("upsert re-register refreshes capabilities without losing registered_at", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const first = await registerRunner(base);
    expect(first.status).toBe(200);
    const firstAt = (first.body as { registered_at: string }).registered_at;
    await new Promise((r) => setTimeout(r, 20));
    const second = await registerRunner(base, {
      capabilities: {
        vendors: [
          { id: "fake", models: [] },
          { id: "codex", models: [{ id: "gpt", efforts: [], default_effort: null }] },
        ],
      },
    });
    expect(second.status).toBe(200);
    expect((second.body as { registered_at: string }).registered_at).toBe(firstAt);
    const listed = await json(base, "GET", "/runners");
    const runners = (listed.body as { runners: { vendors: string[] }[] }).runners;
    expect(runners[0]!.vendors).toEqual(["fake", "codex"]);
  });

  it("persists runner rows across daemon restart", async () => {
    // Default 50s grace keeps a just-registered row online after restart
    // (no open poll; last_seen from register is still recent).
    delete process.env.PARLEY_RUNNER_PRESENCE_GRACE_MS;
    const home = makeHome();
    const { base } = await boot(home);
    await registerRunner(base);
    await server!.close();
    server = null;
    const { base: base2 } = await boot(home);
    const listed = await json(base2, "GET", "/runners");
    expect(listed.status).toBe(200);
    const runners = (listed.body as { runners: { name: string; status: string }[] }).runners;
    expect(runners).toHaveLength(1);
    expect(runners[0]!.name).toBe("gpu");
    expect(runners[0]!.status).toBe("online");
  });

  it("just-registered runner is online with default presence grace (no env override)", async () => {
    // Regression pin for HIGH-1: Number("") === 0 must not collapse grace to 0ms.
    delete process.env.PARLEY_RUNNER_PRESENCE_GRACE_MS;
    const home = makeHome();
    const { base } = await boot(home);
    await registerRunner(base);
    const listed = await json(base, "GET", "/runners");
    expect(listed.status).toBe(200);
    const runners = (listed.body as { runners: { status: string }[] }).runners;
    expect(runners).toHaveLength(1);
    expect(runners[0]!.status).toBe("online");
  });

  it("becomes offline after grace with no open poll and no further contact", async () => {
    process.env.PARLEY_RUNNER_PRESENCE_GRACE_MS = "80";
    const home = makeHome();
    const { base } = await boot(home);
    await registerRunner(base);
    // No lease poll — only the register last_seen bump. Wait past grace.
    await new Promise((r) => setTimeout(r, 150));
    const listed = await json(base, "GET", "/runners");
    expect(listed.status).toBe(200);
    const runners = (listed.body as { runners: { status: string }[] }).runners;
    expect(runners[0]!.status).toBe("offline");
  });

  it("task-traffic heartbeat refreshes last_seen so status stays online mid-execute", async () => {
    // Serial lease→execute leaves no open poll; heartbeat must keep presence.
    process.env.PARLEY_RUNNER_PRESENCE_GRACE_MS = "80";
    const home = makeHome();
    const { base } = await boot(home);
    await registerRunner(base);
    const repo = makeGitRepo();
    repos.push(repo);
    const { task_id } = await createRunnerTask(base, repo);
    const lease = await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);
    expect(lease.status).toBe(200);
    // Lease poll ended; wait past grace with no traffic → would go offline.
    await new Promise((r) => setTimeout(r, 150));
    const before = await json(base, "GET", "/runners");
    expect(
      (before.body as { runners: { status: string }[] }).runners[0]!.status,
    ).toBe("offline");
    // Heartbeat (task traffic) must refresh last_seen without an open poll.
    const hb = await json(
      base,
      "POST",
      `/runner/tasks/${task_id}/heartbeat`,
      {},
      auth,
    );
    expect(hb.status).toBe(200);
    const after = await json(base, "GET", "/runners");
    expect(
      (after.body as { runners: { status: string }[] }).runners[0]!.status,
    ).toBe("online");
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
    await registerRunner(base);
    const repo = makeGitRepo();
    // Token-clone style origin: lease must carry stripped fetch URL + key (#313).
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "remote",
        "add",
        "origin",
        "https://x-access-token:ghp_LEASE_SECRET@github.com/org/parley.git",
      ],
      { stdio: "ignore" },
    );
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
      repo_key: string | null;
      repo_fetch_url: string | null;
      contexts: { name: string; contents: string }[];
      extra_args: string[];
      base_sha: string | null;
    };
    expect(spec.task_id).toBe(task_id);
    expect(spec.vendor).toBe("fake");
    expect(spec.prompt).toBe("do the remote thing");
    expect(spec.repo).toBe(repo);
    // Producer pins: lease carries identity from the task's origin (MEDIUM-2 / HIGH-1).
    expect(spec.repo_key).toBe("github.com/org/parley");
    expect(spec.repo_fetch_url).toBe("https://github.com/org/parley.git");
    expect(spec.repo_fetch_url).not.toContain("ghp_");
    expect(spec.repo_fetch_url).not.toMatch(/:\/\/[^/]*:[^/]*@/);
    expect(spec.contexts).toEqual([{ name: "notes.md", contents: "context body\n" }]);
    expect(spec.base_sha).toMatch(/^[0-9a-f]{40}$/);

    const after = await json(base, "GET", `/tasks/${task_id}`);
    expect((after.body as { row: { state: string } }).row.state).toBe("running");
    const row = (
      after.body as {
        row: { repo_key: string | null; repo_fetch_url: string | null };
      }
    ).row;
    expect(row.repo_key).toBe("github.com/org/parley");
    expect(row.repo_fetch_url).toBe("https://github.com/org/parley.git");
  });

  it("long-poll returns 204 when no task is pending", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    await registerRunner(base);
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
    await registerRunner(base);
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
    await registerRunner(base);
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
    await registerRunner(base);
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
    await registerRunner(base);
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
    await registerRunner(base);
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
