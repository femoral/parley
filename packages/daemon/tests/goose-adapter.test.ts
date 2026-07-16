/**
 * Golden unit tests for the goose adapter — pure-function exception to the
 * suite's CLI-boundary rule (spec §10). Pins argv/env/files across the
 * sandbox-posture matrix and parseEvent normalization of goose stream-json.
 *
 * Surface pinned to goose CLI **v1.43.0**
 * (`docs/research/goose-cli-automation.md`).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGooseAdapter } from "../src/adapters/goose.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/goose/", import.meta.url));

const HUB: HubInfo = {
  url: "http://127.0.0.1:54321/mcp",
  headers: { "x-parley-task": "t7" },
};

/** Default env for prepare/resume: provider required after #107 (#107). */
const PROVIDER_ENV = { GOOSE_PROVIDER: "openai" };

/** A TaskSpec with the given posture; overrides merge over the defaults. */
function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t7",
    name: null,
    prompt: "do the thing",
    vendor: "goose",
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

/** Adapter with provider env so prepare/resume succeed under the #107 gate. */
function goose(env: NodeJS.ProcessEnv = {}): ReturnType<typeof createGooseAdapter> {
  return createGooseAdapter({ ...PROVIDER_ENV, ...env });
}

const AUTH_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
] as const;

