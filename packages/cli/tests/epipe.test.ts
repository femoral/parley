import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homePaths } from "@useparley/core";
import { insertTask, openDatabase } from "@useparley/daemon/db.js";
import { cleanupHome, makeHome, runCli, runCliPiped } from "./helpers.js";

let home: string;

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

/**
 * Seed enough tasks that `parley status` writes well past a single pipe
 * buffer (64KB on Linux) — otherwise a fast reader could drain the whole
 * output before ever closing, and the EPIPE this test exists to catch would
 * never fire.
 */
function seedManyTasks(count: number): void {
  const paths = homePaths(home);
  const db = openDatabase(paths);
  for (let i = 0; i < count; i++) {
    insertTask(db, {
      id: `t${i}`,
      name: `task-${i}-with-a-reasonably-long-label-to-pad-row-width`,
      vendor: "codex",
      model: "gpt-5",
      effort: "medium",
      repo: "/some/repo",
      cwd: "/some/repo/worktree",
      prompt: "do the thing",
      orchestrator_session_id: "orch-session",
      worktree: "/some/repo/.parley/worktrees/t" + i,
      branch: `parley/t${i}-task`,
      base_sha: "0".repeat(40),
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
    });
  }
  db.close();
}

describe("EPIPE from an early-closing downstream reader", () => {
  it("parley status | head -1 exits 0 with no stack trace or error output", async () => {
    seedManyTasks(3000);

    const { code, stderr } = await runCliPiped(["status", "--all"], home, "head -1");

    expect(code).toBe(0);
    expect(stderr).toBe("");
  });

  it("does not swallow real errors: an unknown command still reports and exits non-zero", async () => {
    const result = await runCli(["not-a-real-command"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown command/);
  });

  it("a full, unclosed read still gets the whole output and the original exit code", async () => {
    seedManyTasks(5);
    const result = await runCli(["status", "--all"], home);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    // header + 5 rows
    expect(lines.length).toBe(6);
  });
});
