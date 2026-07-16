import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGrokAdapter } from "../src/adapters/grok.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";
import { createWorktree, excludeMaterializedFiles } from "../src/worktree.js";
import { makeGitRepo } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/grok/", import.meta.url));
const HUB: HubInfo = {
  url: "http://127.0.0.1:54321/mcp",
  headers: { "x-parley-task": "t7" },
};

/** A TaskSpec with the given posture; overrides merge over the defaults. */
function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t7",
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

/** The five Claude-config scanner vars the adapter turns off per child. */
const SCANNERS = [
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("grok adapter — prepare argv (golden)", () => {
  it("builds the pinned headless streaming-json invocation", async () => {
    const adapter = createGrokAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "grok",
      "-p",
      "do the thing",
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--always-approve",
      "--cwd",
      "/work/tree",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("passes the model through with -m when set, omits it otherwise", async () => {
    const adapter = createGrokAdapter({});
    expect((await adapter.prepare(spec({ model: "grok-4.5" }), HUB)).argv).toContain("-m");
    expect((await adapter.prepare(spec({ model: "grok-4.5" }), HUB)).argv).toContain("grok-4.5");
    expect((await adapter.prepare(spec({ model: null }), HUB)).argv).not.toContain("-m");
  });

  it("passes reasoning effort through with --reasoning-effort when set, omits it otherwise", async () => {
    const adapter = createGrokAdapter({});
    const withEffort = await adapter.prepare(spec({ effort: "high" }), HUB);
    expect(withEffort.argv).toEqual([
      "grok",
      "-p",
      "do the thing",
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--always-approve",
      "--cwd",
      "/work/tree",
      "--reasoning-effort",
      "high",
    ]);
    const withoutEffort = await adapter.prepare(spec({ effort: null }), HUB);
    expect(withoutEffort.argv).not.toContain("--reasoning-effort");
  });

  it("carries reasoning effort through resume identically to prepare", async () => {
    const adapter = createGrokAdapter({});
    const plan = await adapter.resume(
      spec({ prompt: "the answer", sessionId: "sess-1", effort: "low" }),
      HUB,
    );
    expect(plan.argv).toContain("--reasoning-effort");
    expect(plan.argv).toContain("low");
  });

  it("honours PARLEY_GROK_BIN override", async () => {
    const adapter = createGrokAdapter({ PARLEY_GROK_BIN: "/opt/grok/grok" });
    expect((await adapter.prepare(spec(), HUB)).argv[0]).toBe("/opt/grok/grok");
  });
});

describe("grok adapter — resume argv (golden)", () => {
  it("resumes the persisted session with -r and the answer prompt", async () => {
    const adapter = createGrokAdapter({});
    const plan = await adapter.resume(spec({ prompt: "the answer", sessionId: "sess-abc" }), HUB);
    expect(plan.argv).toEqual([
      "grok",
      "-p",
      "the answer",
      "-r",
      "sess-abc",
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--always-approve",
      "--cwd",
      "/work/tree",
    ]);
  });

  it("re-materializes the MCP config on resume", async () => {
    const adapter = createGrokAdapter({});
    const plan = await adapter.resume(spec({ sessionId: "sess-abc" }), HUB);
    expect(plan.files.map((f) => f.path)).toContain(".grok/config.toml");
  });

  it("rejects a resume without a session id (would silently start a fresh session)", async () => {
    const adapter = createGrokAdapter({});
    await expect(adapter.resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });
});

describe("grok adapter — env across the sandbox-posture matrix (golden)", () => {
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    expectSandbox: string;
    extra: Record<string, string>;
    sandboxToml: boolean;
  }[] = [
    {
      sandbox: "workspace",
      network: true,
      expectSandbox: "workspace",
      extra: { GROK_SANDBOX_AUTO_ALLOW_BASH: "1" },
      sandboxToml: false,
    },
    {
      sandbox: "workspace",
      network: false,
      expectSandbox: "parley-restricted",
      extra: { GROK_SANDBOX_AUTO_ALLOW_BASH: "1" },
      sandboxToml: true,
    },
    {
      sandbox: "read-only",
      network: true,
      expectSandbox: "read-only",
      extra: { GROK_WRITE_FILE: "0" },
      sandboxToml: false,
    },
    {
      sandbox: "read-only",
      network: false,
      expectSandbox: "parley-restricted",
      extra: { GROK_WRITE_FILE: "0" },
      sandboxToml: true,
    },
    { sandbox: "full", network: true, expectSandbox: "off", extra: {}, sandboxToml: false },
    // full ignores network:false — danger-full-access is inherently network-on.
    { sandbox: "full", network: false, expectSandbox: "off", extra: {}, sandboxToml: false },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network} → GROK_SANDBOX=${c.expectSandbox}`, async () => {
      const adapter = createGrokAdapter({});
      const plan = await adapter.prepare(spec({ sandbox: c.sandbox, network: c.network }), HUB);
      expect(plan.env.GROK_SANDBOX).toBe(c.expectSandbox);
      for (const [k, v] of Object.entries(c.extra)) expect(plan.env[k]).toBe(v);
      // Claude scanners always disabled.
      for (const key of SCANNERS) expect(plan.env[key]).toBe("0");
      // A no-network posture (except full) materializes a custom profile.
      const hasSandboxToml = plan.files.some((f) => f.path === ".grok/sandbox.toml");
      expect(hasSandboxToml).toBe(c.sandboxToml);
    });
  }

  it("resume carries the identical posture env as prepare", async () => {
    const adapter = createGrokAdapter({});
    const s = spec({ sandbox: "read-only", network: false, sessionId: "sess-1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    expect(resumed.env.GROK_SANDBOX).toBe(prepared.env.GROK_SANDBOX);
    expect(resumed.env.GROK_WRITE_FILE).toBe(prepared.env.GROK_WRITE_FILE);
  });
});

describe("grok adapter — env passthrough & leak control", () => {
  it("passes XAI_API_KEY through only when the parent set it", async () => {
    expect((await createGrokAdapter({ XAI_API_KEY: "xai-secret" }).prepare(spec(), HUB)).env
      .XAI_API_KEY).toBe("xai-secret");
    expect("XAI_API_KEY" in (await createGrokAdapter({}).prepare(spec(), HUB)).env).toBe(false);
  });

  it("pins MCP_TIMEOUT so a parent (Claude) value cannot leak into the child", async () => {
    // Even when the parent env exports its own MCP_TIMEOUT, the plan overrides it
    // (the engine spreads SpawnPlan.env over process.env, so ours wins).
    const adapter = createGrokAdapter({ MCP_TIMEOUT: "600000" });
    expect((await adapter.prepare(spec(), HUB)).env.MCP_TIMEOUT).toBe("30000");
  });

  it("sets GROK_XAI_API_BASE_URL to the daemon proxy path when parent did not override (#95)", async () => {
    const plan = await createGrokAdapter({}).prepare(spec({ id: "t7" }), HUB);
    expect(plan.env.GROK_XAI_API_BASE_URL).toBe("http://127.0.0.1:54321/xai/t7/v1");
  });

  it("omits GROK_XAI_API_BASE_URL from plan.env when the parent already set it", async () => {
    // Parent override must not be clobbered: engine spawn is
    // `{...process.env, ...plan.env}`, so omitting the key keeps the parent value.
    const plan = await createGrokAdapter({
      GROK_XAI_API_BASE_URL: "https://custom.example/v1",
    }).prepare(spec(), HUB);
    expect("GROK_XAI_API_BASE_URL" in plan.env).toBe(false);
  });

  it("derives the proxy URL from the hub origin + task id on resume too", async () => {
    const hub: HubInfo = {
      url: "http://127.0.0.1:9999/mcp",
      headers: { "x-parley-task": "task-r" },
    };
    const plan = await createGrokAdapter({}).resume(
      spec({ id: "task-r", sessionId: "sess-1" }),
      hub,
    );
    expect(plan.env.GROK_XAI_API_BASE_URL).toBe("http://127.0.0.1:9999/xai/task-r/v1");
  });
});

describe("grok adapter — materialized .grok/config.toml", () => {
  it("carries the MCP endpoint, correlation header, worktree-never, and approval posture", async () => {
    const adapter = createGrokAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    const config = plan.files.find((f) => f.path === ".grok/config.toml");
    expect(config).toBeDefined();
    const toml = config!.contents;
    expect(toml).toContain('new_session_worktree_mode = "never"');
    expect(toml).toContain('permission_mode = "always-approve"');
    expect(toml).toContain("[mcp_servers.parley]");
    expect(toml).toContain('type = "http"');
    expect(toml).toContain('url = "http://127.0.0.1:54321/mcp"');
    expect(toml).toContain("[mcp_servers.parley.headers]");
    expect(toml).toContain('"x-parley-task" = "t7"');
  });

  it("escapes quotes, backslashes, and control characters in TOML values", async () => {
    const adapter = createGrokAdapter({});
    const hub: HubInfo = {
      url: 'http://127.0.0.1:1/mcp?q="x"\\y',
      headers: { "x-parley-task": "t1\nInjected = true" },
    };
    const plan = await adapter.prepare(spec(), hub);
    const toml = plan.files.find((f) => f.path === ".grok/config.toml")!.contents;
    expect(toml).toContain('url = "http://127.0.0.1:1/mcp?q=\\"x\\"\\\\y"');
    // The newline is escaped, so no injected config line appears.
    expect(toml).toContain('"x-parley-task" = "t1\\u000aInjected = true"');
    expect(toml).not.toMatch(/^Injected = true$/m);
  });

  it("the no-network sandbox.toml extends the base built-in with restrict_network", async () => {
    const adapter = createGrokAdapter({});
    const plan = await adapter.prepare(spec({ sandbox: "workspace", network: false }), HUB);
    const sb = plan.files.find((f) => f.path === ".grok/sandbox.toml");
    expect(sb).toBeDefined();
    expect(sb!.contents).toContain("[profiles.parley-restricted]");
    expect(sb!.contents).toContain('extends = "workspace"');
    expect(sb!.contents).toContain("restrict_network = true");
  });
});

describe("grok adapter — parseEvent (tolerant)", () => {
  const adapter = createGrokAdapter({});

  it("maps text chunks to messages and end to session_meta", () => {
    expect(adapter.parseEvent('{"type":"text","data":"Hi"}')).toEqual([
      { kind: "message", text: "Hi" },
    ]);
    expect(
      adapter.parseEvent('{"type":"end","stopReason":"EndTurn","sessionId":"sid-9"}'),
    ).toEqual([{ kind: "session_meta", session_id: "sid-9" }]);
  });

  it("treats thought chunks as opaque (no normalized event)", () => {
    expect(adapter.parseEvent('{"type":"thought","data":"hmm"}')).toEqual([]);
  });

  it("never throws on unknown, changed, or malformed shapes", () => {
    expect(adapter.parseEvent('{"type":"totally_new_kind","x":1}')).toEqual([]);
    expect(adapter.parseEvent('{"no":"type"}')).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
    expect(adapter.parseEvent('{"type":"end"}')).toEqual([
      { kind: "session_meta", session_id: undefined },
    ]);
  });

  it("surfaces error/fatal events", () => {
    expect(adapter.parseEvent('{"type":"error","message":"boom"}')).toEqual([
      { kind: "error", text: "boom" },
    ]);
  });
});

describe("grok adapter — golden JSONL fixtures (pins observed 0.2.93)", () => {
  function replay(file: string): { messages: string; sessionId: string | undefined } {
    const adapter = createGrokAdapter({});
    const lines = fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    const messages = events
      .filter((e) => e.kind === "message")
      .map((e) => e.text ?? "")
      .join("");
    return { messages, sessionId: adapter.sessionId(events) };
  }

  it("reconstructs the assistant message and session id from a fresh run", () => {
    const { messages, sessionId } = replay("v0.2.93-fresh.jsonl");
    expect(messages).toBe("Hi. How can I help?");
    expect(sessionId).toBe("019f49ce-3e6a-72b2-b5a3-2ed48e513384");
  });

  it("reconstructs a resume turn and its (stable) session id", () => {
    const { messages, sessionId } = replay("v0.2.93-resume.jsonl");
    expect(messages).toBe("PLATYPUS");
    expect(sessionId).toBe("019f49cf-09e0-7123-82df-3084a05b6ebd");
  });
});

describe("grok adapter — worktree git-exclude seam (#19)", () => {
  it("keeps materialized .grok plumbing out of the worktree's git status", () => {
    const src = makeGitRepo();
    scratch.push(src);
    const worktreesDir = fs.mkdtempSync(path.join(src, "..", "wt-"));
    scratch.push(worktreesDir);
    const info = createWorktree({
      repoRoot: src,
      worktreesDir,
      taskId: "t1",
      name: null,
      baseRef: null,
    });

    // Simulate what the engine does: exclude, then materialize the vendor files.
    excludeMaterializedFiles(info.path, [".grok/config.toml", ".grok/sandbox.toml"]);
    fs.mkdirSync(path.join(info.path, ".grok"), { recursive: true });
    fs.writeFileSync(path.join(info.path, ".grok", "config.toml"), "x = 1\n");
    fs.writeFileSync(path.join(info.path, ".grok", "sandbox.toml"), "y = 2\n");

    const status = execFileSync("git", ["-C", info.path, "status", "--porcelain"], {
      encoding: "utf8",
    });
    expect(status).toBe("");

    // A resume re-materializes the same files: excluding again must not grow
    // the exclude file (idempotent across respawns).
    const gitDir = execFileSync("git", ["-C", info.path, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
    }).trim();
    const excludeFile = path.join(gitDir, "parley-exclude");
    const before = fs.readFileSync(excludeFile, "utf8");
    excludeMaterializedFiles(info.path, [".grok/config.toml", ".grok/sandbox.toml"]);
    expect(fs.readFileSync(excludeFile, "utf8")).toBe(before);
  });

  it("excludes the exact file paths, not whole directories (child work stays visible)", () => {
    const src = makeGitRepo();
    scratch.push(src);
    const worktreesDir = fs.mkdtempSync(path.join(src, "..", "wt-"));
    scratch.push(worktreesDir);
    const info = createWorktree({
      repoRoot: src,
      worktreesDir,
      taskId: "t1",
      name: null,
      baseRef: null,
    });

    excludeMaterializedFiles(info.path, [".grok/config.toml"]);
    fs.mkdirSync(path.join(info.path, ".grok"), { recursive: true });
    fs.writeFileSync(path.join(info.path, ".grok", "config.toml"), "x = 1\n");
    // A file the CHILD writes into the same directory must still show up.
    fs.writeFileSync(path.join(info.path, ".grok", "child-artifact.txt"), "work\n");

    const status = execFileSync(
      "git",
      ["-C", info.path, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8" },
    );
    expect(status).toContain(".grok/child-artifact.txt");
    expect(status).not.toContain("config.toml");
  });
});
