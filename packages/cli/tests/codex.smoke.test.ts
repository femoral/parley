import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { cleanupHome, makeGitRepo, makeHome, runCli } from "./helpers.js";

/**
 * Opt-in smoke test: real end-to-end delegation to the installed `codex` CLI
 * (spec §10 — adapter smoke tests behind a flag, versions pinned). Skipped by
 * default; runs only when `PARLEY_SMOKE_CODEX=1` and `CODEX_API_KEY` is set (the
 * exec-only auth path, research §9). It delegates a trivial task and asserts the
 * child reached the daemon's MCP hub and submitted a schema-valid report.
 *
 *   PARLEY_SMOKE_CODEX=1 CODEX_API_KEY=… npx vitest run tests/codex.smoke.test.ts
 */
const ENABLED = process.env.PARLEY_SMOKE_CODEX === "1" && Boolean(process.env.CODEX_API_KEY);

describe.skipIf(!ENABLED)("codex adapter — real end-to-end smoke", () => {
  let home: string;
  const repos: string[] = [];

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    cleanupHome(home);
    for (const dir of repos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("delegates a trivial task and gets a completed report", async () => {
    const repo = makeGitRepo([]);
    repos.push(repo);

    const result = await runCli(
      [
        "delegate",
        "-v",
        "codex",
        "--cwd",
        repo,
        "--wait",
        "Do not edit any files. Immediately call the submit_report tool with " +
          'summary "smoke ok", outcome "success", and files_changed []. Then stop.',
      ],
      home,
      // 5-minute run cap; keep the answer timeout generous so nothing stalls.
      { extraEnv: { CODEX_API_KEY: process.env.CODEX_API_KEY } },
    );

    expect(result.code).toBe(0);
    const env = JSON.parse(result.stdout);
    expect(env.state).toBe("completed");
    expect(env.report.outcome).toBe("success");
  }, 300_000);
});
