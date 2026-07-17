/**
 * #162 — orchestrator session provenance CLI seam: registration, re-anchor,
 * ancestry binding with crafted chains, dual snapshots, session_required gate.
 */
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
  summary: "done",
  outcome: "success",
  files_changed: ["a.ts"],
};

function enableEvals(cwd: string): void {
  const dir = path.join(cwd, ".parley");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ eval: { enabled: true } }),
  );
}

/** Register a session with a crafted anchor via PARLEY_ANCESTRY_CHAIN. */
async function registerSession(
  opts: {
    harness?: string;
    model?: string;
    effort?: string;
    sessionId?: string;
    anchor: { machine_id: string; pid: number; start_time: string };
    cwd?: string;
  },
): Promise<{ session_id: string; harness: string; model: string; effort: string }> {
  const chain = JSON.stringify([opts.anchor]);
  const args = [
    "session",
    "-v",
    opts.harness ?? "Claude",
    "-m",
    opts.model ?? "Opus",
    "-e",
    opts.effort ?? "High",
    "--json",
  ];
  if (opts.sessionId !== undefined) {
    args.push("-s", opts.sessionId);
  }
  const res = await runCli(args, home, {
    cwd: opts.cwd,
    extraEnv: {
      PARLEY_ANCESTRY_CHAIN: chain,
      // Clear default freeform so registration is the source of truth.
      PARLEY_SESSION_ID: undefined,
    },
  });
  expect(res.code, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as {
    session_id: string;
    harness: string;
    model: string;
    effort: string;
  };
}

describe("parley session registration (#162)", () => {
  it("registers with required flags, lowercases provenance, prints id", async () => {
    const ack = await registerSession({
      harness: "Claude",
      model: "Opus-4",
      effort: "High",
      anchor: { machine_id: "m", pid: 1, start_time: "t" },
    });
    expect(ack.session_id).toMatch(/^s/);
    expect(ack.harness).toBe("claude");
    expect(ack.model).toBe("opus-4");
    expect(ack.effort).toBe("high");
  });

  it("re-anchors a known session and updates provenance", async () => {
    const first = await registerSession({
      harness: "claude",
      model: "opus",
      effort: "high",
      anchor: { machine_id: "m", pid: 10, start_time: "old" },
    });
    const second = await registerSession({
      harness: "grok",
      model: "beta",
      effort: "low",
      sessionId: first.session_id,
      anchor: { machine_id: "m", pid: 99, start_time: "new" },
    });
    expect(second.session_id).toBe(first.session_id);
    expect(second.harness).toBe("grok");
    expect(second.model).toBe("beta");
    expect(second.effort).toBe("low");
  });

  it("errors on unknown -s", async () => {
    const res = await runCli(
      ["session", "-v", "h", "-m", "m", "-e", "e", "-s", "no-such-session"],
      home,
      {
        extraEnv: {
          PARLEY_ANCESTRY_CHAIN: JSON.stringify([
            { machine_id: "m", pid: 1, start_time: "t" },
          ]),
        },
      },
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/unknown session/);
  });

  it("requires harness, model, and effort", async () => {
    const res = await runCli(["session", "-v", "h", "-m", "m"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/effort/);
  });
});

describe("ancestry binding at CLI seam (#162)", () => {
  it("binds delegate to the deepest matching session (no cross-bind)", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    // Two same-cwd sessions with distinct anchors.
    const s1 = await registerSession({
      harness: "h1",
      model: "m1",
      effort: "e1",
      anchor: { machine_id: "mac", pid: 111, start_time: "t1" },
      cwd,
    });
    const s2 = await registerSession({
      harness: "h2",
      model: "m2",
      effort: "e2",
      anchor: { machine_id: "mac", pid: 222, start_time: "t2" },
      cwd,
    });

    // Caller's chain includes only s2's anchor (deepest match = s2).
    const chain = JSON.stringify([
      { machine_id: "mac", pid: 999, start_time: "self" },
      { machine_id: "mac", pid: 222, start_time: "t2" },
      { machine_id: "mac", pid: 1, start_time: "boot" },
    ]);
    const del = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "do it"],
      home,
      {
        extraEnv: {
          PARLEY_ANCESTRY_CHAIN: chain,
          PARLEY_SESSION_ID: undefined,
        },
      },
    );
    expect(del.code, del.stderr).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    await waitForState(home, taskId, "completed");

    const row = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBe(s2.session_id);
    expect(row.orch_harness).toBe("h2");
    expect(row.orch_model).toBe("m2");
    expect(row.orch_effort).toBe("e2");
    // s1 never cross-bound.
    expect(row.orchestrator_session_id).not.toBe(s1.session_id);
  });

  it("--session override wins over ancestry", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const s1 = await registerSession({
      harness: "h1",
      model: "m1",
      effort: "e1",
      anchor: { machine_id: "mac", pid: 111, start_time: "t1" },
      cwd,
    });
    const s2 = await registerSession({
      harness: "h2",
      model: "m2",
      effort: "e2",
      anchor: { machine_id: "mac", pid: 222, start_time: "t2" },
      cwd,
    });
    // Ancestry would pick s2; override forces s1.
    const chain = JSON.stringify([
      { machine_id: "mac", pid: 222, start_time: "t2" },
    ]);
    const del = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--session", s1.session_id, "x"],
      home,
      {
        extraEnv: {
          PARLEY_ANCESTRY_CHAIN: chain,
          PARLEY_SESSION_ID: undefined,
        },
      },
    );
    expect(del.code, del.stderr).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    const row = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBe(s1.session_id);
    expect(row.orch_harness).toBe("h1");
    void s2;
  });

  it("falls back to the single live session for the workspace", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const s = await registerSession({
      harness: "solo",
      model: "m",
      effort: "e",
      // Anchor not in the caller's chain.
      anchor: { machine_id: "mac", pid: 1, start_time: "boot" },
      cwd,
    });
    const del = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "x"],
      home,
      {
        extraEnv: {
          // Empty-ish chain with no match.
          PARLEY_ANCESTRY_CHAIN: JSON.stringify([
            { machine_id: "mac", pid: 99999, start_time: "nope" },
          ]),
          PARLEY_SESSION_ID: undefined,
        },
      },
    );
    expect(del.code, del.stderr).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    const row = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBe(s.session_id);
    expect(row.orch_harness).toBe("solo");
  });

  it("ambiguity error when two live sessions and no ancestry match", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    await registerSession({
      harness: "a",
      model: "m",
      effort: "e",
      anchor: { machine_id: "mac", pid: 1, start_time: "t1" },
      cwd,
    });
    await registerSession({
      harness: "b",
      model: "m",
      effort: "e",
      anchor: { machine_id: "mac", pid: 2, start_time: "t2" },
      cwd,
    });
    const del = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "x"],
      home,
      {
        extraEnv: {
          PARLEY_ANCESTRY_CHAIN: JSON.stringify([
            { machine_id: "mac", pid: 99999, start_time: "nope" },
          ]),
          PARLEY_SESSION_ID: undefined,
        },
      },
    );
    expect(del.code).toBe(2);
    expect(del.stderr).toMatch(/ambiguous/i);
  });
});

