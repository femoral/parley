import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPiAdapter, parsePiModels } from "../src/adapters/pi.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";

/**
 * Golden unit tests for the pi adapter — pure-function exception to the
 * suite's CLI-boundary rule (spec §10). Pins argv/env/files across the
 * sandbox-posture matrix and normalization of Pi's JSONL stream against
 * research docs/research/pi-cli-automation.md (verified 0.80.7).
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/pi/", import.meta.url));

const HUB: HubInfo = {
  url: "http://127.0.0.1:5555/mcp",
  headers: { "x-parley-task": "t1" },
};

/** Default 30-minute answer timeout → requestTimeoutMs 1_860_000. */
function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t1",
    name: null,
    prompt: "do the thing",
    vendor: "pi",
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

describe("pi adapter — prepare argv (golden)", () => {
  it("builds the pinned headless json-mode invocation", async () => {
    const adapter = createPiAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "pi",
      "--mode",
      "json",
      "-p",
      "do the thing",
      "--offline",
      "--session-dir",
      path.join("/work/wt", ".pi", "sessions"),
      "--approve",
    ]);
    expect(plan.cwd).toBe("/work/wt");
  });

  it("passes model via --model when set, omits it otherwise", async () => {
    const adapter = createPiAdapter({});
    const withModel = await adapter.prepare(spec({ model: "openai-codex/gpt-5.5" }), HUB);
    expect(withModel.argv).toContain("--model");
    expect(withModel.argv).toContain("openai-codex/gpt-5.5");
    expect((await adapter.prepare(spec({ model: null }), HUB)).argv).not.toContain("--model");
  });

  it("maps effort to --thinking when set, omits it otherwise", async () => {
    const adapter = createPiAdapter({});
    const withEffort = await adapter.prepare(spec({ effort: "high" }), HUB);
    expect(withEffort.argv).toEqual([
      "pi",
      "--mode",
      "json",
      "-p",
      "do the thing",
      "--offline",
      "--session-dir",
      path.join("/work/wt", ".pi", "sessions"),
      "--thinking",
      "high",
      "--approve",
    ]);
    expect((await adapter.prepare(spec({ effort: null }), HUB)).argv).not.toContain("--thinking");
  });

  it("carries model and thinking through resume identically to prepare", async () => {
    const adapter = createPiAdapter({});
    const plan = await adapter.resume(
      spec({
        prompt: "the answer",
        sessionId: "sess-1",
        model: "xai/grok-4.5",
        effort: "low",
      }),
      HUB,
    );
    expect(plan.argv).toContain("--model");
    expect(plan.argv).toContain("xai/grok-4.5");
    expect(plan.argv).toContain("--thinking");
    expect(plan.argv).toContain("low");
  });

  it("honours PARLEY_PI_BIN override", async () => {
    const adapter = createPiAdapter({ PARLEY_PI_BIN: "/opt/pi/pi" });
    expect((await adapter.prepare(spec(), HUB)).argv[0]).toBe("/opt/pi/pi");
  });

  it("loads PARLEY_PI_MCP_ADAPTER with --no-extensions -e for hermetic MCP", async () => {
    const adapter = createPiAdapter({ PARLEY_PI_MCP_ADAPTER: "/opt/pi-mcp-adapter/ext.js" });
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toContain("--no-extensions");
    const eIdx = plan.argv.indexOf("-e");
    expect(eIdx).toBeGreaterThan(-1);
    expect(plan.argv[eIdx + 1]).toBe("/opt/pi-mcp-adapter/ext.js");
  });
});

