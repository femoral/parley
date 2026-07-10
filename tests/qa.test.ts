import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
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

/** Read the fake vendor's echoed tool results from the raw stream. */
function toolResults(home: string, taskId: string): { tool: string; is_error: boolean; text: string }[] {
  const log = fs.readFileSync(path.join(home, "tasks", taskId, "vendor.jsonl"), "utf8");
  return log
    .split("\n")
    .filter((l) => l.includes('"tool_result"'))
    .map((l) => JSON.parse(l) as { tool: string; is_error: boolean; text: string });
}

describe("Q&A channel — ask_orchestrator / parley answer", () => {
  it("blocks on a question, returns exit 3 + question JSON, then answers to completion", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "qa-sess" } },
      { ask: "which database?" },
      { submit_report: REPORT },
    ]);

    // delegate --wait blocks until the child asks; then returns exit 3.
    const delegate = await runCli(
      ["delegate", "-v", "fake", "-n", "qa", "--cwd", cwd, "--wait", "do it"],
      home,
    );
    expect(delegate.stderr).toBe("");
    expect(delegate.code).toBe(3);
    const question = JSON.parse(delegate.stdout);
    expect(question.task_id).toBe("t1");
    expect(question.name).toBe("qa");
    expect(question.question).toBe("which database?");
    expect(typeof question.question_id).toBe("string");

    // The task is visibly awaiting_answer while blocked.
    const status = await runCli(["status", "t1", "--json"], home);
    expect(JSON.parse(status.stdout)[0].state).toBe("awaiting_answer");

    // answer --wait delivers the text and re-blocks; the child reports → exit 0.
    const answer = await runCli(["answer", "t1", "postgres", "--wait"], home);
    expect(answer.stderr).toBe("");
    expect(answer.code).toBe(0);
    const envelope = JSON.parse(answer.stdout);
    expect(envelope.state).toBe("completed");
    expect(envelope.report).toEqual(REPORT);

    // The answer text arrived at the child as the ask_orchestrator tool result.
    const asks = toolResults(home, "t1").filter((r) => r.tool === "ask_orchestrator");
    expect(asks).toHaveLength(1);
    expect(asks[0]!.is_error).toBe(false);
    expect(asks[0]!.text).toBe("postgres");
  });

  it("round-trips multiple sequential questions, each correlated by a distinct id", async () => {
    const cwd = taskDir([
      { ask: "first?" },
      { ask: "second?" },
      { submit_report: REPORT },
    ]);

    const delegate = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--wait", "multi"],
      home,
    );
    expect(delegate.code).toBe(3);
    const q1 = JSON.parse(delegate.stdout);
    expect(q1.question).toBe("first?");

    // answer --wait re-blocks and returns the *next* question (exit 3 again).
    const answer1 = await runCli(["answer", "t1", "one", "--wait"], home);
    expect(answer1.code).toBe(3);
    const q2 = JSON.parse(answer1.stdout);
    expect(q2.question).toBe("second?");
    expect(q2.question_id).not.toBe(q1.question_id);

    // Final answer drives it to completion.
    const answer2 = await runCli(["answer", "t1", "two", "--wait"], home);
    expect(answer2.code).toBe(0);
    expect(JSON.parse(answer2.stdout).state).toBe("completed");

    const asks = toolResults(home, "t1").filter((r) => r.tool === "ask_orchestrator");
    expect(asks.map((r) => r.text)).toEqual(["one", "two"]);
  });

  it("answer without --wait delivers and returns immediately; the child continues", async () => {
    const cwd = taskDir([{ ask: "go on?" }, { submit_report: REPORT }]);

    const delegate = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--wait", "fire-and-forget"],
      home,
    );
    expect(delegate.code).toBe(3);

    const answer = await runCli(["answer", "t1", "yes"], home);
    expect(answer.code).toBe(0);
    const ack = JSON.parse(answer.stdout);
    expect(ack.task_id).toBe("t1");
    expect(ack.state).toBe("running");

    // The child unblocked and ran to completion in the background.
    await waitForState(home, "t1", "completed");
  });

  it("accepts a --name ref for answer", async () => {
    const cwd = taskDir([{ ask: "named?" }, { submit_report: REPORT }]);
    const delegate = await runCli(
      ["delegate", "-v", "fake", "-n", "byname", "--cwd", cwd, "--wait", "x"],
      home,
    );
    expect(delegate.code).toBe(3);

    const answer = await runCli(["answer", "byname", "sure", "--wait"], home);
    expect(answer.code).toBe(0);
    expect(JSON.parse(answer.stdout).state).toBe("completed");
  });
});

describe("answer usage errors (exit 2)", () => {
  it("rejects answering a task with no pending question", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "--wait", "no-q"], home);

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
