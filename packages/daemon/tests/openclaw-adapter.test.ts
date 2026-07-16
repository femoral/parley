import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenclawAdapter, parseOpenclawModels } from "../src/adapters/openclaw.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/openclaw/", import.meta.url));

const HUB: HubInfo = {
  url: "http://127.0.0.1:54321/mcp",
  headers: { "x-parley-task": "t7", "x-parley-token": "secret" },
};

/** A TaskSpec with the given posture; overrides merge over the defaults. */
function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t7",
    name: null,
    prompt: "do the thing",
    vendor: "openclaw",
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

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/** Default answer timeout 30m → tool/run timeout 1800 + 60 headroom = 1860s. */
const DEFAULT_TIMEOUT_SEC = "1860";

describe("openclaw adapter — prepare argv (golden)", () => {
  it("builds the pinned headless agent --local --json invocation", async () => {
    const adapter = createOpenclawAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "openclaw",
      "agent",
      "--local",
      "--agent",
      "parley",
      "--message",
      "do the thing",
      "--json",
      "--timeout",
      DEFAULT_TIMEOUT_SEC,
      "--session-key",
      "agent:parley:t7",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("passes the model through with --model when set, omits it otherwise", async () => {
    const adapter = createOpenclawAdapter({});
    const withModel = await adapter.prepare(spec({ model: "anthropic/claude-sonnet-4-6" }), HUB);
    expect(withModel.argv).toContain("--model");
    expect(withModel.argv).toContain("anthropic/claude-sonnet-4-6");
    // Model lands in the flags region (after --timeout, before session-key / extraArgs).
    const modelIdx = withModel.argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(withModel.argv.indexOf("--timeout"));
    expect((await adapter.prepare(spec({ model: null }), HUB)).argv).not.toContain("--model");
  });

  it("passes effort through as --thinking when set, omits it otherwise", async () => {
    const adapter = createOpenclawAdapter({});
    const withEffort = await adapter.prepare(spec({ effort: "high" }), HUB);
    expect(withEffort.argv).toContain("--thinking");
    expect(withEffort.argv).toContain("high");
    expect((await adapter.prepare(spec({ effort: null }), HUB)).argv).not.toContain("--thinking");
  });

  it("splices extraArgs into the flags region (never after a bare positional)", async () => {
    const adapter = createOpenclawAdapter({});
    const plan = await adapter.prepare(spec({ extraArgs: ["--verbose", "--trace"] }), HUB);
    expect(plan.argv).toContain("--verbose");
    expect(plan.argv).toContain("--trace");
    // Prompt is a --message value, not a trailing bare positional.
    const msgIdx = plan.argv.indexOf("--message");
    expect(plan.argv[msgIdx + 1]).toBe("do the thing");
    expect(plan.argv.indexOf("--verbose")).toBeGreaterThan(msgIdx + 1);
    // No bare prompt at the end that would swallow flags.
    expect(plan.argv[plan.argv.length - 1]).not.toBe("do the thing");
  });

  it("raises --timeout and MCP config timeout above the answer timeout", async () => {
    // 5-minute answer timeout → 300s + 60s headroom = 360s.
    const plan = await createOpenclawAdapter({}).prepare(spec({ answerTimeoutMs: 300_000 }), HUB);
    expect(plan.argv).toContain("--timeout");
    expect(plan.argv[plan.argv.indexOf("--timeout") + 1]).toBe("360");
    const config = plan.files.find((f) => f.path === ".openclaw-state/openclaw.json")!.contents;
    const parsed = JSON.parse(config) as {
      mcp: { servers: { parley: { timeout: number } } };
    };
    expect(parsed.mcp.servers.parley.timeout).toBe(360);
    expect(360).toBeGreaterThan(300);
  });

  it("honours PARLEY_OPENCLAW_BIN override", async () => {
    const adapter = createOpenclawAdapter({ PARLEY_OPENCLAW_BIN: "/opt/openclaw/openclaw" });
    expect((await adapter.prepare(spec(), HUB)).argv[0]).toBe("/opt/openclaw/openclaw");
  });
});

describe("openclaw adapter — resume argv (golden)", () => {
  it("resumes with --session-id when a UUID was persisted", async () => {
    const adapter = createOpenclawAdapter({});
    const plan = await adapter.resume(
      spec({ prompt: "the answer", sessionId: "3a944b05-b121-4269-8576-48b24306e10d" }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "openclaw",
      "agent",
      "--local",
      "--agent",
      "parley",
      "--message",
      "the answer",
      "--json",
      "--timeout",
      DEFAULT_TIMEOUT_SEC,
      "--session-id",
      "3a944b05-b121-4269-8576-48b24306e10d",
    ]);
  });

  it("falls back to --session-key when no session UUID is available", async () => {
    // OpenClaw can resume via stable session key alone (research §4) — unlike
    // grok, which must reject without -r.
    const adapter = createOpenclawAdapter({});
    const plan = await adapter.resume(spec({ prompt: "the answer" }), HUB);
    expect(plan.argv).toContain("--session-key");
    expect(plan.argv).toContain("agent:parley:t7");
    expect(plan.argv).not.toContain("--session-id");
  });

  it("re-materializes config + approvals on resume", async () => {
    const adapter = createOpenclawAdapter({});
    const plan = await adapter.resume(spec({ sessionId: "sess-abc" }), HUB);
    expect(plan.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        ".openclaw-state/openclaw.json",
        ".openclaw-state/exec-approvals.json",
      ]),
    );
  });

  it("carries model and thinking through resume identically to prepare", async () => {
    const adapter = createOpenclawAdapter({});
    const s = spec({
      prompt: "the answer",
      sessionId: "sess-1",
      model: "openai/gpt-5.5",
      effort: "low",
    });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    expect(resumed.argv).toContain("--model");
    expect(resumed.argv).toContain("openai/gpt-5.5");
    expect(resumed.argv).toContain("--thinking");
    expect(resumed.argv).toContain("low");
    // Same model/thinking placement relative to common flags.
    expect(prepared.argv.indexOf("--model")).toBeGreaterThan(0);
    expect(resumed.argv.indexOf("--thinking")).toBeGreaterThan(resumed.argv.indexOf("--model"));
  });
});

