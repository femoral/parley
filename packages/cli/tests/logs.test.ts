import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { ParleyClient } from "@useparley/core";
import {
  cleanupHome,
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

function taskDir(actions: FakeVendorAction[], resumeActions?: FakeVendorAction[]): string {
  const dir = makeTaskDir(actions, resumeActions);
  taskDirs.push(dir);
  return dir;
}

const REPORT = { summary: "did it", outcome: "success", files_changed: ["a.ts"] };

/** Delegate (always async); returns the parsed ack `{task_id, name, state, seq}`. */
async function delegate(cwd: string, name?: string): Promise<Record<string, unknown>> {
  const args = ["delegate", "-v", "fake", "--cwd", cwd, ...(name ? ["-n", name] : []), "run"];
  const res = await runCli(args, home);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

/** The daemon origin, after a first CLI call has spawned it and written discovery. */
function baseUrl(): string {
  const discovery = readDiscovery(home);
  if (!discovery) throw new Error("no discovery file — daemon not spawned yet");
  return `http://127.0.0.1:${discovery.port}`;
}

describe("per-task log tail (#63)", () => {
  it("returns the cursor shape { chunk, next, eof } and the full raw log once complete", async () => {
    await delegate(
      taskDir([{ emit: { type: "session", session_id: "s" } }, { submit_report: REPORT }]),
      "one",
    );
    await waitForState(home, "t1", "completed");

    const client = new ParleyClient({ baseUrl: baseUrl() });
    const res = await client.logs("t1", 0);
    expect(typeof res.chunk).toBe("string");
    expect(typeof res.next).toBe("number");
    expect(typeof res.eof).toBe("boolean");
    expect(res.eof).toBe(true);
    expect(res.next).toBe(Buffer.byteLength(res.chunk, "utf8"));

    // The chunk is the exact raw vendor.jsonl content — same bytes a caller
    // could read straight off disk, delivered over HTTP instead.
    const onDisk = fs.readFileSync(`${home}/tasks/t1/vendor.jsonl`, "utf8");
    expect(res.chunk).toBe(onDisk);
    expect(res.chunk).toContain('"type":"hello"');
    expect(res.chunk).toContain('"type":"session"');
  });

  it("tailing a running task eventually yields its full log", async () => {
    await delegate(
      taskDir([
        { emit: { type: "session", session_id: "s" } },
        { sleep: 150 },
        { emit: { type: "progress", note: "step one" } },
        { sleep: 150 },
        { emit: { type: "progress", note: "step two" } },
        { submit_report: REPORT },
      ]),
      "one",
    );

    const client = new ParleyClient({ baseUrl: baseUrl() });
    let cursor = 0;
    let collected = "";
    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await client.logs("t1", cursor);
      collected += res.chunk;
      cursor = res.next;
      if (collected.includes("step two") && collected.includes('"type":"tool_result"')) break;
      if (Date.now() > deadline) throw new Error(`timed out; collected so far: ${collected}`);
      await new Promise((r) => setTimeout(r, 40));
    }
    await waitForState(home, "t1", "completed");

    const onDisk = fs.readFileSync(`${home}/tasks/t1/vendor.jsonl`, "utf8");
    expect(collected).toBe(onDisk);
  });

  it("resuming from a saved cursor never duplicates or drops bytes", async () => {
    await delegate(
      taskDir([
        { emit: { type: "session", session_id: "s" } },
        { sleep: 150 },
        { emit: { type: "progress", note: "midway" } },
        { submit_report: REPORT },
      ]),
      "one",
    );

    const client = new ParleyClient({ baseUrl: baseUrl() });
    // Grab a first chunk mid-run (whatever's there right after the hello/session
    // lines), remember its cursor, then let the task finish.
    let first = await client.logs("t1", 0);
    await waitForState(home, "t1", "completed");

    // Resume from the saved cursor: the rest of the file, with no overlap.
    // eof flips only once the child process has fully exited, which can lag
    // the completed transition — the contract's rule is "keep polling until
    // eof flips" (cursor reads are idempotent, as asserted below).
    let rest = await client.logs("t1", first.next);
    const eofDeadline = Date.now() + 10_000;
    while (!rest.eof) {
      if (Date.now() > eofDeadline) throw new Error("eof never flipped after completion");
      await new Promise((r) => setTimeout(r, 50));
      rest = await client.logs("t1", first.next);
    }
    const onDisk = fs.readFileSync(`${home}/tasks/t1/vendor.jsonl`, "utf8");
    expect(rest.eof).toBe(true);
    expect(first.chunk + rest.chunk).toBe(onDisk);

    // Re-fetching the same cursor again (idempotent replay) reproduces the same
    // tail — resuming never drops bytes even across repeated calls.
    const restAgain = await client.logs("t1", first.next);
    expect(restAgain.chunk).toBe(rest.chunk);
    expect(restAgain.next).toBe(rest.next);

    // And fetching from the very beginning reproduces the whole file too — no
    // duplication introduced by the earlier partial reads.
    first = await client.logs("t1", 0);
    expect(first.chunk).toBe(onDisk);
  });

  it("a stalled task is never eof — it can still resume and append more log", async () => {
    // An unanswered question stalls the task at the timeout; the fake vendor's
    // resume script keeps writing to the same vendor.jsonl once answered.
    const dir = taskDir(
      [{ emit: { type: "session", session_id: "s" } }, { ask: "which db?" }],
      [{ emit: { type: "progress", note: "resumed" } }, { submit_report: REPORT }],
    );
    const delegate = await runCli(
      ["delegate", "-v", "fake", "--cwd", dir, "--answer-timeout", "250ms", "-n", "one", "run"],
      home,
    );
    expect(delegate.code).toBe(0);
    await waitForState(home, "t1", "stalled");

    const client = new ParleyClient({ baseUrl: baseUrl() });
    const whileStalled = await client.logs("t1", 0);
    // Caught up to what's on disk right now, but never final — a resume can
    // still append more to this same log.
    expect(whileStalled.eof).toBe(false);

    const answer = await runCli(["answer", "t1", "postgres"], home);
    expect(answer.code).toBe(0);
    await waitForState(home, "t1", "completed");

    const afterResume = await client.logs("t1", whileStalled.next);
    expect(afterResume.eof).toBe(true);
    expect(afterResume.chunk).toContain("resumed");

    const onDisk = fs.readFileSync(`${home}/tasks/t1/vendor.jsonl`, "utf8");
    expect(whileStalled.chunk + afterResume.chunk).toBe(onDisk);
  });

  it("an unknown task is a client error, matching existing route conventions", async () => {
    // Spawn the daemon via a real delegate first (discovery needs a live port).
    await delegate(
      taskDir([{ emit: { type: "session", session_id: "s" } }, { submit_report: REPORT }]),
      "one",
    );
    await waitForState(home, "t1", "completed");

    const res = await fetch(`${baseUrl()}/tasks/no-such-task/logs?since=0`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no such task");

    // The typed client surfaces the same 404 as a thrown error.
    const client = new ParleyClient({ baseUrl: baseUrl() });
    await expect(client.logs("no-such-task", 0)).rejects.toThrow(/no such task/);
  });
});
