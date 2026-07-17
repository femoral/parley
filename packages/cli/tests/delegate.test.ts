import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  runCli,
  startCli,
  waitFor,
  waitForState,
  watchJson,
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


/** Delegate then wait for completed; return the watch-delivered report envelope. */
async function completeEnvelope(
  args: string[],
  options: Parameters<typeof runCli>[2] = {},
): Promise<Record<string, unknown>> {
  const result = await runCli(args, home, options);
  expect(result.code).toBe(0);
  const ack = JSON.parse(result.stdout) as { task_id: string };
  await waitForState(home, ack.task_id, "completed");
  const watched = await watchJson(home, [ack.task_id]);
  expect(watched.code).toBe(6);
  expect(watched.task).not.toBeNull();
  return watched.task!;
}

describe("delegate + watch (the spine, ADR-0008)", () => {
  it("runs end-to-end: pending ack then watch delivers completed envelope", async () => {
    const cwd = taskDir(happyActions());
    const result = await runCli(
      ["delegate", "-v", "fake", "-m", "fake-model-1", "-n", "spine", "--cwd", cwd, "do the thing"],
      home,
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const ack = JSON.parse(result.stdout);
    expect(ack.task_id).toBe("t1");
    expect(ack.name).toBe("spine");
    expect(["pending", "running"]).toContain(ack.state);

    await waitForState(home, "t1", "completed");
    const watched = await watchJson(home, ["t1"]);
    expect(watched.code).toBe(6);
    const envelope = watched.task!;
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

  it("rejects --wait with exit 2 and points at parley watch", async () => {
    const cwd = taskDir(happyActions());
    const result = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--wait", "nope"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--wait/);
    expect(result.stderr).toMatch(/parley watch/);
  });

  it("captures the raw vendor stream untouched as per-task JSONL", async () => {
    const cwd = taskDir(happyActions());
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "do it"], home);
    await waitForState(home, "t1", "completed");

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
    const envelope = await completeEnvelope(["delegate", "-v", "fake", "--cwd", cwd, "retry"]);
    expect(envelope.report).toEqual(REPORT);

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
    const envelope = await completeEnvelope(
      ["delegate", "-v", "fake", "-m", weirdModel, "--cwd", cwd, "opaque"],
    );
    expect(envelope.model).toBe(weirdModel);
    // The fake adapter hands the model to the child verbatim; the child echoes it.
    const log = fs.readFileSync(path.join(home, "tasks", "t1", "vendor.jsonl"), "utf8");
    const hello = JSON.parse(log.split("\n").find((l) => l.includes('"hello"'))!);
    expect(hello.model).toBe(weirdModel);
  });

  it("passes --effort through to the adapter opaquely; omitted when not given", async () => {
    const cwd = taskDir(happyActions());
    const envelope = await completeEnvelope(
      ["delegate", "-v", "fake", "--effort", "high", "--cwd", cwd, "reason hard"],
    );
    expect(envelope.effort).toBe("high");
    // The fake adapter hands the effort to the child verbatim; the child echoes it.
    const log = fs.readFileSync(path.join(home, "tasks", "t1", "vendor.jsonl"), "utf8");
    const hello = JSON.parse(log.split("\n").find((l) => l.includes('"hello"'))!);
    expect(hello.effort).toBe("high");
  });

  it("omits effort from the envelope and child env when --effort is not given", async () => {
    const cwd = taskDir(happyActions());
    const envelope = await completeEnvelope(["delegate", "-v", "fake", "--cwd", cwd, "no effort"]);
    expect(envelope.effort).toBeNull();
    const log = fs.readFileSync(path.join(home, "tasks", "t1", "vendor.jsonl"), "utf8");
    const hello = JSON.parse(log.split("\n").find((l) => l.includes('"hello"'))!);
    expect(hello.effort).toBeNull();
  });
});

describe("eval_expected envelope field (#45)", () => {
  it("is true when .parley/config.json declares eval.expected: true", async () => {
    const cwd = taskDir(happyActions());
    fs.mkdirSync(path.join(cwd, ".parley"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".parley", "config.json"),
      JSON.stringify({ eval: { expected: true } }),
    );
    // eval.expected turns the session_required gate on (#162): register first.
    const anchor = { machine_id: "m", pid: 1, start_time: "t" };
    const sess = await runCli(
      ["session", "-v", "h", "-m", "m", "-e", "e", "--json"],
      home,
      {
        cwd,
        extraEnv: {
          PARLEY_ANCESTRY_CHAIN: JSON.stringify([anchor]),
          PARLEY_SESSION_ID: undefined,
        },
      },
    );
    expect(sess.code).toBe(0);
    const envelope = await completeEnvelope(["delegate", "-v", "fake", "--cwd", cwd, "do it"], {
      extraEnv: {
        PARLEY_ANCESTRY_CHAIN: JSON.stringify([anchor]),
        PARLEY_SESSION_ID: undefined,
      },
    });
    expect(envelope.eval_expected).toBe(true);
  });

  it("is false when the repo has no .parley/config.json", async () => {
    const cwd = taskDir(happyActions());
    const envelope = await completeEnvelope(["delegate", "-v", "fake", "--cwd", cwd, "do it"]);
    expect(envelope.eval_expected).toBe(false);
  });

  it("is false when .parley/config.json omits eval, or sets expected: false", async () => {
    const cwdOmitted = taskDir(happyActions());
    fs.mkdirSync(path.join(cwdOmitted, ".parley"), { recursive: true });
    fs.writeFileSync(path.join(cwdOmitted, ".parley", "config.json"), JSON.stringify({}));
    const omitted = await completeEnvelope(
      ["delegate", "-v", "fake", "--cwd", cwdOmitted, "do it"],
    );
    expect(omitted.eval_expected).toBe(false);

    const cwdFalse = taskDir(happyActions());
    fs.mkdirSync(path.join(cwdFalse, ".parley"), { recursive: true });
    fs.writeFileSync(
      path.join(cwdFalse, ".parley", "config.json"),
      JSON.stringify({ eval: { expected: false } }),
    );
    const falseExpected = await completeEnvelope(
      ["delegate", "-v", "fake", "--cwd", cwdFalse, "do it"],
    );
    expect(falseExpected.eval_expected).toBe(false);
  });
});

/**
 * Deferred completion (#72): `submit_report` stores the report but leaves the
 * task `running` until the vendor stream closes, so `completed` and final
 * usage commit atomically. Fallback completes a hung child after a short window.
 */
describe("deferred completed + usage atomicity (#72)", () => {
  it("watch carries final usage emitted AFTER submit_report returns, never null", async () => {
    // Reproduces the race: under the old code, submit_report flipped completed
    // immediately and a waiter could observe usage: null before the trailing
    // usage event landed. Usage after the MCP call must still appear on the
    // completed envelope.
    const cwd = taskDir([
      { emit: { type: "session", session_id: "sess-late-usage" } },
      { submit_report: REPORT },
      // Beat after the report is accepted — usage would race under early complete.
      { sleep: 150 },
      { emit: { type: "usage", input_tokens: 777, output_tokens: 42 } },
    ]);
    const envelope = await completeEnvelope(
      ["delegate", "-v", "fake", "--cwd", cwd, "late usage"],
    );

    expect(envelope.state).toBe("completed");
    expect(envelope.report).toEqual(REPORT);
    expect(envelope.usage).toEqual({ input_tokens: 777, output_tokens: 42 });
    expect(typeof envelope.duration_ms).toBe("number");
    // completed_at is the stream-close commit, so duration includes the sleep.
    expect(envelope.duration_ms).toBeGreaterThanOrEqual(100);
  });

  it("fallback: hung child after accepted report completes with best-effort usage", async () => {
    // Child accepts a report then never exits. Short injectable fallback window
    // so the test is fast; usage emitted before the hang is kept.
    const cwd = taskDir([
      { emit: { type: "usage", input_tokens: 11, output_tokens: 3 } },
      { submit_report: REPORT },
      // Stay alive past the fallback window so only the timer can complete.
      { sleep: 60_000 },
    ]);
    const envelope = await completeEnvelope(
      ["delegate", "-v", "fake", "--cwd", cwd, "hung after report"],
      { extraEnv: { PARLEY_REPORT_ACCEPTED_FALLBACK_MS: "200" } },
    );

    expect(envelope.state).toBe("completed");
    expect(envelope.report).toEqual(REPORT);
    expect(envelope.usage).toEqual({ input_tokens: 11, output_tokens: 3 });
  });

  it("second submit_report after acceptance is rejected", async () => {
    const second = {
      summary: "should bounce",
      outcome: "partial" as const,
      files_changed: ["nope.ts"],
    };
    const cwd = taskDir([
      { submit_report: REPORT },
      { submit_report: second },
      { emit: { type: "usage", input_tokens: 1, output_tokens: 1 } },
    ]);
    const envelope = await completeEnvelope(
      ["delegate", "-v", "fake", "--cwd", cwd, "double report"],
    );

    expect(envelope.state).toBe("completed");
    // First report wins.
    expect(envelope.report).toEqual(REPORT);

    const log = fs.readFileSync(path.join(home, "tasks", "t1", "vendor.jsonl"), "utf8");
    const toolResults = log
      .split("\n")
      .filter((l) => l.includes('"tool_result"'))
      .map((l) => JSON.parse(l) as { is_error: boolean; text: string });
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]!.is_error).toBe(false);
    expect(toolResults[1]!.is_error).toBe(true);
    expect(toolResults[1]!.text).toMatch(/already has an accepted report/);
  });

  it("nonzero exit after an accepted report still yields completed with the report", async () => {
    const cwd = taskDir([
      { submit_report: REPORT },
      { emit: { type: "usage", input_tokens: 5, output_tokens: 2 } },
      { exit: 1 },
    ]);
    const envelope = await completeEnvelope(
      ["delegate", "-v", "fake", "--cwd", cwd, "report then crash"],
    );

    expect(envelope.state).toBe("completed");
    expect(envelope.report).toEqual(REPORT);
    expect(envelope.error).toBeNull();
    expect(envelope.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });

  it("cancel inside the accepted-report window cancels like any running task", async () => {
    const cwd = taskDir([
      { submit_report: REPORT },
      { sleep: 60_000 },
    ]);
    await runCli(["delegate", "-v", "fake", "-n", "cancel-after-report", "--cwd", cwd, "x"], home);
    // Report is accepted while still running — cancel must win over completion.
    await waitFor(
      () => {
        const logPath = path.join(home, "tasks", "t1", "vendor.jsonl");
        try {
          return fs.readFileSync(logPath, "utf8").includes('"tool_result"');
        } catch {
          return false;
        }
      },
      "report accepted tool_result",
    );
    // Confirm still running with a stored report before cancelling.
    const mid = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout);
    expect(mid.state).toBe("running");
    expect(mid.report).toBeTruthy();

    const cancel = await runCli(["cancel", "t1"], home);
    expect(cancel.code).toBe(0);
    const row = await waitForState(home, "t1", "cancelled");
    expect(row.state).toBe("cancelled");
  });
});

