import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const REPORT = {
  summary: "did the thing",
  outcome: "success",
  files_changed: ["src/a.ts"],
};

/** Write a report schema file next to a task dir; returns its absolute path. */
function schemaFile(dir: string, schema: unknown): string {
  const file = path.join(dir, "schema.json");
  fs.writeFileSync(file, typeof schema === "string" ? schema : JSON.stringify(schema));
  return file;
}

describe("child exit without a report", () => {
  it("fails the task (exit 1) with an error and a diagnostics reference; logs retained", async () => {
    // The child chatters, then exits without ever calling submit_report.
    const cwd = taskDir([{ emit: { type: "message", text: "half-done, then quit" } }]);
    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "quitter", "--cwd", cwd, "--wait", "do it"],
      home,
    );

    expect(result.code).toBe(1);
    const env = JSON.parse(result.stdout);
    expect(env.state).toBe("failed");
    expect(env.error).toMatch(/without submitting a report/);

    // The diagnostics reference points at a retained log dir with the raw stream.
    expect(typeof env.logs_dir).toBe("string");
    const vendorLog = path.join(env.logs_dir, "vendor.jsonl");
    expect(fs.existsSync(vendorLog)).toBe(true);
    expect(fs.readFileSync(vendorLog, "utf8")).toContain("half-done, then quit");
  });

  it("surfaces a fatal vendor error event as the failure detail (opaque exit codes)", async () => {
    // Vendors like codex exit 0/1 only — the fatal event in the stream is the
    // real diagnosis, so it is appended to the report-less-exit error.
    const cwd = taskDir([{ emit: { type: "fatal", message: "model overloaded" } }, { exit: 1 }]);
    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "fatalrun", "--cwd", cwd, "--wait", "do it"],
      home,
    );

    expect(result.code).toBe(1);
    const env = JSON.parse(result.stdout);
    expect(env.state).toBe("failed");
    expect(env.error).toMatch(/without submitting a report/);
    expect(env.error).toMatch(/model overloaded/);
  });

  it("surfaces a PARLEY-DIAG event in the failure detail and a separate diag.log", async () => {
    // e.g. codex's guardian approval gate cancelling submit_report headless
    // (no fatal error, no report) — the tag must reach both the failure
    // string an orchestrator reads and a distilled log a human can grep
    // without wading through the full raw vendor stream.
    const cwd = taskDir([
      { emit: { type: "diag", message: "mcp_tool_call server=parley tool=submit_report failed: user cancelled MCP tool call" } },
    ]);
    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "guardian-cancel", "--cwd", cwd, "--wait", "do it"],
      home,
    );

    expect(result.code).toBe(1);
    const env = JSON.parse(result.stdout);
    expect(env.state).toBe("failed");
    expect(env.error).toMatch(/without submitting a report/);
    expect(env.error).toMatch(/PARLEY-DIAG mcp_tool_call server=parley tool=submit_report/);

    const diagLog = path.join(env.logs_dir, "diag.log");
    expect(fs.existsSync(diagLog)).toBe(true);
    expect(fs.readFileSync(diagLog, "utf8")).toMatch(
      /PARLEY-DIAG mcp_tool_call server=parley tool=submit_report failed: user cancelled MCP tool call/,
    );
  });

  it("does not surface a recoverable (non-fatal) error event as failure detail", async () => {
    // A mid-run recoverable error must not be misattributed as the cause when
    // the child later exits without a report for unrelated reasons.
    const cwd = taskDir([
      { emit: { type: "error", message: "npm: transient hiccup" } },
      { emit: { type: "message", text: "recovered and kept going" } },
    ]);
    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "hiccup", "--cwd", cwd, "--wait", "do it"],
      home,
    );

    expect(result.code).toBe(1);
    const env = JSON.parse(result.stdout);
    expect(env.state).toBe("failed");
    expect(env.error).toMatch(/without submitting a report/);
    expect(env.error).not.toMatch(/transient hiccup/);
  });
});

describe("adapter spawn failure", () => {
  it("fails the task with a clear error instead of hanging", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]); // never reached
    const badBin = path.join(os.tmpdir(), "parley-does-not-exist-bin");
    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "badbin", "--cwd", cwd, "--wait", "do it"],
      home,
      { extraEnv: { PARLEY_FAKE_COMMAND: badBin } },
    );

    expect(result.code).toBe(1);
    const env = JSON.parse(result.stdout);
    expect(env.state).toBe("failed");
    expect(env.error).toMatch(/spawn/i);
  });
});

