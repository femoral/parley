import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths, readConfig } from "@useparley/core";
import { openDatabase, setRunnerLastSeen } from "../src/db.js";
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

describe("runner show / remove / stale cleanup (#320)", () => {
  it("GET /runners/:name returns full advertisement + recent tasks", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    await registerRunner(base, {
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
        // Optional wire field — mirrors may add formally later.
        repo_reachability: { "github.com/acme/app": true },
      },
    });
    const repo = makeGitRepo();
    repos.push(repo);
    const { task_id } = await createRunnerTask(base, repo, {
      name: "recent-job",
    });

    const show = await json(base, "GET", "/runners/gpu");
    expect(show.status).toBe(200);
    const body = show.body as {
      name: string;
      status: string;
      build_version: string;
      last_contact_age_ms: number;
      vendors: { id: string; models: { id: string }[] }[];
      repo_reachability: { repo_key: string; reachable: boolean }[] | null;
      recent_tasks: { id: string; name: string | null; state: string }[];
    };
    expect(body.name).toBe("gpu");
    expect(body.build_version).toBe("0.0.4-test");
    expect(body.last_contact_age_ms).toBeGreaterThanOrEqual(0);
    expect(body.vendors).toEqual([
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
    ]);
    expect(body.repo_reachability).toEqual([
      { repo_key: "github.com/acme/app", reachable: true },
    ]);
    expect(body.recent_tasks.some((t) => t.id === task_id && t.name === "recent-job")).toBe(
      true,
    );
  });

  it("GET /runners/:name reports reachability as null when not advertised", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    await registerRunner(base);
    const show = await json(base, "GET", "/runners/gpu");
    expect(show.status).toBe(200);
    expect((show.body as { repo_reachability: unknown }).repo_reachability).toBeNull();
  });

  it("GET /runners/:name returns 404 for unknown runner", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const show = await json(base, "GET", "/runners/nope");
    expect(show.status).toBe(404);
  });

  it("DELETE /runners/:name drops row + config; re-register is unknown", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    await registerRunner(base);

    const removed = await json(base, "DELETE", "/runners/gpu");
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({
      ok: true,
      name: "gpu",
      deleted_row: true,
      deleted_config: true,
    });

    const listed = await json(base, "GET", "/runners");
    expect((listed.body as { runners: unknown[] }).runners).toHaveLength(0);

    const cfg = readConfig(path.join(home, "parley.json"));
    expect(cfg.runners?.gpu).toBeUndefined();

    // Token no longer matches any configured runner → 401 unknown.
    const reReg = await registerRunner(base);
    expect(reReg.status).toBe(401);
  });

  it("DELETE /runners/:name returns 404 when neither row nor config exists", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    const removed = await json(base, "DELETE", "/runners/ghost");
    expect(removed.status).toBe(404);
  });

  it("stale rows auto-delete on list when past runnerSettings.staleWindowMs", async () => {
    // Config floor is DEFAULT_RUNNER_PRESENCE_GRACE_MS (50s); use a valid
    // window and backdate last_seen past it (env override covers short windows).
    const home = makeHome({
      runnerSettings: { staleWindowMs: 60_000 },
    });
    const { base } = await boot(home);
    await registerRunner(base);

    // Backdate last_seen past the stale window while the daemon holds the db.
    // Close server first so we can open the db file, then reopen the server.
    await server!.close();
    server = null;
    const db = openDatabase(homePaths(home));
    setRunnerLastSeen(db, "gpu", new Date(Date.now() - 120_000).toISOString());
    db.close();

    const { base: base2 } = await boot(home);
    const listed = await json(base2, "GET", "/runners");
    expect(listed.status).toBe(200);
    expect((listed.body as { runners: unknown[] }).runners).toHaveLength(0);

    // Config token remains — only the registration row is swept.
    const cfg = readConfig(path.join(home, "parley.json"));
    expect(cfg.runners?.gpu?.token).toBe("secret-gpu");
  });

  it("stale rows auto-delete via PARLEY_RUNNER_STALE_MS env override", async () => {
    process.env.PARLEY_RUNNER_STALE_MS = "30";
    try {
      const home = makeHome();
      const { base } = await boot(home);
      await registerRunner(base);
      await server!.close();
      server = null;
      const db = openDatabase(homePaths(home));
      setRunnerLastSeen(db, "gpu", new Date(Date.now() - 5_000).toISOString());
      db.close();

      const { base: base2 } = await boot(home);
      const listed = await json(base2, "GET", "/runners");
      expect((listed.body as { runners: unknown[] }).runners).toHaveLength(0);
    } finally {
      delete process.env.PARLEY_RUNNER_STALE_MS;
    }
  });

  it("DELETE config-write failure leaves the row intact (M1 atomic)", async () => {
    const home = makeHome();
    const { base } = await boot(home);
    await registerRunner(base);
    const configPath = path.join(home, "parley.json");
    // writeConfig uses temp file + rename in the home dir — make the directory
    // non-writable so the atomic write fails. File mode alone is not enough
    // (rename can still replace a read-only target when the dir is writable).
    fs.chmodSync(home, 0o555);
    try {
      const removed = await json(base, "DELETE", "/runners/gpu");
      expect(removed.status).toBe(500);
      // Row must still be present — config write failed before row delete.
      const listed = await json(base, "GET", "/runners");
      expect((listed.body as { runners: { name: string }[] }).runners).toEqual([
        expect.objectContaining({ name: "gpu" }),
      ]);
    } finally {
      fs.chmodSync(home, 0o755);
    }
    // Credential still live on disk.
    const cfg = readConfig(configPath);
    expect(cfg.runners?.gpu?.token).toBe("secret-gpu");
  });

  it("DELETE removes dotted runner names from config (M2)", async () => {
    const home = makeHome({
      runners: { "gpu.west": { token: "secret-west" } },
    });
    const { base } = await boot(home);
    const westAuth = { authorization: "Bearer secret-west" };
    const reg = await registerRunner(
      base,
      { runner: "gpu.west" },
      westAuth,
    );
    expect(reg.status).toBe(200);

    const removed = await json(base, "DELETE", "/runners/gpu.west");
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({
      ok: true,
      name: "gpu.west",
      deleted_row: true,
      deleted_config: true,
    });

    const listed = await json(base, "GET", "/runners");
    expect((listed.body as { runners: unknown[] }).runners).toHaveLength(0);

    const cfg = readConfig(path.join(home, "parley.json"));
    expect(cfg.runners?.["gpu.west"]).toBeUndefined();

    // Re-register is unknown (401) — credential gone.
    const reReg = await registerRunner(
      base,
      { runner: "gpu.west" },
      westAuth,
    );
    expect(reReg.status).toBe(401);
  });

  it("sweep excludes runners with an open lease poll (M3a)", async () => {
    process.env.PARLEY_RUNNER_STALE_MS = "30";
    try {
      const home = makeHome();
      const { base } = await boot(home);
      await registerRunner(base);

      // Hold an open long-poll so presence excludes the row from the sweep.
      // PARLEY_LONG_POLL_MS is 300 in beforeEach — start without awaiting.
      const leasePromise = json(
        base,
        "POST",
        "/runner/lease",
        { runner: "gpu" },
        auth,
      );
      // Allow the handler to call beginRunnerPoll.
      await new Promise((r) => setTimeout(r, 40));

      // Backdate last_seen past the short env window while the poll is open.
      // WAL allows a second connection against the live daemon db.
      const db = openDatabase(homePaths(home));
      setRunnerLastSeen(db, "gpu", new Date(Date.now() - 5_000).toISOString());
      db.close();

      const listed = await json(base, "GET", "/runners");
      expect(listed.status).toBe(200);
      expect((listed.body as { runners: { name: string }[] }).runners).toEqual([
        expect.objectContaining({ name: "gpu" }),
      ]);

      // Drain the long-poll (204 — no pending task).
      const lease = await leasePromise;
      expect([200, 204]).toContain(lease.status);
    } finally {
      delete process.env.PARLEY_RUNNER_STALE_MS;
    }
  });

  it("re-register after stale sweep restores the row with config kept (M3b)", async () => {
    process.env.PARLEY_RUNNER_STALE_MS = "30";
    try {
      const home = makeHome();
      const { base } = await boot(home);
      await registerRunner(base);
      await server!.close();
      server = null;
      const db = openDatabase(homePaths(home));
      setRunnerLastSeen(db, "gpu", new Date(Date.now() - 5_000).toISOString());
      db.close();

      const { base: base2 } = await boot(home);
      const listed = await json(base2, "GET", "/runners");
      expect((listed.body as { runners: unknown[] }).runners).toHaveLength(0);

      // Config token kept by sweep — re-register succeeds and restores the row.
      const reReg = await registerRunner(base2);
      expect(reReg.status).toBe(200);
      const after = await json(base2, "GET", "/runners");
      expect((after.body as { runners: { name: string }[] }).runners).toEqual([
        expect.objectContaining({ name: "gpu" }),
      ]);
    } finally {
      delete process.env.PARLEY_RUNNER_STALE_MS;
    }
  });

  it("DELETE mid-lease: next poll/heartbeat 401; task fails; daemon serves (M3c)", async () => {
    // PARLEY_RUNNER_HEARTBEAT_MS=200 is set in beforeEach.
    const home = makeHome();
    const { base } = await boot(home);
    await registerRunner(base);
    const repo = makeGitRepo();
    repos.push(repo);
    const { task_id } = await createRunnerTask(base, repo);

    const lease = await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);
    expect(lease.status).toBe(200);

    const removed = await json(base, "DELETE", "/runners/gpu");
    expect(removed.status).toBe(200);

    // Credential gone — runner surface rejects with 401.
    const hb = await json(
      base,
      "POST",
      `/runner/tasks/${task_id}/heartbeat`,
      {},
      auth,
    );
    expect(hb.status).toBe(401);

    const poll = await json(base, "POST", "/runner/lease", { runner: "gpu" }, auth);
    expect(poll.status).toBe(401);

    // Heartbeat window eventually fails the leased task; daemon stays up.
    const deadline = Date.now() + 5_000;
    let state = "";
    while (Date.now() < deadline) {
      const status = await json(base, "GET", `/tasks/${task_id}`);
      state = (status.body as { row: { state: string } }).row.state;
      if (state === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state).toBe("failed");

    const health = await json(base, "GET", "/health");
    expect(health.status).toBe(200);
  });
});