describe("async delegate (always returns immediately)", () => {
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
      runCli(["delegate", "-v", "fake", "-n", "task-a", "--cwd", cwdA, "A"], home),
      runCli(["delegate", "-v", "fake", "-n", "task-b", "--cwd", cwdB, "B"], home),
    ]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const ackA = JSON.parse(a.stdout);
    const ackB = JSON.parse(b.stdout);
    expect(ackA.name).toBe("task-a");
    expect(ackB.name).toBe("task-b");

    await waitForState(home, "task-a", "completed");
    await waitForState(home, "task-b", "completed");
    const envA = (await watchJson(home, ["task-a"])).task!;
    const envB = (await watchJson(home, ["task-b"])).task!;
    expect(envA.report).toMatchObject({ summary: "report A" });
    expect(envA.session_id).toBe("sess-A");
    expect(envB.report).toMatchObject({ summary: "report B" });
    expect(envB.session_id).toBe("sess-B");
  });
});

describe("status", () => {
  it("shows short id and name; both are accepted by task-taking commands", async () => {
    const cwd = taskDir(happyActions());
    await runCli(["delegate", "-v", "fake", "-n", "fix-auth", "--cwd", cwd, "x"], home);
    await waitForState(home, "fix-auth", "completed");

    const table = await runCli(["status"], home);
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/t1/);
    expect(table.stdout).toMatch(/fix-auth/);
    expect(table.stdout).toMatch(/completed/);

    const byId = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout);
    const byName = JSON.parse((await runCli(["status", "fix-auth", "--json"], home)).stdout);
    expect(byId).toEqual(byName);
    expect(byId.id).toBe("t1");
    expect(byId.state).toBe("completed");

    const listing = JSON.parse((await runCli(["status", "--json"], home)).stdout);
    expect(listing).toEqual([byId]);
  });

  it("shows compact token counts in USAGE for a task that reports usage", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "sess-usage" } },
      {
        emit: {
          type: "usage",
          input_tokens: 12345,
          cached_input_tokens: 999,
          output_tokens: 6789,
        },
      },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "-n", "usage-task", "--cwd", cwd, "x"], home);
    await waitForState(home, "usage-task", "completed");

    const table = await runCli(["status"], home);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("USAGE");
    expect(table.stdout).toContain("12.3k in/6.8k out");
    // cached_input_tokens stays --json-only, never shown in the table.
    expect(table.stdout).not.toContain("999");
  });

  it("shows n/r in USAGE for a task with no usage data, never a bare 0 or blank", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "sess-no-usage" } },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "-n", "no-usage-task", "--cwd", cwd, "x"], home);
    await waitForState(home, "no-usage-task", "completed");

    const table = await runCli(["status"], home);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("n/r");
  });

  it("shows a plain MmSSs DURATION for a completed task", async () => {
    const cwd = taskDir(happyActions());
    await runCli(["delegate", "-v", "fake", "-n", "done-task", "--cwd", cwd, "x"], home);
    await waitForState(home, "done-task", "completed");

    const table = await runCli(["status"], home);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("DURATION");
    expect(table.stdout).toMatch(/\d+m\d{2}s(?!\.)/);
  });

  it("shows a live, ...-suffixed DURATION for a still-running task", async () => {
    const cwd = taskDir([{ sleep: 2000 }, ...happyActions()]);
    await runCli(["delegate", "-v", "fake", "-n", "slow-task", "--cwd", cwd, "background"], home);
    await waitForState(home, "t1", "running");

    const table = await runCli(["status"], home);
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/\d+m\d{2}s\.\.\./);
  });
});

