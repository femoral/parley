import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  readDiscovery,
  runCli,
  startCli,
  waitForChildPid,
  waitForState,
  waitUntilDead,
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

function taskDir(actions: FakeVendorAction[], resumeActions?: FakeVendorAction[]): string {
  const dir = makeTaskDir(actions, resumeActions);
  taskDirs.push(dir);
  return dir;
}

const REPORT = {
  summary: "resumed and finished",
  outcome: "success",
  files_changed: ["src/a.ts"],
};

/** Raw vendor log lines for a task, parsed where possible. */
function vendorEvents(home: string, taskId: string): Record<string, unknown>[] {
  const log = fs.readFileSync(path.join(home, "tasks", taskId, "vendor.jsonl"), "utf8");
  const events: Record<string, unknown>[] = [];
  for (const line of log.split("\n")) {
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* opaque non-JSON noise */
    }
  }
  return events;
}

describe("answer timeout → stalled (spec §2, #18)", () => {
  it("records the question durably, stops the child, and stalls the task", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "sess-stall" } },
      { ask: "which database?" },
      // Never reached: the stall stops the child before it can report.
      { submit_report: REPORT },
    ]);

    const delegate = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--answer-timeout", "250ms", "--wait", "do it"],
      home,
    );
    // The question event wins the race (it precedes the timeout): exit 3.
    expect(delegate.code).toBe(3);
    expect(JSON.parse(delegate.stdout).question).toBe("which database?");

    const childPid = await waitForChildPid(home, "t1");

    // Unanswered at --answer-timeout: the task stalls...
    const row = await waitForState(home, "t1", "stalled");
    // ...with the question durably recorded and retrievable via status,
    expect(row.question).toBe("which database?");
    expect(typeof row.question_id).toBe("string");
    // ...the vendor session id persisted at capture time,
    expect(row.session_id).toBe("sess-stall");
    // ...and no report — the child was stopped, it never completed.
    expect(row.report).toBeNull();
    await waitUntilDead(childPid);
  });

  it("a waiting CLI that misses the question window exits 4 with the recorded question and a resume hint", async () => {
    // A CLI blocked on the event stream wakes on the question itself (exit 3)
    // — so exit 4 is the contract for a waiter that observes the task *after*
    // the stall (a slow orchestrator re-polling). Deterministic reproduction:
    // freeze the waiting CLI (SIGSTOP) across the ask → stall window; a short
    // daemon poll window guarantees its buffered response is a null event,
    // not the question, so on thaw it re-polls and sees `stalled`.
    const cwd = taskDir([
      { ask: "first?" },
      // Long enough that the waiting CLI is reliably frozen before the ask.
      { sleep: 3_000 },
      { ask: "second?" },
      { submit_report: REPORT },
    ]);

    const delegate = await runCli(
      [
        "delegate", "-v", "fake", "--cwd", cwd,
        "--answer-timeout", "2s", "--wait", "two asks",
      ],
      home,
      { extraEnv: { PARLEY_LONG_POLL_MS: "150" } }, // inherited by the auto-spawned daemon
    );
    expect(delegate.code).toBe(3);
    expect(JSON.parse(delegate.stdout).question).toBe("first?");

    // answer --wait re-blocks... and immediately goes to sleep at the wheel.
    const waiting = startCli(["answer", "t1", "one", "--wait"], home);
    await waitForState(home, "t1", "running"); // the answer was delivered
    waiting.child.kill("SIGSTOP");

    // While it sleeps: the child asks "second?", nobody answers, stall at 2s.
    await waitForState(home, "t1", "stalled", 10_000);
    waiting.child.kill("SIGCONT");

    const result = await waiting.result;
    expect(result.code).toBe(4);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.state).toBe("stalled");
    expect(envelope.question).toBe("second?");
    expect(result.stderr).toMatch(/parley answer t1/);
  }, 30_000);

  it("rejects an invalid --answer-timeout (exit 2)", async () => {
    const cwd = taskDir([]);
    const result = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--answer-timeout", "soon", "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/answer-timeout/);
  });
});

