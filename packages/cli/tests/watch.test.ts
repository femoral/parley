import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  runCli,
  startCli,
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

const REPORT = { summary: "did it", outcome: "success", files_changed: ["a.ts"] };

/** A quick vendor run: session, then a report. */
function quick(): FakeVendorAction[] {
  return [{ emit: { type: "session", session_id: "s" } }, { submit_report: REPORT }];
}

/** A run that lingers `ms` in `running` before completing. */
function slow(ms: number): FakeVendorAction[] {
  return [{ emit: { type: "session", session_id: "s" } }, { sleep: ms }, { submit_report: REPORT }];
}

/** Delegate (always async) and return the parsed ack `{task_id, name, state, seq}`. */
async function delegate(cwd: string, name?: string): Promise<Record<string, unknown>> {
  const args = ["delegate", "-v", "fake", "--cwd", cwd, ...(name ? ["-n", name] : []), "run"];
  const res = await runCli(args, home);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

describe("transition seq (#34)", () => {
  it("every task envelope from delegate, status, and answer carries a seq", async () => {
    // delegate ack: a fresh pending task has seq 0 (no transition yet).
    const ack = await delegate(taskDir(quick()), "seqs");
    expect(ack.seq).toBe(0);

    await waitForState(home, "t1", "completed");

    // status --json row carries the seq of the latest transition (> 0).
    const row = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout) as Record<
      string,
      unknown
    >;
    expect(typeof row.seq).toBe("number");
    expect(row.seq as number).toBeGreaterThan(0);

    // watch completed envelope carries a seq too.
    const watched = JSON.parse(
      (await runCli(["watch", "t1", "--json"], home)).stdout,
    ) as { seq: number; task: Record<string, unknown> };
    expect(typeof watched.seq).toBe("number");
    expect(watched.task.state).toBe("completed");
  });

  it("answer ack carries a seq", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "s" } },
      { ask: "which db?" },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "qa"], home);
    await waitForState(home, "t1", "awaiting_answer");
    const ack = JSON.parse((await runCli(["answer", "t1", "postgres"], home)).stdout) as Record<
      string,
      unknown
    >;
    expect(typeof ack.seq).toBe("number");
    expect(ack.state).toBe("running");
  });
});

