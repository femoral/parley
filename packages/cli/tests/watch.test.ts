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

/** Delegate without --wait and return the parsed ack `{task_id, name, state, seq}`. */
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
    const rows = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout) as Record<
      string,
      unknown
    >[];
    expect(typeof rows[0]!.seq).toBe("number");
    expect(rows[0]!.seq as number).toBeGreaterThan(0);

    // delegate --wait envelope carries a seq too.
    const waited = JSON.parse(
      (await runCli(["delegate", "-v", "fake", "--cwd", taskDir(quick()), "--wait", "x"], home))
        .stdout,
    ) as Record<string, unknown>;
    expect(typeof waited.seq).toBe("number");
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

describe("parley watch (#34)", () => {
  it("single-task watch blocks and returns on the first state change", async () => {
    await delegate(taskDir(slow(400)));
    const res = await runCli(["watch", "t1", "--since", "0", "--json"], home);
    expect(res.code).toBe(0);
    const ev = JSON.parse(res.stdout) as { event: string; seq: number; task: Record<string, unknown> };
    expect(ev.event).toBe("task.started");
    expect(ev.task.task_id).toBe("t1");
    expect(ev.task.state).toBe("running");
    expect(ev.seq).toBeGreaterThan(0);
  });

  it("watches multiple tasks and returns on the one that changes, leaving the other alone", async () => {
    // A long-runner that stays `running` for the duration of the test.
    await delegate(taskDir(slow(30_000)), "long");
    const running = await waitForState(home, "t1", "running");
    const since = running.seq as number;

    // A second, quick task delegated after capturing `since`.
    await delegate(taskDir(quick()), "quick");

    const res = await runCli(
      ["watch", "t1", "t2", "--since", String(since), "--until", "any-change", "--json"],
      home,
    );
    expect(res.code).toBe(0);
    const ev = JSON.parse(res.stdout) as { task: Record<string, unknown> };
    // Only t2 transitioned after `since`; t1 is still running.
    expect(ev.task.task_id).toBe("t2");
    const t1 = JSON.parse((await runCli(["status", "t1", "--json"], home)).stdout) as Record<
      string,
      unknown
    >[];
    expect(t1[0]!.state).toBe("running");

    await runCli(["cancel", "t1"], home);
  });

  it("--since immediately replays a transition that already happened, rather than blocking", async () => {
    // Capture a seq while the task is running, before it completes.
    await delegate(taskDir(slow(500)));
    const running = await waitForState(home, "t1", "running");
    const sinceBeforeCompletion = running.seq as number;
    await waitForState(home, "t1", "completed");

    // The task completed before `watch` is invoked; --since replays it at once.
    const res = await runCli(
      ["watch", "t1", "--since", String(sinceBeforeCompletion), "--json"],
      home,
    );
    expect(res.code).toBe(0);
    const ev = JSON.parse(res.stdout) as { event: string; task: Record<string, unknown> };
    expect(ev.event).toBe("task.completed");
    expect(ev.task.state).toBe("completed");
  });

  it("--until attention ignores non-attention transitions and returns on awaiting_answer (exit 3)", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "s" } },
      { ask: "which db?" },
      { submit_report: REPORT },
    ]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "qa"], home);

    // --since 0 puts task.started in the replay window; attention must skip it
    // and return on task.question.
    const res = await runCli(
      ["watch", "t1", "--since", "0", "--until", "attention", "--json"],
      home,
    );
    expect(res.code).toBe(3);
    const ev = JSON.parse(res.stdout) as { event: string; task: Record<string, unknown> };
    expect(ev.event).toBe("task.question");
    expect(ev.task.state).toBe("awaiting_answer");
  });

  it("--until terminal blocks until every watched task is terminal, not just one", async () => {
    await delegate(taskDir(quick()), "fast");
    await delegate(taskDir(slow(700)), "slower");

    const res = await runCli(
      ["watch", "t1", "t2", "--since", "0", "--until", "terminal", "--json"],
      home,
    );
    expect(res.code).toBe(0);
    // By the time watch returns, both watched tasks are terminal.
    for (const id of ["t1", "t2"]) {
      const row = JSON.parse((await runCli(["status", id, "--json"], home)).stdout) as Record<
        string,
        unknown
      >[];
      expect(row[0]!.state).toBe("completed");
    }
  });

  it("--follow streams one JSONL line per transition until all watched tasks are terminal", async () => {
    await delegate(taskDir(slow(300)), "a");
    await delegate(taskDir(slow(300)), "b");

    const follow = startCli(["watch", "t1", "t2", "--follow", "--since", "0"], home);
    const res = await follow.result;
    expect(res.code).toBe(0);

    const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l) as {
      event: string;
      seq: number;
      task: { task_id: string; state: string };
    });
    // Two transitions per task: task.started then task.completed.
    const byTask = (id: string) => lines.filter((l) => l.task.task_id === id).map((l) => l.event);
    expect(byTask("t1")).toEqual(["task.started", "task.completed"]);
    expect(byTask("t2")).toEqual(["task.started", "task.completed"]);
    // Monotonic seqs, one line per transition.
    const seqs = lines.map((l) => l.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
  });

  it("a watched task that does not exist is a usage error (exit 2), not a silent hang", async () => {
    const res = await runCli(["watch", "nope"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/no such task/);
  });
});