describe("pi adapter — sandbox × network matrix (soft tools)", () => {
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    tools: string | null;
  }[] = [
    { sandbox: "workspace", network: true, tools: null },
    { sandbox: "workspace", network: false, tools: null }, // network:false not expressible
    { sandbox: "read-only", network: true, tools: "read,grep,find,ls" },
    { sandbox: "read-only", network: false, tools: "read,grep,find,ls" },
    { sandbox: "full", network: true, tools: null },
    { sandbox: "full", network: false, tools: null },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network} → tools=${c.tools ?? "(default)"}`, async () => {
      const adapter = createPiAdapter({});
      const plan = await adapter.prepare(spec({ sandbox: c.sandbox, network: c.network }), HUB);
      if (c.tools === null) {
        expect(plan.argv).not.toContain("--tools");
      } else {
        const i = plan.argv.indexOf("--tools");
        expect(i).toBeGreaterThan(-1);
        expect(plan.argv[i + 1]).toBe(c.tools);
      }
      // Soft isolation only — no network flag ever emitted (research §5).
      expect(plan.argv.join(" ")).not.toMatch(/network/i);
    });
  }

  it("resume maps soft sandbox identically to prepare", async () => {
    const adapter = createPiAdapter({});
    const s = spec({ sandbox: "read-only", network: false, sessionId: "s1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    const toolsOf = (argv: string[]): string | undefined => {
      const i = argv.indexOf("--tools");
      return i >= 0 ? argv[i + 1] : undefined;
    };
    expect(toolsOf(resumed.argv)).toBe(toolsOf(prepared.argv));
  });
});

describe("pi adapter — resume argv (golden)", () => {
  it("resumes with --session and the answer prompt", async () => {
    const adapter = createPiAdapter({});
    const plan = await adapter.resume(
      spec({ prompt: "the answer", sessionId: "019f69fb-6b24-7326-8836-8218d35d2b78" }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "pi",
      "--mode",
      "json",
      "-p",
      "the answer",
      "--session",
      "019f69fb-6b24-7326-8836-8218d35d2b78",
      "--offline",
      "--session-dir",
      path.join("/work/wt", ".pi", "sessions"),
      "--approve",
    ]);
    expect(plan.cwd).toBe("/work/wt");
  });

  it("re-materializes .mcp.json on resume", async () => {
    const adapter = createPiAdapter({});
    const plan = await adapter.resume(spec({ sessionId: "sess-abc" }), HUB);
    expect(plan.files.map((f) => f.path)).toContain(".mcp.json");
  });

  it("rejects a resume without a session id (would silently start a fresh session)", async () => {
    const adapter = createPiAdapter({});
    await expect(adapter.resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });
});

describe("pi adapter — extraArgs splicing", () => {
  it("places extraArgs in the flags region (after -p prompt value)", async () => {
    const plan = await createPiAdapter({}).prepare(
      spec({ extraArgs: ["--foo", "bar"] }),
      HUB,
    );
    const pIdx = plan.argv.indexOf("-p");
    expect(plan.argv[pIdx + 1]).toBe("do the thing");
    expect(plan.argv).toContain("--foo");
    expect(plan.argv).toContain("bar");
    expect(plan.argv.indexOf("--foo")).toBeGreaterThan(pIdx + 1);
    // Never after a bare positional prompt at the end.
    expect(plan.argv[plan.argv.length - 1]).not.toBe("do the thing");
  });

  it("splices on resume too", async () => {
    const plan = await createPiAdapter({}).resume(
      spec({ extraArgs: ["--x"], sessionId: "sess-1", prompt: "answer" }),
      HUB,
    );
    expect(plan.argv).toContain("--x");
    const pIdx = plan.argv.indexOf("-p");
    expect(plan.argv[pIdx + 1]).toBe("answer");
    expect(plan.argv.indexOf("--x")).toBeGreaterThan(pIdx + 1);
  });
});

describe("pi adapter — env passthrough & isolation", () => {
  it("sets PI_OFFLINE and PI_SKIP_VERSION_CHECK for hermetic startup", async () => {
    const plan = await createPiAdapter({}).prepare(spec(), HUB);
    expect(plan.env.PI_OFFLINE).toBe("1");
    expect(plan.env.PI_SKIP_VERSION_CHECK).toBe("1");
  });

  it("passes named auth keys only when the parent set them", async () => {
    const withKeys = await createPiAdapter({
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
      XAI_API_KEY: "xai-secret",
      UNRELATED_KEY: "nope",
    }).prepare(spec(), HUB);
    expect(withKeys.env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(withKeys.env.OPENAI_API_KEY).toBe("sk-oai");
    expect(withKeys.env.XAI_API_KEY).toBe("xai-secret");
    expect("UNRELATED_KEY" in withKeys.env).toBe(false);

    const bare = await createPiAdapter({}).prepare(spec(), HUB);
    expect("ANTHROPIC_API_KEY" in bare.env).toBe(false);
    expect("XAI_API_KEY" in bare.env).toBe(false);
  });
});

describe("pi adapter — materialized .mcp.json (MCP injection)", () => {
  it("carries hub url, headers, raised requestTimeoutMs, and directTools", async () => {
    const adapter = createPiAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    const file = plan.files.find((f) => f.path === ".mcp.json");
    expect(file).toBeDefined();
    const json = JSON.parse(file!.contents) as {
      mcpServers: {
        parley: {
          url: string;
          headers: Record<string, string>;
          auth: boolean;
          lifecycle: string;
          requestTimeoutMs: number;
          directTools: string[];
        };
      };
      settings: { requestTimeoutMs: number; samplingAutoApprove: boolean };
    };
    expect(json.mcpServers.parley.url).toBe("http://127.0.0.1:5555/mcp");
    expect(json.mcpServers.parley.headers).toEqual({ "x-parley-task": "t1" });
    expect(json.mcpServers.parley.auth).toBe(false);
    expect(json.mcpServers.parley.lifecycle).toBe("eager");
    // 1_800_000 + 60_000 headroom
    expect(json.mcpServers.parley.requestTimeoutMs).toBe(1_860_000);
    expect(json.mcpServers.parley.directTools).toEqual([
      "ask_orchestrator",
      "submit_report",
    ]);
    expect(json.settings.requestTimeoutMs).toBe(1_860_000);
    expect(json.settings.samplingAutoApprove).toBe(true);
  });

  it("raises requestTimeoutMs strictly above the task answer timeout", async () => {
    const plan = await createPiAdapter({}).prepare(spec({ answerTimeoutMs: 300_000 }), HUB);
    const json = JSON.parse(plan.files.find((f) => f.path === ".mcp.json")!.contents) as {
      mcpServers: { parley: { requestTimeoutMs: number } };
    };
    expect(json.mcpServers.parley.requestTimeoutMs).toBe(360_000);
    expect(360_000).toBeGreaterThan(300_000);
  });
});

describe("pi adapter — parseEvent (tolerant + research §9 table)", () => {
  const adapter = createPiAdapter({});

  it("session → session_meta carrying id", () => {
    expect(
      adapter.parseEvent(
        '{"type":"session","version":3,"id":"019f69fb-6b24-7326-8836-8218d35d2b78","timestamp":"2026-07-16T08:11:52.484Z","cwd":"/tmp/pi-scratch"}',
      ),
    ).toEqual([{ kind: "session_meta", session_id: "019f69fb-6b24-7326-8836-8218d35d2b78" }]);
  });

  it("assistant message_end → message + session_meta usage (canonical keys)", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "PONG" }],
        usage: {
          input: 424,
          output: 6,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: 430,
          cost: { total: 0.0023 },
        },
        stopReason: "stop",
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "message", text: "PONG" },
      {
        kind: "session_meta",
        usage: {
          input: 424,
          output: 6,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: 430,
          cost: 0.0023,
          input_tokens: 424,
          output_tokens: 6,
          cached_tokens: 0,
        },
      },
    ]);
  });

  it("message_end stopReason=error → fatal error", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "error",
        text: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        fatal: true,
      },
    ]);
  });

  it("tool_execution_start bash → command; write/edit → file_change", () => {
    expect(
      adapter.parseEvent(
        '{"type":"tool_execution_start","toolCallId":"call_…","toolName":"bash","args":{"command":"echo HELLO_PARLEY"}}',
      ),
    ).toEqual([{ kind: "command", text: "echo HELLO_PARLEY" }]);
    expect(
      adapter.parseEvent(
        '{"type":"tool_execution_start","toolCallId":"c2","toolName":"write","args":{"path":"src/a.ts"}}',
      ),
    ).toEqual([{ kind: "file_change", text: "src/a.ts" }]);
    expect(
      adapter.parseEvent(
        '{"type":"tool_execution_start","toolCallId":"c3","toolName":"edit","args":{"path":"src/b.ts"}}',
      ),
    ).toEqual([{ kind: "file_change", text: "src/b.ts" }]);
  });

  it("tool_execution_end isError for hub tools → tagged non-fatal PARLEY-DIAG", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "c",
      toolName: "submit_report",
      isError: true,
      result: { content: [{ type: "text", text: "cancelled" }] },
    });
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "error",
        text: "PARLEY-DIAG tool=submit_report failed: cancelled",
      },
    ]);
  });

  it("tool_execution_end isError for ordinary tools → non-fatal error", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text: "exit 1" }] },
    });
    expect(adapter.parseEvent(line)).toEqual([{ kind: "error", text: "exit 1" }]);
  });

  it("never throws on unknown, changed, or malformed shapes", () => {
    expect(adapter.parseEvent('{"type":"totally_new_kind","x":1}')).toEqual([]);
    expect(adapter.parseEvent('{"type":"agent_start"}')).toEqual([]);
    expect(adapter.parseEvent('{"type":"agent_settled"}')).toEqual([]);
    expect(adapter.parseEvent('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"x"}}')).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
    expect(adapter.parseEvent("null")).toEqual([]);
  });
});

describe("pi adapter — golden JSONL fixtures (pins observed 0.80.7)", () => {
  function replay(file: string) {
    const adapter = createPiAdapter({});
    const lines = fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    const messages = events
      .filter((e) => e.kind === "message")
      .map((e) => e.text ?? "")
      .join("");
    const usageEvents = events.filter((e) => e.kind === "session_meta" && e.usage);
    const commands = events.filter((e) => e.kind === "command").map((e) => e.text);
    const files = events.filter((e) => e.kind === "file_change").map((e) => e.text);
    const errors = events.filter((e) => e.kind === "error");
    return {
      messages,
      sessionId: adapter.sessionId(events),
      usageEvents,
      commands,
      files,
      errors,
    };
  }

  it("reconstructs assistant message, session id, and usage from a fresh PONG run", () => {
    const { messages, sessionId, usageEvents } = replay("v0.80.7-fresh.jsonl");
    expect(messages).toBe("PONG");
    expect(sessionId).toBe("019f69fb-6b24-7326-8836-8218d35d2b78");
    expect(usageEvents[0]?.usage).toMatchObject({
      input: 424,
      output: 6,
      input_tokens: 424,
      output_tokens: 6,
      cached_tokens: 0,
      totalTokens: 430,
    });
  });

  it("extracts bash commands and file writes from a tool run", () => {
    const { sessionId, commands, files, messages } = replay("v0.80.7-tools.jsonl");
    expect(sessionId).toBe("019f69fc-tool-session-demo-0001");
    expect(commands).toEqual(["echo HELLO_PARLEY"]);
    expect(files).toEqual(["src/hello.ts"]);
    expect(messages).toBe("done");
  });

  it("marks auth stopReason=error as fatal and still captures session id", () => {
    const { sessionId, errors } = replay("v0.80.7-error.jsonl");
    expect(sessionId).toBe("019f69fd-error-session-demo-0001");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fatal).toBe(true);
    expect(errors[0]?.text).toMatch(/invalid x-api-key/);
  });
});

describe("pi adapter — sessionId extraction", () => {
  const adapter = createPiAdapter({});

  it("returns the id from the session header event", () => {
    const events = [
      ...adapter.parseEvent(
        '{"type":"session","version":3,"id":"sess-42","timestamp":"2026-07-16T00:00:00.000Z","cwd":"/tmp"}',
      ),
      ...adapter.parseEvent(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"stopReason":"stop"}}',
      ),
    ];
    expect(adapter.sessionId(events)).toBe("sess-42");
  });

  it("returns undefined when no session id was seen", () => {
    const events = adapter.parseEvent('{"type":"agent_start"}');
    expect(adapter.sessionId(events)).toBeUndefined();
  });
});

describe("pi --list-models parser (golden fixture)", () => {
  const text = fs.readFileSync(path.join(FIXTURES, "list-models.txt"), "utf8");

  it("parses provider/model rows with fixed thinking efforts", () => {
    const models = parsePiModels(text);
    expect(models.map((m) => m.id)).toEqual([
      "openai-codex/gpt-5.3-codex-spark",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.5",
      "xai-oauth/grok-4.5",
    ]);
    expect(models[0]?.efforts).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(models[0]?.default_effort).toBeNull();
  });

  it("throws when no rows parse (refresh keeps existing entry)", () => {
    expect(() => parsePiModels("No models here.\n")).toThrow(/no model rows/);
  });
});