describe("dual snapshot immutability (#162)", () => {
  it("session updates never rewrite past task/eval provenance", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const s = await registerSession({
      harness: "claude",
      model: "opus",
      effort: "high",
      anchor: { machine_id: "mac", pid: 50, start_time: "t0" },
      cwd,
    });
    const chain = JSON.stringify([
      { machine_id: "mac", pid: 50, start_time: "t0" },
    ]);
    const del = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "x"],
      home,
      {
        extraEnv: {
          PARLEY_ANCESTRY_CHAIN: chain,
          PARLEY_SESSION_ID: undefined,
        },
      },
    );
    expect(del.code).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    await waitForState(home, taskId, "completed");

    // Re-anchor with different provenance.
    await registerSession({
      harness: "grok",
      model: "fast",
      effort: "low",
      sessionId: s.session_id,
      anchor: { machine_id: "mac", pid: 50, start_time: "t0" },
      cwd,
    });

    const row = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    // Spawn snapshot frozen at original values.
    expect(row.orchestrator_session_id).toBe(s.session_id);
    expect(row.orch_harness).toBe("claude");
    expect(row.orch_model).toBe("opus");
    expect(row.orch_effort).toBe("high");

    // Eval with a different judging session snapshots independently.
    const judge = await registerSession({
      harness: "judge-h",
      model: "judge-m",
      effort: "judge-e",
      anchor: { machine_id: "mac", pid: 77, start_time: "j" },
      cwd,
    });
    const judgeChain = JSON.stringify([
      { machine_id: "mac", pid: 77, start_time: "j" },
    ]);
    // Answers for the generic rubric (type defaults to other → generic).
    const answers = {
      "brief-fulfilled": true,
      evidenced: true,
      complete: true,
      "report-complete": true,
      "broke-existing": false,
      "fabricated-claim": false,
      "scope-creep": false,
    };
    const evalRes = await runCli(
      [
        "eval",
        taskId,
        "--answers",
        JSON.stringify(answers),
        "--feedback",
        "ok",
      ],
      home,
      {
        cwd,
        extraEnv: {
          PARLEY_ANCESTRY_CHAIN: judgeChain,
          PARLEY_SESSION_ID: undefined,
        },
      },
    );
    expect(evalRes.code, evalRes.stderr).toBe(0);

    const after = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    // Spawn orch_* still frozen.
    expect(after.orch_harness).toBe("claude");
    expect(after.orch_model).toBe("opus");
    // Judge snapshot is the judging session.
    expect(after.eval_session_id).toBe(judge.session_id);
    expect(after.eval_harness).toBe("judge-h");
    expect(after.eval_model).toBe("judge-m");
    expect(after.eval_effort).toBe("judge-e");

    // Update judge session — eval snapshot must not change.
    await registerSession({
      harness: "mutated",
      model: "mutated",
      effort: "mutated",
      sessionId: judge.session_id,
      anchor: { machine_id: "mac", pid: 77, start_time: "j" },
      cwd,
    });
    const final = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    expect(final.eval_harness).toBe("judge-h");
    expect(final.eval_model).toBe("judge-m");
    expect(final.eval_effort).toBe("judge-e");
  });
});