describe("openclaw adapter — sandbox × network matrix (materialized config)", () => {
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    expectMode: string;
    expectAccess?: string;
    expectDockerNetwork?: string;
  }[] = [
    { sandbox: "workspace", network: true, expectMode: "off" },
    {
      sandbox: "workspace",
      network: false,
      expectMode: "all",
      expectAccess: "rw",
      expectDockerNetwork: "none",
    },
    {
      sandbox: "read-only",
      network: true,
      expectMode: "all",
      expectAccess: "ro",
      expectDockerNetwork: "none",
    },
    {
      sandbox: "read-only",
      network: false,
      expectMode: "all",
      expectAccess: "ro",
      expectDockerNetwork: "none",
    },
    { sandbox: "full", network: true, expectMode: "off" },
    // full ignores network:false — full host access (research §5).
    { sandbox: "full", network: false, expectMode: "off" },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network} → sandbox.mode=${c.expectMode}`, async () => {
      const adapter = createOpenclawAdapter({});
      const plan = await adapter.prepare(spec({ sandbox: c.sandbox, network: c.network }), HUB);
      const config = JSON.parse(
        plan.files.find((f) => f.path === ".openclaw-state/openclaw.json")!.contents,
      ) as {
        agents: {
          defaults: {
            sandbox: {
              mode: string;
              workspaceAccess?: string;
              docker?: { network?: string };
            };
            workspace: string;
          };
        };
      };
      expect(config.agents.defaults.sandbox.mode).toBe(c.expectMode);
      expect(config.agents.defaults.workspace).toBe("/work/tree");
      if (c.expectAccess !== undefined) {
        expect(config.agents.defaults.sandbox.workspaceAccess).toBe(c.expectAccess);
      }
      if (c.expectDockerNetwork !== undefined) {
        expect(config.agents.defaults.sandbox.docker?.network).toBe(c.expectDockerNetwork);
      }
    });
  }

  it("resume carries the identical sandbox config as prepare", async () => {
    const adapter = createOpenclawAdapter({});
    const s = spec({ sandbox: "read-only", network: false, sessionId: "sess-1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    const prepConfig = prepared.files.find((f) => f.path === ".openclaw-state/openclaw.json")!
      .contents;
    const resConfig = resumed.files.find((f) => f.path === ".openclaw-state/openclaw.json")!
      .contents;
    expect(JSON.parse(resConfig).agents.defaults.sandbox).toEqual(
      JSON.parse(prepConfig).agents.defaults.sandbox,
    );
  });
});

describe("openclaw adapter — env isolation & auth passthrough", () => {
  it("points OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH at task-local state", async () => {
    const plan = await createOpenclawAdapter({}).prepare(spec(), HUB);
    expect(plan.env.OPENCLAW_STATE_DIR).toBe("/work/tree/.openclaw-state");
    expect(plan.env.OPENCLAW_CONFIG_PATH).toBe("/work/tree/.openclaw-state/openclaw.json");
  });

  it("passes named provider keys through only when the parent set them", async () => {
    const withKeys = await createOpenclawAdapter({
      OPENAI_API_KEY: "sk-test",
      ANTHROPIC_API_KEY: "ant-test",
      XAI_API_KEY: "xai-test",
      UNRELATED_SECRET: "nope",
    }).prepare(spec(), HUB);
    expect(withKeys.env.OPENAI_API_KEY).toBe("sk-test");
    expect(withKeys.env.ANTHROPIC_API_KEY).toBe("ant-test");
    expect(withKeys.env.XAI_API_KEY).toBe("xai-test");
    expect("UNRELATED_SECRET" in withKeys.env).toBe(false);

    const without = await createOpenclawAdapter({}).prepare(spec(), HUB);
    expect("OPENAI_API_KEY" in without.env).toBe(false);
    expect("ANTHROPIC_API_KEY" in without.env).toBe(false);
  });
});

describe("openclaw adapter — materialized openclaw.json + exec-approvals", () => {
  it("injects the MCP hub (url, transport, headers, raised timeout)", async () => {
    const plan = await createOpenclawAdapter({}).prepare(spec(), HUB);
    const config = JSON.parse(
      plan.files.find((f) => f.path === ".openclaw-state/openclaw.json")!.contents,
    ) as {
      agents: { list: { id: string; workspace: string }[] };
      tools: { exec: { security: string; ask: string } };
      mcp: {
        servers: {
          parley: {
            url: string;
            transport: string;
            timeout: number;
            headers: Record<string, string>;
          };
        };
      };
    };
    expect(config.mcp.servers.parley.url).toBe("http://127.0.0.1:54321/mcp");
    expect(config.mcp.servers.parley.transport).toBe("streamable-http");
    expect(config.mcp.servers.parley.timeout).toBe(1860);
    expect(config.mcp.servers.parley.headers).toEqual({
      "x-parley-task": "t7",
      "x-parley-token": "secret",
    });
    expect(config.agents.list[0]).toEqual({ id: "parley", workspace: "/work/tree" });
    expect(config.tools.exec.security).toBe("full");
    expect(config.tools.exec.ask).toBe("off");
  });

  it("materializes YOLO exec-approvals for headless runs", async () => {
    const plan = await createOpenclawAdapter({}).prepare(spec(), HUB);
    const approvals = JSON.parse(
      plan.files.find((f) => f.path === ".openclaw-state/exec-approvals.json")!.contents,
    ) as {
      version: number;
      defaults: { security: string; ask: string; askFallback: string };
    };
    expect(approvals.version).toBe(1);
    expect(approvals.defaults).toEqual({
      security: "full",
      ask: "off",
      askFallback: "full",
    });
  });

  it("escapes special characters in hub url/headers via JSON encoding", async () => {
    const hub: HubInfo = {
      url: 'http://127.0.0.1:1/mcp?q="x"\\y',
      headers: { "x-parley-task": "t1\nInjected" },
    };
    const plan = await createOpenclawAdapter({}).prepare(spec(), hub);
    const raw = plan.files.find((f) => f.path === ".openclaw-state/openclaw.json")!.contents;
    const parsed = JSON.parse(raw) as {
      mcp: { servers: { parley: { url: string; headers: Record<string, string> } } };
    };
    expect(parsed.mcp.servers.parley.url).toBe('http://127.0.0.1:1/mcp?q="x"\\y');
    expect(parsed.mcp.servers.parley.headers["x-parley-task"]).toBe("t1\nInjected");
    // Round-trip safe: no injected raw newlines breaking the document.
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("openclaw adapter — parseEvent (research §2/§8/§9 envelopes)", () => {
  const adapter = createOpenclawAdapter({});

  it("maps success envelope payloads + sessionId + usage (golden fixture)", () => {
    const events = adapter.parseEvent(readFixture("success-envelope.json"));
    expect(events).toEqual([
      { kind: "message", text: "Report ready" },
      {
        kind: "session_meta",
        session_id: "3a944b05-b121-4269-8576-48b24306e10d",
        usage: {
          input: 1200,
          output: 340,
          cacheRead: 0,
          cacheWrite: 0,
          total: 1540,
          input_tokens: 1200,
          output_tokens: 340,
          cached_tokens: 0,
        },
      },
    ]);
  });

  it("maps usage with cache fields and canonical token keys (golden fixture)", () => {
    const events = adapter.parseEvent(readFixture("success-usage.json"));
    const meta = events.find((e) => e.kind === "session_meta");
    expect(meta?.session_id).toBe("3a944b05-b121-4269-8576-48b24306e10d");
    expect(meta?.usage).toEqual({
      input: 15234,
      output: 892,
      cacheRead: 12000,
      cacheWrite: 200,
      total: 16326,
      input_tokens: 15234,
      output_tokens: 892,
      cached_tokens: 12000,
    });
    expect(events.find((e) => e.kind === "message")?.text).toBe("Done.");
  });

  it("maps compact single-line success JSON the same way", () => {
    const line = JSON.stringify({
      payloads: [{ text: "Hi" }],
      meta: { agentMeta: { sessionId: "sid-1", usage: { input: 1, output: 2 } } },
    });
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "message", text: "Hi" },
      {
        kind: "session_meta",
        session_id: "sid-1",
        usage: { input: 1, output: 2, input_tokens: 1, output_tokens: 2 },
      },
    ]);
  });

  it("maps payload.isError to non-fatal error", () => {
    const line = JSON.stringify({
      payloads: [{ text: "tool blew up", isError: true }],
      meta: { agentMeta: { sessionId: "sid-err" } },
    });
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "error", text: "tool blew up" },
      { kind: "session_meta", session_id: "sid-err" },
    ]);
  });

  it("maps ProviderAuthError diagnostic text to fatal error", () => {
    const stderr = readFixture("auth-fail-stderr.txt");
    const events = adapter.parseEvent(stderr);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("error");
    expect(events[0]?.fatal).toBe(true);
    expect(events[0]?.text).toMatch(/ProviderAuthError|FailoverError|missing-provider-auth/);
  });

  it("tags approval-gate style MCP cancellations with VENDOR_DIAG_PREFIX", () => {
    const line = "mcp tool parley/submit_report cancelled: approval required";
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "error",
        text: "PARLEY-DIAG openclaw approval/tool gate: mcp tool parley/submit_report cancelled: approval required",
      },
    ]);
  });

  it("never throws on unknown, partial, or malformed shapes", () => {
    expect(adapter.parseEvent('{"type":"totally_new_kind","x":1}')).toEqual([]);
    expect(adapter.parseEvent('{"no":"envelope"}')).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
    // Intermediate pretty-print lines (engine feeds line-by-line) → opaque.
    expect(adapter.parseEvent("  \"payloads\": [")).toEqual([]);
    expect(adapter.parseEvent("{")).toEqual([]);
  });
});

describe("openclaw adapter — sessionId extraction", () => {
  const adapter = createOpenclawAdapter({});

  it("returns the session id from the last session_meta", () => {
    const events = adapter.parseEvent(readFixture("success-envelope.json"));
    expect(adapter.sessionId(events)).toBe("3a944b05-b121-4269-8576-48b24306e10d");
  });

  it("returns undefined when no session id was seen", () => {
    expect(adapter.sessionId(adapter.parseEvent('{"payloads":[{"text":"hi"}]}'))).toBeUndefined();
    expect(adapter.sessionId([])).toBeUndefined();
  });
});

describe("openclaw adapter — parseOpenclawModels (research §7 fixture)", () => {
  it("parses models[].key as id and applies advisory thinking efforts", () => {
    const models = parseOpenclawModels(readFixture("models-list.json"), undefined);
    expect(models).toEqual([
      {
        id: "openai/gpt-5.5",
        efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"],
        default_effort: null,
      },
    ]);
  });

  it("carries efforts forward from the existing catalog entry", () => {
    const models = parseOpenclawModels(readFixture("models-list.json"), {
      fetched_at: null,
      source: "manual",
      models: [
        {
          id: "openai/gpt-5.5",
          efforts: ["low", "high"],
          default_effort: "high",
        },
      ],
    });
    expect(models[0]).toEqual({
      id: "openai/gpt-5.5",
      efforts: ["low", "high"],
      default_effort: "high",
    });
  });

  it("throws when the models array is missing or empty", () => {
    expect(() => parseOpenclawModels("{}", undefined)).toThrow(/missing 'models' array/);
    expect(() => parseOpenclawModels('{"models":[]}', undefined)).toThrow(/no model ids/);
  });
});
