import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKiloAdapter, parseKiloModels } from "../src/adapters/kilo.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";

/**
 * Golden unit tests for the kilo adapter — pure-function exception to the
 * suite's CLI-boundary rule (spec §10). Pins argv/env across the sandbox
 * posture matrix and normalization of Kilo's JSONL stream (research surface
 * pinned to `@kilocode/cli@7.4.9`, docs/research/kilo-cli-automation.md).
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/kilo/", import.meta.url));

const HUB: HubInfo = {
  url: "http://127.0.0.1:54321/mcp",
  headers: { "x-parley-task": "t7", "X-Extra": "1" },
};

/** A TaskSpec with the given posture; overrides merge over the defaults. */
function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t7",
    name: null,
    prompt: "do the thing",
    vendor: "kilo",
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

/** Parse the injected KILO_CONFIG_CONTENT from a spawn plan. */
function configOf(plan: { env: Record<string, string> }): Record<string, unknown> {
  const raw = plan.env.KILO_CONFIG_CONTENT;
  expect(raw).toBeDefined();
  return JSON.parse(raw!) as Record<string, unknown>;
}

describe("kilo adapter — prepare argv (golden)", () => {
  it("builds the pinned headless json + auto-approve invocation", async () => {
    const adapter = createKiloAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "kilo",
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      "/work/tree",
      "do the thing",
    ]);
    expect(plan.cwd).toBe("/work/tree");
    expect(plan.files).toEqual([]);
  });

  it("passes the model through with -m when set, omits it otherwise", async () => {
    const adapter = createKiloAdapter({});
    const withModel = await adapter.prepare(
      spec({ model: "kilo/anthropic/claude-sonnet-4.6" }),
      HUB,
    );
    expect(withModel.argv).toEqual([
      "kilo",
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      "/work/tree",
      "-m",
      "kilo/anthropic/claude-sonnet-4.6",
      "do the thing",
    ]);
    expect((await adapter.prepare(spec({ model: null }), HUB)).argv).not.toContain("-m");
  });

  it("passes effort through with --variant when set, omits it otherwise", async () => {
    const adapter = createKiloAdapter({});
    const withEffort = await adapter.prepare(spec({ effort: "high" }), HUB);
    expect(withEffort.argv).toEqual([
      "kilo",
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      "/work/tree",
      "--variant",
      "high",
      "do the thing",
    ]);
    expect((await adapter.prepare(spec({ effort: null }), HUB)).argv).not.toContain("--variant");
  });

  it("splices extraArgs into the flags region before the positional prompt", async () => {
    const plan = await createKiloAdapter({}).prepare(
      spec({ extraArgs: ["--foo", "bar"], model: "m1" }),
      HUB,
    );
    expect(plan.argv[plan.argv.length - 1]).toBe("do the thing");
    const promptIdx = plan.argv.length - 1;
    expect(plan.argv.slice(promptIdx - 2, promptIdx)).toEqual(["--foo", "bar"]);
    // Model flag still before extraArgs / prompt.
    expect(plan.argv.indexOf("-m")).toBeLessThan(plan.argv.indexOf("--foo"));
    expect(plan.argv.slice(0, 2)).toEqual(["kilo", "run"]);
  });

  it("honours PARLEY_KILO_BIN override", async () => {
    const adapter = createKiloAdapter({ PARLEY_KILO_BIN: "/opt/kilo/kilo" });
    expect((await adapter.prepare(spec(), HUB)).argv[0]).toBe("/opt/kilo/kilo");
  });
});