describe("session_required gate (#162)", () => {
  it("fires on delegate when evals on and nothing resolves", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    enableEvals(cwd);
    const del = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "x"],
      home,
      {
        extraEnv: {
          PARLEY_ANCESTRY_CHAIN: JSON.stringify([
            { machine_id: "mac", pid: 1, start_time: "t" },
          ]),
          PARLEY_SESSION_ID: undefined,
        },
      },
    );
    expect(del.code).toBe(2);
    expect(del.stderr).toMatch(/session_required/);
    expect(del.stderr).toMatch(/parley session/);
  });

  it("does not fire when evals off and no session (optional)", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const del = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "x"],
      home,
      {
        extraEnv: {
          PARLEY_ANCESTRY_CHAIN: JSON.stringify([
            { machine_id: "mac", pid: 1, start_time: "t" },
          ]),
          PARLEY_SESSION_ID: undefined,
        },
      },
    );
    expect(del.code, del.stderr).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    const row = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBeNull();
    expect(row.orch_harness).toBeNull();
  });

  it("fires on eval when evals on and no judge session resolves", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    // Create task while evals off (no session required).
    const del = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "x"],
      home,
      {
        extraEnv: {
          PARLEY_SESSION_ID: "free",
        },
      },
    );
    expect(del.code).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    await waitForState(home, taskId, "completed");

    enableEvals(cwd);
    const answers = {
      "brief-fulfilled": true,
      evidenced: true,
      complete: true,
      "report-complete": true,
      "broke-existing": false,
      "fabricated-claim": false,
      "scope-creep": false,
    };
    const evalRes = await runCli(
      [
        "eval",
        taskId,
        "--answers",
        JSON.stringify(answers),
        "--feedback",
        "ok",
      ],
      home,
      {
        cwd,
        extraEnv: {
          PARLEY_SESSION_ID: undefined,
          PARLEY_ANCESTRY_CHAIN: JSON.stringify([
            { machine_id: "mac", pid: 1, start_time: "t" },
          ]),
        },
      },
    );
    expect(evalRes.code).toBe(2);
    expect(evalRes.stderr).toMatch(/session_required/);
  });

  it("freeform --session still works when evals off", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const del = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--session", "my-orch", "x"],
      home,
      { extraEnv: { PARLEY_SESSION_ID: undefined } },
    );
    expect(del.code).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    const row = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBe("my-orch");
    expect(row.orch_harness).toBeNull();
  });
});