/** Parse log stdout as JSONL, skipping the `# launch_command …` header (#154). */
function parseLogJsonl(stdout: string): unknown[] {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0 && !l.startsWith("# "))
    .map((l) => JSON.parse(l));
}

describe("logs", () => {
  it("prints the raw captured vendor stream", async () => {
    const cwd = taskDir(happyActions());
    await runCli(["delegate", "-v", "fake", "-n", "loggy", "--cwd", cwd, "x"], home);
    await waitForState(home, "loggy", "completed");

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

  it("coalesces consecutive token-streamed chunks of the same type (#27)", async () => {
    const cwd = taskDir([
      { emit: { type: "thought", data: "The" } },
      { emit: { type: "thought", data: " user" } },
      { emit: { type: "thought", data: " wants" } },
      { emit: { type: "text", data: "Hello" } },
      { emit: { type: "text", data: " world" } },
      { emit: { type: "end", stopReason: "EndTurn", sessionId: "sess-1" } },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "-n", "chunky", "--cwd", cwd, "x"], home);
    await waitForState(home, "chunky", "completed");

    const logs = await runCli(["logs", "t1"], home);
    expect(logs.code).toBe(0);
    const lines = parseLogJsonl(logs.stdout);
    expect(lines).toContainEqual({ type: "thought", data: "The user wants" });
    expect(lines).toContainEqual({ type: "text", data: "Hello world" });
    // Not chunk-shaped (extra fields) — passes through unchanged, one line.
    expect(lines).toContainEqual({ type: "end", stopReason: "EndTurn", sessionId: "sess-1" });
  });

  it("--json prints the raw untouched per-event JSONL, uncoalesced", async () => {
    const cwd = taskDir([
      { emit: { type: "thought", data: "The" } },
      { emit: { type: "thought", data: " user" } },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "x"], home);
    await waitForState(home, "t1", "completed");

    const raw = await runCli(["logs", "t1", "--json"], home);
    expect(raw.code).toBe(0);
    expect(raw.stdout).toContain('{"type":"thought","data":"The"}');
    expect(raw.stdout).toContain('{"type":"thought","data":" user"}');
    // Each raw chunk is its own line — never merged.
    expect(raw.stdout.split("\n").filter((l) => l.includes('"thought"')).length).toBe(2);
  });

  it("--follow merges chunks that arrive within one poll window", async () => {
    const cwd = taskDir([
      { emit: { type: "thought", data: "one" } },
      { emit: { type: "thought", data: " two" } },
      { sleep: 300 },
      { emit: { type: "text", data: "done" } },
      { submit_report: REPORT },
    ]);
    const ack = JSON.parse(
      (await runCli(["delegate", "-v", "fake", "--cwd", cwd, "chunky follow"], home)).stdout,
    );

    const follow = startCli(["logs", ack.task_id, "--follow"], home);
    const result = await follow.result;
    expect(result.code).toBe(0);
    const lines = parseLogJsonl(result.stdout);
    expect(lines).toContainEqual({ type: "thought", data: "one two" });
    expect(lines).toContainEqual({ type: "text", data: "done" });
  });

  it("--follow flushes a buffered group on every poll — live output never goes silent for a slow same-type run (#27 fix)", async () => {
    // Generous gaps: the follow CLI is a fresh tsx process whose boot can take
    // seconds on a loaded machine, and the liveness assertion below is only
    // meaningful while the vendor is still mid-run.
    const cwd = taskDir([
      { emit: { type: "thought", data: "one" } },
      { sleep: 2500 },
      { emit: { type: "thought", data: " two" } },
      { sleep: 2500 },
      { submit_report: REPORT },
    ]);
    const ack = JSON.parse(
      (await runCli(["delegate", "-v", "fake", "--cwd", cwd, "slow follow"], home)).stdout,
    );

    const follow = startCli(["logs", ack.task_id, "--follow"], home);
    // Chunks are 2500ms apart, well past one 100ms poll — the first must render
    // well before the task finishes, not just at the end.
    await waitFor(
      () => follow.stdoutSoFar().includes('{"type":"thought","data":"one"}'),
      "first thought chunk to render live, before the task completes",
      10_000,
    );
    const result = await follow.result;
    expect(result.code).toBe(0);
    const lines = parseLogJsonl(result.stdout);
    // Flushed as two separate groups, not merged into "one two" — the
    // liveness/parity tradeoff a post-hoc read of the same file wouldn't make.
    expect(lines).toContainEqual({ type: "thought", data: "one" });
    expect(lines).toContainEqual({ type: "thought", data: " two" });
  });

  it("does not merge distinct error/fatal events even though they share the chunk shape (#27 fix)", async () => {
    const cwd = taskDir([
      { emit: { type: "error", data: "first failure" } },
      { emit: { type: "error", data: "second failure" } },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "x"], home);
    await waitForState(home, "t1", "completed");

    const logs = await runCli(["logs", "t1"], home);
    const lines = parseLogJsonl(logs.stdout);
    expect(lines).toContainEqual({ type: "error", data: "first failure" });
    expect(lines).toContainEqual({ type: "error", data: "second failure" });
  });

  it("a vendor log with no sub-message chunking renders unchanged (codex-shaped events)", async () => {
    const cwd = taskDir([
      { emit: { type: "item.completed", item: { id: "i0", type: "agent_message", text: "hi" } } },
      { emit: { type: "item.completed", item: { id: "i1", type: "agent_message", text: "bye" } } },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "x"], home);
    await waitForState(home, "t1", "completed");

    const coalesced = await runCli(["logs", "t1"], home);
    const raw = await runCli(["logs", "t1", "--json"], home);
    expect(coalesced.stdout).toBe(raw.stdout);
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
    const result = await runCli(["delegate", "-v", "nope", "--cwd", cwd, "x"], home);
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

describe("orchestrator session identity (#42)", () => {
  it("stamps the task with PARLEY_SESSION_ID, visible via status --json", async () => {
    const cwd = taskDir(happyActions());
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "x"], home, {
      extraEnv: { PARLEY_SESSION_ID: "orch-from-env" },
    });
    await waitForState(home, "t1", "completed");

    const row = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBe("orch-from-env");
  });

  it("--session overrides PARLEY_SESSION_ID when both are set", async () => {
    const cwd = taskDir(happyActions());
    await runCli(
      ["delegate", "-v", "fake", "--session", "orch-from-flag", "--cwd", cwd, "x"],
      home,
      { extraEnv: { PARLEY_SESSION_ID: "orch-from-env" } },
    );
    await waitForState(home, "t1", "completed");

    const row = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBe("orch-from-flag");
  });

  it("allows a missing session when evals are off (#162; free-form still works)", async () => {
    const cwd = taskDir(happyActions());
    const result = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "x"], home, {
      extraEnv: { PARLEY_SESSION_ID: undefined },
    });
    expect(result.code).toBe(0);
    const taskId = JSON.parse(result.stdout).task_id as string;
    await waitForState(home, taskId, "completed");
    const row = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBeNull();
  });
});

describe("session grouping & filtering (#46)", () => {
  /** Delegate a completed task stamped with a given orchestrator session. */
  async function delegateUnder(session: string): Promise<void> {
    const cwd = taskDir(happyActions());
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "x"], home, {
      extraEnv: { PARLEY_SESSION_ID: session },
    });
    // Tasks are sequential t1, t2, … under one home; wait for newest completed via status list.
    const rows = JSON.parse((await runCli(["status", "--json", "--all"], home)).stdout) as { id: string; state: string }[];
    const pending = rows.filter((r) => r.state !== "completed");
    for (const r of pending) await waitForState(home, r.id, "completed");
  }

  const sessionsOf = (stdout: string): string[] =>
    (JSON.parse(stdout) as { orchestrator_session_id: string }[]).map(
      (r) => r.orchestrator_session_id,
    );

  it("--session <id> shows only that session's tasks", async () => {
    await delegateUnder("sess-A");
    await delegateUnder("sess-B");

    const rows = await runCli(["status", "--session", "sess-A", "--json"], home);
    expect(sessionsOf(rows.stdout)).toEqual(["sess-A"]);
  });

  it("--session latest resolves to the most-recently-used session", async () => {
    await delegateUnder("sess-A");
    await delegateUnder("sess-B");

    const rows = await runCli(["status", "--session", "latest", "--json"], home);
    expect(sessionsOf(rows.stdout)).toEqual(["sess-B"]);
  });

  it("bare status filters by PARLEY_SESSION_ID from its own environment", async () => {
    await delegateUnder("sess-A");
    await delegateUnder("sess-B");

    const rows = await runCli(["status", "--json"], home, {
      extraEnv: { PARLEY_SESSION_ID: "sess-A" },
    });
    expect(sessionsOf(rows.stdout)).toEqual(["sess-A"]);
  });

  it("bare status with no PARLEY_SESSION_ID falls back to the newest session", async () => {
    await delegateUnder("sess-A");
    await delegateUnder("sess-B");

    const rows = await runCli(["status", "--json"], home, {
      extraEnv: { PARLEY_SESSION_ID: undefined },
    });
    expect(sessionsOf(rows.stdout)).toEqual(["sess-B"]);
  });

  it("--all bypasses session filtering and shows every task", async () => {
    await delegateUnder("sess-A");
    await delegateUnder("sess-B");

    const rows = await runCli(["status", "--all", "--json"], home, {
      extraEnv: { PARLEY_SESSION_ID: "sess-A" },
    });
    expect(sessionsOf(rows.stdout).sort()).toEqual(["sess-A", "sess-B"]);
  });

  it("the table carries a SESSION column", async () => {
    await delegateUnder("sess-A");

    const table = await runCli(["status"], home, {
      extraEnv: { PARLEY_SESSION_ID: "sess-A" },
    });
    expect(table.stdout).toMatch(/SESSION/);
    expect(table.stdout).toMatch(/sess-A/);
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
