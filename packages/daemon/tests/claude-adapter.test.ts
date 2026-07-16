import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";

/**
 * Golden unit tests for the claude adapter — pure-function exception to the
 * suite's CLI-boundary rule (spec §10). Pins argv/env across the sandbox-posture
 * matrix and stream-json normalization against Claude Code 2.1.211
 * (docs/research/claude-code-cli-automation.md).
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/claude/", import.meta.url));

const HUB: HubInfo = {
  url: "http://127.0.0.1:54321/mcp",
  headers: { "X-Parley-Task": "t98", Authorization: "Bearer test-token" },
};

/** A task at the daemon's default 30-minute answer timeout → MCP timeout 1_860_000. */
function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t98",
    name: null,
    prompt: "do the thing",
    vendor: "claude",
    model: null,
    effort: null,
    cwd: "/work/tree",
    sandbox: "workspace",
    network: true,
    answerTimeoutMs: 1_800_000,
    extraArgs: [],
    ...overrides,
  };
}

/** Default MCP timeout: 30m answer + 60s headroom. */
const DEFAULT_MCP_TIMEOUT_MS = 1_860_000;

describe("claude adapter — prepare argv (golden)", () => {
  it("builds the pinned headless stream-json invocation", async () => {
    const adapter = createClaudeAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "claude",
      "-p",
      "do the thing",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      ".parley/claude-mcp.json",
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      "--settings",
      ".parley/claude-settings.json",
      "--allowedTools",
      "Read,Edit,Write,Bash,mcp__parley__*",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("passes the model through with --model when set, omits it otherwise", async () => {
    const adapter = createClaudeAdapter({});
    const withModel = await adapter.prepare(spec({ model: "sonnet" }), HUB);
    expect(withModel.argv).toContain("--model");
    expect(withModel.argv).toContain("sonnet");
    const without = await adapter.prepare(spec({ model: null }), HUB);
    expect(without.argv).not.toContain("--model");
  });

  it("passes effort through with --effort when set, omits it otherwise", async () => {
    const adapter = createClaudeAdapter({});
    const withEffort = await adapter.prepare(spec({ effort: "high" }), HUB);
    expect(withEffort.argv).toContain("--effort");
    expect(withEffort.argv).toContain("high");
    // Placed after permission-mode / settings, before extraArgs.
    const effortIdx = withEffort.argv.indexOf("--effort");
    expect(withEffort.argv[effortIdx + 1]).toBe("high");

    const without = await adapter.prepare(spec({ effort: null }), HUB);
    expect(without.argv).not.toContain("--effort");
  });

  it("carries model and effort through resume identically to prepare", async () => {
    const adapter = createClaudeAdapter({});
    const plan = await adapter.resume(
      spec({
        prompt: "the answer",
        sessionId: "98428278-d240-475c-ad41-b840a6a42ffb",
        model: "opus",
        effort: "low",
      }),
      HUB,
    );
    expect(plan.argv).toContain("--model");
    expect(plan.argv).toContain("opus");
    expect(plan.argv).toContain("--effort");
    expect(plan.argv).toContain("low");
  });

  it("honours PARLEY_CLAUDE_BIN override", async () => {
    const adapter = createClaudeAdapter({ PARLEY_CLAUDE_BIN: "/opt/claude/claude" });
    expect((await adapter.prepare(spec(), HUB)).argv[0]).toBe("/opt/claude/claude");
  });

  it("adds --add-dir for gitDir and gitCommonDir when present", async () => {
    const plan = await createClaudeAdapter({}).prepare(
      spec({
        gitDir: "/repo/.git/worktrees/t98",
        gitCommonDir: "/repo/.git",
      }),
      HUB,
    );
    expect(plan.argv).toContain("--add-dir");
    expect(plan.argv).toContain("/repo/.git/worktrees/t98");
    expect(plan.argv).toContain("/repo/.git");
  });

  it("does not duplicate --add-dir when gitDir === gitCommonDir", async () => {
    const plan = await createClaudeAdapter({}).prepare(
      spec({ gitDir: "/repo/.git", gitCommonDir: "/repo/.git" }),
      HUB,
    );
    const dirs = plan.argv.filter((a, i) => plan.argv[i - 1] === "--add-dir");
    expect(dirs).toEqual(["/repo/.git"]);
  });
});

describe("claude adapter — resume argv (golden)", () => {
  it("resumes the persisted session with --resume and the answer prompt", async () => {
    const adapter = createClaudeAdapter({});
    const plan = await adapter.resume(
      spec({ prompt: "the answer", sessionId: "sess-abc-uuid" }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "claude",
      "-p",
      "the answer",
      "--resume",
      "sess-abc-uuid",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      ".parley/claude-mcp.json",
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      "--settings",
      ".parley/claude-settings.json",
      "--allowedTools",
      "Read,Edit,Write,Bash,mcp__parley__*",
    ]);
  });

  it("re-materializes MCP config and settings on resume", async () => {
    const adapter = createClaudeAdapter({});
    const plan = await adapter.resume(spec({ sessionId: "sess-abc" }), HUB);
    expect(plan.files.map((f) => f.path)).toEqual([
      ".parley/claude-mcp.json",
      ".parley/claude-settings.json",
    ]);
  });

  it("rejects a resume without a session id (would silently start a fresh session)", async () => {
    const adapter = createClaudeAdapter({});
    await expect(adapter.resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });
});

describe("claude adapter — sandbox-posture matrix (golden)", () => {
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    permission: string;
    allowedTools: string | null;
    sandboxSettings: boolean;
  }[] = [
    {
      sandbox: "workspace",
      network: true,
      permission: "acceptEdits",
      allowedTools: "Read,Edit,Write,Bash,mcp__parley__*",
      sandboxSettings: false,
    },
    {
      sandbox: "workspace",
      network: false,
      permission: "acceptEdits",
      allowedTools: "Read,Edit,Write,Bash,mcp__parley__*",
      sandboxSettings: true,
    },
    {
      sandbox: "read-only",
      network: true,
      permission: "dontAsk",
      allowedTools: "Read,Grep,Glob,mcp__parley__*",
      sandboxSettings: false,
    },
    {
      sandbox: "read-only",
      network: false,
      permission: "dontAsk",
      allowedTools: "Read,Grep,Glob,mcp__parley__*",
      sandboxSettings: true,
    },
    {
      sandbox: "full",
      network: true,
      permission: "bypassPermissions",
      allowedTools: null,
      sandboxSettings: false,
    },
    // full ignores network:false — danger-full-access is inherently network-on.
    {
      sandbox: "full",
      network: false,
      permission: "bypassPermissions",
      allowedTools: null,
      sandboxSettings: false,
    },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network} → permission-mode ${c.permission} (not silent full bypass for workspace/read-only)`, async () => {
      const adapter = createClaudeAdapter({});
      const plan = await adapter.prepare(spec({ sandbox: c.sandbox, network: c.network }), HUB);
      const modeIdx = plan.argv.indexOf("--permission-mode");
      expect(plan.argv[modeIdx + 1]).toBe(c.permission);
      if (c.allowedTools === null) {
        expect(plan.argv).not.toContain("--allowedTools");
      } else {
        const toolsIdx = plan.argv.indexOf("--allowedTools");
        expect(toolsIdx).toBeGreaterThan(-1);
        expect(plan.argv[toolsIdx + 1]).toBe(c.allowedTools);
        // Hub protocol tools must be on the allowlist so submit_report works.
        expect(c.allowedTools).toContain("mcp__parley__*");
      }

      const settings = plan.files.find((f) => f.path === ".parley/claude-settings.json");
      expect(settings).toBeDefined();
      const parsed = JSON.parse(settings!.contents) as {
        disableClaudeAiConnectors: boolean;
        sandbox?: { enabled: boolean };
      };
      expect(parsed.disableClaudeAiConnectors).toBe(true);
      if (c.sandboxSettings) {
        expect(parsed.sandbox?.enabled).toBe(true);
        expect(settings!.contents).toContain("localhost");
        expect(settings!.contents).toContain("127.0.0.1");
      } else {
        expect(parsed.sandbox).toBeUndefined();
      }
    });
  }

  it("resume carries the identical permission-mode as prepare", async () => {
    const adapter = createClaudeAdapter({});
    const s = spec({ sandbox: "read-only", network: false, sessionId: "sess-1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    const permOf = (argv: string[]): string => {
      const i = argv.indexOf("--permission-mode");
      return argv[i + 1]!;
    };
    expect(permOf(resumed.argv)).toBe(permOf(prepared.argv));
    // Defect scenario: plan mode could block hub MCP; dontAsk + allowlist instead.
    expect(permOf(prepared.argv)).toBe("dontAsk");
  });
});

describe("claude adapter — MCP injection & timeout", () => {
  it("materializes .parley/claude-mcp.json with hub url, headers, and raised timeout", async () => {
    const adapter = createClaudeAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    const mcp = plan.files.find((f) => f.path === ".parley/claude-mcp.json");
    expect(mcp).toBeDefined();
    const parsed = JSON.parse(mcp!.contents) as {
      mcpServers: {
        parley: {
          type: string;
          url: string;
          headers: Record<string, string>;
          timeout: number;
        };
      };
    };
    expect(parsed.mcpServers.parley.type).toBe("http");
    expect(parsed.mcpServers.parley.url).toBe("http://127.0.0.1:54321/mcp");
    expect(parsed.mcpServers.parley.headers).toEqual({
      "X-Parley-Task": "t98",
      Authorization: "Bearer test-token",
    });
    expect(parsed.mcpServers.parley.timeout).toBe(DEFAULT_MCP_TIMEOUT_MS);
  });

  it("raises MCP_TOOL_TIMEOUT and per-server timeout above answerTimeoutMs", async () => {
    // 5-minute answer timeout → 300_000 + 60_000 = 360_000 ms.
    const plan = await createClaudeAdapter({}).prepare(spec({ answerTimeoutMs: 300_000 }), HUB);
    expect(plan.env.MCP_TOOL_TIMEOUT).toBe("360000");
    const mcp = JSON.parse(
      plan.files.find((f) => f.path === ".parley/claude-mcp.json")!.contents,
    ) as { mcpServers: { parley: { timeout: number } } };
    expect(mcp.mcpServers.parley.timeout).toBe(360_000);
    expect(360_000).toBeGreaterThan(300_000);
  });

  it("points --mcp-config at the materialized file and pairs --strict-mcp-config", async () => {
    const plan = await createClaudeAdapter({}).prepare(spec(), HUB);
    expect(plan.argv).toContain("--mcp-config");
    expect(plan.argv).toContain(".parley/claude-mcp.json");
    expect(plan.argv).toContain("--strict-mcp-config");
  });
});

describe("claude adapter — env passthrough & leak control", () => {
  it("passes ANTHROPIC_API_KEY through only when the parent set it", async () => {
    expect(
      (await createClaudeAdapter({ ANTHROPIC_API_KEY: "sk-ant-test" }).prepare(spec(), HUB)).env
        .ANTHROPIC_API_KEY,
    ).toBe("sk-ant-test");
    expect(
      "ANTHROPIC_API_KEY" in (await createClaudeAdapter({}).prepare(spec(), HUB)).env,
    ).toBe(false);
  });

  it("passes CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_AUTH_TOKEN when set", async () => {
    const plan = await createClaudeAdapter({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok",
      ANTHROPIC_AUTH_TOKEN: "bearer-tok",
    }).prepare(spec(), HUB);
    expect(plan.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("bearer-tok");
  });

  it("always disables claude.ai connectors via env (hermetic MCP)", async () => {
    const plan = await createClaudeAdapter({}).prepare(spec(), HUB);
    expect(plan.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  });
});

describe("claude adapter — extraArgs splicing", () => {
  it("places extraArgs in the flags region after -p <prompt>", async () => {
    const plan = await createClaudeAdapter({}).prepare(
      spec({ extraArgs: ["--fallback-model", "haiku"] }),
      HUB,
    );
    const pIdx = plan.argv.indexOf("-p");
    expect(plan.argv[pIdx + 1]).toBe("do the thing");
    expect(plan.argv).toContain("--fallback-model");
    expect(plan.argv).toContain("haiku");
    // Extra flags land after the prompt value (flags region), not as a later positional.
    expect(plan.argv.indexOf("--fallback-model")).toBeGreaterThan(pIdx + 1);
  });

  it("splices on resume before the end of flags too", async () => {
    const plan = await createClaudeAdapter({}).resume(
      spec({ extraArgs: ["--foo"], sessionId: "sess-1", prompt: "answer" }),
      HUB,
    );
    expect(plan.argv).toContain("--foo");
    expect(plan.argv.indexOf("--foo")).toBeGreaterThan(plan.argv.indexOf("-p"));
  });
});

describe("claude adapter — parseEvent (tolerant)", () => {
  const adapter = createClaudeAdapter({});

  it("system/init → session_meta carrying session_id", () => {
    expect(
      adapter.parseEvent(
        '{"type":"system","subtype":"init","session_id":"98428278-d240-475c-ad41-b840a6a42ffb"}',
      ),
    ).toEqual([
      { kind: "session_meta", session_id: "98428278-d240-475c-ad41-b840a6a42ffb" },
    ]);
  });

  it("assistant text content → message", () => {
    const line =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there"}]}}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "message", text: "Hi there" }]);
  });

  it("assistant Bash tool_use → command", () => {
    const line =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo hello-parley"}}]}}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "command", text: "echo hello-parley" }]);
  });

  it("assistant Edit/Write tool_use → file_change", () => {
    const edit =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/a.ts"}}]}}';
    expect(adapter.parseEvent(edit)).toEqual([{ kind: "file_change", text: "src/a.ts" }]);
    const write =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"src/b.ts"}}]}}';
    expect(adapter.parseEvent(write)).toEqual([{ kind: "file_change", text: "src/b.ts" }]);
  });

  it("result with usage → session_meta; is_error → fatal error", () => {
    const ok =
      '{"type":"result","is_error":false,"session_id":"sid-1","total_cost_usd":0.1,' +
      '"usage":{"input_tokens":2,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":43}}';
    expect(adapter.parseEvent(ok)).toEqual([
      {
        kind: "session_meta",
        session_id: "sid-1",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
          output_tokens: 43,
          cached_tokens: 20,
          total_cost_usd: 0.1,
        },
      },
    ]);

    const fail =
      '{"type":"result","is_error":true,"session_id":"sid-2","result":"Invalid API key","terminal_reason":"api_error","usage":{"input_tokens":0,"output_tokens":0}}';
    expect(adapter.parseEvent(fail)).toEqual([
      {
        kind: "session_meta",
        session_id: "sid-2",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
      { kind: "error", text: "Invalid API key", fatal: true },
    ]);
  });

  it("failed tool_result → tagged non-fatal diagnostic", () => {
    const line =
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x","is_error":true,"content":"permission denied"}]}}';
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "error",
        text: "PARLEY-DIAG tool_result tool_use_id=toolu_x failed: permission denied",
      },
    ]);
  });

  it("successful tool_result, rate_limit, and thinking stay opaque", () => {
    expect(
      adapter.parseEvent(
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","is_error":false,"content":"ok"}]}}',
      ),
    ).toEqual([]);
    expect(adapter.parseEvent('{"type":"rate_limit_event","rate_limit_info":{}}')).toEqual([]);
    expect(
      adapter.parseEvent(
        '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}',
      ),
    ).toEqual([]);
  });

  it("never throws on unknown, changed, or malformed shapes", () => {
    expect(adapter.parseEvent('{"type":"totally_new_kind","x":1}')).toEqual([]);
    expect(adapter.parseEvent('{"no":"type"}')).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
    expect(adapter.parseEvent("null")).toEqual([]);
  });
});

describe("claude adapter — golden JSONL fixtures (pins observed 2.1.211)", () => {
  function replay(file: string): {
    messages: string[];
    commands: string[];
    fileChanges: string[];
    sessionId: string | undefined;
    usage: Record<string, number> | undefined;
    fatalErrors: string[];
  } {
    const adapter = createClaudeAdapter({});
    const lines = fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    return {
      messages: events.filter((e) => e.kind === "message").map((e) => e.text ?? ""),
      commands: events.filter((e) => e.kind === "command").map((e) => e.text ?? ""),
      fileChanges: events.filter((e) => e.kind === "file_change").map((e) => e.text ?? ""),
      sessionId: adapter.sessionId(events),
      usage: events.filter((e) => e.kind === "session_meta" && e.usage).at(-1)?.usage,
      fatalErrors: events
        .filter((e) => e.kind === "error" && e.fatal)
        .map((e) => e.text ?? ""),
    };
  }

  it("reconstructs message, session id, and usage from a fresh run", () => {
    const { messages, sessionId, usage, fatalErrors } = replay("v2.1.211-fresh.jsonl");
    expect(messages).toEqual(["Hi Felipe! 👋 What can I help you with today?"]);
    expect(sessionId).toBe("98428278-d240-475c-ad41-b840a6a42ffb");
    expect(usage?.input_tokens).toBe(2);
    expect(usage?.output_tokens).toBe(43);
    expect(usage?.cached_tokens).toBe(15042);
    expect(usage?.cache_read_input_tokens).toBe(15042);
    expect(usage?.total_cost_usd).toBe(0.175672);
    expect(fatalErrors).toEqual([]);
  });

  it("maps Bash/Edit tool use and keeps the stable session id", () => {
    const { messages, commands, fileChanges, sessionId } = replay("v2.1.211-tool-use.jsonl");
    expect(commands).toEqual(["echo hello-parley"]);
    expect(fileChanges).toEqual(["src/hello.ts"]);
    expect(messages).toEqual(["Done."]);
    expect(sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });
});

describe("claude adapter — sessionId extraction", () => {
  const adapter = createClaudeAdapter({});

  it("returns the last session_meta session_id", () => {
    const events = [
      ...adapter.parseEvent(
        '{"type":"system","subtype":"init","session_id":"first-id"}',
      ),
      ...adapter.parseEvent(
        '{"type":"result","is_error":false,"session_id":"last-id","usage":{"input_tokens":1,"output_tokens":1}}',
      ),
    ];
    expect(adapter.sessionId(events)).toBe("last-id");
  });

  it("returns undefined when no session id was seen", () => {
    const events = adapter.parseEvent('{"type":"rate_limit_event"}');
    expect(adapter.sessionId(events)).toBeUndefined();
  });
});
