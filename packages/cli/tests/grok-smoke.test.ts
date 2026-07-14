import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { cleanupHome, makeGitRepo, makeHome, runCli } from "./helpers.js";

/**
 * Opt-in smoke test: delegates a trivial task to the REAL `grok` binary end to
 * end — spawn → MCP hub connect → `submit_report` → completed. Skipped unless
 * `PARLEY_SMOKE_GROK=1`; also needs `grok` on PATH and working auth
 * (`XAI_API_KEY` or a stored `grok login`). Kept out of the default suite because
 * it makes real (billed) model calls and hits the network.
 *
 * Run with: `PARLEY_SMOKE_GROK=1 XAI_API_KEY=… npx vitest run tests/grok-smoke.test.ts`
 */
const ENABLED = process.env.PARLEY_SMOKE_GROK === "1";

// A prompt that drives grok straight to the report tool — no file edits needed.
const PROMPT = [
  "Do not write or change any files.",
  "Call the MCP tool `submit_report` exactly once with this JSON argument:",
  '{"summary":"parley grok smoke ok","outcome":"success","files_changed":[]}',
  "Then stop.",
].join(" ");

describe.skipIf(!ENABLED)("grok smoke (real binary, opt-in)", () => {
  let home: string;
  const scratch: string[] = [];

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    cleanupHome(home);
    for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("delegates a trivial task to real grok and completes via submit_report", async () => {
    const src = makeGitRepo([]);
    scratch.push(src);

    const result = await runCli(
      ["delegate", "-v", "grok", "-n", "smoke", "--wait", PROMPT],
      home,
      { cwd: src },
    );

    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.state).toBe("completed");
    expect(envelope.report.outcome).toBe("success");

    // The grok session id is only emitted in the terminal `end` event, which
    // grok prints as it exits — a beat after `submit_report` (over MCP) has
    // already moved the task to `completed` and released `--wait`. Poll briefly
    // for it to land, proving the stream-side capture works too.
    let sessionId: unknown = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const row = JSON.parse((await runCli(["status", envelope.task_id, "--json"], home)).stdout);
      sessionId = row.session_id;
      if (sessionId) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(sessionId).toBeTruthy();
  }, 180_000);
});
