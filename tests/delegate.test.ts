import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  runCli,
  startCli,
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
  summary: "did the thing",
  outcome: "success",
  files_changed: ["src/a.ts", "src/b.ts"],
};

/** A well-behaved vendor run: session id, some chatter, usage, then a report. */
function happyActions(overrides: Partial<typeof REPORT> = {}): FakeVendorAction[] {
  return [
    { emit: { type: "session", session_id: "fake-sess-42" } },
    { emit: { type: "message", text: "working on it" } },
    { emit_raw: "not json at all — opaque vendor noise" },
    { emit: { type: "usage", input_tokens: 100, output_tokens: 25 } },
    { submit_report: { ...REPORT, ...overrides } },
  ];
}

describe("delegate --wait (the spine)", () => {
  it("runs end-to-end and prints the report envelope, exit 0", async () => {
    const cwd = taskDir(happyActions());
    const result = await runCli(
      ["delegate", "-v", "fake", "-m", "fake-model-1", "-n", "spine", "--cwd", cwd, "--wait", "do the thing"],
      home,
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.task_id).toBe("t1");
    expect(envelope.name).toBe("spine");
    expect(envelope.repo).toBe(cwd);
    expect(envelope.vendor).toBe("fake");
    expect(envelope.model).toBe("fake-model-1");
    expect(envelope.session_id).toBe("fake-sess-42");
    expect(envelope.usage).toEqual({ input_tokens: 100, output_tokens: 25 });
    expect(typeof envelope.duration_ms).toBe("number");
    expect(envelope.state).toBe("completed");
    expect(envelope.report).toEqual(REPORT);
  });

  it("captures the raw vendor stream untouched as per-task JSONL", async () => {
    const cwd = taskDir(happyActions());
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "--wait", "do it"], home);

    const log = fs.readFileSync(path.join(home, "tasks", "t1", "vendor.jsonl"), "utf8");
    const lines = log.split("\n");
    expect(lines).toContain('{"type":"session","session_id":"fake-sess-42"}');
    expect(lines).toContain("not json at all — opaque vendor noise");
    expect(lines).toContain('{"type":"usage","input_tokens":100,"output_tokens":25}');
  });

  it("bounces schema-invalid reports back as tool errors so the child can retry", async () => {
    const cwd = taskDir([
      // Missing `outcome`, wrong files_changed type — must bounce, not complete.
      { submit_report: { summary: "bad", files_changed: "nope" } },
      { submit_report: REPORT },
    ]);
    const result = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "--wait", "retry"], home);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).report).toEqual(REPORT);

    // The fake vendor echoes tool results into its stream: first errored, then ok.
    const log = fs.readFileSync(path.join(home, "tasks", "t1", "vendor.jsonl"), "utf8");
    const toolResults = log
      .split("\n")
      .filter((l) => l.includes('"tool_result"'))
      .map((l) => JSON.parse(l) as { is_error: boolean; text: string });
    expect(toolResults.map((r) => r.is_error)).toEqual([true, false]);
    expect(toolResults[0]!.text).toMatch(/outcome/);
  });

  it("passes model and vendor strings through to the adapter opaquely", async () => {
    const cwd = taskDir(happyActions());
    const weirdModel = "my/weird:model@2026-preview";
    const result = await runCli(
      ["delegate", "-v", "fake", "-m", weirdModel, "--cwd", cwd, "--wait", "opaque"],
      home,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).model).toBe(weirdModel);
    // The fake adapter hands the model to the child verbatim; the child echoes it.
    const log = fs.readFileSync(path.join(home, "tasks", "t1", "vendor.jsonl"), "utf8");
    const hello = JSON.parse(log.split("\n").find((l) => l.includes('"hello"'))!);
    expect(hello.model).toBe(weirdModel);
  });
});

describe("delegate without --wait", () => {
  it("returns {task_id, name, state} immediately; task completes in background", async () => {
    const cwd = taskDir([{ sleep: 300 }, ...happyActions()]);
    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "bg", "--cwd", cwd, "background task"],
      home,
    );

    expect(result.code).toBe(0);
    const ack = JSON.parse(result.stdout);
    expect(ack.task_id).toBe("t1");
    expect(ack.name).toBe("bg");
    expect(["pending", "running"]).toContain(ack.state);

    const row = await waitForState(home, "t1", "completed");
    expect(row.name).toBe("bg");
  });

  it("persists rows through pending → running → completed", async () => {
    const cwd = taskDir([{ sleep: 1200 }, ...happyActions()]);
    const ack = JSON.parse(
      (await runCli(["delegate", "-v", "fake", "--cwd", cwd, "slow task"], home)).stdout,
    );
    expect(["pending", "running"]).toContain(ack.state);

    await waitForState(home, "t1", "running");
    await waitForState(home, "t1", "completed");
  });
});

