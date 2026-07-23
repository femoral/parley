import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanupHome,
  git,
  makeGitRepo,
  makeHome,
  makeTaskDir,
  runCli,
  waitForState,
  type FakeVendorAction,
} from "./helpers.js";

let home: string;
const scratch: string[] = [];

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const REPORT = { summary: "did the thing", outcome: "success", files_changed: ["a"] };

function repo(actions: FakeVendorAction[], files: Record<string, string> = {}): string {
  const dir = makeGitRepo(actions, files);
  scratch.push(dir);
  return dir;
}

function taskDir(actions: FakeVendorAction[], resumeActions?: FakeVendorAction[]): string {
  const dir = makeTaskDir(actions, resumeActions);
  scratch.push(dir);
  return dir;
}

/** Write a temp context file and return its absolute path. */
function contextFile(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ctx-"));
  scratch.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

/** The worktree parley creates for task `id` under a repo directory. */
function worktreePath(id: string, repoDir: string): string {
  return path.join(home, "worktrees", path.basename(repoDir), id);
}

/** Every parsed `hello` event from a task's captured stream, in order. */
function hellos(home: string, taskId: string): Record<string, unknown>[] {
  const log = fs.readFileSync(path.join(home, "tasks", taskId, "vendor.jsonl"), "utf8");
  return log
    .split("\n")
    .filter((l) => l.includes('"hello"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("context materialization (spec §7)", () => {
  it("writes TASK.md and copies --context files, all git-excluded", async () => {
    // The child writes a file so the worktree is retained for inspection.
    const src = repo([{ write_file: { path: "keep.txt", contents: "x" } }, { submit_report: REPORT }]);
    const ctxA = contextFile("spec.md", "# the spec\ncontext A body\n");
    const ctxB = contextFile("notes.txt", "context B body\n");

    const result = await runCli(
      [
        "delegate", "-v", "fake", "-n", "ctx",
        "--context", ctxA, "--context", ctxB, "implement the feature",
      ],
      home,
      { cwd: src },
    );
    expect(result.code).toBe(0);
    await waitForState(home, "t1", "completed");

    const wt = worktreePath("t1", src);
    expect(fs.existsSync(wt)).toBe(true);

    // TASK.md holds the caller prompt verbatim.
    expect(fs.readFileSync(path.join(wt, ".parley", "TASK.md"), "utf8")).toContain(
      "implement the feature",
    );
    // Each --context file copied under .parley/context/ by basename.
    expect(fs.readFileSync(path.join(wt, ".parley", "context", "spec.md"), "utf8")).toBe(
      "# the spec\ncontext A body\n",
    );
    expect(fs.readFileSync(path.join(wt, ".parley", "context", "notes.txt"), "utf8")).toBe(
      "context B body\n",
    );

    // .parley/ never shows in git status (worktree-scoped exclude).
    const status = git(wt, ["status", "--porcelain"]);
    expect(status).toContain("keep.txt");
    expect(status).not.toContain(".parley");
  });

  it("the vendor prompt is preamble + caller prompt + on-disk pointers", async () => {
    const src = repo([{ write_file: { path: "keep.txt", contents: "x" } }, { submit_report: REPORT }]);
    const ctx = contextFile("design.md", "design doc body\n");

    await runCli(
      ["delegate", "-v", "fake", "-n", "p", "--context", ctx, "port the parser"],
      home,
      { cwd: src },
    );

    await waitForState(home, "t1", "completed");
    const prompt = hellos(home, "t1")[0]!.prompt as string;
    // Preamble mechanics: tools, report-schema summary, worktree facts, timeout.
    expect(prompt).toContain("Parley protocol");
    expect(prompt).toContain("ask_orchestrator");
    expect(prompt).toContain("submit_report");
    expect(prompt).toMatch(/summary/); // default report-schema field
    expect(prompt).toMatch(/outcome/);
    expect(prompt).toContain("parley/t1-p"); // branch fact
    expect(prompt).toContain("30 minutes"); // default answer-timeout
    // Pointers to the on-disk files, not their contents.
    expect(prompt).toContain(".parley/TASK.md");
    expect(prompt).toContain(".parley/context/design.md");
    expect(prompt).not.toContain("design doc body");
    // The caller prompt itself rides along.
    expect(prompt).toContain("port the parser");
  });

  it("carries a caller-supplied report schema into the preamble summary", async () => {
    const src = repo([{ write_file: { path: "keep.txt", contents: "x" } }, { submit_report: { verdict: "ok" } }]);
    const schema = contextFile(
      "schema.json",
      JSON.stringify({
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      }),
    );

    await runCli(
      ["delegate", "-v", "fake", "-n", "s", "--report-schema", schema, "grade it"],
      home,
      { cwd: src },
    );

    await waitForState(home, "t1", "completed");
    const prompt = hellos(home, "t1")[0]!.prompt as string;
    expect(prompt).toContain("verdict");
    // Not the default schema's fields.
    expect(prompt).not.toMatch(/files_changed/);
  });

  it("re-prepends the preamble on resume; on-disk context survives", async () => {
    const cwd = taskDir(
      [
        { emit: { type: "session", session_id: "sess-r" } },
        { ask: "which target?" },
      ],
      [{ submit_report: REPORT }],
    );
    const ctx = contextFile("brief.md", "extra brief body\n");

    const delegate = await runCli(
      [
        "delegate", "-v", "fake", "--cwd", cwd,
        "--context", ctx, "--answer-timeout", "250ms", "the original task",
      ],
      home,
    );
    expect(delegate.code).toBe(0);
    await waitForState(home, "t1", "stalled");

    // Context materialized in the --cwd directory and still present at resume.
    expect(fs.readFileSync(path.join(cwd, ".parley", "TASK.md"), "utf8")).toContain(
      "the original task",
    );
    expect(fs.existsSync(path.join(cwd, ".parley", "context", "brief.md"))).toBe(true);

    // #206: stalled-resume ack may still report `stalled` until the child is live.
    const answer = await runCli(["answer", "t1", "the-target"], home);
    expect(answer.code).toBe(0);
    expect(["running", "stalled"]).toContain(JSON.parse(answer.stdout).state);
    await waitForState(home, "t1", "completed");

    // The resume run's prompt re-prepends the preamble and carries the answer.
    const resumeHello = hellos(home, "t1").at(-1)!.prompt as string;
    expect(resumeHello).toContain("Parley protocol");
    expect(resumeHello).toContain(".parley/context/brief.md");
    expect(resumeHello).toContain("the-target");

    // Context files are untouched on disk after the resume.
    expect(fs.existsSync(path.join(cwd, ".parley", "context", "brief.md"))).toBe(true);
  });

  it("exits 2 for a missing --context file before creating any task", async () => {
    const src = repo([{ submit_report: REPORT }]);
    const result = await runCli(
      ["delegate", "-v", "fake", "--context", "/nonexistent/ctx.md", "x"],
      home,
      { cwd: src },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/context/);
    // No task was created.
    const list = JSON.parse((await runCli(["--json"], home)).stdout);
    expect(list).toEqual([]);
  });

  it("rejects two --context files that share a basename (exit 2)", async () => {
    const src = repo([{ submit_report: REPORT }]);
    const a = contextFile("dup.md", "first\n");
    // A different directory, same basename — would clobber under .parley/context/.
    const b = contextFile("dup.md", "second\n");
    const result = await runCli(
      ["delegate", "-v", "fake", "--context", a, "--context", b, "x"],
      home,
      { cwd: src },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/duplicate .*dup\.md/);
    expect(JSON.parse((await runCli(["--json"], home)).stdout)).toEqual([]);
  });

  it("keeps repo contents out of the preamble (mechanics only, no digest)", async () => {
    const src = repo([{ write_file: { path: "keep.txt", contents: "x" } }, { submit_report: REPORT }], {
      "README.md": "SECRET_REPO_DIGEST_MARKER should never enter the prompt\n",
    });

    await runCli(["delegate", "-v", "fake", "-n", "d", "go"], home, { cwd: src });

    await waitForState(home, "t1", "completed");
    const prompt = hellos(home, "t1")[0]!.prompt as string;
    expect(prompt).not.toContain("SECRET_REPO_DIGEST_MARKER");
  });
});
