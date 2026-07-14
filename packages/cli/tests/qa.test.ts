import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  runCli,
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
  summary: "answered and done",
  outcome: "success",
  files_changed: ["src/a.ts"],
};

/** Read the fake vendor's echoed tool results from the raw stream. */
function toolResults(home: string, taskId: string): { tool: string; is_error: boolean; text: string }[] {
  const log = fs.readFileSync(path.join(home, "tasks", taskId, "vendor.jsonl"), "utf8");
  return log
    .split("\n")
    .filter((l) => l.includes('"tool_result"'))
    .map((l) => JSON.parse(l) as { tool: string; is_error: boolean; text: string });
}

describe("Q&A channel — ask_orchestrator / parley answer", () => {
  it("watch surfaces the question (exit 3); answer then watch delivers completed", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "qa-sess" } },
      { ask: "which database?" },
      { submit_report: REPORT },
    ]);

    const delegate = await runCli(
      ["delegate", "-v", "fake", "-n", "qa", "--cwd", cwd, "do it"],
      home,
    );
    expect(delegate.stderr).toBe("");
    expect(delegate.code).toBe(0);

    const q = await watchJson(home, ["t1"]);
    expect(q.code).toBe(3);
    expect(q.task!.task_id).toBe("t1");
    expect(q.task!.name).toBe("qa");
    expect(q.task!.question).toBe("which database?");
    expect(typeof q.task!.question_id).toBe("string");

    // The task is visibly awaiting_answer while blocked.
    const status = await runCli(["status", "t1", "--json"], home);
    expect(JSON.parse(status.stdout).state).toBe("awaiting_answer");

    // answer posts and returns immediately; next watch delivers completed.
    const answer = await runCli(["answer", "t1", "postgres"], home);
    expect(answer.stderr).toBe("");
    expect(answer.code).toBe(0);
    expect(JSON.parse(answer.stdout).state).toBe("running");

    const done = await watchJson(home, ["t1"]);
    expect(done.code).toBe(6);
    expect(done.task!.state).toBe("completed");
    expect(done.task!.report).toEqual(REPORT);

    // The answer text arrived at the child as the ask_orchestrator tool result.
    const asks = toolResults(home, "t1").filter((r) => r.tool === "ask_orchestrator");
    expect(asks).toHaveLength(1);
    expect(asks[0]!.is_error).toBe(false);
    expect(asks[0]!.text).toBe("postgres");
  });

  it("single-task end-to-end: delegate→watch→answer→watch→ack→exit-0", async () => {
    const cwd = taskDir([
      { ask: "which?" },
      { submit_report: REPORT },
    ]);
    expect((await runCli(["delegate", "-v", "fake", "-n", "e2e", "--cwd", cwd, "go"], home)).code).toBe(0);

    const q = await watchJson(home);
    expect(q.code).toBe(3);
    expect(q.task!.question).toBe("which?");
    // Answering auto-resolves the question event — no --ack for it.
    expect((await runCli(["answer", "t1", "that"], home)).code).toBe(0);

    const done = await watchJson(home);
    expect(done.code).toBe(6);
    expect(done.task!.state).toBe("completed");

    // Explicit ack after review → all-done.
    const allDone = await watchJson(home, ["--ack", String(done.seq)]);
    expect(allDone.code).toBe(0);
  });

  it("round-trips multiple sequential questions, each correlated by a distinct id", async () => {
    const cwd = taskDir([
      { ask: "first?" },
      { ask: "second?" },
      { submit_report: REPORT },
    ]);

    expect((await runCli(["delegate", "-v", "fake", "--cwd", cwd, "multi"], home)).code).toBe(0);

    const q1 = await watchJson(home, ["t1"]);
    expect(q1.code).toBe(3);
    expect(q1.task!.question).toBe("first?");

    // answer returns immediately; next watch delivers the *next* question.
    expect((await runCli(["answer", "t1", "one"], home)).code).toBe(0);
    const q2 = await watchJson(home, ["t1"]);
    expect(q2.code).toBe(3);
    expect(q2.task!.question).toBe("second?");
    expect(q2.task!.question_id).not.toBe(q1.task!.question_id);

    // Final answer drives it to completion.
    expect((await runCli(["answer", "t1", "two"], home)).code).toBe(0);
    const done = await watchJson(home, ["t1"]);
    expect(done.code).toBe(6);
    expect(done.task!.state).toBe("completed");

    const asks = toolResults(home, "t1").filter((r) => r.tool === "ask_orchestrator");
    expect(asks.map((r) => r.text)).toEqual(["one", "two"]);
  });

  it("answer always returns immediately; the child continues", async () => {
    const cwd = taskDir([{ ask: "go on?" }, { submit_report: REPORT }]);

    expect((await runCli(["delegate", "-v", "fake", "--cwd", cwd, "fire-and-forget"], home)).code).toBe(0);
    await waitForState(home, "t1", "awaiting_answer");

    const answer = await runCli(["answer", "t1", "yes"], home);
    expect(answer.code).toBe(0);
    const ack = JSON.parse(answer.stdout);
    expect(ack.task_id).toBe("t1");
    expect(ack.state).toBe("running");

    // The child unblocked and ran to completion in the background.
    await waitForState(home, "t1", "completed");
  });

  it("rejects --wait with exit 2 and points at parley watch", async () => {
    const answer = await runCli(["answer", "t1", "x", "--wait"], home);
    expect(answer.code).toBe(2);
    expect(answer.stderr).toMatch(/--wait/);
    expect(answer.stderr).toMatch(/parley watch/);
  });

  it("accepts a --name ref for answer", async () => {
    const cwd = taskDir([{ ask: "named?" }, { submit_report: REPORT }]);
    expect((await runCli(["delegate", "-v", "fake", "-n", "byname", "--cwd", cwd, "x"], home)).code).toBe(0);
    await waitForState(home, "byname", "awaiting_answer");

    const answer = await runCli(["answer", "byname", "sure"], home);
    expect(answer.code).toBe(0);
    expect(JSON.parse(answer.stdout).state).toBe("running");
    await waitForState(home, "byname", "completed");
  });
});

describe("answer usage errors (exit 2)", () => {
  it("rejects answering a task with no pending question", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "no-q"], home);
    await waitForState(home, "t1", "completed");

    const answer = await runCli(["answer", "t1", "hello"], home);
    expect(answer.code).toBe(2);
    expect(answer.stderr).toMatch(/pending question/);
  });

  it("rejects answering an unknown task", async () => {
    const answer = await runCli(["answer", "t999", "hello"], home);
    expect(answer.code).toBe(2);
    expect(answer.stderr).toMatch(/no such task/);
  });

  it("rejects a missing task ref", async () => {
    const answer = await runCli(["answer"], home);
    expect(answer.code).toBe(2);
    expect(answer.stderr).toMatch(/task/);
  });

  it("rejects a missing answer text", async () => {
    const answer = await runCli(["answer", "t1"], home);
    expect(answer.code).toBe(2);
    expect(answer.stderr).toMatch(/text/);
  });
});
