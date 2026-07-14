import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { cleanupHome, makeHome, makeTaskDir, runCli, type FakeVendorAction } from "./helpers.js";

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
  summary: "done",
  outcome: "success",
  files_changed: ["src/a.ts"],
};

describe("parley eval", () => {
  it("records a score/feedback, readable back via status --json", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const delegate = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "--wait", "do it"], home);
    expect(delegate.code).toBe(0);
    const taskId = JSON.parse(delegate.stdout).task_id as string;

    const evalRes = await runCli(
      ["eval", taskId, "--score", "8", "--feedback", "solid work"],
      home,
    );
    expect(evalRes.code).toBe(0);
    expect(JSON.parse(evalRes.stdout).task_id).toBe(taskId);

    const status = await runCli(["status", taskId, "--json"], home);
    const row = JSON.parse(status.stdout);
    expect(row.eval_score).toBe(8);
    expect(row.eval_feedback).toBe("solid work");
  });

  it("a later call overwrites the previous score/feedback", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const delegate = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "--wait", "do it"], home);
    const taskId = JSON.parse(delegate.stdout).task_id as string;

    await runCli(["eval", taskId, "--score", "3", "--feedback", "meh"], home);
    await runCli(["eval", taskId, "--score", "9", "--feedback", "great"], home);

    const status = await runCli(["status", taskId, "--json"], home);
    const row = JSON.parse(status.stdout);
    expect(row.eval_score).toBe(9);
    expect(row.eval_feedback).toBe("great");
  });
});

describe("eval usage errors (exit 2)", () => {
  it("rejects a missing task ref", async () => {
    const result = await runCli(["eval"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/task/);
  });

  it("rejects a missing --score", async () => {
    const result = await runCli(["eval", "t1", "--feedback", "x"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/score/);
  });

  it("rejects a missing --feedback", async () => {
    const result = await runCli(["eval", "t1", "--score", "5"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/feedback/);
  });

  it("rejects --score 0", async () => {
    const result = await runCli(["eval", "t1", "--score", "0", "--feedback", "x"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/score/);
  });

  it("rejects --score 11", async () => {
    const result = await runCli(["eval", "t1", "--score", "11", "--feedback", "x"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/score/);
  });

  it("rejects a non-integer --score", async () => {
    const result = await runCli(["eval", "t1", "--score", "abc", "--feedback", "x"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/score/);
  });

  it("rejects an unknown task", async () => {
    const result = await runCli(["eval", "t999", "--score", "5", "--feedback", "x"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no such task/);
  });

  it("writes nothing on a rejected score", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const delegate = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "--wait", "do it"], home);
    const taskId = JSON.parse(delegate.stdout).task_id as string;

    await runCli(["eval", taskId, "--score", "0", "--feedback", "x"], home);

    const status = await runCli(["status", taskId, "--json"], home);
    const row = JSON.parse(status.stdout);
    expect(row.eval_score).toBeNull();
    expect(row.eval_feedback).toBeNull();
  });
});