describe("header-based task correlation", () => {
  it("two concurrent tasks against one daemon do not cross streams", async () => {
    const cwdA = taskDir([
      { emit: { type: "session", session_id: "sess-A" } },
      { sleep: 800 },
      { submit_report: { summary: "report A", outcome: "success", files_changed: ["a"] } },
    ]);
    const cwdB = taskDir([
      { emit: { type: "session", session_id: "sess-B" } },
      { sleep: 800 },
      { submit_report: { summary: "report B", outcome: "partial", files_changed: ["b"] } },
    ]);

    const [a, b] = await Promise.all([
      runCli(["delegate", "-v", "fake", "-n", "task-a", "--cwd", cwdA, "--wait", "A"], home),
      runCli(["delegate", "-v", "fake", "-n", "task-b", "--cwd", cwdB, "--wait", "B"], home),
    ]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const envA = JSON.parse(a.stdout);
    const envB = JSON.parse(b.stdout);
    expect(envA.name).toBe("task-a");
    expect(envA.report.summary).toBe("report A");
    expect(envA.session_id).toBe("sess-A");
    expect(envB.name).toBe("task-b");
    expect(envB.report.summary).toBe("report B");
    expect(envB.session_id).toBe("sess-B");
  });
});

describe("status", () => {
  it("shows short id and name; both are accepted by task-taking commands", async () => {
    const cwd = taskDir(happyActions());
    await runCli(["delegate", "-v", "fake", "-n", "fix-auth", "--cwd", cwd, "--wait", "x"], home);

    const table = await runCli(["status"], home);
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/t1/);
    expect(table.stdout).toMatch(/fix-auth/);
    expect(table.stdout).toMatch(/completed/);

    const byId = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout);
    const byName = JSON.parse((await runCli(["status", "fix-auth", "--json"], home)).stdout);
    expect(byId).toEqual(byName);
    expect(byId[0].id).toBe("t1");
    expect(byId[0].state).toBe("completed");
  });
});

describe("logs", () => {
  it("prints the raw captured vendor stream", async () => {
    const cwd = taskDir(happyActions());
    await runCli(["delegate", "-v", "fake", "-n", "loggy", "--cwd", cwd, "--wait", "x"], home);

    const logs = await runCli(["logs", "t1"], home);
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain('{"type":"message","text":"working on it"}');
    expect(logs.stdout).toContain("not json at all — opaque vendor noise");

    // Accepts the name too.
    const byName = await runCli(["logs", "loggy"], home);
    expect(byName.stdout).toBe(logs.stdout);
  });

  it("--follow streams the log and exits when the task reaches a terminal state", async () => {
    const cwd = taskDir([
      { emit: { type: "message", text: "early line" } },
      { sleep: 1000 },
      { emit: { type: "message", text: "late line" } },
      { submit_report: REPORT },
    ]);
    const ack = JSON.parse(
      (await runCli(["delegate", "-v", "fake", "--cwd", cwd, "follow me"], home)).stdout,
    );

    const follow = startCli(["logs", ack.task_id, "--follow"], home);
    const result = await follow.result;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("early line");
    expect(result.stdout).toContain("late line");
  });
});

describe("delegate usage errors (exit 2)", () => {
  it("rejects a missing prompt", async () => {
    const result = await runCli(["delegate", "-v", "fake", "--cwd", "/tmp"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/prompt/);
  });

  it("rejects an unknown vendor", async () => {
    const cwd = taskDir([]);
    const result = await runCli(["delegate", "-v", "nope", "--cwd", cwd, "--wait", "x"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/vendor/);
  });

  it("rejects a missing vendor", async () => {
    const result = await runCli(["delegate", "--cwd", "/tmp", "x"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/vendor/);
  });

  it("rejects a nonexistent --cwd", async () => {
    const result = await runCli(
      ["delegate", "-v", "fake", "--cwd", "/nonexistent/nowhere", "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/cwd/);
  });

  it("rejects an id-shaped --name (ids and names are interchangeable refs)", async () => {
    const cwd = taskDir([]);
    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "t2", "--cwd", cwd, "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/name/);
  });
});

describe("global flags", () => {
  it("bare `parley --json` is the JSON task listing", async () => {
    const result = await runCli(["--json"], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("--help prints usage and exits 0, for the bare CLI and per command", async () => {
    for (const args of [["--help"], ["delegate", "-h"]]) {
      const result = await runCli(args, home);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Usage:/);
    }
  });
});