describe("parley answer resumes a stalled task", () => {
  it("respawns via adapter resume() with the persisted session id; the answer reaches the child", async () => {
    const cwd = taskDir(
      [{ emit: { type: "session", session_id: "sess-9" } }, { ask: "pick one?" }],
      [{ submit_report: REPORT }],
    );

    const delegate = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--answer-timeout", "250ms", "--wait", "pick"],
      home,
    );
    expect(delegate.code).toBe(3);
    await waitForState(home, "t1", "stalled");

    // Late answer on the stalled task: respawn through resume(), run to completion.
    const answer = await runCli(["answer", "t1", "option-b", "--wait"], home);
    expect(answer.code).toBe(0);
    const envelope = JSON.parse(answer.stdout);
    expect(envelope.state).toBe("completed");
    expect(envelope.report).toEqual(REPORT);
    expect(envelope.session_id).toBe("sess-9");

    // The resumed child got the persisted vendor session id and the answer text.
    const resumed = vendorEvents(home, "t1").find((e) => e.type === "resumed");
    expect(resumed).toBeDefined();
    expect(resumed!.session_id).toBe("sess-9");
    // The resume prompt re-prepends the protocol preamble (spec §7); the answer
    // rides along as the conversation's continuation.
    expect(resumed!.answer).toContain("option-b");

    // The question is no longer outstanding.
    const row = await waitForState(home, "t1", "completed");
    expect(row.question).toBeNull();
    expect(row.question_id).toBeNull();
  });

  it("resume preserves --effort (#28): the respawned child gets the same FAKE_EFFORT", async () => {
    const cwd = taskDir(
      [{ emit: { type: "session", session_id: "sess-effort" } }, { ask: "pick one?" }],
      [{ submit_report: REPORT }],
    );

    const delegate = await runCli(
      [
        "delegate", "-v", "fake", "--effort", "high", "--cwd", cwd,
        "--answer-timeout", "250ms", "--wait", "pick",
      ],
      home,
    );
    expect(delegate.code).toBe(3);
    await waitForState(home, "t1", "stalled");

    const answer = await runCli(["answer", "t1", "option-b", "--wait"], home);
    expect(answer.code).toBe(0);
    // The task row (and its report envelope) keep the effort the task was
    // delegated with — same persistence seam as sandbox posture.
    expect(JSON.parse(answer.stdout).effort).toBe("high");

    // The resumed child received it too (fake adapter echoes FAKE_EFFORT in `hello`).
    const hello = vendorEvents(home, "t1").find((e) => e.type === "hello");
    expect(hello!.effort).toBe("high");
  });

  it("revives a stalled task with no captured session by rerunning it fresh", async () => {
    // The child stalls before ever emitting a session id — there is nothing
    // for the vendor to resume, so `answer` reruns the original prompt.
    const cwd = taskDir([{ ask: "no session yet?" }, { submit_report: REPORT }]);

    const delegate = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--answer-timeout", "2s", "--wait", "fresh"],
      home,
    );
    expect(delegate.code).toBe(3);
    const stalledRow = await waitForState(home, "t1", "stalled");
    expect(stalledRow.session_id).toBeNull();

    const answer = await runCli(["answer", "t1", "carry on"], home);
    expect(answer.code).toBe(0);

    // The fresh rerun executes the original script from the top: it asks again
    // (no `resumed` event — this was a fresh `prepare()`, not a `resume()`).
    const row = await waitForState(home, "t1", "awaiting_answer");
    expect(row.question).toBe("no session yet?");
    expect(vendorEvents(home, "t1").some((e) => e.type === "resumed")).toBe(false);

    // And the revived run is fully live: answering it completes the task.
    const finish = await runCli(["answer", "t1", "proceed", "--wait"], home);
    expect(finish.code).toBe(0);
    expect(JSON.parse(finish.stdout).state).toBe("completed");
  });
});

describe("daemon crash recovery (spec §3)", () => {
  it("kill + restart: live tasks stalled, completed untouched, children die with the group, resumable", async () => {
    const cwdA = taskDir(
      [
        { emit: { type: "session", session_id: "sess-A" } },
        { sleep: 60_000 },
        { submit_report: REPORT },
      ],
      [{ submit_report: REPORT }],
    );
    const cwdB = taskDir([
      { submit_report: { summary: "done before crash", outcome: "success", files_changed: [] } },
    ]);

    // t1 runs long; t2 completes.
    await runCli(["delegate", "-v", "fake", "-n", "crashy", "--cwd", cwdA, "long task"], home);
    await waitForState(home, "t1", "running");
    const done = await runCli(["delegate", "-v", "fake", "--cwd", cwdB, "--wait", "quick"], home);
    expect(done.code).toBe(0);

    const discovery = readDiscovery(home);
    expect(discovery).not.toBeNull();
    const childPid = await waitForChildPid(home, "t1");

    // Hard-kill the daemon's process group — the crash story. Children run in
    // the daemon's group, so they die with it: no orphans.
    process.kill(-discovery!.pid, "SIGKILL");
    await waitUntilDead(discovery!.pid);
    await waitUntilDead(childPid);

    // Next CLI call auto-spawns a fresh daemon whose startup sweep marks tasks
    // recorded running as stalled; completed tasks are untouched.
    const status = await runCli(["status", "--json"], home);
    expect(status.code).toBe(0);
    const rows = JSON.parse(status.stdout) as Record<string, unknown>[];
    const t1 = rows.find((r) => r.id === "t1")!;
    const t2 = rows.find((r) => r.id === "t2")!;
    expect(t1.state).toBe("stalled");
    expect(t2.state).toBe("completed");
    expect(t2.report).toEqual({
      summary: "done before crash",
      outcome: "success",
      files_changed: [],
    });

    // The crash-stalled task resumes the same way: answer → resume() → done.
    const answer = await runCli(["answer", "t1", "keep going", "--wait"], home);
    expect(answer.code).toBe(0);
    expect(JSON.parse(answer.stdout).state).toBe("completed");
    const resumed = vendorEvents(home, "t1").find((e) => e.type === "resumed");
    expect(resumed!.session_id).toBe("sess-A");
    expect(resumed!.answer).toContain("keep going");
  });
});

describe("no orphan children", () => {
  it("daemon stop terminates running vendor children", async () => {
    const cwd = taskDir([{ sleep: 60_000 }, { submit_report: REPORT }]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "long task"], home);
    await waitForState(home, "t1", "running");
    const childPid = await waitForChildPid(home, "t1");
    const discovery = readDiscovery(home)!;

    const stop = await runCli(["daemon", "stop"], home);
    expect(stop.code).toBe(0);
    await waitUntilDead(discovery.pid);
    await waitUntilDead(childPid);
  });
});
