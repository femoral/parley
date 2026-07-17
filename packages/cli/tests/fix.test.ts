/**
 * #152 — attempt chains and `parley fix`: linked rows, inheritance, resume
 * toggle, and tri-state cache honesty.
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

function taskDir(actions: FakeVendorAction[], resumeActions?: FakeVendorAction[]): string {
  const dir = makeTaskDir(actions, resumeActions);
  taskDirs.push(dir);
  return dir;
}

const REPORT = {
  summary: "did the thing",
  outcome: "success",
  files_changed: ["src/a.ts"],
};

const FIX_REPORT = {
  summary: "fixed it",
  outcome: "success",
  files_changed: ["src/a.ts", "src/b.ts"],
};

/** First attempt: session + optional cache usage + report. */
function firstAttemptActions(opts: {
  sessionId?: string;
  usage?: Record<string, number> | null;
} = {}): FakeVendorAction[] {
  const sessionId = opts.sessionId ?? "fake-sess-parent";
  const actions: FakeVendorAction[] = [
    { emit: { type: "session", session_id: sessionId } },
    { emit: { type: "message", text: "first attempt" } },
  ];
  if (opts.usage !== null && opts.usage !== undefined) {
    actions.push({ emit: { type: "usage", ...opts.usage } });
  } else if (opts.usage === undefined) {
    // Default: report tokens but no cache field (tri-state: unreported).
    actions.push({ emit: { type: "usage", input_tokens: 50, output_tokens: 10 } });
  }
  actions.push({ submit_report: REPORT });
  return actions;
}

/** Resume/fix attempt script (runs under FAKE_RESUME_SESSION). */
function fixResumeActions(opts: {
  usage?: Record<string, number> | null;
} = {}): FakeVendorAction[] {
  const actions: FakeVendorAction[] = [
    { emit: { type: "session", session_id: "fake-sess-parent" } },
    { emit: { type: "message", text: "fix attempt" } },
  ];
  if (opts.usage !== null && opts.usage !== undefined) {
    actions.push({ emit: { type: "usage", ...opts.usage } });
  } else if (opts.usage === undefined) {
    actions.push({
      emit: {
        type: "usage",
        input_tokens: 20,
        output_tokens: 5,
        cached_input_tokens: 40,
      },
    });
  }
  actions.push({ submit_report: FIX_REPORT });
  return actions;
}

/** Fresh-session fix script (no FAKE_RESUME_SESSION — uses main .fake-vendor.json). */
function freshFixScript(opts: {
  usage?: Record<string, number> | null;
} = {}): FakeVendorAction[] {
  const actions: FakeVendorAction[] = [
    { emit: { type: "session", session_id: "fake-sess-fresh" } },
    { emit: { type: "message", text: "fresh fix attempt" } },
  ];
  if (opts.usage !== null && opts.usage !== undefined) {
    actions.push({ emit: { type: "usage", ...opts.usage } });
  } else if (opts.usage === undefined) {
    actions.push({ emit: { type: "usage", input_tokens: 30, output_tokens: 8 } });
  }
  actions.push({ submit_report: FIX_REPORT });
  return actions;
}

async function completeDelegate(
  args: string[],
  options: Parameters<typeof runCli>[2] = {},
): Promise<string> {
  const result = await runCli(args, home, options);
  expect(result.code).toBe(0);
  const ack = JSON.parse(result.stdout) as { task_id: string };
  await waitForState(home, ack.task_id, "completed");
  return ack.task_id;
}

