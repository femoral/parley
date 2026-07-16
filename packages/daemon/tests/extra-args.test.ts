/**
 * extraArgs splicing in codex/grok spawn plans (#112).
 */
import { describe, expect, it } from "vitest";
import { createCodexAdapter } from "../src/adapters/codex.js";
import { createGrokAdapter } from "../src/adapters/grok.js";
import type { HubInfo, TaskSpec } from "../src/adapters/types.js";

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
    const plan = await createGrokAdapter({}).prepare(
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
