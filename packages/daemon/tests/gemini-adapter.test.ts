import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertGeminiNetworkPosture,
  createGeminiAdapter,
} from "../src/adapters/gemini.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";

/**
 * Golden unit tests for the gemini adapter (#99). Pins argv/env/files across
 * the sandbox-posture matrix and stream-json event normalization against
 * `@google/gemini-cli@0.50.0` (docs/research/gemini-cli-cli-automation.md).
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/gemini/", import.meta.url));

const HUB: HubInfo = {
  url: "http://127.0.0.1:54321/mcp",
  headers: { "x-parley-task": "t9", "X-Parley-Extra": "v" },
};

/** A TaskSpec with the given overrides; defaults match the ADR-0006 posture. */
function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t9",
    name: null,
    prompt: "do the thing",
    vendor: "gemini",
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

describe("gemini adapter — prepare argv (golden)", () => {
  it("builds the pinned headless stream-json invocation (research §2)", async () => {
    const adapter = createGeminiAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "gemini",
      "-p",
      "do the thing",
      "--output-format",
      "stream-json",
      "--approval-mode=yolo",
      "--skip-trust",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("passes the model through with -m when set, omits it otherwise", async () => {
    const adapter = createGeminiAdapter({});
    const withModel = await adapter.prepare(spec({ model: "gemini-3.1-pro-preview" }), HUB);
    expect(withModel.argv).toContain("-m");
    expect(withModel.argv).toContain("gemini-3.1-pro-preview");
    // Model sits in the flags region after --skip-trust.
    const skipIdx = withModel.argv.indexOf("--skip-trust");
    expect(withModel.argv[skipIdx + 1]).toBe("-m");
    expect(withModel.argv[skipIdx + 2]).toBe("gemini-3.1-pro-preview");

    const without = await adapter.prepare(spec({ model: null }), HUB);
    expect(without.argv).not.toContain("-m");
  });

  it("does not emit an effort flag (no surface on 0.50.0; research §6)", async () => {
    // UNKNOWN(research): no verified effort mapping — must not invent flags.
    const plan = await createGeminiAdapter({}).prepare(spec({ effort: "high" }), HUB);
    expect(plan.argv).not.toContain("--effort");
    expect(plan.argv).not.toContain("--reasoning-effort");
    expect(plan.argv.join(" ")).not.toMatch(/effort/i);
  });

  it("splices extraArgs into the flags region (not after a positional prompt)", async () => {
    const plan = await createGeminiAdapter({}).prepare(
      spec({ extraArgs: ["--verbose", "--debug"] }),
      HUB,
    );
    expect(plan.argv).toContain("--verbose");
    expect(plan.argv).toContain("--debug");
    const pIdx = plan.argv.indexOf("-p");
    expect(plan.argv[pIdx + 1]).toBe("do the thing");
    // extraArgs land after known flags, never ambiguous with the -p value.
    expect(plan.argv.indexOf("--verbose")).toBeGreaterThan(pIdx + 1);
    expect(plan.argv).toEqual([
      "gemini",
      "-p",
      "do the thing",
      "--output-format",
      "stream-json",
      "--approval-mode=yolo",
      "--skip-trust",
      "--verbose",
      "--debug",
    ]);
  });

  it("honours PARLEY_GEMINI_BIN override", async () => {
    const adapter = createGeminiAdapter({ PARLEY_GEMINI_BIN: "/opt/gemini/gemini" });
    expect((await adapter.prepare(spec(), HUB)).argv[0]).toBe("/opt/gemini/gemini");
  });
});

describe("gemini adapter — resume argv (golden)", () => {
  it("resumes the persisted session with -r and the answer prompt", async () => {
    const adapter = createGeminiAdapter({});
    const plan = await adapter.resume(spec({ prompt: "the answer", sessionId: "sess-abc" }), HUB);
    expect(plan.argv).toEqual([
      "gemini",
      "-p",
      "the answer",
      "-r",
      "sess-abc",
      "--output-format",
      "stream-json",
      "--approval-mode=yolo",
      "--skip-trust",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("re-materializes the MCP settings on resume", async () => {
    const adapter = createGeminiAdapter({});
    const plan = await adapter.resume(spec({ sessionId: "sess-abc" }), HUB);
    expect(plan.files.map((f) => f.path)).toContain(".gemini/settings.json");
  });

  it("rejects a resume without a session id (would silently start a fresh session)", async () => {
    const adapter = createGeminiAdapter({});
    await expect(adapter.resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });

  it("carries model and extraArgs through resume identically to prepare", async () => {
    const adapter = createGeminiAdapter({});
    const s = spec({
      prompt: "answer",
      sessionId: "sess-1",
      model: "flash",
      extraArgs: ["--foo"],
    });
    const plan = await adapter.resume(s, HUB);
    expect(plan.argv).toContain("-m");
    expect(plan.argv).toContain("flash");
    expect(plan.argv).toContain("--foo");
    expect(plan.argv).toContain("-r");
    expect(plan.argv).toContain("sess-1");
  });
});

describe("gemini adapter — sandbox × network posture matrix (golden)", () => {
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    approval: string;
    sandboxFlag: boolean;
    seatbelt?: string;
  }[] = [
    {
      sandbox: "workspace",
      network: true,
      approval: "yolo",
      sandboxFlag: false,
    },
    {
      sandbox: "read-only",
      network: true,
      approval: "plan",
      sandboxFlag: false,
    },
    {
      sandbox: "full",
      network: true,
      approval: "yolo",
      sandboxFlag: false,
    },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network} → approval=${c.approval} sandboxFlag=${c.sandboxFlag}`, async () => {
      const adapter = createGeminiAdapter({});
      const plan = await adapter.prepare(spec({ sandbox: c.sandbox, network: c.network }), HUB);
      expect(plan.argv).toContain(`--approval-mode=${c.approval}`);
      expect(plan.argv.includes("-s")).toBe(c.sandboxFlag);
      if (c.seatbelt !== undefined) {
        expect(plan.env.SEATBELT_PROFILE).toBe(c.seatbelt);
      } else {
        expect(plan.env.SEATBELT_PROFILE).toBeUndefined();
      }
      // Folder trust always set for project MCP (research §3).
      expect(plan.env.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
      // Always skip-trust on argv too.
      expect(plan.argv).toContain("--skip-trust");
    });
  }

  it("Linux network:false is refused (defect: seatbelt was a silent no-op)", async () => {
    // On this host (linux) SEATBELT_PROFILE/-s do not implement network-off.
    // Old code would emit -s + SEATBELT_PROFILE and claim the posture.
    const adapter = createGeminiAdapter({});
    await expect(
      adapter.prepare(spec({ sandbox: "workspace", network: false }), HUB),
    ).rejects.toThrow(/network:false is not enforced/);
    await expect(
      adapter.prepare(spec({ sandbox: "full", network: false }), HUB),
    ).rejects.toThrow(/network:false is not enforced/);
    await expect(
      adapter.prepare(spec({ sandbox: "read-only", network: false }), HUB),
    ).rejects.toThrow(/network:false is not enforced/);
  });

  it("macOS workspace + network:false is allowed (seatbelt path)", () => {
    expect(() =>
      assertGeminiNetworkPosture(spec({ sandbox: "workspace", network: false }), "darwin"),
    ).not.toThrow();
    expect(() =>
      assertGeminiNetworkPosture(spec({ sandbox: "workspace", network: false }), "linux"),
    ).toThrow(/network:false is not enforced/);
  });

  it("resume refuses the same network:false postures as prepare", async () => {
    const adapter = createGeminiAdapter({});
    await expect(
      adapter.resume(spec({ sandbox: "workspace", network: false, sessionId: "sess-1" }), HUB),
    ).rejects.toThrow(/network:false is not enforced/);
  });

  it("resume carries the identical posture as prepare when network is on", async () => {
    const adapter = createGeminiAdapter({});
    const s = spec({ sandbox: "workspace", network: true, sessionId: "sess-1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    expect(resumed.argv.filter((a) => a.startsWith("--approval-mode") || a === "-s")).toEqual(
      prepared.argv.filter((a) => a.startsWith("--approval-mode") || a === "-s"),
    );
    expect(resumed.env.SEATBELT_PROFILE).toBe(prepared.env.SEATBELT_PROFILE);
  });
});

describe("gemini adapter — gitDir/gitCommonDir include-directories (#107)", () => {
  it("passes --include-directories for gitDir and gitCommonDir (defect: flag unused when set)", async () => {
    const plan = await createGeminiAdapter({}).prepare(
      spec({
        gitDir: "/repo/.git/worktrees/t9",
        gitCommonDir: "/repo/.git",
      }),
      HUB,
    );
    const i = plan.argv.indexOf("--include-directories");
    expect(i).toBeGreaterThan(-1);
    expect(plan.argv[i + 1]).toBe("/repo/.git/worktrees/t9,/repo/.git");
  });

  it("does not duplicate when gitDir === gitCommonDir", async () => {
    const plan = await createGeminiAdapter({}).prepare(
      spec({ gitDir: "/repo/.git", gitCommonDir: "/repo/.git" }),
      HUB,
    );
    expect(plan.argv).toContain("--include-directories");
    expect(plan.argv[plan.argv.indexOf("--include-directories") + 1]).toBe("/repo/.git");
  });

  it("omits --include-directories when neither git root is set", async () => {
    const plan = await createGeminiAdapter({}).prepare(spec(), HUB);
    expect(plan.argv).not.toContain("--include-directories");
  });
});

describe("gemini adapter — MCP injection (.gemini/settings.json)", () => {
  it("materializes httpUrl, headers, raised timeout, and trust:true", async () => {
    const adapter = createGeminiAdapter({});
    // 30 min answer timeout → timeout ms = 1_800_000 + 60_000 headroom.
    const plan = await adapter.prepare(spec({ answerTimeoutMs: 1_800_000 }), HUB);
    const file = plan.files.find((f) => f.path === ".gemini/settings.json");
    expect(file).toBeDefined();
    const json = JSON.parse(file!.contents) as {
      mcpServers: {
        parley: {
          httpUrl: string;
          headers: Record<string, string>;
          timeout: number;
          trust: boolean;
        };
      };
    };
    expect(json.mcpServers.parley.httpUrl).toBe("http://127.0.0.1:54321/mcp");
    expect(json.mcpServers.parley.headers).toEqual({
      "x-parley-task": "t9",
      "X-Parley-Extra": "v",
    });
    expect(json.mcpServers.parley.timeout).toBe(1_860_000);
    expect(json.mcpServers.parley.trust).toBe(true);
  });

  it("raises MCP timeout strictly above the task's answer timeout", async () => {
    const plan = await createGeminiAdapter({}).prepare(spec({ answerTimeoutMs: 300_000 }), HUB);
    const json = JSON.parse(plan.files[0]!.contents) as {
      mcpServers: { parley: { timeout: number } };
    };
    expect(json.mcpServers.parley.timeout).toBe(360_000);
    expect(json.mcpServers.parley.timeout).toBeGreaterThan(300_000);
  });
});

describe("gemini adapter — auth env passthrough (research §6)", () => {
  it("forwards only the named keys, and only when set in the parent", async () => {
    const withKey = await createGeminiAdapter({
      GEMINI_API_KEY: "g-secret",
      GOOGLE_CLOUD_PROJECT: "my-proj",
      // Unrelated parent env must not leak.
      HOME: "/home/user",
      PATH: "/usr/bin",
    }).prepare(spec(), HUB);
    expect(withKey.env.GEMINI_API_KEY).toBe("g-secret");
    expect(withKey.env.GOOGLE_CLOUD_PROJECT).toBe("my-proj");
    expect(withKey.env.HOME).toBeUndefined();
    expect(withKey.env.PATH).toBeUndefined();

    const without = await createGeminiAdapter({}).prepare(spec(), HUB);
    expect("GEMINI_API_KEY" in without.env).toBe(false);
    expect("GOOGLE_CLOUD_PROJECT" in without.env).toBe(false);
    // Trust flag is always present even without auth.
    expect(without.env.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
  });

  it("forwards the full Vertex/GCA set when present", async () => {
    const plan = await createGeminiAdapter({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "p",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      GOOGLE_API_KEY: "gapik",
      GOOGLE_GENAI_USE_GCA: "true",
    }).prepare(spec(), HUB);
    expect(plan.env.GOOGLE_GENAI_USE_VERTEXAI).toBe("true");
    expect(plan.env.GOOGLE_CLOUD_PROJECT).toBe("p");
    expect(plan.env.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
    expect(plan.env.GOOGLE_API_KEY).toBe("gapik");
    expect(plan.env.GOOGLE_GENAI_USE_GCA).toBe("true");
  });
});

describe("gemini adapter — parseEvent (research §9)", () => {
  const adapter = createGeminiAdapter({});

  it("init → session_meta carrying session_id", () => {
    expect(
      adapter.parseEvent(
        '{"type":"init","timestamp":"2026-07-16T08:11:55.484Z","session_id":"a559d264-82c8-48a4-85ec-0fbe645d82e0","model":"auto"}',
      ),
    ).toEqual([{ kind: "session_meta", session_id: "a559d264-82c8-48a4-85ec-0fbe645d82e0" }]);
  });

  it("assistant message → message; user message → opaque", () => {
    expect(
      adapter.parseEvent(
        '{"type":"message","timestamp":"t","role":"assistant","content":"Hi","delta":true}',
      ),
    ).toEqual([{ kind: "message", text: "Hi" }]);
    expect(
      adapter.parseEvent(
        '{"type":"message","timestamp":"t","role":"user","content":"say hi only"}',
      ),
    ).toEqual([]);
  });

  it("tool_use → command with name + parameters", () => {
    expect(
      adapter.parseEvent(
        '{"type":"tool_use","tool_name":"run_shell_command","tool_id":"c1","parameters":{"command":"ls"}}',
      ),
    ).toEqual([{ kind: "command", text: 'run_shell_command {"command":"ls"}' }]);
  });

  it("tool_result success → opaque; error → non-fatal error", () => {
    expect(
      adapter.parseEvent(
        '{"type":"tool_result","tool_id":"c1","status":"success","output":"ok"}',
      ),
    ).toEqual([]);
    expect(
      adapter.parseEvent(
        '{"type":"tool_result","tool_id":"c1","status":"error","error":{"type":"x","message":"tool blew up"}}',
      ),
    ).toEqual([{ kind: "error", text: "tool blew up" }]);
  });

  it("tool_result error implicating parley MCP → PARLEY-DIAG tagged", () => {
    expect(
      adapter.parseEvent(
        '{"type":"tool_result","tool_id":"c1","status":"error","error":{"type":"x","message":"mcp_parley_submit_report cancelled"}}',
      ),
    ).toEqual([
      {
        kind: "error",
        text: "PARLEY-DIAG tool_result failed: mcp_parley_submit_report cancelled",
      },
    ]);
  });

  it("mid-stream error → non-fatal error", () => {
    expect(
      adapter.parseEvent(
        '{"type":"error","timestamp":"t","severity":"error","message":"something odd"}',
      ),
    ).toEqual([{ kind: "error", text: "something odd" }]);
  });

  it("result status=error → fatal error (+ usage when present)", () => {
    const line =
      '{"type":"result","status":"error","error":{"type":"unknown","message":"[API Error: API_KEY_INVALID]"},"stats":{"total_tokens":0,"input_tokens":0,"output_tokens":0,"cached":0,"input":0,"duration_ms":0,"tool_calls":0}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "error", text: "[API Error: API_KEY_INVALID]", fatal: true },
      {
        kind: "session_meta",
        usage: {
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached: 0,
          cached_tokens: 0,
          input: 0,
          duration_ms: 0,
          tool_calls: 0,
        },
      },
    ]);
  });

  it("result status=success → session_meta usage with canonical keys", () => {
    const line =
      '{"type":"result","status":"success","stats":{"total_tokens":120,"input_tokens":80,"output_tokens":40,"cached":10,"input":0,"duration_ms":1200,"tool_calls":1,"models":{"x":{"total_tokens":120}}}}';
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "session_meta",
        usage: {
          total_tokens: 120,
          input_tokens: 80,
          output_tokens: 40,
          cached: 10,
          cached_tokens: 10,
          input: 0,
          duration_ms: 1200,
          tool_calls: 1,
        },
      },
    ]);
  });

  it("unknown / non-JSON / non-object lines pass through opaque ([])", () => {
    expect(adapter.parseEvent('{"type":"totally_new_kind","x":1}')).toEqual([]);
    expect(adapter.parseEvent('{"no":"type"}')).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("null")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
  });
});

describe("gemini adapter — sessionId extraction", () => {
  const adapter = createGeminiAdapter({});

  it("returns the session_id from the last session_meta that carries one", () => {
    const events = [
      ...adapter.parseEvent(
        '{"type":"init","session_id":"sess-42","model":"auto","timestamp":"t"}',
      ),
      ...adapter.parseEvent(
        '{"type":"message","role":"assistant","content":"hi","timestamp":"t"}',
      ),
      ...adapter.parseEvent(
        '{"type":"result","status":"success","stats":{"input_tokens":1,"output_tokens":2,"cached":0}}',
      ),
    ];
    expect(adapter.sessionId(events)).toBe("sess-42");
  });

  it("returns undefined when no session id was seen", () => {
    const events = adapter.parseEvent(
      '{"type":"message","role":"assistant","content":"hi","timestamp":"t"}',
    );
    expect(adapter.sessionId(events)).toBeUndefined();
  });
});

describe("gemini adapter — golden JSONL fixtures (pins observed 0.50.0)", () => {
  function replay(file: string): {
    messages: string;
    sessionId: string | undefined;
    fatals: string[];
    usage: Record<string, number> | undefined;
  } {
    const adapter = createGeminiAdapter({});
    const lines = fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    const messages = events
      .filter((e) => e.kind === "message")
      .map((e) => e.text ?? "")
      .join("");
    const fatals = events
      .filter((e) => e.kind === "error" && e.fatal)
      .map((e) => e.text ?? "");
    let usage: Record<string, number> | undefined;
    for (const e of events) {
      if (e.kind === "session_meta" && e.usage !== undefined) usage = e.usage;
    }
    return { messages, sessionId: adapter.sessionId(events), fatals, usage };
  }

  it("auth-fail path: captures session id, fatal API error, and zero usage", () => {
    // Real stdout lines from research §2 (invalid GEMINI_API_KEY run).
    const { messages, sessionId, fatals, usage } = replay("v0.50.0-auth-fail.jsonl");
    expect(messages).toBe(""); // only a user echo, which is dropped
    expect(sessionId).toBe("a559d264-82c8-48a4-85ec-0fbe645d82e0");
    expect(fatals).toEqual(["[API Error: API_KEY_INVALID]"]);
    expect(usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 0,
    });
  });

  it("success-shape path: reconstructs assistant text, session id, command, usage", () => {
    // Field shapes from research §2/§8/§9 (success path not live-captured;
    // keys match VERIFIED source converters).
    const { messages, sessionId, fatals, usage } = replay("v0.50.0-success-shape.jsonl");
    expect(messages).toBe("Hi there.");
    expect(sessionId).toBe("b661e375-93d9-59b5-96fd-1fcf756e93f1");
    expect(fatals).toEqual([]);
    expect(usage).toMatchObject({
      input_tokens: 80,
      output_tokens: 40,
      cached_tokens: 10,
      total_tokens: 120,
      tool_calls: 1,
    });
  });
});

describe("gemini adapter — listModels omitted (research §7)", () => {
  it("does not expose listModels (no enumeration command on 0.50.0)", () => {
    const adapter = createGeminiAdapter({});
    expect(adapter.listModels).toBeUndefined();
  });
});