describe("parley fix — attempt chains (#152)", () => {
  it("creates a linked attempt row; first delegations are attempt 1", async () => {
    const cwd = taskDir(firstAttemptActions(), fixResumeActions());
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "-n",
      "spine",
      "--size",
      "M",
      "--difficulty",
      "hard",
      "--cwd",
      cwd,
      "do the thing",
    ]);

    const parent = JSON.parse(
      (await runCli(["status", parentId, "--json"], home)).stdout,
    ) as Record<string, unknown>;
    expect(parent.attempt).toBe(1);
    expect(parent.parent_task_id).toBeNull();
    expect(parent.resumed).toBe(false);
    expect(parent.size).toBe("M");
    expect(parent.difficulty).toBe("hard");

    const fix = await runCli(["fix", parentId, "please fix the edge case"], home);
    expect(fix.code).toBe(0);
    expect(fix.stderr).toBe("");
    const ack = JSON.parse(fix.stdout) as {
      task_id: string;
      parent_task_id: string;
      attempt: number;
      resumed: boolean;
    };
    expect(ack.task_id).toBe("t2");
    expect(ack.parent_task_id).toBe(parentId);
    expect(ack.attempt).toBe(2);
    expect(ack.resumed).toBe(true);

    await waitForState(home, ack.task_id, "completed");
    const child = JSON.parse(
      (await runCli(["status", ack.task_id, "--json"], home)).stdout,
    ) as Record<string, unknown>;
    expect(child.parent_task_id).toBe(parentId);
    expect(child.attempt).toBe(2);
    expect(child.resumed).toBe(true);
    // Inheritance: size/difficulty/profile/worktree (cwd) from parent.
    expect(child.size).toBe("M");
    expect(child.difficulty).toBe("hard");
    expect(child.name).toBe("spine");
    expect(child.cwd).toBe(parent.cwd);
    expect(child.vendor).toBe("fake");
    // State/usage/eval hang off each attempt independently.
    expect(child.state).toBe("completed");
    expect(parent.state).toBe("completed");
    expect(child.prompt).toBe("please fix the edge case");
    expect(parent.prompt).toBe("do the thing");
  });

  it("resumes the parent vendor session when resume.enabled (default on)", async () => {
    const cwd = taskDir(
      firstAttemptActions({ sessionId: "sess-resume-me" }),
      fixResumeActions(),
    );
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "--cwd",
      cwd,
      "original brief",
    ]);

    const fix = await runCli(["fix", parentId, "fix brief"], home);
    const ack = JSON.parse(fix.stdout) as { task_id: string; resumed: boolean };
    expect(ack.resumed).toBe(true);
    await waitForState(home, ack.task_id, "completed");

    // Fake vendor emits { type: "resumed", session_id } when FAKE_RESUME_SESSION
    // carries the parent's session — that is the proof of adapter.resume().
    const log = fs.readFileSync(path.join(home, "tasks", ack.task_id, "vendor.jsonl"), "utf8");
    expect(log).toContain('"type":"resumed"');
    expect(log).toContain("sess-resume-me");

    const row = JSON.parse(
      (await runCli(["status", ack.task_id, "--json"], home)).stdout,
    ) as { resumed: boolean; session_id: string | null };
    expect(row.resumed).toBe(true);
    // Session id remains populated (seeded from parent, possibly re-emitted).
    expect(row.session_id).toBeTruthy();
  });

  it("spawns a fresh session (still linked) when resume.enabled is false", async () => {
    // First attempt uses the main script; after completion we swap the main
    // script so a non-resumed fix re-reads a fresh-session script (resume
    // script would only run if FAKE_RESUME_SESSION were set).
    const cwd = taskDir(firstAttemptActions({ sessionId: "sess-parent" }), fixResumeActions());
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "--cwd",
      cwd,
      "original",
    ]);

    // Project config: resume off. For --cwd tasks the project root is cwd.
    fs.mkdirSync(path.join(cwd, ".parley"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".parley", "config.json"),
      JSON.stringify({ resume: { enabled: false } }),
    );
    // Fresh fix runs prepare() → main script again.
    fs.writeFileSync(
      path.join(cwd, ".fake-vendor.json"),
      JSON.stringify(freshFixScript(), null, 2),
    );

    const fix = await runCli(["fix", parentId, "fresh fix brief"], home);
    expect(fix.code).toBe(0);
    const ack = JSON.parse(fix.stdout) as {
      task_id: string;
      parent_task_id: string;
      attempt: number;
      resumed: boolean;
    };
    expect(ack.parent_task_id).toBe(parentId);
    expect(ack.attempt).toBe(2);
    expect(ack.resumed).toBe(false);

    await waitForState(home, ack.task_id, "completed");
    const log = fs.readFileSync(path.join(home, "tasks", ack.task_id, "vendor.jsonl"), "utf8");
    // No resume marker — fresh session path.
    expect(log).not.toContain('"type":"resumed"');
    expect(log).toContain("fake-sess-fresh");

    const row = JSON.parse(
      (await runCli(["status", ack.task_id, "--json"], home)).stdout,
    ) as { resumed: boolean; session_id: string; parent_task_id: string };
    expect(row.resumed).toBe(false);
    expect(row.session_id).toBe("fake-sess-fresh");
    expect(row.parent_task_id).toBe(parentId);
  });

  it("persists tri-state cache: null when unreported, number when reported", async () => {
    // Parent: usage without cache field → cached_input_tokens null, cache_hit null.
    const cwd = taskDir(
      firstAttemptActions({ usage: { input_tokens: 10, output_tokens: 2 } }),
      fixResumeActions({
        usage: { input_tokens: 5, output_tokens: 1, cached_input_tokens: 100 },
      }),
    );
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "--cwd",
      cwd,
      "no cache",
    ]);
    const parent = JSON.parse(
      (await runCli(["status", parentId, "--json"], home)).stdout,
    ) as { cached_input_tokens: number | null; cache_hit: boolean | null };
    expect(parent.cached_input_tokens).toBeNull();
    expect(parent.cache_hit).toBeNull();

    // Fix with reported cache hit.
    const fix = await runCli(["fix", parentId, "with cache"], home);
    const ack = JSON.parse(fix.stdout) as { task_id: string };
    await waitForState(home, ack.task_id, "completed");
    const child = JSON.parse(
      (await runCli(["status", ack.task_id, "--json"], home)).stdout,
    ) as { cached_input_tokens: number | null; cache_hit: boolean | null };
    expect(child.cached_input_tokens).toBe(100);
    expect(child.cache_hit).toBe(true);
  });

  it("records cache_hit false when vendor reports zero cached tokens", async () => {
    const cwd = taskDir(
      firstAttemptActions({
        usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 },
      }),
      fixResumeActions(),
    );
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "--cwd",
      cwd,
      "zero cache",
    ]);
    const parent = JSON.parse(
      (await runCli(["status", parentId, "--json"], home)).stdout,
    ) as { cached_input_tokens: number | null; cache_hit: boolean | null };
    expect(parent.cached_input_tokens).toBe(0);
    expect(parent.cache_hit).toBe(false);
  });

  it("shows ATTEMPT in list/status text and --json", async () => {
    const cwd = taskDir(firstAttemptActions(), fixResumeActions());
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "--cwd",
      cwd,
      "a",
    ]);
    const fix = await runCli(["fix", parentId, "b"], home);
    const fixId = (JSON.parse(fix.stdout) as { task_id: string }).task_id;
    await waitForState(home, fixId, "completed");

    const table = await runCli(["status", "--all"], home);
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/ATTEMPT/);
    // Header + two rows; attempt numbers appear as standalone cells.
    const lines = table.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/ATTEMPT/);
    // Both attempts visible.
    expect(table.stdout).toContain(parentId);
    expect(table.stdout).toContain(fixId);

    const listJson = JSON.parse(
      (await runCli(["status", "--all", "--json"], home)).stdout,
    ) as Array<{ id: string; attempt: number; parent_task_id: string | null }>;
    const byId = Object.fromEntries(listJson.map((r) => [r.id, r]));
    expect(byId[parentId]?.attempt).toBe(1);
    expect(byId[parentId]?.parent_task_id).toBeNull();
    expect(byId[fixId]?.attempt).toBe(2);
    expect(byId[fixId]?.parent_task_id).toBe(parentId);
  });

  it("rejects fix on a non-terminal task with exit 2", async () => {
    // Park the child on an ask so the task stays running without a long sleep.
    const cwd = taskDir([
      { emit: { type: "session", session_id: "s" } },
      { ask: "need a decision" },
      { submit_report: REPORT },
    ]);
    const del = await runCli(["delegate", "-v", "fake", "--cwd", cwd, "hang"], home);
    const taskId = (JSON.parse(del.stdout) as { task_id: string }).task_id;
    await waitForState(home, taskId, "awaiting_answer");

    const fix = await runCli(["fix", taskId, "too soon"], home);
    expect(fix.code).toBe(2);
    expect(fix.stderr).toMatch(/terminal|fix requires/i);

    // Unblock so afterEach cleanup does not wait on a parked child.
    await runCli(["answer", taskId, "go ahead"], home);
    await waitForState(home, taskId, "completed");
  });

  it("rejects fix with a missing brief", async () => {
    const res = await runCli(["fix", "t1"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/fix brief|required/i);
  });
});

