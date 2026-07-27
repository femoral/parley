/**
 * extraArgs splicing in codex/grok spawn plans (#112).
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexAdapter } from "../src/adapters/codex.js";
import { createGrokAdapter } from "../src/adapters/grok.js";
import type { HubInfo, TaskSpec } from "../src/adapters/types.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Happy inspect probe so prepare does not require bubblewrap (#247). */
function happyGrokBin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-grok-extra-"));
  scratch.push(dir);
  const file = path.join(dir, "grok");
  fs.writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "inspect" ]; then echo '{"permissions":{"loaded":0,"sources":[]}}'; fi\n`,
    { mode: 0o755 },
  );
  return file;
}

const HUB: HubInfo = {
  url: "http://127.0.0.1:5555/mcp",
  headers: { "x-parley-task": "t1" },
};

function codexSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t1",
    name: null,
    prompt: "do the thing",
    vendor: "codex",
    model: null,
    effort: null,
    cwd: "/work/wt",
    sandbox: "workspace",
    network: true,
    answerTimeoutMs: 1_800_000,
    extraArgs: [],
    ...overrides,
  };
}

function grokSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t1",
    name: null,
    prompt: "do the thing",
    vendor: "grok",
    model: null,
    effort: null,
    cwd: "/work/tree",
    sandbox: "workspace",
    network: true,
    answerTimeoutMs: 30 * 60 * 1000,
    extraArgs: [],
    ...overrides,
  };
}

describe("codex extraArgs splicing", () => {
  it("places extraArgs in the flags region before the positional prompt", async () => {
    const plan = await createCodexAdapter({}).prepare(
      codexSpec({ extraArgs: ["--foo", "bar"] }),
      HUB,
    );
    const promptIdx = plan.argv.indexOf("do the thing");
    expect(promptIdx).toBe(plan.argv.length - 1);
    expect(plan.argv.slice(promptIdx - 2, promptIdx)).toEqual(["--foo", "bar"]);
    // Subcommand head still leads.
    expect(plan.argv.slice(0, 2)).toEqual(["codex", "exec"]);
  });

  it("splices on resume before the prompt too", async () => {
    const plan = await createCodexAdapter({}).resume(
      codexSpec({ extraArgs: ["--x"], sessionId: "sess-1", prompt: "answer" }),
      HUB,
    );
    expect(plan.argv[plan.argv.length - 1]).toBe("answer");
    expect(plan.argv).toContain("--x");
    expect(plan.argv.indexOf("--x")).toBeLessThan(plan.argv.length - 1);
  });
});

describe("grok extraArgs splicing", () => {
  it("appends extraArgs into commonArgv (flags region)", async () => {
    const plan = await createGrokAdapter({ PARLEY_GROK_BIN: happyGrokBin() }).prepare(
      grokSpec({ extraArgs: ["--verbose", "--trace"] }),
      HUB,
    );
    // Prompt is a -p value early in argv; extraArgs land with other flags.
    expect(plan.argv).toContain("--verbose");
    expect(plan.argv).toContain("--trace");
    const pIdx = plan.argv.indexOf("-p");
    expect(plan.argv[pIdx + 1]).toBe("do the thing");
    expect(plan.argv.indexOf("--verbose")).toBeGreaterThan(pIdx + 1);
  });
});
