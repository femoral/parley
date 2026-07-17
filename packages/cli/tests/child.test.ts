import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  readDiscovery,
  runCli,
  waitFor,
  waitForState,
  type FakeVendorAction,
} from "./helpers.js";

let home: string;
const taskDirs: string[] = [];

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of taskDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function taskDir(actions: FakeVendorAction[]): string {
  const dir = makeTaskDir(actions);
  taskDirs.push(dir);
  return dir;
}

const REPORT = {
  summary: "done via http",
  outcome: "success" as const,
  files_changed: ["src/a.ts"],
};

const TASK_HEADER = "x-parley-task";

async function startDaemon(): Promise<string> {
  // Fast post-report completion so tests that submit via HTTP/CLI don't wait
  // the production 30s fallback for a still-sleeping fake vendor.
  const res = await runCli(["daemon", "start"], home, {
    extraEnv: { PARLEY_REPORT_ACCEPTED_FALLBACK_MS: "200" },
  });
  expect(res.code).toBe(0);
  const discovery = readDiscovery(home);
  if (!discovery) throw new Error("daemon did not publish discovery");
  return `http://127.0.0.1:${discovery.port}`;
}

async function childFetch(
  base: string,
  pathname: string,
  taskId: string | null,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (taskId !== null) headers[TASK_HEADER] = taskId;
  const res = await fetch(`${base}${pathname}`, { ...init, headers });
  const raw = await res.text();
  let body: unknown;
  try {
    body = raw === "" ? undefined : JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { status: res.status, body };
}

/** First `hello` event from the fake vendor's vendor.jsonl. */
async function waitForHello(
  taskId: string,
): Promise<Record<string, unknown>> {
  const logPath = path.join(home, "tasks", taskId, "vendor.jsonl");
  await waitFor(() => {
    try {
      return fs.readFileSync(logPath, "utf8").includes('"hello"');
    } catch {
      return false;
    }
  }, `hello for ${taskId}`);
  const line = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .find((l) => l.includes('"hello"'))!;
  return JSON.parse(line) as Record<string, unknown>;
}

describe("child REST surface (ADR-0011 / #109)", () => {
  it("POST /child/report accepts a valid report and rejects an invalid one", async () => {
    const base = await startDaemon();
    // Sleep forever so the task stays live for direct HTTP calls.
    const cwd = taskDir([{ sleep: 60_000 }]);
    const del = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "http report"], home);
    expect(del.code).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    await waitForHello(taskId);

    const bad = await childFetch(base, "/child/report", taskId, {
      method: "POST",
      body: JSON.stringify({ summary: "nope" }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ errors: expect.any(Array) });
    expect((bad.body as { errors: string[] }).errors.join(" ")).toMatch(/outcome|files_changed/);

    const ok = await childFetch(base, "/child/report", taskId, {
      method: "POST",
      body: JSON.stringify(REPORT),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ accepted: true });

    // Wait for post-report completion (fallback or stream close after cancel sleep).
    await waitForState(home, taskId, "completed");
    const status = await runCli(["status", taskId, "--json"], home);
    expect(JSON.parse(status.stdout).report).toEqual(REPORT);
  });

  it("POST /child/ask long-polls until answered", async () => {
    const base = await startDaemon();
    const cwd = taskDir([{ sleep: 60_000 }]);
    const del = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "http ask"], home);
    expect(del.code).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    await waitForHello(taskId);

    // Start the ask; answer after the task reaches awaiting_answer.
    const askPromise = childFetch(base, "/child/ask", taskId, {
      method: "POST",
      body: JSON.stringify({ question: "which db?" }),
    });
    await waitForState(home, taskId, "awaiting_answer");

    const answer = await runCli(["answer", taskId, "postgres"], home);
    expect(answer.code).toBe(0);

    const ask = await askPromise;
    expect(ask.status).toBe(200);
    expect(ask.body).toEqual({ answer: "postgres" });
  });

  it("GET /child/task returns the envelope; missing header is 400 naming the header", async () => {
    const base = await startDaemon();
    const cwd = taskDir([{ sleep: 60_000 }]);
    const del = await runCli(
      ["delegate", "-v", "fake", "-n", "inspect", "--cwd", cwd, "task envelope"],
      home,
    );
    expect(del.code).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    await waitForHello(taskId);

    const missing = await childFetch(base, "/child/task", null, { method: "GET" });
    expect(missing.status).toBe(400);
    expect(String((missing.body as { error: string }).error)).toMatch(new RegExp(TASK_HEADER));

    const unknown = await childFetch(base, "/child/task", "t999", { method: "GET" });
    expect(unknown.status).toBe(400);
    expect(String((unknown.body as { error: string }).error)).toMatch(new RegExp(TASK_HEADER));

    const ok = await childFetch(base, "/child/task", taskId, { method: "GET" });
    expect(ok.status).toBe(200);
    const envelope = ok.body as { task_id: string; name: string; state: string };
    expect(envelope.task_id).toBe(taskId);
    expect(envelope.name).toBe("inspect");
    expect(envelope.state).toBe("running");
  });

  it("POST /child/ask with empty question is 400", async () => {
    const base = await startDaemon();
    const cwd = taskDir([{ sleep: 60_000 }]);
    const del = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "empty ask"], home);
    expect(del.code).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    await waitForHello(taskId);

    const res = await childFetch(base, "/child/ask", taskId, {
      method: "POST",
      body: JSON.stringify({ question: "  " }),
    });
    expect(res.status).toBe(400);
    expect(String((res.body as { error: string }).error)).toMatch(/question/i);
  });
});