describe("parley cancel", () => {
  it("terminates the child and the waiting delegate exits 5 (cancelled)", async () => {
    // A child that never finishes on its own — only cancel ends it.
    const cwd = taskDir([{ sleep: 60_000 }, { submit_report: REPORT }]);
    const waiting = startCli(
      ["delegate", "-v", "fake", "-n", "longrun", "--cwd", cwd, "--wait", "do it"],
      home,
    );

    await waitForState(home, "longrun", "running");
    const cancel = await runCli(["cancel", "longrun"], home);
    expect(cancel.code).toBe(0);
    expect(cancel.stdout).toMatch(/Cancelled/);

    const result = await waiting.result;
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout).state).toBe("cancelled");
  });

  it("cancels a task blocked on a question and clears the outstanding question", async () => {
    const cwd = taskDir([{ ask: "which db?" }, { submit_report: REPORT }]);
    const waiting = startCli(
      ["delegate", "-v", "fake", "-n", "asking", "--cwd", cwd, "--wait", "do it"],
      home,
    );
    // The delegate --wait returns exit 3 on the question; the task sits awaiting.
    expect((await waiting.result).code).toBe(3);
    await waitForState(home, "asking", "awaiting_answer");

    const cancel = await runCli(["cancel", "asking"], home);
    expect(cancel.code).toBe(0);

    const row = JSON.parse((await runCli(["status", "asking", "--json"], home)).stdout);
    expect(row.state).toBe("cancelled");
    // The terminal envelope must not still advertise an outstanding question.
    expect(row.question_id).toBeNull();
    expect(row.question).toBeNull();
  });

  it("rejects cancelling an unknown task (exit 2)", async () => {
    const result = await runCli(["cancel", "t999"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no such task/);
  });

  it("rejects cancelling an already-finished task (exit 2)", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    await runCli(["delegate", "-v", "fake", "-n", "done", "--cwd", cwd, "--wait", "x"], home);

    const result = await runCli(["cancel", "done"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/already completed/);
  });
});

describe("delegate --report-schema", () => {
  const CUSTOM = {
    type: "object",
    properties: { summary: { type: "string" }, ticket: { type: "string" } },
    required: ["summary", "ticket"],
  };

  it("rejects an unreadable schema file before creating the task (exit 2)", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const missing = path.join(cwd, "nope.json");
    const result = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--report-schema", missing, "--wait", "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/report schema/);
    // No task was created.
    expect(JSON.parse((await runCli(["status", "--json"], home)).stdout)).toEqual([]);
  });

  it("rejects a schema file that is not valid JSON (exit 2)", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const file = schemaFile(cwd, "{ this is not json");
    const result = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--report-schema", file, "--wait", "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/not valid JSON/);
  });

  it("rejects a file that is valid JSON but not a valid JSON Schema (exit 2)", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const file = schemaFile(cwd, { type: "banana" });
    const result = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--report-schema", file, "--wait", "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/schema/);
    expect(JSON.parse((await runCli(["status", "--json"], home)).stdout)).toEqual([]);
  });

  it("rejects a scalar schema file (valid JSON, not a schema) before task creation (exit 2)", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    const file = schemaFile(cwd, 42);
    const result = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--report-schema", file, "--wait", "x"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/schema/);
    expect(JSON.parse((await runCli(["status", "--json"], home)).stdout)).toEqual([]);
  });

  it("accepts a boolean schema file (a valid JSON Schema that accepts anything)", async () => {
    // `true` is a valid JSON Schema meaning "anything"; it must be applied, not
    // silently dropped in favour of the strict default.
    const cwd = taskDir([{ submit_report: { anything: "goes", n: 1 } }]);
    const file = schemaFile(cwd, true);
    const result = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--report-schema", file, "--wait", "x"],
      home,
    );
    expect(result.code).toBe(0);
    const env = JSON.parse(result.stdout);
    expect(env.state).toBe("completed");
    expect(env.report_schema).toBe(true);
  });

  it("replaces the default schema: a non-conforming report bounces, then a conforming one completes", async () => {
    const cwd = taskDir([
      // Valid under the DEFAULT schema, but missing `ticket` → invalid here.
      { submit_report: REPORT },
      { submit_report: { summary: "now with ticket", ticket: "T-42" } },
    ]);
    const file = schemaFile(cwd, CUSTOM);
    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "sch", "--cwd", cwd, "--report-schema", file, "--wait", "x"],
      home,
    );

    expect(result.code).toBe(0);
    const env = JSON.parse(result.stdout);
    expect(env.state).toBe("completed");
    expect(env.report).toEqual({ summary: "now with ticket", ticket: "T-42" });
    // The envelope records the schema actually applied.
    expect(env.report_schema).toEqual(CUSTOM);

    // The child saw the first submit bounce as a tool error, then success.
    const log = fs.readFileSync(path.join(home, "tasks", "t1", "vendor.jsonl"), "utf8");
    const results = log
      .split("\n")
      .filter((l) => l.includes('"tool_result"'))
      .map((l) => JSON.parse(l) as { is_error: boolean; text: string });
    expect(results.map((r) => r.is_error)).toEqual([true, false]);
    expect(results[0]!.text).toMatch(/ticket/);
  });

  it("fails the task when the child never conforms and exits (exit 1)", async () => {
    const cwd = taskDir([
      { submit_report: REPORT }, // missing `ticket` → bounces
      { exit: 0 }, // gives up without a conforming report
    ]);
    const file = schemaFile(cwd, CUSTOM);
    const result = await runCli(
      ["delegate", "-v", "fake", "-n", "nope", "--cwd", cwd, "--report-schema", file, "--wait", "x"],
      home,
    );

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).state).toBe("failed");
  });
});
