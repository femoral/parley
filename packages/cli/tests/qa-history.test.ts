/**
 * #79 — end-to-end Q&A history on `GET /tasks/:ref`: ask/answer round-trips,
 * multi-question order, outstanding null answers, complete-over-question, and
 * survival across a daemon restart (fresh client, no live observation).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  isAlive,
  makeHome,
  makeTaskDir,
  readDiscovery,
  runCli,
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
  summary: "answered and done",
  outcome: "success",
  files_changed: ["src/a.ts"],
};

/** Fetch task detail from the live daemon (fresh client path — no SSE). */
async function fetchDetail(taskId: string): Promise<{
  task: { state: string; question: string | null; question_id: string | null };
  qa: { question: string; answer: string | null; question_id: string }[];
}> {
  const discovery = readDiscovery(home);
  if (!discovery) throw new Error("no daemon discovery");
  const res = await fetch(`http://127.0.0.1:${discovery.port}/tasks/${encodeURIComponent(taskId)}`);
  if (!res.ok) throw new Error(`GET /tasks/${taskId} → ${res.status}`);
  return (await res.json()) as {
    task: { state: string; question: string | null; question_id: string | null };
    qa: { question: string; answer: string | null; question_id: string }[];
  };
}

/** Hard-kill the daemon so the next CLI call spawns a fresh process. */
function killDaemon(): void {
  const discovery = readDiscovery(home);
  if (!discovery || !isAlive(discovery.pid)) return;
  try {
    process.kill(-discovery.pid, "SIGKILL");
  } catch {
    try {
      process.kill(discovery.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  try {
    fs.unlinkSync(path.join(home, "daemon.json"));
  } catch {
    /* missing */
  }
}

describe("durable Q&A history on task detail (#79)", () => {
  it("ask + answer then a fresh detail fetch shows the full exchange", async () => {
    const cwd = taskDir([{ ask: "which database?" }, { submit_report: REPORT }]);
    const delegate = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--wait", "do it"],
      home,
    );
    expect(delegate.code).toBe(3);

    // Outstanding turn is visible with answer null before anyone answers.
    const outstanding = await fetchDetail("t1");
    expect(outstanding.qa).toEqual([
      expect.objectContaining({ question: "which database?", answer: null }),
    ]);
    expect(outstanding.task.question).toBe("which database?");

    await runCli(["answer", "t1", "postgres", "--wait"], home);
    await waitForState(home, "t1", "completed");

    // Fresh HTTP client (no live SSE observation) rehydrates the exchange.
    const detail = await fetchDetail("t1");
    expect(detail.qa).toEqual([
      expect.objectContaining({
        question: "which database?",
        answer: "postgres",
      }),
    ]);
    // Outstanding fields cleared on the envelope once answered.
    expect(detail.task.question).toBeNull();
    expect(detail.task.question_id).toBeNull();
  });

  it("returns multi-question turns in ask order", async () => {
    const cwd = taskDir([
      { ask: "first?" },
      { ask: "second?" },
      { submit_report: REPORT },
    ]);
    expect(
      (await runCli(["delegate", "-v", "fake", "--cwd", cwd, "--wait", "multi"], home)).code,
    ).toBe(3);
    expect((await runCli(["answer", "t1", "one", "--wait"], home)).code).toBe(3);
    expect((await runCli(["answer", "t1", "two", "--wait"], home)).code).toBe(0);

    const detail = await fetchDetail("t1");
    expect(detail.qa.map((t) => ({ q: t.question, a: t.answer }))).toEqual([
      { q: "first?", a: "one" },
      { q: "second?", a: "two" },
    ]);
  });

  it("updates an outstanding turn in place when answered (no duplicate)", async () => {
    const cwd = taskDir([{ ask: "one turn?" }, { submit_report: REPORT }]);
    expect(
      (await runCli(["delegate", "-v", "fake", "--cwd", cwd, "--wait", "x"], home)).code,
    ).toBe(3);

    const before = await fetchDetail("t1");
    expect(before.qa).toHaveLength(1);
    const qid = before.qa[0]!.question_id;
    expect(before.qa[0]!.answer).toBeNull();

    await runCli(["answer", "t1", "yes", "--wait"], home);
    const after = await fetchDetail("t1");
    expect(after.qa).toHaveLength(1);
    expect(after.qa[0]).toMatchObject({
      question_id: qid,
      question: "one turn?",
      answer: "yes",
    });
  });

  it("leaves answer null when a task completes over its outstanding question", async () => {
    // Misbehaving child: fire-and-forget ask, then submit_report without ever
    // receiving an answer. Engine settles the parked call and completes with
    // the report; history keeps the turn with answer null (#79 + #72).
    // No --wait: the question transition would exit 3 before completion.
    const cwd = taskDir([
      { ask: "should I keep going?", background: true },
      { sleep: 200 },
      { submit_report: REPORT },
    ]);
    const delegate = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "misbehave"],
      home,
    );
    expect(delegate.code).toBe(0);
    await waitForState(home, "t1", "completed");

    const detail = await fetchDetail("t1");
    expect(detail.qa).toEqual([
      expect.objectContaining({
        question: "should I keep going?",
        answer: null,
      }),
    ]);
    // Outstanding fields cleared on the terminal envelope.
    expect(detail.task.question).toBeNull();
  });

  it("history survives a daemon restart (CLI answer, no HUD open)", async () => {
    const cwd = taskDir([{ ask: "persist me?" }, { submit_report: REPORT }]);
    expect(
      (await runCli(["delegate", "-v", "fake", "--cwd", cwd, "--wait", "x"], home)).code,
    ).toBe(3);
    // Answer via CLI while no HUD is observing.
    expect((await runCli(["answer", "t1", "sure", "--wait"], home)).code).toBe(0);

    killDaemon();

    // Next CLI call respawns the daemon; detail must rehydrate from SQLite.
    const status = await runCli(["status", "t1", "--json"], home);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)[0].state).toBe("completed");

    const detail = await fetchDetail("t1");
    expect(detail.qa).toEqual([
      expect.objectContaining({ question: "persist me?", answer: "sure" }),
    ]);
  });
});