describe("parley fix — retry limits and --fresh (#158)", () => {
  function writeProjectRetry(
    cwd: string,
    retry: { max?: number; window?: string },
  ): void {
    fs.mkdirSync(path.join(cwd, ".parley"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".parley", "config.json"),
      JSON.stringify({ retry }),
    );
  }

  function writeDaemonVendorRetry(window: string | number): void {
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify({ vendors: { fake: { retryWindow: window } } }, null, 2),
    );
  }

  it("rejects a second resume when retry.max is 1 (exit 7, stable code)", async () => {
    // Default retry.max=1: one resumed fix is allowed, the next resume is not.
    const cwd = taskDir(firstAttemptActions(), fixResumeActions());
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "--cwd",
      cwd,
      "original brief",
    ]);

    const first = await runCli(["fix", parentId, "first resumed fix"], home);
    expect(first.code).toBe(0);
    const firstAck = JSON.parse(first.stdout) as {
      task_id: string;
      attempt: number;
      resumed: boolean;
    };
    expect(firstAck.resumed).toBe(true);
    expect(firstAck.attempt).toBe(2);
    await waitForState(home, firstAck.task_id, "completed");

    // Second resume against the latest attempt: budget already spent.
    const second = await runCli(["fix", firstAck.task_id, "second resume"], home);
    expect(second.code).toBe(7);
    expect(second.stderr).toMatch(/retry limit exceeded/i);
    expect(second.stderr).toMatch(/parley fix --fresh/);
    expect(second.stderr).toMatch(/new delegate/i);
    // Never coach raising the limit.
    expect(second.stderr.toLowerCase()).not.toMatch(/raise|increase|set retry/);
    expect(second.stdout).toBe("");

    // Rejection creates no new task row — chain still has one resumed attempt.
    const list = JSON.parse(
      (await runCli(["status", "--all", "--json"], home)).stdout,
    ) as Array<{ id: string; resumed: boolean; parent_task_id: string | null }>;
    const chain = list.filter(
      (t) => t.id === parentId || t.parent_task_id === parentId || t.id === firstAck.task_id,
    );
    expect(chain.filter((t) => t.resumed).length).toBe(1);
  });

  it("window expiry rejects resume (exit 8) without consuming budget", async () => {
    const cwd = taskDir(firstAttemptActions(), fixResumeActions());
    // Tiny window so a brief wait after completion expires it.
    writeProjectRetry(cwd, { max: 1, window: "1ms" });
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "--cwd",
      cwd,
      "original brief",
    ]);
    // Ensure parent has been terminal longer than 1ms.
    await new Promise((r) => setTimeout(r, 20));

    const blocked = await runCli(["fix", parentId, "too late to resume"], home);
    expect(blocked.code).toBe(8);
    expect(blocked.stderr).toMatch(/reattempt window expired/i);
    expect(blocked.stderr).toMatch(/parley fix --fresh/);
    expect(blocked.stderr).toMatch(/new delegate/i);
    expect(blocked.stderr.toLowerCase()).not.toMatch(/raise|increase/);
    expect(blocked.stdout).toBe("");

    // No attempt row created → budget still unused. Lengthen the window and
    // a resume must succeed (window expiry must not consume the retry budget).
    writeProjectRetry(cwd, { max: 1, window: "30m" });
    const after = await runCli(["fix", parentId, "still within budget"], home);
    expect(after.code).toBe(0);
    const ack = JSON.parse(after.stdout) as { resumed: boolean; attempt: number };
    expect(ack.resumed).toBe(true);
    expect(ack.attempt).toBe(2);
    await waitForState(home, (JSON.parse(after.stdout) as { task_id: string }).task_id, "completed");
  });

  it("honors vendors.<id>.retryWindow override (hot-read)", async () => {
    const cwd = taskDir(firstAttemptActions(), fixResumeActions());
    // Project window is generous; vendor override is already expired.
    writeProjectRetry(cwd, { max: 2, window: "30m" });
    writeDaemonVendorRetry("1ms");
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "--cwd",
      cwd,
      "original",
    ]);
    await new Promise((r) => setTimeout(r, 20));

    const blocked = await runCli(["fix", parentId, "vendor window"], home);
    expect(blocked.code).toBe(8);
    expect(blocked.stderr).toMatch(/reattempt window expired/i);

    // Hot-read: widen vendor window without restarting the daemon.
    writeDaemonVendorRetry("30m");
    const ok = await runCli(["fix", parentId, "now allowed"], home);
    expect(ok.code).toBe(0);
    const ack = JSON.parse(ok.stdout) as { resumed: boolean };
    expect(ack.resumed).toBe(true);
    await waitForState(home, (JSON.parse(ok.stdout) as { task_id: string }).task_id, "completed");
  });

  it("--fresh is uncapped, stays in the chain, and composes three-section context", async () => {
    const cwd = taskDir(firstAttemptActions(), fixResumeActions());
    // Spend the resume budget so a normal fix would fail.
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "--cwd",
      cwd,
      "do the original thing",
    ]);
    const resumed = await runCli(["fix", parentId, "first fix brief"], home);
    const resumedId = (JSON.parse(resumed.stdout) as { task_id: string }).task_id;
    await waitForState(home, resumedId, "completed");

    // Normal fix is blocked.
    const blocked = await runCli(["fix", resumedId, "would resume"], home);
    expect(blocked.code).toBe(7);

    // Fresh path: swap main script so the blank session uses a known session id.
    fs.writeFileSync(
      path.join(cwd, ".fake-vendor.json"),
      JSON.stringify(freshFixScript(), null, 2),
    );

    const fresh = await runCli(
      ["fix", "--fresh", resumedId, "start over with full context"],
      home,
    );
    expect(fresh.code).toBe(0);
    const ack = JSON.parse(fresh.stdout) as {
      task_id: string;
      parent_task_id: string;
      attempt: number;
      resumed: boolean;
    };
    expect(ack.parent_task_id).toBe(resumedId);
    expect(ack.attempt).toBe(3);
    expect(ack.resumed).toBe(false);

    await waitForState(home, ack.task_id, "completed");

    const log = fs.readFileSync(path.join(home, "tasks", ack.task_id, "vendor.jsonl"), "utf8");
    expect(log).not.toContain('"type":"resumed"');
    expect(log).toContain("fake-sess-fresh");

    // Hello event carries the full prompt — assert three-section composition
    // behind the channel-matched preamble.
    const helloLine = log.split("\n").find((l) => l.includes('"hello"'));
    expect(helloLine).toBeTruthy();
    const prompt = (JSON.parse(helloLine!) as { prompt: string }).prompt;
    expect(prompt).toContain("Parley protocol");
    expect(prompt).toMatch(/ask_orchestrator|submit_report/);
    expect(prompt).toContain("## Original brief");
    expect(prompt).toContain("do the original thing");
    expect(prompt).toContain("## Attempt history");
    expect(prompt).toContain("### Attempt 1 (");
    expect(prompt).toContain("Brief: do the original thing");
    expect(prompt).toMatch(/Report: did the thing \(outcome: success\)/);
    expect(prompt).toContain("### Attempt 2 (");
    expect(prompt).toContain("Brief: first fix brief");
    expect(prompt).toMatch(/Report: fixed it \(outcome: success\)/);
    expect(prompt).toContain("## Fix request");
    expect(prompt).toContain("start over with full context");
  });

  it("stable error codes appear in the daemon HTTP body", async () => {
    const cwd = taskDir(firstAttemptActions(), fixResumeActions());
    writeProjectRetry(cwd, { max: 0, window: "30m" });
    const parentId = await completeDelegate([
      "delegate",
      "-v",
      "fake",
      "--cwd",
      cwd,
      "x",
    ]);

    // max=0: any resume is over budget. Hit the daemon HTTP surface directly
    // so we can assert the JSON `code` field (CLI only surfaces the message).
    const discovery = JSON.parse(
      fs.readFileSync(path.join(home, "daemon.json"), "utf8"),
    ) as { port: number };
    const res = await fetch(`http://127.0.0.1:${discovery.port}/tasks/${parentId}/fix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "nope" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("retry_limit_exceeded");
    expect(body.error).toMatch(/retry limit exceeded/i);
    expect(body.error).toMatch(/parley fix --fresh/);
  });
});

