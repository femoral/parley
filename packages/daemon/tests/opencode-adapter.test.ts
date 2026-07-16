import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencodeAdapter, parseOpencodeModels } from "../src/adapters/opencode.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";

/**
 * Golden unit tests for the opencode adapter — the allowed pure-function exception
 * to the suite's CLI-boundary rule (spec §10). Pins argv/env across the
 * sandbox-posture matrix and JSONL normalization against OpenCode CLI **1.18.2**
 * (docs/research/opencode-cli-automation.md).
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/opencode/", import.meta.url));

const HUB: HubInfo = {
  url: "http://127.0.0.1:5555/mcp",
  headers: { "x-parley-task": "t1", "X-Extra": "v" },
};

/** A task at the daemon's default 30-minute answer timeout. */
function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t1",
    name: null,
    prompt: "do the thing",
    vendor: "opencode",
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

function configOf(plan: { env: Record<string, string> }): Record<string, unknown> {
  const raw = plan.env.OPENCODE_CONFIG_CONTENT;
  expect(raw).toBeDefined();
  return JSON.parse(raw!) as Record<string, unknown>;
}

function permissionOf(plan: { env: Record<string, string> }): Record<string, unknown> {
  const cfg = configOf(plan);
  return cfg.permission as Record<string, unknown>;
}

describe("opencode prepare — golden argv", () => {
  it("builds the pinned headless run --format json --auto invocation", async () => {
    const plan = await createOpencodeAdapter({}).prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      "/work/wt",
      "--",
      "do the thing",
    ]);
    expect(plan.cwd).toBe("/work/wt");
    expect(plan.files).toEqual([]);
  });

  it("passes the model opaquely via -m when set, omits it otherwise", async () => {
    const withModel = await createOpencodeAdapter({}).prepare(
      spec({ model: "opencode/deepseek-v4-flash-free" }),
      HUB,
    );
    const i = withModel.argv.indexOf("-m");
    expect(i).toBeGreaterThan(-1);
    expect(withModel.argv[i + 1]).toBe("opencode/deepseek-v4-flash-free");
    // Flags region, before `--` / prompt.
    expect(withModel.argv.indexOf("-m")).toBeLessThan(withModel.argv.indexOf("--"));

    const without = await createOpencodeAdapter({}).prepare(spec({ model: null }), HUB);
    expect(without.argv).not.toContain("-m");
  });

  it("passes effort via --variant when set, omits it otherwise", async () => {
    const withEffort = await createOpencodeAdapter({}).prepare(spec({ effort: "high" }), HUB);
    expect(withEffort.argv).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      "/work/wt",
      "--variant",
      "high",
      "--",
      "do the thing",
    ]);
    const without = await createOpencodeAdapter({}).prepare(spec({ effort: null }), HUB);
    expect(without.argv).not.toContain("--variant");
  });

  it("passes --title from task.name when set", async () => {
    const plan = await createOpencodeAdapter({}).prepare(spec({ name: "my-task" }), HUB);
    expect(plan.argv).toContain("--title");
    expect(plan.argv).toContain("my-task");
    expect(plan.argv.indexOf("--title")).toBeLessThan(plan.argv.indexOf("--"));
  });

  it("splices extraArgs into the flags region before the positional prompt", async () => {
    const plan = await createOpencodeAdapter({}).prepare(
      spec({ extraArgs: ["--pure", "--agent", "build"] }),
      HUB,
    );
    const dash = plan.argv.indexOf("--");
    expect(plan.argv[dash + 1]).toBe("do the thing");
    expect(plan.argv.slice(dash - 3, dash)).toEqual(["--pure", "--agent", "build"]);
    expect(plan.argv.slice(0, 2)).toEqual(["opencode", "run"]);
  });

  it("honours PARLEY_OPENCODE_BIN override", async () => {
    const plan = await createOpencodeAdapter({
      PARLEY_OPENCODE_BIN: "/opt/opencode/opencode",
    }).prepare(spec(), HUB);
    expect(plan.argv[0]).toBe("/opt/opencode/opencode");
  });
});

