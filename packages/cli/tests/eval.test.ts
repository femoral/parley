/**
 * #157 — structured rubric eval CLI seam: --answers, --score rejection,
 * persistence via status --json, project override, answer validation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getShippedRubric, type RubricAnswers } from "@useparley/core";
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

function answersFor(rubricId: string, positives: boolean, negatives: boolean): RubricAnswers {
  const r = getShippedRubric(rubricId)!;
  const out: RubricAnswers = {};
  for (const c of r.criteria) {
    out[c.id] = c.kind === "positive" ? positives : negatives;
  }
  return out;
}

async function delegate(
  cwd: string,
  type?: string,
): Promise<string> {
  const args = ["delegate", "-v", "fake", "--cwd", cwd, "do it"];
  if (type !== undefined) args.splice(5, 0, "--type", type);
  const res = await runCli(args, home);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).task_id as string;
}

describe("parley eval --answers (#157)", () => {
  it("records answers; daemon computes score/baseline; status --json surfaces them", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const taskId = await delegate(cwd, "coding");

    const a = answersFor("coding", true, false);
    const evalRes = await runCli(
      ["eval", taskId, "--answers", JSON.stringify(a), "--feedback", "solid work"],
      home,
    );
    expect(evalRes.code).toBe(0);
    const ack = JSON.parse(evalRes.stdout) as {
      task_id: string;
      eval_score: number;
      eval_baseline: number;
      eval_rubric: string;
      eval_rubric_version: number;
    };
    expect(ack.task_id).toBe(taskId);
    expect(ack.eval_score).toBe(10);
    expect(ack.eval_baseline).toBe(5);
    expect(ack.eval_rubric).toBe("coding");
    expect(ack.eval_rubric_version).toBe(1);

    const status = await runCli(["status", taskId, "--json"], home);
    const row = JSON.parse(status.stdout) as {
      eval_score: number;
      eval_baseline: number;
      eval_feedback: string;
      eval_rubric: string;
      eval_rubric_version: number;
      eval_answers: RubricAnswers;
    };
    expect(row.eval_score).toBe(10);
    expect(row.eval_baseline).toBe(5);
    expect(row.eval_feedback).toBe("solid work");
    expect(row.eval_rubric).toBe("coding");
    expect(row.eval_rubric_version).toBe(1);
    expect(row.eval_answers).toEqual(a);

    const human = await runCli(["status", taskId], home);
    expect(human.code).toBe(0);
    // #164 enriched status: Session / Eval / Attempts sections.
    expect(human.stdout).toMatch(/Eval/);
    expect(human.stdout).toMatch(/score: 10 baseline=5/);
    expect(human.stdout).toMatch(/rubric: coding@v1/);
  });

  it("other type falls back to generic rubric", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const taskId = await delegate(cwd); // no --type → other
    const a = answersFor("generic", true, false);
    const evalRes = await runCli(
      ["eval", taskId, "--answers", JSON.stringify(a), "--feedback", "ok"],
      home,
    );
    expect(evalRes.code).toBe(0);
    const ack = JSON.parse(evalRes.stdout) as { eval_rubric: string; eval_score: number };
    expect(ack.eval_rubric).toBe("generic");
    expect(ack.eval_score).toBe(10);
  });

  it("project rubric override is used for scoring", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const rubricsDir = path.join(cwd, ".parley", "rubrics");
    fs.mkdirSync(rubricsDir, { recursive: true });
    fs.writeFileSync(
      path.join(rubricsDir, "coding.json"),
      JSON.stringify({
        id: "coding",
        version: 2,
        criteria: [
          { id: "shipped", kind: "positive", weight: 1, text: "Shipped" },
          { id: "broke", kind: "negative", weight: 1, text: "Broke" },
        ],
      }),
    );

    const taskId = await delegate(cwd, "coding");
    const evalRes = await runCli(
      [
        "eval",
        taskId,
        "--answers",
        JSON.stringify({ shipped: true, broke: false }),
        "--feedback",
        "custom rubric",
      ],
      home,
    );
    expect(evalRes.code).toBe(0);
    const ack = JSON.parse(evalRes.stdout) as {
      eval_score: number;
      eval_baseline: number;
      eval_rubric_version: number;
    };
    // max=2, raw=2, score=10; baseline=round(10*1/2)=5
    expect(ack.eval_score).toBe(10);
    expect(ack.eval_baseline).toBe(5);
    expect(ack.eval_rubric_version).toBe(2);
  });

  it("a later call overwrites the previous eval", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const taskId = await delegate(cwd, "coding");
    const good = answersFor("coding", true, false);
    const bad = answersFor("coding", false, true);

    await runCli(
      ["eval", taskId, "--answers", JSON.stringify(good), "--feedback", "first"],
      home,
    );
    await runCli(
      ["eval", taskId, "--answers", JSON.stringify(bad), "--feedback", "second"],
      home,
    );

    const status = await runCli(["status", taskId, "--json"], home);
    const row = JSON.parse(status.stdout) as {
      eval_score: number;
      eval_feedback: string;
      eval_answers: RubricAnswers;
    };
    expect(row.eval_score).toBe(0);
    expect(row.eval_feedback).toBe("second");
    expect(row.eval_answers).toEqual(bad);
  });

  it("below-baseline is derivable as score < baseline", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const taskId = await delegate(cwd, "coding");
    // Fail all positives, trigger all negatives → score 0, baseline 5
    const a = answersFor("coding", false, true);
    await runCli(
      ["eval", taskId, "--answers", JSON.stringify(a), "--feedback", "bad"],
      home,
    );
    const status = await runCli(["status", taskId, "--json"], home);
    const row = JSON.parse(status.stdout) as { eval_score: number; eval_baseline: number };
    expect(row.eval_score).toBe(0);
    expect(row.eval_baseline).toBe(5);
    expect(row.eval_score < row.eval_baseline).toBe(true);
  });
});

describe("eval usage errors (exit 2)", () => {
  it("rejects a missing task ref", async () => {
    const result = await runCli(["eval"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/task/);
  });

  it("rejects --score with a teaching message", async () => {
    const result = await runCli(
      ["eval", "t1", "--score", "8", "--feedback", "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--score is no longer accepted/);
    expect(result.stderr).toMatch(/--answers/);
  });

  it("rejects a missing --answers", async () => {
    const result = await runCli(["eval", "t1", "--feedback", "x"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/answers/);
  });

  it("rejects a missing --feedback", async () => {
    const result = await runCli(
      ["eval", "t1", "--answers", JSON.stringify({ a: true })],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/feedback/);
  });

  it("rejects invalid JSON for --answers", async () => {
    const result = await runCli(
      ["eval", "t1", "--answers", "{not-json", "--feedback", "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/JSON/);
  });

  it("rejects missing criterion ids", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const taskId = await delegate(cwd, "coding");
    const result = await runCli(
      [
        "eval",
        taskId,
        "--answers",
        JSON.stringify({ "brief-implemented": true }),
        "--feedback",
        "incomplete",
      ],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/missing criterion ids/);
  });

  it("rejects unknown criterion ids", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const taskId = await delegate(cwd, "coding");
    const a = answersFor("coding", true, false);
    const result = await runCli(
      [
        "eval",
        taskId,
        "--answers",
        JSON.stringify({ ...a, "not-a-criterion": true }),
        "--feedback",
        "extra",
      ],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown criterion ids/);
  });

  it("rejects an unknown task", async () => {
    const a = answersFor("generic", true, false);
    const result = await runCli(
      ["eval", "t999", "--answers", JSON.stringify(a), "--feedback", "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no such task/);
  });

  it("writes nothing on a rejected answers payload", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const taskId = await delegate(cwd, "coding");

    await runCli(
      [
        "eval",
        taskId,
        "--answers",
        JSON.stringify({ "brief-implemented": true }),
        "--feedback",
        "x",
      ],
      home,
    );

    const status = await runCli(["status", taskId, "--json"], home);
    const row = JSON.parse(status.stdout) as {
      eval_score: number | null;
      eval_feedback: string | null;
      eval_answers: unknown;
    };
    expect(row.eval_score).toBeNull();
    expect(row.eval_feedback).toBeNull();
    expect(row.eval_answers).toBeNull();
  });
});
