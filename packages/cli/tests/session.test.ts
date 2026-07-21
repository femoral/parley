/**
 * #162 / #190 / #196 — orchestrator session provenance CLI seam: env-only
 * harness/model/effort, env > session-state > unknown, env > flag > state >
 * ancestry for session id, registration, re-anchor, dual snapshots.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sessionStatePath, writeSessionState, type SessionState } from "@useparley/core";
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

/** Register a session with crafted anchor + env provenance (#190). */
async function registerSession(
  opts: {
    harness?: string | null;
    model?: string | null;
    effort?: string | null;
    sessionId?: string;
    /** When set, also put this on PARLEY_SESSION_ID (env wins over -s). */
    envSessionId?: string;
    anchor: { machine_id: string; pid: number; start_time: string };
    cwd?: string;
  },
): Promise<{
  session_id: string;
  harness: string | null;
  model: string | null;
  effort: string | null;
}> {
  const chain = JSON.stringify([opts.anchor]);
  const args = ["session", "--json"];
  if (opts.sessionId !== undefined) {
    args.push("-s", opts.sessionId);
  }
  // Always clear parent/process provenance env so tests own the values.
  // Explicit null opts leave the var unset (honest unknown).
  const extraEnv: NodeJS.ProcessEnv = {
    PARLEY_ANCESTRY_CHAIN: chain,
    PARLEY_SESSION_ID: opts.envSessionId ?? undefined,
    PARLEY_HARNESS: opts.harness === null ? undefined : (opts.harness ?? "Claude"),
    PARLEY_MODEL: opts.model === null ? undefined : (opts.model ?? "Opus"),
    PARLEY_EFFORT: opts.effort === null ? undefined : (opts.effort ?? "High"),
  };

  const res = await runCli(args, home, {
    cwd: opts.cwd,
    extraEnv,
  });
  expect(res.code, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as {
    session_id: string;
    harness: string | null;
    model: string | null;
    effort: string | null;
  };
}

describe("parley session registration (#190 env-only provenance)", () => {
  it("registers from env vars, lowercases provenance, prints id", async () => {
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

  it("registers with all-null provenance when env vars are unset", async () => {
    const ack = await registerSession({
      harness: null,
      model: null,
      effort: null,
      anchor: { machine_id: "m", pid: 1, start_time: "t" },
    });
    expect(ack.session_id).toMatch(/^s/);
    expect(ack.harness).toBeNull();
    expect(ack.model).toBeNull();
    expect(ack.effort).toBeNull();
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
    const res = await runCli(["session", "-s", "no-such-session", "--json"], home, {
      extraEnv: {
        PARLEY_ANCESTRY_CHAIN: JSON.stringify([
          { machine_id: "m", pid: 1, start_time: "t" },
        ]),
        PARLEY_HARNESS: "h",
        PARLEY_MODEL: "m",
        PARLEY_EFFORT: "e",
        PARLEY_SESSION_ID: undefined,
      },
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/unknown session/);
  });

  it("rejects removed -m/--model with env-var message", async () => {
    for (const flag of ["-m", "--model"] as const) {
      const res = await runCli(["session", flag, "opus"], home);
      expect(res.code, res.stderr).toBe(2);
      expect(res.stderr).toMatch(/removed/i);
      expect(res.stderr).toMatch(/PARLEY_MODEL|PARLEY_HARNESS|PARLEY_EFFORT/);
    }
  });

  it("rejects removed -e/--effort with env-var message", async () => {
    for (const flag of ["-e", "--effort"] as const) {
      const res = await runCli(["session", flag, "high"], home);
      expect(res.code, res.stderr).toBe(2);
      expect(res.stderr).toMatch(/removed/i);
      expect(res.stderr).toMatch(/PARLEY_/);
    }
  });

  it("rejects removed -v/--harness with env-var message", async () => {
    for (const flag of ["-v", "--harness"] as const) {
      const res = await runCli(["session", flag, "claude"], home);
      expect(res.code, res.stderr).toBe(2);
      expect(res.stderr).toMatch(/removed/i);
      expect(res.stderr).toMatch(/PARLEY_HARNESS/);
    }
  });

  it("PARLEY_SESSION_ID wins over -s for registration id", async () => {
    // First create a known session so re-anchor by env id succeeds.
    const first = await registerSession({
      harness: "claude",
      model: "opus",
      effort: "high",
      anchor: { machine_id: "m", pid: 1, start_time: "t" },
    });
    const second = await registerSession({
      harness: "grok",
      model: "fast",
      effort: "low",
      sessionId: "would-be-flag",
      envSessionId: first.session_id,
      anchor: { machine_id: "m", pid: 2, start_time: "t2" },
    });
    expect(second.session_id).toBe(first.session_id);
    expect(second.harness).toBe("grok");
  });
});

/** Write a plugin session-state file under the test home (#196). */
function writeState(
  homeDir: string,
  vendor: string,
  over: Partial<SessionState> & Pick<SessionState, "pid" | "harness_session_id">,
): void {
  const state: SessionState = {
    harness: "claude",
    model: "sonnet",
    effort: "high",
    started_at: "2026-07-20T12:00:00.000Z",
    updated_at: "2026-07-20T12:00:00.000Z",
    ...over,
  };
  writeSessionState(sessionStatePath(homeDir, vendor, state.harness_session_id), state);
}

describe("session-state file fallback (#196)", () => {
  it("file-only: registers harness/model/effort and harness session id", async () => {
    const livePid = process.pid;
    writeState(home, "claude", {
      harness: "Claude",
      harness_session_id: "hs-file-only",
      model: "Opus-4",
      effort: "High",
      pid: livePid,
    });
    const res = await runCli(["session", "--json"], home, {
      extraEnv: {
        PARLEY_ANCESTRY_CHAIN: JSON.stringify([
          { machine_id: "m", pid: livePid, start_time: "t" },
        ]),
        PARLEY_SESSION_ID: undefined,
        PARLEY_HARNESS: undefined,
        PARLEY_MODEL: undefined,
        PARLEY_EFFORT: undefined,
      },
    });
    expect(res.code, res.stderr).toBe(0);
    const ack = JSON.parse(res.stdout) as {
      session_id: string;
      harness: string | null;
      model: string | null;
      effort: string | null;
    };
    expect(ack.session_id).toBe("hs-file-only");
    expect(ack.harness).toBe("claude");
    expect(ack.model).toBe("opus-4");
    expect(ack.effort).toBe("high");
  });

  it("env beats file for provenance and session id", async () => {
    const livePid = process.pid;
    writeState(home, "claude", {
      harness: "file-harness",
      harness_session_id: "from-file",
      model: "file-model",
      effort: "file-effort",
      pid: livePid,
    });
    // Register once so env id re-anchor works if create_if_missing weren't set;
    // env create_if_missing allows first-time insert of "from-env".
    const res = await runCli(["session", "--json"], home, {
      extraEnv: {
        PARLEY_ANCESTRY_CHAIN: JSON.stringify([
          { machine_id: "m", pid: livePid, start_time: "t" },
        ]),
        PARLEY_SESSION_ID: "from-env",
        PARLEY_HARNESS: "env-harness",
        PARLEY_MODEL: "env-model",
        PARLEY_EFFORT: "env-effort",
      },
    });
    expect(res.code, res.stderr).toBe(0);
    const ack = JSON.parse(res.stdout);
    expect(ack.session_id).toBe("from-env");
    expect(ack.harness).toBe("env-harness");
    expect(ack.model).toBe("env-model");
    expect(ack.effort).toBe("env-effort");
  });

  it("--session flag beats file for session id (re-anchor)", async () => {
    const livePid = process.pid;
    const first = await registerSession({
      harness: "first",
      model: "m",
      effort: "e",
      anchor: { machine_id: "m", pid: livePid, start_time: "t0" },
    });
    writeState(home, "claude", {
      harness: "file-h",
      harness_session_id: "from-file-id",
      model: "file-m",
      effort: "file-e",
      pid: livePid,
    });
    const res = await runCli(["session", "-s", first.session_id, "--json"], home, {
      extraEnv: {
        PARLEY_ANCESTRY_CHAIN: JSON.stringify([
          { machine_id: "m", pid: livePid, start_time: "t1" },
        ]),
        PARLEY_SESSION_ID: undefined,
        // Env unset so provenance can come from the file; id still from -s.
        PARLEY_HARNESS: undefined,
        PARLEY_MODEL: undefined,
        PARLEY_EFFORT: undefined,
      },
    });
    expect(res.code, res.stderr).toBe(0);
    const ack = JSON.parse(res.stdout);
    expect(ack.session_id).toBe(first.session_id);
    expect(ack.session_id).not.toBe("from-file-id");
    // Provenance still falls back to the matched state file.
    expect(ack.harness).toBe("file-h");
    expect(ack.model).toBe("file-m");
    expect(ack.effort).toBe("file-e");
  });

  it("dead-pid state file is ignored (unknown provenance, fresh id)", async () => {
    const deadPid = 2_147_483_640;
    writeState(home, "claude", {
      harness: "should-ignore",
      harness_session_id: "dead-sess",
      model: "x",
      effort: "y",
      pid: deadPid,
    });
    const res = await runCli(["session", "--json"], home, {
      extraEnv: {
        // Chain includes the dead pid so matching would succeed without liveness.
        PARLEY_ANCESTRY_CHAIN: JSON.stringify([
          { machine_id: "m", pid: deadPid, start_time: "t" },
        ]),
        PARLEY_SESSION_ID: undefined,
        PARLEY_HARNESS: undefined,
        PARLEY_MODEL: undefined,
        PARLEY_EFFORT: undefined,
      },
    });
    expect(res.code, res.stderr).toBe(0);
    const ack = JSON.parse(res.stdout);
    expect(ack.session_id).not.toBe("dead-sess");
    expect(ack.harness).toBeNull();
    expect(ack.model).toBeNull();
    expect(ack.effort).toBeNull();
    expect(res.stderr).toMatch(/dead pid|session-state/i);
  });

  it("malformed JSON state file degrades without crash", async () => {
    const livePid = process.pid;
    const file = sessionStatePath(home, "claude", "bad");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    const res = await runCli(["session", "--json"], home, {
      extraEnv: {
        PARLEY_ANCESTRY_CHAIN: JSON.stringify([
          { machine_id: "m", pid: livePid, start_time: "t" },
        ]),
        PARLEY_SESSION_ID: undefined,
        PARLEY_HARNESS: undefined,
        PARLEY_MODEL: undefined,
        PARLEY_EFFORT: undefined,
      },
    });
    expect(res.code, res.stderr).toBe(0);
    const ack = JSON.parse(res.stdout);
    expect(ack.harness).toBeNull();
    expect(ack.model).toBeNull();
    expect(ack.effort).toBeNull();
  });

  it("partial fields: null model/effort still register harness + session id", async () => {
    const livePid = process.pid;
    writeState(home, "codex", {
      harness: "codex",
      harness_session_id: "partial-hs",
      model: null,
      effort: null,
      pid: livePid,
    });
    const res = await runCli(["session", "--json"], home, {
      extraEnv: {
        PARLEY_ANCESTRY_CHAIN: JSON.stringify([
          { machine_id: "m", pid: livePid, start_time: "t" },
        ]),
        PARLEY_SESSION_ID: undefined,
        PARLEY_HARNESS: undefined,
        PARLEY_MODEL: undefined,
        PARLEY_EFFORT: undefined,
      },
    });
    expect(res.code, res.stderr).toBe(0);
    const ack = JSON.parse(res.stdout);
    expect(ack.session_id).toBe("partial-hs");
    expect(ack.harness).toBe("codex");
    expect(ack.model).toBeNull();
    expect(ack.effort).toBeNull();
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

  it("--session override used when env unset; ancestry loses", async () => {
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
    // Ancestry would pick s2; flag forces s1 when env unset.
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

  it("PARLEY_SESSION_ID wins over --session on delegate (#190)", async () => {
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
    const del = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--session", s1.session_id, "x"],
      home,
      {
        extraEnv: {
          PARLEY_SESSION_ID: s2.session_id,
        },
      },
    );
    expect(del.code, del.stderr).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    const row = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBe(s2.session_id);
    expect(row.orch_harness).toBe("h2");
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

  it("null provenance snapshots through to status JSON", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const s = await registerSession({
      harness: null,
      model: null,
      effort: null,
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
    expect(del.code, del.stderr).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    const row = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBe(s.session_id);
    expect(row.orch_harness).toBeNull();
    expect(row.orch_model).toBeNull();
    expect(row.orch_effort).toBeNull();
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

  it("unknown-provenance session still accepts eval (null judge snapshot)", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    enableEvals(cwd);
    const s = await registerSession({
      harness: null,
      model: null,
      effort: null,
      anchor: { machine_id: "mac", pid: 10, start_time: "t" },
      cwd,
    });
    const chain = JSON.stringify([{ machine_id: "mac", pid: 10, start_time: "t" }]);
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
    expect(del.code, del.stderr).toBe(0);
    const taskId = JSON.parse(del.stdout).task_id as string;
    await waitForState(home, taskId, "completed");

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
          PARLEY_ANCESTRY_CHAIN: chain,
          PARLEY_SESSION_ID: undefined,
        },
      },
    );
    expect(evalRes.code, evalRes.stderr).toBe(0);
    const row = JSON.parse((await runCli(["status", taskId, "--json"], home)).stdout);
    expect(row.orchestrator_session_id).toBe(s.session_id);
    expect(row.orch_harness).toBeNull();
    expect(row.eval_session_id).toBe(s.session_id);
    expect(row.eval_harness).toBeNull();
    expect(row.eval_score).toBeTypeOf("number");
  });
});
