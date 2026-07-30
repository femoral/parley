import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpenhandsAdapter,
  OPENHANDS_MCP_TOOL_TIMEOUT_MS,
} from "../src/adapters/openhands.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";

/**
 * Golden unit tests for the openhands adapter — pins argv/env/files across the
 * sandbox-posture matrix and the exact normalization of OpenHands CLI JSONL
 * (plus polluted stdout). Verified shapes from OpenHands CLI 1.16.0
 * (docs/research/openhands-cli-automation.md).
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/openhands/", import.meta.url));

const HUB: HubInfo = {
  url: "http://127.0.0.1:5555/mcp",
  headers: { "x-parley-task": "t1" },
};

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t1",
    name: null,
    prompt: "do the thing",
    vendor: "openhands",
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

describe("openhands adapter — enforcement (#279)", () => {
  it("declares no real sandbox/network enforcement", () => {
    const adapter = createOpenhandsAdapter({});
    expect(adapter.enforcement["read-only"].level).toBe("none");
    expect(adapter.enforcement.workspace.level).toBe("approximate");
    expect(adapter.enforcement.full.level).toBe("enforced");
    expect(adapter.enforcement["network:false"].level).toBe("none");
  });

  it("emits prepare-time PARLEY-DIAG for unenforced postures", async () => {
    const plan = await createOpenhandsAdapter({}).prepare(
      spec({ sandbox: "read-only", network: false }),
      HUB,
    );
    const diags = plan.diagnostics ?? [];
    expect(diags.some((d) => /PARLEY-DIAG posture: openhands sandbox=read-only/.test(d))).toBe(
      true,
    );
    expect(diags.some((d) => /PARLEY-DIAG posture: openhands network=false/.test(d))).toBe(true);
  });
});

describe("openhands adapter — prepare argv (golden)", () => {
  it("builds the hermetic headless --json --override-with-envs invocation", async () => {
    const adapter = createOpenhandsAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "openhands",
      "--headless",
      "--json",
      "--override-with-envs",
      "-t",
      "do the thing",
    ]);
    expect(plan.cwd).toBe("/work/wt");
  });

  it("places extraArgs in the flags region before -t <prompt>", async () => {
    const plan = await createOpenhandsAdapter({}).prepare(
      spec({ extraArgs: ["--foo", "bar"] }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "openhands",
      "--headless",
      "--json",
      "--override-with-envs",
      "--foo",
      "bar",
      "-t",
      "do the thing",
    ]);
    // Prompt is the value of -t, never before extraArgs.
    const tIdx = plan.argv.indexOf("-t");
    expect(plan.argv[tIdx + 1]).toBe("do the thing");
    expect(plan.argv.indexOf("--foo")).toBeLessThan(tIdx);
  });

  it("passes the model via LLM_MODEL when set, omits it otherwise", async () => {
    const withModel = await createOpenhandsAdapter({}).prepare(
      spec({ model: "openai/gpt-4o" }),
      HUB,
    );
    expect(withModel.env.LLM_MODEL).toBe("openai/gpt-4o");
    const without = await createOpenhandsAdapter({}).prepare(spec({ model: null }), HUB);
    expect("LLM_MODEL" in without.env).toBe(false);
  });

  it("forwards parent LLM_MODEL when task.model is unset", async () => {
    const plan = await createOpenhandsAdapter({ LLM_MODEL: "openai/gpt-4o" }).prepare(
      spec({ model: null }),
      HUB,
    );
    expect(plan.env.LLM_MODEL).toBe("openai/gpt-4o");
  });

  it("task.model wins over parent LLM_MODEL", async () => {
    const plan = await createOpenhandsAdapter({ LLM_MODEL: "parent-model" }).prepare(
      spec({ model: "task-model" }),
      HUB,
    );
    expect(plan.env.LLM_MODEL).toBe("task-model");
  });

  it("does not materialize partial agent_settings.json for effort (#107 major; old code wrote unproven stub)", async () => {
    // Partial {llm:{reasoning_effort}} may replace full agent specs — omit until verified.
    const withEffort = await createOpenhandsAdapter({}).prepare(spec({ effort: "low" }), HUB);
    expect(withEffort.files.some((f) => f.path.endsWith("agent_settings.json"))).toBe(false);
    expect(withEffort.files.map((f) => f.path)).toEqual([
      ".parley-openhands/persist/mcp.json",
    ]);

    const without = await createOpenhandsAdapter({}).prepare(spec({ effort: null }), HUB);
    expect(without.files.some((f) => f.path.endsWith("agent_settings.json"))).toBe(false);
  });

  it("honours PARLEY_OPENHANDS_BIN override", async () => {
    const adapter = createOpenhandsAdapter({ PARLEY_OPENHANDS_BIN: "/opt/openhands/bin" });
    expect((await adapter.prepare(spec(), HUB)).argv[0]).toBe("/opt/openhands/bin");
  });
});

describe("openhands adapter — resume argv (golden)", () => {
  it("resumes with --resume <id> and -t follow-up prompt", async () => {
    const adapter = createOpenhandsAdapter({});
    const plan = await adapter.resume(
      spec({ prompt: "continue please", sessionId: "826e5421-4256-4e7b-bf35-3d2a7d9ae7ff" }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "openhands",
      "--headless",
      "--json",
      "--override-with-envs",
      "--resume",
      "826e5421-4256-4e7b-bf35-3d2a7d9ae7ff",
      "-t",
      "continue please",
    ]);
    expect(plan.cwd).toBe("/work/wt");
  });

  it("splices extraArgs before -t on resume too", async () => {
    const plan = await createOpenhandsAdapter({}).resume(
      spec({
        prompt: "answer",
        sessionId: "sess-1",
        extraArgs: ["--x"],
      }),
      HUB,
    );
    const tIdx = plan.argv.indexOf("-t");
    expect(plan.argv[tIdx + 1]).toBe("answer");
    expect(plan.argv.indexOf("--x")).toBeLessThan(tIdx);
    expect(plan.argv).toContain("--resume");
  });

  it("re-materializes mcp.json on resume", async () => {
    const plan = await createOpenhandsAdapter({}).resume(
      spec({ sessionId: "sess-abc" }),
      HUB,
    );
    expect(plan.files.map((f) => f.path)).toContain(".parley-openhands/persist/mcp.json");
  });

  it("rejects a resume without a session id", async () => {
    const adapter = createOpenhandsAdapter({});
    await expect(adapter.resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });

  it("rejects a resume with an empty session id", async () => {
    const adapter = createOpenhandsAdapter({});
    await expect(adapter.resume(spec({ sessionId: "" }), HUB)).rejects.toThrow(/no session id/);
  });

  it("resume also omits partial agent_settings for effort (#107)", async () => {
    const adapter = createOpenhandsAdapter({});
    const s = spec({ effort: "medium", sessionId: "sess-1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    expect(prepared.files.some((f) => f.path.endsWith("agent_settings.json"))).toBe(false);
    expect(resumed.files.some((f) => f.path.endsWith("agent_settings.json"))).toBe(false);
  });
});

describe("openhands adapter — env isolation & sandbox posture (golden)", () => {
  it("isolates persistence/conversations under task-private dirs and sets workdir", async () => {
    const plan = await createOpenhandsAdapter({}).prepare(spec(), HUB);
    expect(plan.env.OPENHANDS_SUPPRESS_BANNER).toBe("1");
    expect(plan.env.OPENHANDS_PERSISTENCE_DIR).toBe("/work/wt/.parley-openhands/persist");
    expect(plan.env.OPENHANDS_CONVERSATIONS_DIR).toBe("/work/wt/.parley-openhands/conversations");
    expect(plan.env.OPENHANDS_WORK_DIR).toBe("/work/wt");
  });

  const cases: { sandbox: SandboxMode; network: boolean }[] = [
    { sandbox: "workspace", network: true },
    { sandbox: "workspace", network: false },
    { sandbox: "read-only", network: true },
    { sandbox: "read-only", network: false },
    { sandbox: "full", network: true },
    { sandbox: "full", network: false },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network}: soft workdir only (no harness sandbox flags)`, async () => {
      // research §5: no CLI sandbox matrix; all postures share the same host-process
      // env with OPENHANDS_WORK_DIR affinity.
      const plan = await createOpenhandsAdapter({}).prepare(
        spec({ sandbox: c.sandbox, network: c.network }),
        HUB,
      );
      expect(plan.env.OPENHANDS_WORK_DIR).toBe("/work/wt");
      expect(plan.argv).not.toContain("--sandbox");
      expect(plan.argv.some((a) => /sandbox/i.test(a))).toBe(false);
      // No network-off env/flag exists.
      expect(plan.env.OPENHANDS_NETWORK).toBeUndefined();
    });
  }

  it("resume carries the identical isolation env as prepare", async () => {
    const adapter = createOpenhandsAdapter({});
    const s = spec({ sandbox: "read-only", network: false, sessionId: "sess-1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    expect(resumed.env.OPENHANDS_PERSISTENCE_DIR).toBe(prepared.env.OPENHANDS_PERSISTENCE_DIR);
    expect(resumed.env.OPENHANDS_CONVERSATIONS_DIR).toBe(prepared.env.OPENHANDS_CONVERSATIONS_DIR);
    expect(resumed.env.OPENHANDS_WORK_DIR).toBe(prepared.env.OPENHANDS_WORK_DIR);
  });
});

describe("openhands adapter — auth env passthrough", () => {
  it("passes LLM_API_KEY and LLM_BASE_URL only when the parent set them", async () => {
    const withKeys = await createOpenhandsAdapter({
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://api.example.com",
    }).prepare(spec(), HUB);
    expect(withKeys.env.LLM_API_KEY).toBe("sk-test");
    expect(withKeys.env.LLM_BASE_URL).toBe("https://api.example.com");

    const without = await createOpenhandsAdapter({}).prepare(spec(), HUB);
    expect("LLM_API_KEY" in without.env).toBe(false);
    expect("LLM_BASE_URL" in without.env).toBe(false);
  });

  it("does not forward unrelated parent secrets", async () => {
    const plan = await createOpenhandsAdapter({
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant",
    }).prepare(spec(), HUB);
    expect("OPENAI_API_KEY" in plan.env).toBe(false);
    expect("ANTHROPIC_API_KEY" in plan.env).toBe(false);
  });
});

describe("openhands adapter — materialized mcp.json", () => {
  it("injects the hub URL, http transport, headers, and enabled flag", async () => {
    const plan = await createOpenhandsAdapter({}).prepare(spec(), HUB);
    const mcp = plan.files.find((f) => f.path === ".parley-openhands/persist/mcp.json");
    expect(mcp).toBeDefined();
    expect(JSON.parse(mcp!.contents)).toEqual({
      mcpServers: {
        parley: {
          url: "http://127.0.0.1:5555/mcp",
          transport: "http",
          headers: { "x-parley-task": "t1" },
          enabled: true,
        },
      },
    });
  });

  it("preserves multiple correlation headers", async () => {
    const hub: HubInfo = {
      url: "http://127.0.0.1:9/mcp",
      headers: { "x-parley-task": "t9", Authorization: "Bearer tok" },
    };
    const plan = await createOpenhandsAdapter({}).prepare(spec(), hub);
    const parsed = JSON.parse(
      plan.files.find((f) => f.path.endsWith("mcp.json"))!.contents,
    ) as {
      mcpServers: { parley: { headers: Record<string, string> } };
    };
    expect(parsed.mcpServers.parley.headers).toEqual({
      "x-parley-task": "t9",
      Authorization: "Bearer tok",
    });
  });
});

describe("openhands adapter — parseEvent (golden, CLI 1.16.0 shapes)", () => {
  const adapter = createOpenhandsAdapter({});

  it("MessageEvent → message with joined content text blocks", () => {
    const line =
      '{"id":"d9a2e92c-acb8-4952-b87f-7398728a320d","source":"user","llm_message":{"role":"user","content":[{"cache_prompt":false,"type":"text","text":"say hi"}]},"kind":"MessageEvent"}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "message", text: "say hi" }]);
  });

  it("ActionEvent terminal → command", () => {
    const line =
      '{"kind":"ActionEvent","tool_name":"terminal","action":{"kind":"TerminalAction","command":"ls -la"}}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "command", text: "ls -la" }]);
  });

  it("ActionEvent file_editor → file_change", () => {
    const line =
      '{"kind":"ActionEvent","tool_name":"file_editor","action":{"kind":"FileEditorAction","command":"str_replace","path":"src/a.ts"}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "file_change", text: "str_replace src/a.ts" },
    ]);
  });

  it("ActionEvent other tools → message with tool name", () => {
    const line = '{"kind":"ActionEvent","tool_name":"parley_submit_report","action":{}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "message", text: "tool:parley_submit_report" },
    ]);
  });

  it("ConversationErrorEvent → fatal error", () => {
    const line =
      '{"kind":"ConversationErrorEvent","code":"AuthenticationError","detail":"bad key"}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "error", text: "AuthenticationError: bad key", fatal: true },
    ]);
  });

  it("AgentErrorEvent → non-fatal diagnostic error", () => {
    const line = '{"kind":"AgentErrorEvent","tool_name":"terminal","error":"command failed"}';
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "error",
        text: "PARLEY-DIAG agent_error tool=terminal: command failed",
        fatal: false,
      },
    ]);
  });

  it("ConversationStateUpdateEvent with stats → session_meta usage (harness + canonical keys)", () => {
    const line = JSON.stringify({
      kind: "ConversationStateUpdateEvent",
      stats: {
        usage_to_metrics: {
          agent: {
            accumulated_cost: 0.012,
            accumulated_token_usage: {
              prompt_tokens: 100,
              completion_tokens: 40,
              cache_read_tokens: 10,
              cache_write_tokens: 0,
              reasoning_tokens: 5,
            },
          },
        },
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "session_meta",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          cache_read_tokens: 10,
          cache_write_tokens: 0,
          reasoning_tokens: 5,
          input_tokens: 100,
          output_tokens: 40,
          cached_tokens: 10,
          cost: 0.012,
        },
      },
    ]);
  });

  it("scrapes Conversation ID text into session_meta (normalizes undashed hex)", () => {
    expect(adapter.parseEvent("Conversation ID: 826e542142564e7bbf353d2a7d9ae7ff")).toEqual([
      {
        kind: "session_meta",
        session_id: "826e5421-4256-4e7b-bf35-3d2a7d9ae7ff",
      },
    ]);
  });

  it("scrapes dashed Conversation ID text as-is", () => {
    expect(
      adapter.parseEvent("Conversation ID: 826e5421-4256-4e7b-bf35-3d2a7d9ae7ff"),
    ).toEqual([
      {
        kind: "session_meta",
        session_id: "826e5421-4256-4e7b-bf35-3d2a7d9ae7ff",
      },
    ]);
  });

  it("ObservationEvent and unknown kinds pass through opaque ([])", () => {
    expect(adapter.parseEvent('{"kind":"ObservationEvent","tool_name":"terminal"}')).toEqual([]);
    expect(adapter.parseEvent('{"kind":"SystemPromptEvent"}')).toEqual([]);
    expect(adapter.parseEvent('{"kind":"TokenEvent"}')).toEqual([]);
    expect(adapter.parseEvent('{"kind":"TotallyNewKind","x":1}')).toEqual([]);
    expect(adapter.parseEvent('{"no":"kind"}')).toEqual([]);
  });

  it("non-JSON pollution and non-object lines pass through opaque ([])", () => {
    expect(adapter.parseEvent("Initializing agent...")).toEqual([]);
    expect(adapter.parseEvent("Agent is working")).toEqual([]);
    expect(adapter.parseEvent("Goodbye! 👋")).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("null")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
  });
});

describe("openhands adapter — golden JSONL fixtures (CLI 1.16.0)", () => {
  const adapter = createOpenhandsAdapter({});

  function replay(file: string) {
    const lines = fs
      .readFileSync(path.join(FIXTURES, file), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    return { events, sessionId: adapter.sessionId(events) };
  }

  it("auth-fail stream: user message, fatal auth error, scraped session id", () => {
    const { events, sessionId } = replay("cli-1.16.0-auth-fail.jsonl");
    expect(events.filter((e) => e.kind === "message")).toEqual([
      { kind: "message", text: "say hi" },
    ]);
    const fatals = events.filter((e) => e.kind === "error" && e.fatal === true);
    expect(fatals).toHaveLength(1);
    expect(fatals[0]!.text).toMatch(/AuthenticationError/);
    expect(sessionId).toBe("826e5421-4256-4e7b-bf35-3d2a7d9ae7ff");
  });

  it("action-shape stream: command, file_change, tool message, non-fatal error, usage", () => {
    const { events } = replay("cli-1.16.0-action-shapes.jsonl");
    expect(events.find((e) => e.kind === "command")).toEqual({
      kind: "command",
      text: "ls -la",
    });
    expect(events.find((e) => e.kind === "file_change")).toEqual({
      kind: "file_change",
      text: "str_replace src/a.ts",
    });
    expect(events.find((e) => e.kind === "message" && e.text?.startsWith("tool:"))).toEqual({
      kind: "message",
      text: "tool:parley_submit_report",
    });
    expect(events.find((e) => e.kind === "error" && e.fatal === false)?.text).toMatch(
      /PARLEY-DIAG/,
    );
    expect(events.find((e) => e.kind === "message" && e.text === "all done")).toEqual({
      kind: "message",
      text: "all done",
    });
    const usageMeta = events.find((e) => e.kind === "session_meta" && e.usage !== undefined);
    expect(usageMeta?.usage?.input_tokens).toBe(100);
    expect(usageMeta?.usage?.output_tokens).toBe(40);
    expect(usageMeta?.usage?.cached_tokens).toBe(10);
    expect(usageMeta?.usage?.prompt_tokens).toBe(100);
    expect(usageMeta?.usage?.cost).toBe(0.012);
  });
});

describe("openhands adapter — sessionId extraction", () => {
  const adapter = createOpenhandsAdapter({});

  it("returns the last session_meta session_id", () => {
    const events = [
      ...adapter.parseEvent("Conversation ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      ...adapter.parseEvent('{"kind":"MessageEvent","llm_message":{"content":[{"type":"text","text":"hi"}]}}'),
      ...adapter.parseEvent("Conversation ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ];
    expect(adapter.sessionId(events)).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  });

  it("returns undefined when no session id was seen", () => {
    const events = adapter.parseEvent('{"kind":"MessageEvent","llm_message":{"content":[]}}');
    expect(adapter.sessionId(events)).toBeUndefined();
  });
});

describe("openhands adapter — #107 MCP 300s ceiling vs long answerTimeoutMs", () => {
  it("exports the SDK 300s ceiling constant", () => {
    expect(OPENHANDS_MCP_TOOL_TIMEOUT_MS).toBe(300_000);
  });

  it("emits PARLEY-DIAG when prepare saw answerTimeoutMs > 300s (old code silent)", async () => {
    const adapter = createOpenhandsAdapter({});
    await adapter.prepare(spec({ answerTimeoutMs: 1_800_000 }), HUB);
    const events = adapter.parseEvent(
      '{"kind":"MessageEvent","llm_message":{"content":[{"type":"text","text":"hi"}]}}',
    );
    const diag = events.find((e) => e.kind === "error" && e.text?.includes("MCP_TOOL_TIMEOUT"));
    expect(diag).toBeDefined();
    expect(diag!.fatal).toBe(false);
    expect(diag!.text).toMatch(/^PARLEY-DIAG/);
    expect(diag!.text).toMatch(/300/);
    // Message still present after the diag.
    expect(events.some((e) => e.kind === "message" && e.text === "hi")).toBe(true);
    // One-shot: second line does not re-emit.
    const again = adapter.parseEvent(
      '{"kind":"MessageEvent","llm_message":{"content":[{"type":"text","text":"yo"}]}}',
    );
    expect(again.every((e) => !e.text?.includes("MCP_TOOL_TIMEOUT"))).toBe(true);
  });

  it("does not emit MCP timeout diag when answerTimeoutMs ≤ 300s", async () => {
    const adapter = createOpenhandsAdapter({});
    await adapter.prepare(spec({ answerTimeoutMs: 300_000 }), HUB);
    const events = adapter.parseEvent(
      '{"kind":"MessageEvent","llm_message":{"content":[{"type":"text","text":"hi"}]}}',
    );
    expect(events.every((e) => !e.text?.includes("MCP_TOOL_TIMEOUT"))).toBe(true);
  });
});

describe("openhands adapter — omits listModels", () => {
  it("does not expose listModels (no CLI enumeration — research §7)", () => {
    const adapter = createOpenhandsAdapter({});
    expect(adapter.listModels).toBeUndefined();
  });
});