describe("engine hub injection (ADR-0011)", () => {
  it("injects PARLEY_HUB_URL + PARLEY_TASK_ID and materializes .parley/child.json", async () => {
    const cwd = taskDir([{ sleep: 5_000 }, { submit_report: REPORT }]);
    const del = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "inject"], home);
    expect(del.code).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    const hello = await waitForHello(taskId);

    const discovery = readDiscovery(home)!;
    const expectedUrl = `http://127.0.0.1:${discovery.port}`;
    expect(hello.parley_hub_url).toBe(expectedUrl);
    expect(hello.parley_task_id).toBe(taskId);
    expect(hello.child_json).toEqual({ url: expectedUrl, task_id: taskId });

    // File still on disk under the task cwd (engine wrote it pre-spawn).
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(cwd, ".parley", "child.json"), "utf8"),
    ) as { url: string; task_id: string };
    expect(onDisk).toEqual({ url: expectedUrl, task_id: taskId });
  });
});

describe("parley child CLI (ADR-0011 / #110)", () => {
  it("report / ask / task end-to-end against a live daemon via env", async () => {
    const base = await startDaemon();
    const cwd = taskDir([{ sleep: 60_000 }]);
    const del = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "cli child"], home);
    expect(del.code).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    await waitForHello(taskId);

    const hubEnv = {
      PARLEY_HUB_URL: base,
      PARLEY_TASK_ID: taskId,
    };

    const task = await runCli(["child", "task"], home, { extraEnv: hubEnv });
    expect(task.code).toBe(0);
    expect(JSON.parse(task.stdout).task_id).toBe(taskId);

    // Missing --outcome is usage (exit 2).
    const usage = await runCli(
      ["child", "report", "--summary", "only"],
      home,
      { extraEnv: hubEnv },
    );
    expect(usage.code).toBe(2);

    // Schema-invalid report → exit 5 with violation list.
    const badJsonPath = path.join(cwd, "bad-report.json");
    fs.writeFileSync(badJsonPath, JSON.stringify({ summary: "nope" }));
    const reject = await runCli(
      ["child", "report", "--json-file", badJsonPath],
      home,
      { extraEnv: hubEnv },
    );
    expect(reject.code).toBe(5);
    expect(reject.stderr).toMatch(/rejected|outcome|files_changed/i);

    // Ask via CLI (background), answer, collect.
    const askRun = runCli(["child", "ask", "which?"], home, { extraEnv: hubEnv });
    await waitForState(home, taskId, "awaiting_answer");
    expect((await runCli(["answer", taskId, "that one"], home)).code).toBe(0);
    const ask = await askRun;
    expect(ask.code).toBe(0);
    expect(ask.stdout.trim()).toBe("that one");

    // Accept a report via default-schema flags.
    const report = await runCli(
      [
        "child",
        "report",
        "--summary",
        "all good",
        "--outcome",
        "success",
        "--file",
        "src/a.ts",
      ],
      home,
      { extraEnv: hubEnv },
    );
    expect(report.code).toBe(0);
    expect(report.stdout).toMatch(/accepted/);

    await waitForState(home, taskId, "completed");
  });

  it("resolves hub from .parley/child.json when env is absent", async () => {
    const base = await startDaemon();
    const cwd = taskDir([{ sleep: 60_000 }]);
    const del = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "via file"], home);
    expect(del.code).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    await waitForHello(taskId);

    // Explicitly clear hub env; CLI walks up from cwd to find child.json.
    const task = await runCli(["child", "task"], home, {
      cwd,
      extraEnv: { PARLEY_HUB_URL: "", PARLEY_TASK_ID: "" },
    });
    expect(task.code).toBe(0);
    expect(JSON.parse(task.stdout).task_id).toBe(taskId);
    // Sanity: child.json points at this daemon.
    const childJson = JSON.parse(
      fs.readFileSync(path.join(cwd, ".parley", "child.json"), "utf8"),
    ) as { url: string };
    expect(childJson.url).toBe(base);
  });

  it("usage error when neither env nor child.json exists", async () => {
    // Isolated cwd under /tmp so the hub walk cannot climb into a developer
    // home that happens to hold a leftover .parley/child.json.
    const emptyCwd = taskDir([{ sleep: 60_000 }]);
    const res = await runCli(["child", "task"], home, {
      cwd: emptyCwd,
      extraEnv: { PARLEY_HUB_URL: "", PARLEY_TASK_ID: "" },
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/PARLEY_HUB_URL|child\.json/i);
  });
});