describe("opencode resume — golden argv", () => {
  it("resumes the persisted session with -s and the answer prompt", async () => {
    const plan = await createOpencodeAdapter({}).resume(
      spec({ prompt: "use postgres", sessionId: "ses_096042ed7ffegkkH3BpVm5C5CH" }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "opencode",
      "run",
      "-s",
      "ses_096042ed7ffegkkH3BpVm5C5CH",
      "--format",
      "json",
      "--auto",
      "--dir",
      "/work/wt",
      "--",
      "use postgres",
    ]);
    expect(plan.cwd).toBe("/work/wt");
  });

  it("re-injects OPENCODE_CONFIG_CONTENT on resume", async () => {
    const plan = await createOpencodeAdapter({}).resume(
      spec({ sessionId: "ses_abc", sandbox: "read-only", network: false }),
      HUB,
    );
    const cfg = configOf(plan);
    expect(cfg.mcp).toBeDefined();
    expect((cfg.mcp as Record<string, unknown>).parley).toBeDefined();
  });

  it("carries model/effort through resume identically to prepare", async () => {
    const s = spec({
      sessionId: "ses_1",
      model: "anthropic/claude-sonnet-4-5",
      effort: "max",
      prompt: "answer",
    });
    const prepared = await createOpencodeAdapter({}).prepare(s, HUB);
    const resumed = await createOpencodeAdapter({}).resume(s, HUB);
    expect(resumed.argv).toContain("-m");
    expect(resumed.argv).toContain("anthropic/claude-sonnet-4-5");
    expect(resumed.argv).toContain("--variant");
    expect(resumed.argv).toContain("max");
    // Session flag is the only structural difference before common flags.
    expect(resumed.argv).toContain("-s");
    expect(resumed.argv).toContain("ses_1");
    expect(prepared.argv).not.toContain("-s");
  });

  it("rejects a resume without a session id (would silently start a fresh session)", async () => {
    await expect(createOpencodeAdapter({}).resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });

  it("splices extraArgs before the prompt on resume too", async () => {
    const plan = await createOpencodeAdapter({}).resume(
      spec({ extraArgs: ["--pure"], sessionId: "ses_1", prompt: "answer" }),
      HUB,
    );
    expect(plan.argv[plan.argv.length - 1]).toBe("answer");
    expect(plan.argv.indexOf("--pure")).toBeLessThan(plan.argv.indexOf("--"));
  });
});

describe("opencode prepare — sandbox × network posture matrix (golden config)", () => {
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    expectExternal: "deny" | "allow" | "map";
    expectWeb: "allow" | "deny";
    expectReadOnlyDenies: boolean;
  }[] = [
    {
      sandbox: "workspace",
      network: true,
      expectExternal: "map",
      expectWeb: "allow",
      expectReadOnlyDenies: false,
    },
    {
      sandbox: "workspace",
      network: false,
      expectExternal: "map",
      expectWeb: "deny",
      expectReadOnlyDenies: false,
    },
    {
      sandbox: "read-only",
      network: true,
      expectExternal: "deny",
      expectWeb: "allow",
      expectReadOnlyDenies: true,
    },
    {
      sandbox: "read-only",
      network: false,
      expectExternal: "deny",
      expectWeb: "deny",
      expectReadOnlyDenies: true,
    },
    {
      sandbox: "full",
      network: true,
      expectExternal: "allow",
      expectWeb: "allow",
      expectReadOnlyDenies: false,
    },
    {
      sandbox: "full",
      network: false,
      expectExternal: "allow",
      expectWeb: "deny",
      expectReadOnlyDenies: false,
    },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network}`, async () => {
      const plan = await createOpencodeAdapter({}).prepare(
        spec({ sandbox: c.sandbox, network: c.network }),
        HUB,
      );
      // Always headless-safe flags.
      expect(plan.argv).toContain("--auto");
      expect(plan.argv).toContain("--format");
      expect(plan.argv).toContain("json");

      const perm = permissionOf(plan);
      expect(perm.webfetch).toBe(c.expectWeb);
      expect(perm.websearch).toBe(c.expectWeb);

      if (c.expectExternal === "map") {
        expect(perm.external_directory).toEqual({ "*": "deny" });
      } else {
        expect(perm.external_directory).toBe(c.expectExternal);
      }

      if (c.expectReadOnlyDenies) {
        expect(perm.edit).toBe("deny");
        expect(perm.write).toBe("deny");
        expect(perm.bash).toBe("deny");
        expect(perm.read).toBe("allow");
      } else {
        expect(perm.edit).toBeUndefined();
        expect(perm.write).toBeUndefined();
        expect(perm.bash).toBeUndefined();
      }
    });
  }

  it("workspace + gitDir/gitCommonDir grants external_directory allow paths", async () => {
    const plan = await createOpencodeAdapter({}).prepare(
      spec({
        sandbox: "workspace",
        gitDir: "/repo/.git/worktrees/t1",
        gitCommonDir: "/repo/.git",
      }),
      HUB,
    );
    const perm = permissionOf(plan);
    expect(perm.external_directory).toEqual({
      "*": "deny",
      "/repo/.git/worktrees/t1/**": "allow",
      "/repo/.git/**": "allow",
    });
  });

  it("resume maps posture identically to prepare", async () => {
    const s = spec({
      sandbox: "workspace",
      network: false,
      sessionId: "ses_1",
      gitDir: "/repo/.git/worktrees/t1",
    });
    const prepared = await createOpencodeAdapter({}).prepare(s, HUB);
    const resumed = await createOpencodeAdapter({}).resume(s, HUB);
    expect(resumed.env.OPENCODE_CONFIG_CONTENT).toBe(prepared.env.OPENCODE_CONFIG_CONTENT);
  });
});

describe("opencode prepare — MCP injection, timeout, auth, isolation", () => {
  it("injects remote MCP hub via OPENCODE_CONFIG_CONTENT (url, headers, oauth:false)", async () => {
    const plan = await createOpencodeAdapter({}).prepare(spec(), HUB);
    const cfg = configOf(plan);
    expect(cfg.autoupdate).toBe(false);
    const mcp = (cfg.mcp as Record<string, Record<string, unknown>>).parley;
    expect(mcp).toEqual({
      type: "remote",
      url: "http://127.0.0.1:5555/mcp",
      enabled: true,
      oauth: false,
      timeout: 1_800_000 + 60_000,
      headers: { "x-parley-task": "t1", "X-Extra": "v" },
    });
  });

  it("raises MCP timeout strictly above the task's answer timeout", async () => {
    // 5-minute answer timeout → 300_000 + 60_000 headroom = 360_000 ms.
    const plan = await createOpencodeAdapter({}).prepare(spec({ answerTimeoutMs: 300_000 }), HUB);
    const mcp = (configOf(plan).mcp as Record<string, Record<string, unknown>>).parley;
    expect(mcp?.timeout).toBe(360_000);
    expect(360_000).toBeGreaterThan(300_000);
  });

  it("disables interactive approvals in config permission + --auto", async () => {
    const plan = await createOpencodeAdapter({}).prepare(spec(), HUB);
    expect(plan.argv).toContain("--auto");
    const perm = permissionOf(plan);
    // Workspace posture uses global allow (no ask); explicit deny still applies for external_directory.
    expect(perm["*"]).toBe("allow");
  });

  it("isolates the child from user config bleed (scanner / update / project config env)", async () => {
    const plan = await createOpencodeAdapter({}).prepare(spec(), HUB);
    expect(plan.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(plan.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(plan.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  });

  it("passes named auth keys through only when the parent set them", async () => {
    const withKeys = await createOpencodeAdapter({
      OPENCODE_API_KEY: "oc-secret",
      OPENAI_API_KEY: "oai-secret",
      ANTHROPIC_API_KEY: "ant-secret",
      XAI_API_KEY: "xai-secret",
      OPENROUTER_API_KEY: "or-secret",
      GOOGLE_API_KEY: "g-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/path/creds.json",
      // Not in the §6 allowlist — must not leak.
      SOME_OTHER_KEY: "nope",
    }).prepare(spec(), HUB);
    expect(withKeys.env.OPENCODE_API_KEY).toBe("oc-secret");
    expect(withKeys.env.OPENAI_API_KEY).toBe("oai-secret");
    expect(withKeys.env.ANTHROPIC_API_KEY).toBe("ant-secret");
    expect(withKeys.env.XAI_API_KEY).toBe("xai-secret");
    expect(withKeys.env.OPENROUTER_API_KEY).toBe("or-secret");
    expect(withKeys.env.GOOGLE_API_KEY).toBe("g-secret");
    expect(withKeys.env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/path/creds.json");
    expect("SOME_OTHER_KEY" in withKeys.env).toBe(false);

    const without = await createOpencodeAdapter({}).prepare(spec(), HUB);
    expect("OPENCODE_API_KEY" in without.env).toBe(false);
    expect("OPENAI_API_KEY" in without.env).toBe(false);
    expect("XAI_API_KEY" in without.env).toBe(false);
  });
});

describe("opencode parseEvent — golden JSONL (1.18.2 research samples)", () => {
  const adapter = createOpencodeAdapter({});

  it("step_start → session_meta carrying sessionID", () => {
    const line =
      '{"type":"step_start","timestamp":1,"sessionID":"ses_096042ed7ffegkkH3BpVm5C5CH","part":{"type":"step-start"}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "session_meta", session_id: "ses_096042ed7ffegkkH3BpVm5C5CH" },
    ]);
  });

  it("text → message with part.text", () => {
    const line =
      '{"type":"text","timestamp":1784189542831,"sessionID":"ses_096042ed7ffegkkH3BpVm5C5CH","part":{"type":"text","text":"pong"}}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "message", text: "pong" }]);
  });

  it("tool_use bash → command with input.command", () => {
    const line =
      '{"type":"tool_use","sessionID":"ses_1","part":{"tool":"bash","state":{"status":"completed","input":{"command":"echo tool-ok"},"title":"echo tool-ok"}}}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "command", text: "echo tool-ok" }]);
  });

  it("tool_use write → file_change with filepath", () => {
    const line =
      '{"type":"tool_use","sessionID":"ses_1","part":{"tool":"write","state":{"status":"completed","input":{"filePath":"/tmp/oc-write-test/hello.txt","content":"hi"},"metadata":{"filepath":"/tmp/oc-write-test/hello.txt"}}}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "file_change", text: "/tmp/oc-write-test/hello.txt" },
    ]);
  });

  it("tool_use edit/patch → file_change", () => {
    expect(
      adapter.parseEvent(
        '{"type":"tool_use","part":{"tool":"edit","state":{"status":"completed","input":{"filePath":"src/a.ts"}}}}',
      ),
    ).toEqual([{ kind: "file_change", text: "src/a.ts" }]);
    expect(
      adapter.parseEvent(
        '{"type":"tool_use","part":{"tool":"patch","state":{"status":"completed","input":{"path":"src/b.ts"}}}}',
      ),
    ).toEqual([{ kind: "file_change", text: "src/b.ts" }]);
  });

  it("tool_use other/MCP → command with tool name", () => {
    expect(
      adapter.parseEvent(
        '{"type":"tool_use","part":{"tool":"parley_submit_report","state":{"status":"completed"}}}',
      ),
    ).toEqual([{ kind: "command", text: "parley_submit_report" }]);
  });

  it("failed parley tool_use → tagged, non-fatal diagnostic error", () => {
    const line =
      '{"type":"tool_use","part":{"tool":"parley_ask_orchestrator","state":{"status":"error","output":"permission denied"}}}';
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "error",
        text: "PARLEY-DIAG tool_use tool=parley_ask_orchestrator status=error: permission denied",
      },
    ]);
  });

  it("step_finish → session_meta usage (harness + canonical keys)", () => {
    const line =
      '{"type":"step_finish","timestamp":1784189542831,"sessionID":"ses_096042ed7ffegkkH3BpVm5C5CH","part":{"type":"step-finish","reason":"stop","tokens":{"total":8084,"input":8069,"output":3,"reasoning":12,"cache":{"write":0,"read":0}},"cost":0}}';
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "session_meta",
        session_id: "ses_096042ed7ffegkkH3BpVm5C5CH",
        usage: {
          input: 8069,
          input_tokens: 8069,
          output: 3,
          output_tokens: 3,
          reasoning: 12,
          total: 8084,
          cache_read: 0,
          cached_tokens: 0,
          cache_write: 0,
          cost: 0,
        },
      },
    ]);
  });

  it("error → session_meta + fatal error carrying error.data.message", () => {
    const line =
      '{"type":"error","timestamp":1784189651888,"sessionID":"ses_0960279aeffeh2QyCo5pXi11rd","error":{"name":"APIError","data":{"message":"Invalid API key.","statusCode":401}}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "session_meta", session_id: "ses_0960279aeffeh2QyCo5pXi11rd" },
      { kind: "error", text: "Invalid API key.", fatal: true },
    ]);
  });

  it("error falls back to error.name when message missing", () => {
    expect(
      adapter.parseEvent('{"type":"error","error":{"name":"UnknownError","data":{}}}'),
    ).toEqual([{ kind: "error", text: "UnknownError", fatal: true }]);
  });

  it("unknown types and non-JSON pass through opaque ([])", () => {
    expect(adapter.parseEvent('{"type":"whatever.new"}')).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("null")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
  });
});

describe("opencode parseEvent — golden fixtures (pins observed 1.18.2)", () => {
  function replay(file: string) {
    const adapter = createOpencodeAdapter({});
    const lines = fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    const messages = events
      .filter((e) => e.kind === "message")
      .map((e) => e.text ?? "")
      .join("");
    const commands = events.filter((e) => e.kind === "command").map((e) => e.text);
    const files = events.filter((e) => e.kind === "file_change").map((e) => e.text);
    const errors = events.filter((e) => e.kind === "error");
    const usages = events
      .filter((e) => e.kind === "session_meta" && e.usage !== undefined)
      .map((e) => e.usage);
    return {
      messages,
      commands,
      files,
      errors,
      usages,
      sessionId: adapter.sessionId(events),
    };
  }

  it("fresh short run: message, session id, usage", () => {
    const r = replay("v1.18.2-fresh.jsonl");
    expect(r.messages).toBe("pong");
    expect(r.sessionId).toBe("ses_096042ed7ffegkkH3BpVm5C5CH");
    expect(r.usages).toHaveLength(1);
    expect(r.usages[0]).toMatchObject({
      input_tokens: 8069,
      output_tokens: 3,
      cached_tokens: 0,
      input: 8069,
      output: 3,
    });
  });

  it("tool + write multi-step: command, file_change, message, session id", () => {
    const r = replay("v1.18.2-tool-write.jsonl");
    expect(r.commands).toContain("echo tool-ok");
    expect(r.files).toContain("/tmp/oc-write-test/hello.txt");
    expect(r.messages).toBe("DONE");
    expect(r.sessionId).toBe("ses_09603fdbbffeHJQX9GiIjpIfpb");
    // Engine supersedes usage; last step_finish wins in sessionId path — we still
    // emit one usage object per step_finish.
    expect(r.usages.length).toBe(2);
    expect(r.usages[1]).toMatchObject({
      input_tokens: 150,
      output_tokens: 20,
      cached_tokens: 3,
      cost: 0.001,
    });
  });

  it("API/auth failure: fatal error + session id from the error line", () => {
    const r = replay("v1.18.2-error.jsonl");
    expect(r.errors).toEqual([{ kind: "error", text: "Invalid API key.", fatal: true }]);
    // sessionID is on every JSONL line including error (research §4); adapter
    // emits session_meta alongside the fatal error so pure-error streams still
    // capture a resumable id.
    expect(r.sessionId).toBe("ses_0960279aeffeh2QyCo5pXi11rd");
  });
});

describe("opencode sessionId — extraction from parsed events", () => {
  const adapter = createOpencodeAdapter({});

  it("returns the session id from the last session_meta that carries one", () => {
    const events = [
      ...adapter.parseEvent(
        '{"type":"step_start","sessionID":"ses_first","part":{"type":"step-start"}}',
      ),
      ...adapter.parseEvent(
        '{"type":"text","sessionID":"ses_first","part":{"type":"text","text":"hi"}}',
      ),
      ...adapter.parseEvent(
        '{"type":"step_finish","sessionID":"ses_first","part":{"type":"step-finish","tokens":{"input":1,"output":1}}}',
      ),
    ];
    expect(adapter.sessionId(events)).toBe("ses_first");
  });

  it("returns undefined when no session id was seen", () => {
    const events = adapter.parseEvent('{"type":"text","part":{"type":"text","text":"hi"}}');
    expect(adapter.sessionId(events)).toBeUndefined();
  });
});

describe("opencode parseOpencodeModels", () => {
  it("parses provider/model lines and carries prior efforts", () => {
    const text = [
      "opencode/big-pickle",
      "opencode/deepseek-v4-flash-free",
      "github-copilot/claude-sonnet-4.5",
      "",
      "{",
      '  "id": "ignored-verbose"',
      "}",
    ].join("\n");
    const models = parseOpencodeModels(text, {
      source: "hand",
      fetched_at: "2026-07-16T00:00:00.000Z",
      models: [
        {
          id: "opencode/deepseek-v4-flash-free",
          efforts: ["high", "max"],
          default_effort: "high",
        },
      ],
    });
    expect(models).toEqual([
      { id: "opencode/big-pickle", efforts: [], default_effort: null },
      {
        id: "opencode/deepseek-v4-flash-free",
        efforts: ["high", "max"],
        default_effort: "high",
      },
      { id: "github-copilot/claude-sonnet-4.5", efforts: [], default_effort: null },
    ]);
  });

  it("throws when no ids parse (refresh keeps existing catalog entry)", () => {
    expect(() => parseOpencodeModels("Available models:\n(none)\n", undefined)).toThrow(
      /no model ids/,
    );
  });
});