describe("goose adapter — prepare argv (golden)", () => {
  it("builds the hermetic headless stream-json invocation", async () => {
    const adapter = goose();
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "goose",
      "run",
      "--output-format",
      "stream-json",
      "-n",
      "parley-t7",
      "-t",
      "do the thing",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("passes the model through with --model when set, omits it otherwise", async () => {
    const adapter = goose();
    const withModel = await adapter.prepare(spec({ model: "gpt-4o" }), HUB);
    expect(withModel.argv).toContain("--model");
    expect(withModel.argv).toContain("gpt-4o");
    // Model sits in the flags region before -n / -t.
    const modelIdx = withModel.argv.indexOf("--model");
    expect(modelIdx).toBeLessThan(withModel.argv.indexOf("-n"));
    expect(modelIdx).toBeLessThan(withModel.argv.indexOf("-t"));

    const without = await adapter.prepare(spec({ model: null }), HUB);
    expect(without.argv).not.toContain("--model");
  });

  it("splices extraArgs into the flags region before -t (never after the prompt)", async () => {
    const plan = await goose().prepare(
      spec({ extraArgs: ["--provider", "openai", "--max-turns", "5"] }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "goose",
      "run",
      "--output-format",
      "stream-json",
      "--provider",
      "openai",
      "--max-turns",
      "5",
      "-n",
      "parley-t7",
      "-t",
      "do the thing",
    ]);
    const tIdx = plan.argv.indexOf("-t");
    expect(plan.argv[tIdx + 1]).toBe("do the thing");
    expect(plan.argv.indexOf("--provider")).toBeLessThan(tIdx);
  });

  it("honours PARLEY_GOOSE_BIN override", async () => {
    const adapter = goose({ PARLEY_GOOSE_BIN: "/opt/goose/goose" });
    expect((await adapter.prepare(spec(), HUB)).argv[0]).toBe("/opt/goose/goose");
  });

  it("does not pass --no-session or -q (resume + banner session-id capture)", async () => {
    const plan = await goose().prepare(spec(), HUB);
    expect(plan.argv).not.toContain("--no-session");
    expect(plan.argv).not.toContain("-q");
    expect(plan.argv).not.toContain("--quiet");
  });
});

describe("goose adapter — resume argv (golden)", () => {
  it("resumes by --session-id when captured", async () => {
    const adapter = goose();
    const plan = await adapter.resume(
      spec({ prompt: "the answer", sessionId: "20260716_9" }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "goose",
      "run",
      "--output-format",
      "stream-json",
      "--resume",
      "--session-id",
      "20260716_9",
      "-t",
      "the answer",
    ]);
  });

  it("falls back to name-based --resume -n when session id is missing", async () => {
    // Goose can resume by stable name (§4.2); we always assigned -n on prepare.
    const plan = await goose().resume(spec({ prompt: "follow up" }), HUB);
    expect(plan.argv).toEqual([
      "goose",
      "run",
      "--output-format",
      "stream-json",
      "--resume",
      "-n",
      "parley-t7",
      "-t",
      "follow up",
    ]);
  });

  it("re-materializes the MCP config on resume", async () => {
    const plan = await goose().resume(
      spec({ sessionId: "20260716_9" }),
      HUB,
    );
    expect(plan.files.map((f) => f.path)).toContain(".parley-goose/config/config.yaml");
  });

  it("carries model and extraArgs on resume in the flags region before -t", async () => {
    const plan = await goose().resume(
      spec({
        prompt: "answer",
        sessionId: "20260716_1",
        model: "claude-sonnet-4-5-20250929",
        extraArgs: ["--provider", "anthropic"],
      }),
      HUB,
    );
    const tIdx = plan.argv.indexOf("-t");
    expect(plan.argv[tIdx + 1]).toBe("answer");
    expect(plan.argv.indexOf("--model")).toBeLessThan(tIdx);
    expect(plan.argv.indexOf("--provider")).toBeLessThan(tIdx);
    expect(plan.argv).toContain("claude-sonnet-4-5-20250929");
  });
});

describe("goose adapter — sandbox × network posture (golden env)", () => {
  /**
   * Goose has no OS sandbox (§5). Mapping is policy-only via GOOSE_MODE:
   * read-only → chat; workspace/full → auto. network:false has no native lever.
   */
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    expectMode: string;
  }[] = [
    { sandbox: "workspace", network: true, expectMode: "auto" },
    { sandbox: "workspace", network: false, expectMode: "auto" },
    { sandbox: "read-only", network: true, expectMode: "chat" },
    { sandbox: "read-only", network: false, expectMode: "chat" },
    { sandbox: "full", network: true, expectMode: "auto" },
    { sandbox: "full", network: false, expectMode: "auto" },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network} → GOOSE_MODE=${c.expectMode}`, async () => {
      const plan = await goose().prepare(
        spec({ sandbox: c.sandbox, network: c.network }),
        HUB,
      );
      expect(plan.env.GOOSE_MODE).toBe(c.expectMode);
      // Config file carries the same mode (belt-and-braces; env wins).
      const yaml = plan.files.find((f) => f.path.endsWith("config.yaml"))!.contents;
      expect(yaml).toContain(`GOOSE_MODE: ${c.expectMode}`);
    });
  }

  it("resume carries the identical posture env as prepare", async () => {
    const adapter = goose();
    const s = spec({ sandbox: "read-only", network: false, sessionId: "20260716_1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    expect(resumed.env.GOOSE_MODE).toBe(prepared.env.GOOSE_MODE);
    expect(resumed.env.GOOSE_PATH_ROOT).toBe(prepared.env.GOOSE_PATH_ROOT);
  });
});

describe("goose adapter — env isolation & auth passthrough", () => {
  it("sets GOOSE_PATH_ROOT to the per-task private dir under cwd", async () => {
    const plan = await goose().prepare(spec(), HUB);
    expect(plan.env.GOOSE_PATH_ROOT).toBe("/work/tree/.parley-goose");
  });

  it("disables keyring and session naming for headless children", async () => {
    const plan = await goose().prepare(spec(), HUB);
    expect(plan.env.GOOSE_DISABLE_KEYRING).toBe("1");
    expect(plan.env.GOOSE_DISABLE_SESSION_NAMING).toBe("true");
  });

  it("passes provider API keys through only when the parent set them", async () => {
    const withKeys = await goose({
      OPENAI_API_KEY: "sk-openai",
      XAI_API_KEY: "xai-secret",
      ANTHROPIC_API_KEY: "sk-ant",
    }).prepare(spec(), HUB);
    expect(withKeys.env.OPENAI_API_KEY).toBe("sk-openai");
    expect(withKeys.env.XAI_API_KEY).toBe("xai-secret");
    expect(withKeys.env.ANTHROPIC_API_KEY).toBe("sk-ant");

    const without = await goose().prepare(spec(), HUB);
    for (const key of AUTH_KEYS) {
      expect(key in without.env).toBe(false);
    }
  });

  it("does not invent auth keys that were never set", async () => {
    const plan = await goose({ OPENAI_API_KEY: "only-this" }).prepare(spec(), HUB);
    expect(plan.env.OPENAI_API_KEY).toBe("only-this");
    expect("ANTHROPIC_API_KEY" in plan.env).toBe(false);
    expect("XAI_API_KEY" in plan.env).toBe(false);
  });
});

describe("goose adapter — effort passthrough (provider-specific envs)", () => {
  it("maps Claude thinking effort values to CLAUDE_THINKING_TYPE", async () => {
    const plan = await goose().prepare(spec({ effort: "adaptive" }), HUB);
    expect(plan.env.CLAUDE_THINKING_TYPE).toBe("adaptive");
    expect(plan.argv).not.toContain("--effort");
    expect(plan.argv).not.toContain("--reasoning-effort");
  });

  it("maps Gemini low/high effort to GEMINI3_THINKING_LEVEL", async () => {
    const plan = await goose().prepare(spec({ effort: "high" }), HUB);
    expect(plan.env.GEMINI3_THINKING_LEVEL).toBe("high");
  });

  it("passes unknown effort strings opaquely as CLAUDE_THINKING_TYPE", async () => {
    const plan = await goose().prepare(spec({ effort: "medium" }), HUB);
    expect(plan.env.CLAUDE_THINKING_TYPE).toBe("medium");
  });

  it("omits effort envs when effort is null", async () => {
    const plan = await goose().prepare(spec({ effort: null }), HUB);
    expect("CLAUDE_THINKING_TYPE" in plan.env).toBe(false);
    expect("GEMINI3_THINKING_LEVEL" in plan.env).toBe(false);
  });
});

describe("goose adapter — materialized config.yaml (MCP injection)", () => {
  it("carries streamable_http hub URL, correlation headers, and raised timeout", async () => {
    const plan = await goose().prepare(spec(), HUB);
    const file = plan.files.find((f) => f.path === ".parley-goose/config/config.yaml");
    expect(file).toBeDefined();
    const yaml = file!.contents;
    expect(yaml).toContain("type: streamable_http");
    expect(yaml).toContain('uri: "http://127.0.0.1:54321/mcp"');
    expect(yaml).toContain("headers:");
    expect(yaml).toContain('"x-parley-task": "t7"');
    // 30 min answer timeout → 1800s + 60s headroom = 1860.
    expect(yaml).toContain("timeout: 1860");
    expect(yaml).toContain("GOOSE_MODE: auto");
    expect(yaml).toContain("enabled: true");
    expect(yaml).toContain("name: parley");
  });

  it("raises extension timeout strictly above the task's answer timeout", async () => {
    // 5-minute answer timeout → 300s + 60s headroom = 360s.
    const plan = await goose().prepare(
      spec({ answerTimeoutMs: 300_000 }),
      HUB,
    );
    const yaml = plan.files[0]!.contents;
    expect(yaml).toContain("timeout: 360");
    expect(360).toBeGreaterThan(300);
  });

  it("escapes quotes, backslashes, and newlines in YAML values", async () => {
    const hub: HubInfo = {
      url: 'http://127.0.0.1:1/mcp?q="x"\\y',
      headers: { "x-parley-task": "t1\nInjected: true" },
    };
    const plan = await goose().prepare(spec(), hub);
    const yaml = plan.files[0]!.contents;
    expect(yaml).toContain('uri: "http://127.0.0.1:1/mcp?q=\\"x\\"\\\\y"');
    // Newline escaped — no injected config line.
    expect(yaml).toContain('"x-parley-task": "t1\\nInjected: true"');
    expect(yaml).not.toMatch(/^Injected: true$/m);
  });
});

describe("goose adapter — parseEvent (tolerant)", () => {
  const adapter = createGooseAdapter({});

  it("maps message text to message events", () => {
    const line =
      '{"type":"message","message":{"id":null,"role":"assistant","created":1,' +
      '"content":[{"type":"text","text":"hello"}],"metadata":{}}}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "message", text: "hello" }]);
  });

  it("maps stream error to fatal error", () => {
    expect(adapter.parseEvent('{"type":"error","error":"provider down"}')).toEqual([
      { kind: "error", text: "provider down", fatal: true },
    ]);
  });

  it("maps complete to session_meta usage, dropping nulls", () => {
    expect(adapter.parseEvent('{"type":"complete","total_tokens":null}')).toEqual([
      { kind: "session_meta", usage: {} },
    ]);
    expect(
      adapter.parseEvent(
        '{"type":"complete","total_tokens":1234,"input_tokens":1000,"output_tokens":234}',
      ),
    ).toEqual([
      {
        kind: "session_meta",
        usage: {
          total_tokens: 1234,
          input_tokens: 1000,
          output_tokens: 234,
        },
      },
    ]);
  });

  it("emits cached_tokens when cache_read_input_tokens is present", () => {
    expect(
      adapter.parseEvent(
        '{"type":"complete","total_tokens":10,"input_tokens":8,"output_tokens":2,' +
          '"cache_read_input_tokens":3}',
      ),
    ).toEqual([
      {
        kind: "session_meta",
        usage: {
          total_tokens: 10,
          input_tokens: 8,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cached_tokens: 3,
        },
      },
    ]);
  });

  it("scrapes session id from the human banner (non-JSON stdout)", () => {
    const banner = fs.readFileSync(path.join(FIXTURES, "v1.43.0-banner.txt"), "utf8");
    const events = banner.split("\n").flatMap((line) => adapter.parseEvent(line));
    expect(adapter.sessionId(events)).toBe("20260716_9");
  });

  it("never throws on unknown, changed, or malformed shapes", () => {
    expect(adapter.parseEvent('{"type":"totally_new_kind","x":1}')).toEqual([]);
    expect(adapter.parseEvent('{"no":"type"}')).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
    expect(adapter.parseEvent("null")).toEqual([]);
    expect(adapter.parseEvent('{"type":"notification","extension_id":"x"}')).toEqual([]);
  });

  it("maps toolRequest content to command events", () => {
    const line =
      '{"type":"message","message":{"content":[{"type":"toolRequest","toolCall":' +
      '{"name":"developer__shell","arguments":{"command":"ls"}}}]}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "command", text: 'developer__shell {"command":"ls"}' },
    ]);
  });

  it("tags hub toolResponse errors with PARLEY-DIAG", () => {
    const line =
      '{"type":"message","message":{"content":[{"type":"toolResponse",' +
      '"name":"submit_report","isError":true,"error":{"message":"cancelled"}}]}}';
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "error",
        text: "PARLEY-DIAG goose toolResponse tool=submit_report failed: cancelled",
      },
    ]);
  });

  it("stderr MCP extension init failure → fatal PARLEY-DIAG (defect: silent hub-less run)", () => {
    // Live shape: Warning: Failed to start extension 'parley' … continuing without it
    const line =
      "Warning: Failed to start extension 'parley' (connection refused); continuing without it";
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "error",
        text:
          "PARLEY-DIAG goose MCP extension 'parley' failed to start (hub tools unavailable): " +
          line,
        fatal: true,
      },
    ]);
  });

  it("stderr resume/session miss → fatal PARLEY-DIAG (defect: generic exited-without-report)", () => {
    const line = "Error: No session found with name 'parley-nonexistent'";
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "error",
        text: `PARLEY-DIAG goose resume/session error: ${line}`,
        fatal: true,
      },
    ]);
  });
});

describe("goose adapter — provider required (#107)", () => {
  it("refuses prepare without GOOSE_PROVIDER or --provider (defect: hermetic root drops config)", async () => {
    await expect(createGooseAdapter({}).prepare(spec(), HUB)).rejects.toThrow(
      /no provider configured/,
    );
  });

  it("accepts GOOSE_PROVIDER from parent env", async () => {
    const plan = await createGooseAdapter({ GOOSE_PROVIDER: "anthropic" }).prepare(spec(), HUB);
    expect(plan.env.GOOSE_PROVIDER).toBe("anthropic");
  });

  it("accepts --provider in extraArgs without GOOSE_PROVIDER env", async () => {
    const plan = await createGooseAdapter({}).prepare(
      spec({ extraArgs: ["--provider", "openai"] }),
      HUB,
    );
    expect(plan.argv).toContain("--provider");
    expect(plan.argv).toContain("openai");
  });

  it("forwards GOOSE_PROVIDER and GOOSE_MODEL when set", async () => {
    const plan = await createGooseAdapter({
      GOOSE_PROVIDER: "openai",
      GOOSE_MODEL: "gpt-4o",
    }).prepare(spec(), HUB);
    expect(plan.env.GOOSE_PROVIDER).toBe("openai");
    expect(plan.env.GOOSE_MODEL).toBe("gpt-4o");
  });
});

describe("goose adapter — golden JSONL fixtures (pins observed v1.43.0)", () => {
  function replay(file: string) {
    const adapter = createGooseAdapter({});
    const lines = fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    return { adapter, events };
  }

  it("auth-fail fixture → fatal error + empty usage complete", () => {
    const { adapter, events } = replay("v1.43.0-auth-fail.jsonl");
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fatal).toBe(true);
    expect(errors[0]!.text).toMatch(/Authentication error/);
    expect(adapter.sessionId(events)).toBeUndefined();
    const meta = events.filter((e) => e.kind === "session_meta");
    expect(meta).toHaveLength(1);
    expect(meta[0]!.usage).toEqual({});
  });

  it("complete-usage fixture → message + numeric usage with canonical keys", () => {
    const { events } = replay("v1.43.0-complete-usage.jsonl");
    expect(events.filter((e) => e.kind === "message").map((e) => e.text)).toEqual(["Done."]);
    const usage = events.find((e) => e.kind === "session_meta")?.usage;
    expect(usage).toEqual({
      total_tokens: 1234,
      input_tokens: 1000,
      output_tokens: 234,
    });
  });

  it("tool-request fixture → command + message + usage", () => {
    const { events } = replay("v1.43.0-tool-request.jsonl");
    const commands = events.filter((e) => e.kind === "command");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.text).toContain("developer__shell");
    expect(commands[0]!.text).toContain("ls -la");
    expect(events.filter((e) => e.kind === "message").map((e) => e.text)).toEqual([
      "listed files",
    ]);
  });
});

describe("goose adapter — sessionId extraction", () => {
  const adapter = createGooseAdapter({});

  it("returns the last banner-scraped session id", () => {
    const events = [
      ...adapter.parseEvent("   \\____)    20260716_1 · /tmp/wt"),
      ...adapter.parseEvent('{"type":"message","message":{"content":[{"type":"text","text":"hi"}]}}'),
      ...adapter.parseEvent("   \\____)    20260716_9 · /tmp/wt"),
    ];
    expect(adapter.sessionId(events)).toBe("20260716_9");
  });

  it("returns undefined when no session id was seen", () => {
    const events = adapter.parseEvent('{"type":"complete","total_tokens":1}');
    expect(adapter.sessionId(events)).toBeUndefined();
  });
});

describe("goose adapter — listModels omitted", () => {
  it("does not implement listModels (no cloud catalog CLI in v1.43.0)", () => {
    const adapter = createGooseAdapter({});
    expect(adapter.listModels).toBeUndefined();
  });
});
