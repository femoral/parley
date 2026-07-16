import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHermesAdapter } from "../src/adapters/hermes.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/hermes/", import.meta.url));
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
    vendor: "hermes",
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

const HERMES_HOME = "/work/tree/.parley/hermes-home";
const CONFIG_PATH = ".parley/hermes-home/config.yaml";

describe("hermes adapter — prepare argv (golden)", () => {
  it("builds the pinned headless quiet invocation (research §2)", async () => {
    const adapter = createHermesAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "hermes",
      "chat",
      "--quiet",
      "--yolo",
      "--accept-hooks",
      "--source",
      "tool",
      "-q",
      "do the thing",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("passes the model through with -m when set, omits it otherwise", async () => {
    const adapter = createHermesAdapter({});
    const withModel = await adapter.prepare(spec({ model: "claude-sonnet-4" }), HUB);
    expect(withModel.argv).toContain("-m");
    expect(withModel.argv).toContain("claude-sonnet-4");
    // Model is in the flags region, before -q.
    expect(withModel.argv.indexOf("-m")).toBeLessThan(withModel.argv.indexOf("-q"));
    const without = await adapter.prepare(spec({ model: null }), HUB);
    expect(without.argv).not.toContain("-m");
  });

  it("does not invent a CLI effort flag (effort rides config.yaml)", async () => {
    const adapter = createHermesAdapter({});
    const withEffort = await adapter.prepare(spec({ effort: "high" }), HUB);
    expect(withEffort.argv).not.toContain("--reasoning-effort");
    expect(withEffort.argv).not.toContain("--effort");
    const config = withEffort.files.find((f) => f.path === CONFIG_PATH)!;
    expect(config.contents).toContain('reasoning_effort: "high"');
    const without = await adapter.prepare(spec({ effort: null }), HUB);
    const bare = without.files.find((f) => f.path === CONFIG_PATH)!;
    expect(bare.contents).not.toContain("reasoning_effort");
  });

  it("splices extraArgs into the flags region before -q", async () => {
    const plan = await createHermesAdapter({}).prepare(
      spec({ extraArgs: ["--provider", "openrouter", "--verbose"] }),
      HUB,
    );
    const qIdx = plan.argv.indexOf("-q");
    expect(plan.argv[qIdx + 1]).toBe("do the thing");
    expect(plan.argv.indexOf("--provider")).toBeLessThan(qIdx);
    expect(plan.argv.indexOf("openrouter")).toBeLessThan(qIdx);
    expect(plan.argv.indexOf("--verbose")).toBeLessThan(qIdx);
    // Prompt is never followed by extra flags.
    expect(plan.argv[plan.argv.length - 1]).toBe("do the thing");
  });

  it("honours PARLEY_HERMES_BIN override", async () => {
    const adapter = createHermesAdapter({ PARLEY_HERMES_BIN: "/opt/hermes/hermes" });
    expect((await adapter.prepare(spec(), HUB)).argv[0]).toBe("/opt/hermes/hermes");
  });

  it("never passes --safe-mode, --ignore-user-config, or -w/--worktree", async () => {
    const plan = await createHermesAdapter({}).prepare(spec(), HUB);
    expect(plan.argv).not.toContain("--safe-mode");
    expect(plan.argv).not.toContain("--ignore-user-config");
    expect(plan.argv).not.toContain("-w");
    expect(plan.argv).not.toContain("--worktree");
    expect(plan.argv).not.toContain("-z");
  });
});

describe("hermes adapter — resume argv (golden)", () => {
  it("resumes with --resume <session-id> and the answer as -q prompt", async () => {
    const adapter = createHermesAdapter({});
    const plan = await adapter.resume(
      spec({ prompt: "the answer", sessionId: "20260716_143052_a1b2c3" }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "hermes",
      "chat",
      "--quiet",
      "--yolo",
      "--accept-hooks",
      "--source",
      "tool",
      "--resume",
      "20260716_143052_a1b2c3",
      "-q",
      "the answer",
    ]);
    // Same private HERMES_HOME as prepare (session scoped to home).
    expect(plan.env.HERMES_HOME).toBe(HERMES_HOME);
  });

  it("re-materializes config.yaml on resume", async () => {
    const adapter = createHermesAdapter({});
    const plan = await adapter.resume(spec({ sessionId: "sess-abc" }), HUB);
    expect(plan.files.map((f) => f.path)).toContain(CONFIG_PATH);
  });

  it("rejects a resume without a session id (would race --continue)", async () => {
    const adapter = createHermesAdapter({});
    await expect(adapter.resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });

  it("carries model and extraArgs through resume identically to prepare", async () => {
    const adapter = createHermesAdapter({});
    const s = spec({
      prompt: "follow-up",
      sessionId: "sess-1",
      model: "gpt-4.1",
      extraArgs: ["--provider", "openai-api"],
      effort: "medium",
    });
    const plan = await adapter.resume(s, HUB);
    expect(plan.argv).toContain("-m");
    expect(plan.argv).toContain("gpt-4.1");
    expect(plan.argv).toContain("--provider");
    expect(plan.argv.indexOf("--provider")).toBeLessThan(plan.argv.indexOf("-q"));
    expect(plan.files.find((f) => f.path === CONFIG_PATH)!.contents).toContain(
      'reasoning_effort: "medium"',
    );
  });
});

describe("hermes adapter — env across the sandbox-posture matrix (golden)", () => {
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    writeSafeRoot: string | undefined;
  }[] = [
    {
      sandbox: "workspace",
      network: true,
      writeSafeRoot: `/work/tree:${HERMES_HOME}`,
    },
    {
      sandbox: "workspace",
      network: false,
      // Local backend: no network filter (research §5 residual gap).
      writeSafeRoot: `/work/tree:${HERMES_HOME}`,
    },
    {
      sandbox: "read-only",
      network: true,
      // Only private home writable via write_file/patch tools.
      writeSafeRoot: HERMES_HOME,
    },
    {
      sandbox: "read-only",
      network: false,
      writeSafeRoot: HERMES_HOME,
    },
    { sandbox: "full", network: true, writeSafeRoot: undefined },
    { sandbox: "full", network: false, writeSafeRoot: undefined },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network} → HERMES_WRITE_SAFE_ROOT=${c.writeSafeRoot ?? "(unset)"}`, async () => {
      const adapter = createHermesAdapter({});
      const plan = await adapter.prepare(spec({ sandbox: c.sandbox, network: c.network }), HUB);
      expect(plan.env.HERMES_HOME).toBe(HERMES_HOME);
      expect(plan.env.HERMES_YOLO_MODE).toBe("1");
      expect(plan.env.HERMES_ACCEPT_HOOKS).toBe("1");
      if (c.writeSafeRoot === undefined) {
        expect("HERMES_WRITE_SAFE_ROOT" in plan.env).toBe(false);
      } else {
        expect(plan.env.HERMES_WRITE_SAFE_ROOT).toBe(c.writeSafeRoot);
      }
    });
  }

  it("workspace + gitDir/gitCommonDir grants those roots for git commit", async () => {
    const plan = await createHermesAdapter({}).prepare(
      spec({
        gitDir: "/repo/.git/worktrees/t7",
        gitCommonDir: "/repo/.git",
      }),
      HUB,
    );
    const roots = plan.env.HERMES_WRITE_SAFE_ROOT!.split(":");
    expect(roots).toContain("/work/tree");
    expect(roots).toContain(HERMES_HOME);
    expect(roots).toContain("/repo/.git/worktrees/t7");
    expect(roots).toContain("/repo/.git");
  });

  it("resume carries the identical posture env as prepare", async () => {
    const adapter = createHermesAdapter({});
    const s = spec({ sandbox: "read-only", network: false, sessionId: "sess-1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    expect(resumed.env.HERMES_HOME).toBe(prepared.env.HERMES_HOME);
    expect(resumed.env.HERMES_WRITE_SAFE_ROOT).toBe(prepared.env.HERMES_WRITE_SAFE_ROOT);
    expect(resumed.env.HERMES_YOLO_MODE).toBe(prepared.env.HERMES_YOLO_MODE);
  });
});

describe("hermes adapter — auth env passthrough (research §6)", () => {
  it("forwards named provider keys only when the parent set them", async () => {
    const withKeys = await createHermesAdapter({
      OPENROUTER_API_KEY: "or-secret",
      ANTHROPIC_API_KEY: "ant-secret",
      XAI_API_KEY: "xai-secret",
      // Not in the research §6 allow-list — must not be forwarded by us.
      SOME_OTHER_KEY: "nope",
    }).prepare(spec(), HUB);
    expect(withKeys.env.OPENROUTER_API_KEY).toBe("or-secret");
    expect(withKeys.env.ANTHROPIC_API_KEY).toBe("ant-secret");
    expect(withKeys.env.XAI_API_KEY).toBe("xai-secret");
    expect("SOME_OTHER_KEY" in withKeys.env).toBe(false);

    const without = await createHermesAdapter({}).prepare(spec(), HUB);
    expect("OPENROUTER_API_KEY" in without.env).toBe(false);
    expect("ANTHROPIC_API_KEY" in without.env).toBe(false);
    expect("XAI_API_KEY" in without.env).toBe(false);
  });

  it("forwards OPENAI_API_KEY, OPENAI_BASE_URL, GOOGLE_API_KEY, GEMINI_API_KEY", async () => {
    const plan = await createHermesAdapter({
      OPENAI_API_KEY: "oa",
      OPENAI_BASE_URL: "https://example.test/v1",
      GOOGLE_API_KEY: "g",
      GEMINI_API_KEY: "gem",
    }).prepare(spec(), HUB);
    expect(plan.env.OPENAI_API_KEY).toBe("oa");
    expect(plan.env.OPENAI_BASE_URL).toBe("https://example.test/v1");
    expect(plan.env.GOOGLE_API_KEY).toBe("g");
    expect(plan.env.GEMINI_API_KEY).toBe("gem");
  });
});

describe("hermes adapter — materialized config.yaml (MCP + posture)", () => {
  it("injects the MCP hub URL, headers, and raised tool timeout", async () => {
    const adapter = createHermesAdapter({});
    // 5-minute answer timeout → 300s + 60s headroom = 360s (above 300s default).
    const plan = await adapter.prepare(spec({ answerTimeoutMs: 300_000 }), HUB);
    const config = plan.files.find((f) => f.path === CONFIG_PATH);
    expect(config).toBeDefined();
    const yaml = config!.contents;
    expect(yaml).toContain("approvals:");
    expect(yaml).toContain("mode: off");
    expect(yaml).toContain("mcp_servers:");
    expect(yaml).toContain("parley:");
    expect(yaml).toContain('url: "http://127.0.0.1:54321/mcp"');
    expect(yaml).toContain('"x-parley-task": "t7"');
    expect(yaml).toContain("timeout: 360");
    expect(yaml).toContain("connect_timeout: 15");
    expect(yaml).toContain("enabled: true");
    expect(yaml).toContain("backend: local");
    expect(360).toBeGreaterThan(300);
  });

  it("uses default 30-minute answer timeout → tool timeout 1860", async () => {
    const plan = await createHermesAdapter({}).prepare(spec(), HUB);
    const yaml = plan.files.find((f) => f.path === CONFIG_PATH)!.contents;
    expect(yaml).toContain("timeout: 1860");
  });

  it("escapes quotes, backslashes, and control characters in YAML values", async () => {
    const adapter = createHermesAdapter({});
    const hub: HubInfo = {
      url: 'http://127.0.0.1:1/mcp?q="x"\\y',
      headers: { "x-parley-task": "t1\nInjected: true" },
    };
    const plan = await adapter.prepare(spec(), hub);
    const yaml = plan.files.find((f) => f.path === CONFIG_PATH)!.contents;
    expect(yaml).toContain('url: "http://127.0.0.1:1/mcp?q=\\"x\\"\\\\y"');
    // Newline escaped so no injected config line appears.
    expect(yaml).toContain('"x-parley-task": "t1\\u000aInjected: true"');
    expect(yaml).not.toMatch(/^Injected: true$/m);
  });
});

describe("hermes adapter — parseEvent (research §9 line-oriented)", () => {
  const adapter = createHermesAdapter({});

  it("maps non-empty stdout text to message", () => {
    expect(adapter.parseEvent("Implemented the fix and ran the tests.")).toEqual([
      { kind: "message", text: "Implemented the fix and ran the tests." },
    ]);
  });

  it("maps session_id: stderr line to session_meta", () => {
    expect(adapter.parseEvent("session_id: 20260716_143052_a1b2c3")).toEqual([
      { kind: "session_meta", session_id: "20260716_143052_a1b2c3" },
    ]);
  });

  it("maps auth-failure stdout to fatal error", () => {
    const line =
      "No inference provider configured. Run 'hermes model' to choose a provider and";
    expect(adapter.parseEvent(line)).toEqual([{ kind: "error", text: line, fatal: true }]);
  });

  it("maps agent-failed text to fatal error", () => {
    expect(adapter.parseEvent("hermes -z: agent failed: boom")).toEqual([
      { kind: "error", text: "hermes -z: agent failed: boom", fatal: true },
    ]);
  });

  it("tags MCP/approval cancellation as PARLEY-DIAG (non-fatal)", () => {
    const line = "submit_report cancelled by approval gate";
    const events = adapter.parseEvent(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("error");
    expect(events[0]!.fatal).toBeUndefined();
    expect(events[0]!.text).toMatch(/^PARLEY-DIAG/);
  });

  it("never throws on unknown, empty, or whitespace-only lines", () => {
    expect(adapter.parseEvent("")).toEqual([]);
    expect(adapter.parseEvent("   ")).toEqual([]);
    expect(adapter.parseEvent("\t")).toEqual([]);
  });

  it("parses research §8 usage JSON into session_meta with canonical keys", () => {
    const line = fs.readFileSync(path.join(FIXTURES, "v0.17.0-usage.json"), "utf8").trim();
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "session_meta",
        session_id: "20260716_143052_a1b2c3",
        usage: {
          input_tokens: 12840,
          output_tokens: 952,
          cache_read_tokens: 4000,
          cache_write_tokens: 0,
          reasoning_tokens: 600,
          estimated_cost_usd: 0.042,
          cached_tokens: 4000,
        },
      },
    ]);
  });

  it("treats unrelated JSON as opaque ([])", () => {
    expect(adapter.parseEvent('{"type":"unrelated","x":1}')).toEqual([
      // Not usage shape — falls through as plain message text (non-empty).
      { kind: "message", text: '{"type":"unrelated","x":1}' },
    ]);
  });
});

describe("hermes adapter — golden fixtures (research §2 / §8)", () => {
  function replay(file: string): ReturnType<ReturnType<typeof createHermesAdapter>["parseEvent"]> {
    const adapter = createHermesAdapter({});
    const text = fs.readFileSync(path.join(FIXTURES, file), "utf8");
    const lines = text.split("\n");
    // Keep trailing empty lines' last empty out via filter only for pure blank;
    // multi-line auth failure needs every non-final-empty content line.
    return lines.flatMap((line) => adapter.parseEvent(line));
  }

  it("reconstructs the assistant message from a successful quiet stdout", () => {
    const events = replay("v0.17.0-quiet-success.txt");
    expect(events).toEqual([
      { kind: "message", text: "Implemented the fix and ran the tests." },
    ]);
  });

  it("extracts session id from the quiet stderr session line", () => {
    const adapter = createHermesAdapter({});
    const events = replay("v0.17.0-session-id.txt");
    expect(adapter.sessionId(events)).toBe("20260716_143052_a1b2c3");
  });

  it("marks VERIFIED auth-failure stdout as fatal errors", () => {
    const events = replay("v0.17.0-auth-failure.txt");
    // Multi-line error: first line matches the fatal pattern; continuation
    // lines become messages (or also fatal if they match). At least one fatal.
    expect(events.some((e) => e.kind === "error" && e.fatal === true)).toBe(true);
    expect(events.find((e) => e.kind === "error")!.text).toMatch(/No inference provider/);
  });
});

describe("hermes adapter — sessionId extraction", () => {
  const adapter = createHermesAdapter({});

  it("returns the last session_meta session_id (compression may rotate)", () => {
    const events = [
      ...adapter.parseEvent("session_id: 20260716_100000_aaaaaa"),
      ...adapter.parseEvent("some intermediate text"),
      ...adapter.parseEvent("session_id: 20260716_143052_a1b2c3"),
    ];
    expect(adapter.sessionId(events)).toBe("20260716_143052_a1b2c3");
  });

  it("returns undefined when no session id was seen", () => {
    const events = adapter.parseEvent("just a message");
    expect(adapter.sessionId(events)).toBeUndefined();
  });
});

describe("hermes adapter — listModels omitted", () => {
  it("does not expose listModels (research §7: no non-interactive list)", () => {
    const adapter = createHermesAdapter({});
    expect(adapter.listModels).toBeUndefined();
  });
});
