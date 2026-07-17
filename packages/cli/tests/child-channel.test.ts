/**
 * Adapter-declared child channels with channel-matched preambles (#155).
 *
 * Covers: config override selects the tools-section variant; a fake child can
 * complete report + Q&A end-to-end over the HTTP and CLI channels.
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
  watchJson,
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

function writeVendorConfig(childChannel: "mcp" | "cli" | "http"): void {
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify({ vendors: { fake: { childChannel } } }, null, 2),
  );
}

function hellos(taskId: string): Record<string, unknown>[] {
  const log = fs.readFileSync(path.join(home, "tasks", taskId, "vendor.jsonl"), "utf8");
  return log
    .split("\n")
    .filter((l) => l.includes('"hello"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const REPORT = {
  summary: "done via child channel",
  outcome: "success" as const,
  files_changed: ["src/a.ts"],
};

describe("child-channel preamble variant selection (#155)", () => {
  it("defaults to the MCP tools section", async () => {
    const cwd = taskDir([{ submit_report: REPORT }]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "go"], home);
    await waitForState(home, "t1", "completed");
    const prompt = hellos("t1")[0]!.prompt as string;
    expect(prompt).toContain("ask_orchestrator({ question })");
    expect(prompt).toContain("submit_report({ ... })");
    expect(prompt).not.toContain("parley child ask");
    expect(prompt).not.toContain("curl -sS");
  });

  it("vendors.fake.childChannel=cli teaches parley child commands", async () => {
    writeVendorConfig("cli");
    const cwd = taskDir([{ submit_report: REPORT }]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "go"], home);
    await waitForState(home, "t1", "completed");
    const prompt = hellos("t1")[0]!.prompt as string;
    expect(prompt).toContain("parley child ask");
    expect(prompt).toContain("parley child report");
    expect(prompt).toContain("parley child task");
    // MCP phrasing untaught.
    expect(prompt).not.toContain("ask_orchestrator({ question })");
    expect(prompt).not.toContain("submit_report({ ... })");
    // Channel-independent sections still present.
    expect(prompt).toContain("Parley protocol");
    expect(prompt).toContain(".parley/TASK.md");
    expect(prompt).toMatch(/summary/);
  });

  it("vendors.fake.childChannel=http teaches curl examples with the task header", async () => {
    writeVendorConfig("http");
    const cwd = taskDir([{ submit_report: REPORT }]);
    await runCli(["delegate", "-v", "fake", "--cwd", cwd, "go"], home);
    await waitForState(home, "t1", "completed");
    const prompt = hellos("t1")[0]!.prompt as string;
    expect(prompt).toContain("curl -sS");
    expect(prompt).toContain("/child/report");
    expect(prompt).toContain("/child/ask");
    expect(prompt).toContain("x-parley-task");
    expect(prompt).toContain("$PARLEY_HUB_URL");
    expect(prompt).not.toContain("ask_orchestrator({ question })");
    expect(prompt).not.toContain("parley child ask");
  });

  it("re-prepends the same channel-matched preamble on resume", async () => {
    writeVendorConfig("cli");
    const cwd = taskDir(
      [
        { emit: { type: "session", session_id: "sess-ch" } },
        { ask: "which target?" },
      ],
      [{ submit_report: REPORT }],
    );
    await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--answer-timeout", "250ms", "the original"],
      home,
    );
    await waitForState(home, "t1", "stalled");
    await runCli(["answer", "t1", "the-target"], home);
    await waitForState(home, "t1", "completed");

    const resumeHello = hellos("t1").at(-1)!.prompt as string;
    expect(resumeHello).toContain("parley child report");
    expect(resumeHello).toContain("the-target");
    expect(resumeHello).toMatch(/parley child report/);
    expect(resumeHello).not.toContain("ask_orchestrator({ question })");
  });
});

describe("cli/http-channel child end-to-end report + Q&A (#155)", () => {
  it("completes report and Q&A over the HTTP channel", async () => {
    writeVendorConfig("http");
    const cwd = taskDir([
      { emit: { type: "session", session_id: "http-sess" } },
      { ask_http: "which database?" },
      { submit_report_http: REPORT },
    ]);

    const delegate = await runCli(
      ["delegate", "-v", "fake", "-n", "http-ch", "--cwd", cwd, "do it"],
      home,
    );
    expect(delegate.code).toBe(0);

    const q = await watchJson(home, ["t1"]);
    expect(q.code).toBe(3);
    expect(q.task!.question).toBe("which database?");

    const answer = await runCli(["answer", "t1", "postgres"], home);
    expect(answer.code).toBe(0);
    await waitForState(home, "t1", "completed");

    const status = await runCli(["status", "t1", "--json"], home);
    const row = JSON.parse(status.stdout) as {
      state: string;
      report: { summary: string; outcome: string };
    };
    expect(row.state).toBe("completed");
    expect(row.report.summary).toBe(REPORT.summary);
    expect(row.report.outcome).toBe("success");

    // Prompt taught HTTP, not MCP.
    const prompt = hellos("t1")[0]!.prompt as string;
    expect(prompt).toContain("/child/report");
  });

  it("completes report and Q&A over the CLI channel", async () => {
    writeVendorConfig("cli");
    const cwd = taskDir([
      { emit: { type: "session", session_id: "cli-sess" } },
      { ask_cli: "which database?" },
      { submit_report_cli: REPORT },
    ]);

    const delegate = await runCli(
      ["delegate", "-v", "fake", "-n", "cli-ch", "--cwd", cwd, "do it"],
      home,
    );
    expect(delegate.code).toBe(0);

    const q = await watchJson(home, ["t1"]);
    expect(q.code).toBe(3);
    expect(q.task!.question).toBe("which database?");

    const answer = await runCli(["answer", "t1", "sqlite"], home);
    expect(answer.code).toBe(0);
    await waitForState(home, "t1", "completed");

    const status = await runCli(["status", "t1", "--json"], home);
    const row = JSON.parse(status.stdout) as {
      state: string;
      report: { summary: string };
    };
    expect(row.state).toBe("completed");
    expect(row.report.summary).toBe(REPORT.summary);

    const prompt = hellos("t1")[0]!.prompt as string;
    expect(prompt).toContain("parley child report");
  });
});