describe("kilo adapter — resume argv (golden)", () => {
  it("resumes the persisted session with -s and the answer prompt", async () => {
    const adapter = createKiloAdapter({});
    const plan = await adapter.resume(
      spec({ prompt: "the answer", sessionId: "ses_abc123" }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "kilo",
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      "/work/tree",
      "-s",
      "ses_abc123",
      "the answer",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("carries model/effort/extraArgs through resume before the prompt", async () => {
    const adapter = createKiloAdapter({});
    const plan = await adapter.resume(
      spec({
        prompt: "the answer",
        sessionId: "ses_1",
        model: "kilo/x",
        effort: "max",
        extraArgs: ["--trace"],
      }),
      HUB,
    );
    expect(plan.argv).toContain("-m");
    expect(plan.argv).toContain("kilo/x");
    expect(plan.argv).toContain("--variant");
    expect(plan.argv).toContain("max");
    expect(plan.argv).toContain("--trace");
    expect(plan.argv[plan.argv.length - 1]).toBe("the answer");
    expect(plan.argv.indexOf("--trace")).toBeLessThan(plan.argv.length - 1);
    expect(plan.argv.indexOf("-s")).toBeLessThan(plan.argv.length - 1);
  });

  it("re-injects KILO_CONFIG_CONTENT on resume", async () => {
    const adapter = createKiloAdapter({});
    const plan = await adapter.resume(spec({ sessionId: "ses_abc" }), HUB);
    expect(plan.env.KILO_CONFIG_CONTENT).toBeDefined();
    const cfg = configOf(plan);
    expect(cfg.mcp).toBeDefined();
  });

  it("rejects a resume without a session id (would silently start a fresh session)", async () => {
    const adapter = createKiloAdapter({});
    await expect(adapter.resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });
});

describe("kilo adapter — sandbox × network → config (golden)", () => {
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    permission: string | Record<string, string>;
    sandboxCfg: { enabled: boolean; network?: "allow" | "deny" };
  }[] = [
    {
      sandbox: "workspace",
      network: true,
      permission: "allow",
      // Sandbox off so git commit + hub MCP work (research §5).
      sandboxCfg: { enabled: false },
    },
    {
      sandbox: "workspace",
      network: false,
      permission: "allow",
      // network-deny isolates; breaks remote MCP (documented gap).
      sandboxCfg: { enabled: true, network: "deny" },
    },
    {
      sandbox: "read-only",
      network: true,
      permission: {
        "*": "deny",
        read: "allow",
        grep: "allow",
        glob: "allow",
        "parley_*": "allow",
      },
      sandboxCfg: { enabled: true, network: "allow" },
    },
    {
      sandbox: "read-only",
      network: false,
      permission: {
        "*": "deny",
        read: "allow",
        grep: "allow",
        glob: "allow",
        "parley_*": "allow",
      },
      sandboxCfg: { enabled: true, network: "deny" },
    },
    {
      sandbox: "full",
      network: true,
      permission: "allow",
      sandboxCfg: { enabled: false },
    },
    // full ignores network:false — danger-full-access is inherently network-on.
    {
      sandbox: "full",
      network: false,
      permission: "allow",
      sandboxCfg: { enabled: false },
    },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network}`, async () => {
      const adapter = createKiloAdapter({});
      const plan = await adapter.prepare(spec({ sandbox: c.sandbox, network: c.network }), HUB);
      const cfg = configOf(plan);
      expect(cfg.permission).toEqual(c.permission);
      expect(cfg.sandbox).toEqual(c.sandboxCfg);
      // Isolation pins always present.
      expect(plan.env.KILO_DISABLE_AUTOUPDATE).toBe("1");
      expect(plan.env.KILO_DISABLE_CLAUDE_CODE).toBe("1");
      expect(plan.env.KILO_DISABLE_PROJECT_CONFIG).toBe("1");
    });
  }

  it("resume carries the identical posture config as prepare", async () => {
    const adapter = createKiloAdapter({});
    const s = spec({ sandbox: "read-only", network: false, sessionId: "ses_1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    expect(resumed.env.KILO_CONFIG_CONTENT).toBe(prepared.env.KILO_CONFIG_CONTENT);
  });
});

describe("kilo adapter — MCP injection & timeout", () => {
  it("injects the hub URL, headers, oauth:false, and enabled via KILO_CONFIG_CONTENT", async () => {
    const plan = await createKiloAdapter({}).prepare(spec(), HUB);
    const cfg = configOf(plan);
    const mcp = (cfg.mcp as Record<string, unknown>).parley as Record<string, unknown>;
    expect(mcp).toEqual({
      type: "remote",
      url: "http://127.0.0.1:54321/mcp",
      headers: { "x-parley-task": "t7", "X-Extra": "1" },
      oauth: false,
      enabled: true,
      timeout: 1_800_000 + 60_000,
    });
  });

  it("raises mcp timeout and experimental.mcp_timeout above answerTimeoutMs", async () => {
    // 5-minute answer timeout → 300_000 + 60_000 headroom.
    const plan = await createKiloAdapter({}).prepare(spec({ answerTimeoutMs: 300_000 }), HUB);
    const cfg = configOf(plan);
    const timeout = 360_000;
    expect(timeout).toBeGreaterThan(300_000);
    const mcp = (cfg.mcp as Record<string, unknown>).parley as Record<string, unknown>;
    expect(mcp.timeout).toBe(timeout);
    expect((cfg.experimental as Record<string, unknown>).mcp_timeout).toBe(timeout);
  });
});

describe("kilo adapter — env passthrough", () => {
  it("passes KILO_API_KEY through only when the parent set it", async () => {
    expect(
      (await createKiloAdapter({ KILO_API_KEY: "kilo-secret" }).prepare(spec(), HUB)).env
        .KILO_API_KEY,
    ).toBe("kilo-secret");
    expect("KILO_API_KEY" in (await createKiloAdapter({}).prepare(spec(), HUB)).env).toBe(false);
  });

  it("passes KILO_ORG_ID through only when the parent set it", async () => {
    expect(
      (await createKiloAdapter({ KILO_ORG_ID: "org-1" }).prepare(spec(), HUB)).env.KILO_ORG_ID,
    ).toBe("org-1");
    expect("KILO_ORG_ID" in (await createKiloAdapter({}).prepare(spec(), HUB)).env).toBe(false);
  });

  it("forwards BYOK provider keys when set (#107; old code only passed KILO_API_KEY)", async () => {
    const plan = await createKiloAdapter({
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
      UNRELATED_SECRET: "nope",
    }).prepare(spec(), HUB);
    expect(plan.env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(plan.env.OPENAI_API_KEY).toBe("sk-oai");
    expect("UNRELATED_SECRET" in plan.env).toBe(false);
  });
});

describe("kilo adapter — parseEvent (tolerant)", () => {
  const adapter = createKiloAdapter({});

  it("maps text chunks to messages", () => {
    expect(
      adapter.parseEvent(
        '{"type":"text","timestamp":1,"sessionID":"ses_x","part":{"type":"text","text":"Hi"}}',
      ),
    ).toEqual([{ kind: "message", text: "Hi", session_id: "ses_x" }]);
  });

  it("maps step_start to session_meta with session_id", () => {
    expect(
      adapter.parseEvent(
        '{"type":"step_start","timestamp":1,"sessionID":"ses_start","part":{"type":"step-start"}}',
      ),
    ).toEqual([{ kind: "session_meta", session_id: "ses_start" }]);
  });

  it("maps bash tool_use to command", () => {
    const line = JSON.stringify({
      type: "tool_use",
      timestamp: 1,
      sessionID: "ses_t",
      part: {
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { command: "echo hello" }, output: "hello\n" },
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "command", text: "echo hello", session_id: "ses_t" },
    ]);
  });

  it("maps write/edit tool_use to file_change", () => {
    const line = JSON.stringify({
      type: "tool_use",
      timestamp: 1,
      sessionID: "ses_t",
      part: {
        type: "tool",
        tool: "edit",
        state: { status: "completed", input: { path: "src/a.ts" } },
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "file_change", text: "src/a.ts", session_id: "ses_t" },
    ]);
  });

  it("maps step_finish to session_meta usage (harness + canonical keys)", () => {
    const line = JSON.stringify({
      type: "step_finish",
      timestamp: 1767036064273,
      sessionID: "ses_494719016ffe85dkDMj0FPRbHK",
      part: {
        type: "step-finish",
        reason: "stop",
        cost: 0.001,
        tokens: { input: 671, output: 8, reasoning: 0, cache: { read: 21415, write: 0 } },
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "session_meta",
        session_id: "ses_494719016ffe85dkDMj0FPRbHK",
        usage: {
          input: 671,
          input_tokens: 671,
          output: 8,
          output_tokens: 8,
          reasoning: 0,
          cache_read: 21415,
          cached_tokens: 21415,
          cache_write: 0,
          cost: 0.001,
        },
      },
    ]);
  });

  it("maps top-level error to fatal error + session_meta (exit codes untrustworthy)", () => {
    const line =
      '{"type":"error","timestamp":1784189544500,"sessionID":"ses_0960423adffeuBdTh4fmHZMFzY",' +
      '"error":{"name":"APIError","data":{"message":"Unauthorized: boom","statusCode":401,"isRetryable":false}}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "session_meta", session_id: "ses_0960423adffeuBdTh4fmHZMFzY" },
      {
        kind: "error",
        text: "Unauthorized: boom",
        fatal: true,
        session_id: "ses_0960423adffeuBdTh4fmHZMFzY",
      },
    ]);
  });

  it("tags failed parley_* tool_use as non-fatal PARLEY-DIAG", () => {
    const line = JSON.stringify({
      type: "tool_use",
      timestamp: 1,
      sessionID: "ses_t",
      part: {
        type: "tool",
        tool: "parley_submit_report",
        state: {
          status: "error",
          error: { message: "permission denied" },
        },
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "error",
        text: "PARLEY-DIAG tool_use tool=parley_submit_report failed: permission denied",
        session_id: "ses_t",
      },
    ]);
  });

  it("never throws on unknown, changed, or malformed shapes", () => {
    expect(adapter.parseEvent('{"type":"totally_new_kind","x":1}')).toEqual([]);
    expect(adapter.parseEvent('{"no":"type"}')).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
    expect(adapter.parseEvent("null")).toEqual([]);
    // Other tools stay opaque.
    expect(
      adapter.parseEvent(
        JSON.stringify({
          type: "tool_use",
          sessionID: "s",
          part: { type: "tool", tool: "read", state: { status: "completed", input: {} } },
        }),
      ),
    ).toEqual([]);
  });
});

describe("kilo adapter — golden JSONL fixtures (pins research §2/§8 shapes)", () => {
  function replay(file: string) {
    const adapter = createKiloAdapter({});
    const lines = fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    return { events, sessionId: adapter.sessionId(events) };
  }

  it("reconstructs message, command, usage, and session id from binary-confirmed success shapes (#107; old UNKNOWN live path)", () => {
    // Fixture mirrors 7.4.9 binary emission (nA("step_start"|"tool_use"|"text"|"step_finish")).
    // Live-auth capture still unavailable; binary verify replaces pure OpenCode guesswork.
    const { events, sessionId } = replay("v7.4.9-success.jsonl");
    expect(sessionId).toBe("ses_494719016ffe85dkDMj0FPRbHK");
    expect(events.filter((e) => e.kind === "message").map((e) => e.text)).toEqual(["hello"]);
    expect(events.filter((e) => e.kind === "command").map((e) => e.text)).toEqual(["echo hello"]);
    const usageMeta = events.filter((e) => e.kind === "session_meta" && e.usage !== undefined);
    expect(usageMeta).toHaveLength(1);
    expect(usageMeta[0]!.usage).toMatchObject({
      input: 671,
      input_tokens: 671,
      output: 8,
      output_tokens: 8,
      cached_tokens: 21415,
      cache_read: 21415,
      cost: 0.001,
    });
  });

  it("maps tool_call alias the same as tool_use (binary also inventories tool_call)", () => {
    const adapter = createKiloAdapter({});
    const line = JSON.stringify({
      type: "tool_call",
      timestamp: 1,
      sessionID: "ses_t",
      part: {
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { command: "pwd" } },
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "command", text: "pwd", session_id: "ses_t" },
    ]);
  });

  it("extracts session id and fatal error from the verified auth-failure line", () => {
    const { events, sessionId } = replay("v7.4.9-auth-error.jsonl");
    expect(sessionId).toBe("ses_0960423adffeuBdTh4fmHZMFzY");
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fatal).toBe(true);
    expect(errors[0]!.text).toMatch(/PAID_MODEL_AUTH_REQUIRED|Unauthorized/);
  });
});

describe("kilo sessionId — extraction from parsed events", () => {
  const adapter = createKiloAdapter({});

  it("returns the last session_meta session_id", () => {
    const events = [
      ...adapter.parseEvent(
        '{"type":"step_start","timestamp":1,"sessionID":"ses_first","part":{"type":"step-start"}}',
      ),
      ...adapter.parseEvent(
        '{"type":"step_start","timestamp":2,"sessionID":"ses_second","part":{"type":"step-start"}}',
      ),
      ...adapter.parseEvent(
        '{"type":"text","timestamp":3,"sessionID":"ses_second","part":{"type":"text","text":"hi"}}',
      ),
    ];
    expect(adapter.sessionId(events)).toBe("ses_second");
  });

  it("returns undefined when no session id was seen", () => {
    const events = adapter.parseEvent('{"type":"unknown"}');
    expect(adapter.sessionId(events)).toBeUndefined();
  });
});

describe("kilo parseKiloModels", () => {
  it("parses plain one-id-per-line output", () => {
    const text = [
      "kilo/~anthropic/claude-fable-latest",
      "kilo/anthropic/claude-sonnet-4.6",
      "",
      "kilo/anthropic/claude-opus-4.8",
    ].join("\n");
    expect(parseKiloModels(text)).toEqual([
      { id: "kilo/~anthropic/claude-fable-latest", efforts: [], default_effort: null },
      { id: "kilo/anthropic/claude-sonnet-4.6", efforts: [], default_effort: null },
      { id: "kilo/anthropic/claude-opus-4.8", efforts: [], default_effort: null },
    ]);
  });

  it("throws when no ids parse", () => {
    expect(() => parseKiloModels("\n\n")).toThrow(/no model ids/);
  });
});