describe("parley watch attention inbox (ADR-0007 / #91)", () => {
  it("level-trigger: event already pending at watch start returns immediately", async () => {
    // Complete before watch starts — level-triggered inbox surfaces `completed`
    // without needing a transition after connect (the #89 edge-trigger miss).
    await delegate(taskDir(quick()), "done");
    await waitForState(home, "t1", "completed");

    const res = await runCli(["watch", "t1", "--json"], home);
    expect(res.code).toBe(6);
    const ev = JSON.parse(res.stdout) as { event: string; seq: number; task: Record<string, unknown> };
    expect(ev.event).toBe("task.completed");
    expect(ev.task.task_id).toBe("t1");
    expect(ev.task.state).toBe("completed");
    expect(ev.seq).toBeGreaterThan(0);
  });

  it("all-terminal + all-acked exits 0 (the #89 hang case)", async () => {
    await delegate(taskDir(quick()), "a");
    await delegate(taskDir(quick()), "b");
    await waitForState(home, "t1", "completed");
    await waitForState(home, "t2", "completed");

    // Drain both completed events via the ack loop.
    const first = await runCli(["watch", "--json"], home);
    expect(first.code).toBe(6);
    const ev1 = JSON.parse(first.stdout) as { seq: number };

    const second = await runCli(["watch", "--json", "--ack", String(ev1.seq)], home);
    expect(second.code).toBe(6);
    const ev2 = JSON.parse(second.stdout) as { seq: number };

    // Both acked and terminal → all-done, exit 0 (cannot hang).
    const done = await runCli(["watch", "--json", "--ack", String(ev2.seq)], home);
    expect(done.code).toBe(0);
    expect(done.stdout.trim()).toBe("");
  });

  it("priority: awaiting_answer is delivered before completed", async () => {
    // A completed task and a later question — question must win regardless of seq.
    await delegate(taskDir(quick()), "done-first");
    await waitForState(home, "t1", "completed");

    const cwd = taskDir([
      { emit: { type: "session", session_id: "s" } },
      { ask: "which db?" },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "-n", "asks", "qa"], home);
    await waitForState(home, "t2", "awaiting_answer");

    const res = await runCli(["watch", "--json"], home);
    expect(res.code).toBe(3);
    const ev = JSON.parse(res.stdout) as { event: string; task: Record<string, unknown> };
    expect(ev.event).toBe("task.question");
    expect(ev.task.task_id).toBe("t2");
    expect(ev.task.state).toBe("awaiting_answer");
  });

  it("priority within a tier is FIFO by seq", async () => {
    await delegate(taskDir(quick()), "first");
    await waitForState(home, "t1", "completed");
    await delegate(taskDir(quick()), "second");
    await waitForState(home, "t2", "completed");

    const res = await runCli(["watch", "--json"], home);
    expect(res.code).toBe(6);
    const ev = JSON.parse(res.stdout) as { task: Record<string, unknown>; seq: number };
    // Older completed seq first.
    expect(ev.task.task_id).toBe("t1");

    const next = await runCli(["watch", "--json", "--ack", String(ev.seq)], home);
    expect(next.code).toBe(6);
    const ev2 = JSON.parse(next.stdout) as { task: Record<string, unknown> };
    expect(ev2.task.task_id).toBe("t2");
  });

  it("un-acked events are redelivered (at-least-once)", async () => {
    await delegate(taskDir(quick()), "redo");
    await waitForState(home, "t1", "completed");

    const a = await runCli(["watch", "t1", "--json"], home);
    expect(a.code).toBe(6);
    const evA = JSON.parse(a.stdout) as { seq: number; task: Record<string, unknown> };

    // No --ack: same event comes back.
    const b = await runCli(["watch", "t1", "--json"], home);
    expect(b.code).toBe(6);
    const evB = JSON.parse(b.stdout) as { seq: number; task: Record<string, unknown> };
    expect(evB.seq).toBe(evA.seq);
    expect(evB.task.task_id).toBe("t1");

    // Ack then all-done.
    const done = await runCli(["watch", "t1", "--json", "--ack", String(evA.seq)], home);
    expect(done.code).toBe(0);
  });

  it("ack of a superseded event is a no-op", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "s" } },
      { ask: "which db?" },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "qa"], home);
    await waitForState(home, "t1", "awaiting_answer");

    const q = await runCli(["watch", "t1", "--json"], home);
    expect(q.code).toBe(3);
    const questionSeq = (JSON.parse(q.stdout) as { seq: number }).seq;

    // Answering leaves awaiting_answer — the question event is superseded.
    await runCli(["answer", "t1", "postgres"], home);
    await waitForState(home, "t1", "completed");

    // Acking the old question seq must not swallow the completed event.
    const res = await runCli(["watch", "t1", "--json", "--ack", String(questionSeq)], home);
    expect(res.code).toBe(6);
    const ev = JSON.parse(res.stdout) as { event: string; task: Record<string, unknown> };
    expect(ev.event).toBe("task.completed");
    expect(ev.task.state).toBe("completed");
  });

  it("answer implicitly consumes the question event (supersession)", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "s" } },
      { ask: "which db?" },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "qa"], home);
    await waitForState(home, "t1", "awaiting_answer");

    // Answer without ever acking the question via watch.
    await runCli(["answer", "t1", "postgres"], home);
    await waitForState(home, "t1", "completed");

    // Next watch yields completed, not a redelivered question.
    const res = await runCli(["watch", "t1", "--json"], home);
    expect(res.code).toBe(6);
    const ev = JSON.parse(res.stdout) as { event: string; task: Record<string, unknown> };
    expect(ev.event).toBe("task.completed");
    expect(ev.task.state).toBe("completed");
  });

  it("returns exit 3 on awaiting_answer", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "s" } },
      { ask: "which db?" },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "qa"], home);
    await waitForState(home, "t1", "awaiting_answer");

    const res = await runCli(["watch", "t1", "--json"], home);
    expect(res.code).toBe(3);
    const ev = JSON.parse(res.stdout) as { event: string; task: Record<string, unknown> };
    expect(ev.event).toBe("task.question");
    expect(ev.task.state).toBe("awaiting_answer");
  });

  it("blocks until an actionable state appears (live running tasks)", async () => {
    await delegate(taskDir(slow(400)), "slow");
    await waitForState(home, "t1", "running");

    // Watch while still running; should return completed once it finishes.
    const res = await runCli(["watch", "t1", "--json"], home);
    expect(res.code).toBe(6);
    const ev = JSON.parse(res.stdout) as { event: string; task: Record<string, unknown> };
    expect(ev.event).toBe("task.completed");
    expect(ev.task.state).toBe("completed");
  });

  it("--follow streams one JSONL line per transition until all watched tasks are terminal", async () => {
    // Start follow before tasks finish so the firehose (start-from-now) still
    // sees completions. Delegate slow tasks, wait for running, then follow.
    // Sleep must cover waitForState×2 + follow attach overhead or a task can
    // complete before the firehose baseline and vanish from the stream.
    await delegate(taskDir(slow(2500)), "a");
    await delegate(taskDir(slow(2500)), "b");
    await waitForState(home, "t1", "running");
    await waitForState(home, "t2", "running");

    const follow = startCli(["watch", "t1", "t2", "--follow"], home);
    const res = await follow.result;
    expect(res.code).toBe(0);

    const lines = res.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as {
        event: string;
        seq: number;
        task: { task_id: string; state: string };
      });
    // At least task.completed for each; task.started may have been missed if it
    // landed before follow attached (start-from-now baseline).
    const byTask = (id: string) => lines.filter((l) => l.task.task_id === id).map((l) => l.event);
    expect(byTask("t1")).toContain("task.completed");
    expect(byTask("t2")).toContain("task.completed");
    // Monotonic seqs, one line per transition.
    const seqs = lines.map((l) => l.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
  });

  it("a watched task that does not exist is a usage error (exit 2), not a silent hang", async () => {
    const res = await runCli(["watch", "nope"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/no such task/);
  });

  it("unknown --until / --since flags are usage errors (clean break)", async () => {
    const until = await runCli(["watch", "--until", "attention"], home);
    expect(until.code).toBe(2);
    expect(until.stderr).toMatch(/unknown flag/);

    const since = await runCli(["watch", "--since", "0"], home);
    expect(since.code).toBe(2);
    expect(since.stderr).toMatch(/unknown flag/);
  });

  it("invalid --ack is a usage error (exit 2)", async () => {
    const res = await runCli(["watch", "--ack", "nope"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/invalid --ack/);
  });
});
