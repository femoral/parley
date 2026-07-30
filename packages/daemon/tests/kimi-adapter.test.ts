import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKimiAdapter,
  KIMI_CODE_HOME_REL,
  KIMI_CONFIG_TOML_REL,
  KIMI_MCP_JSON_REL,
} from "../src/adapters/kimi.js";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";
import { buildProtocolPreamble } from "../src/preamble.js";
import { DEFAULT_REPORT_SCHEMA } from "../src/report.js";

/**
 * Golden unit tests for the kimi adapter — pure-function exception to the
 * suite's CLI-boundary rule (spec §10). Pins argv/env/files against
 * docs/research/kimi-code-cli.md shapes (no live binary in this environment).
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/kimi/", import.meta.url));

const HUB: HubInfo = {
  url: "http://127.0.0.1:54321/mcp",
  headers: { "x-parley-task": "t160" },
};

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t160",
    name: null,
    prompt: "do the thing",
    vendor: "kimi",
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

function expectedHome(cwd = "/work/tree"): string {
  return path.resolve(cwd, KIMI_CODE_HOME_REL);
}

describe("kimi adapter — registration", () => {
  it("is registered as a built-in with childChannel mcp", () => {
    const registry = createAdapterRegistrySync({});
    const adapter = registry.get("kimi");
    expect(adapter).toBeDefined();
    expect(adapter!.id).toBe("kimi");
    expect(adapter!.childChannel).toBe("mcp");
    // Hardcoded default retired in #281 — discovery reads operator config instead.
    expect(adapter!.defaultModel).toBeUndefined();
  });

  it("declares non-enforcing postures (#279)", () => {
    const adapter = createKimiAdapter({});
    expect(adapter.enforcement["read-only"].level).toBe("approximate");
    expect(adapter.enforcement.workspace.level).toBe("none");
    expect(adapter.enforcement.full.level).toBe("enforced");
    expect(adapter.enforcement["network:false"].level).toBe("none");
  });

  it("emits prepare-time PARLEY-DIAG for weak postures (#279)", async () => {
    const plan = await createKimiAdapter({}).prepare(
      spec({ sandbox: "read-only", network: false }),
      HUB,
    );
    const diags = plan.diagnostics ?? [];
    expect(diags.some((d) => /PARLEY-DIAG posture: kimi sandbox=read-only/.test(d))).toBe(true);
    expect(diags.some((d) => /PARLEY-DIAG posture: kimi network=false/.test(d))).toBe(true);
  });

  it("emits no posture PARLEY-DIAG for sandbox=full + network=true (#279)", async () => {
    const plan = await createKimiAdapter({}).prepare(
      spec({ sandbox: "full", network: true }),
      HUB,
    );
    const postureDiags = (plan.diagnostics ?? []).filter((d) =>
      d.startsWith("PARLEY-DIAG posture:"),
    );
    expect(postureDiags).toEqual([]);
  });

  it("preamble for declared channel teaches MCP tools only", () => {
    const adapter = createAdapterRegistrySync({}).get("kimi")!;
    const text = buildProtocolPreamble({
      cwd: "/work/tree",
      branch: "parley/t160-kimi",
      answerTimeoutMs: 1_800_000,
      reportSchema: DEFAULT_REPORT_SCHEMA,
      childChannel: adapter.childChannel,
    });
    expect(text).toContain("ask_orchestrator({ question })");
    expect(text).toContain("submit_report({ ... })");
    expect(text).not.toContain("parley child ask");
    expect(text).not.toContain("curl");
  });
});

describe("kimi adapter — prepare argv (golden)", () => {
  it("builds the pinned headless stream-json invocation", async () => {
    const adapter = createKimiAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "kimi",
      "-p",
      "do the thing",
      "--output-format",
      "stream-json",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("passes the model with -m when set, omits it otherwise", async () => {
    const adapter = createKimiAdapter({});
    const withModel = await adapter.prepare(spec({ model: "kimi-for-coding" }), HUB);
    expect(withModel.argv).toContain("-m");
    expect(withModel.argv).toContain("kimi-for-coding");
    // Model is in the flags region after -p <prompt>.
    expect(withModel.argv.indexOf("-m")).toBeGreaterThan(withModel.argv.indexOf("-p"));
    const without = await adapter.prepare(spec({ model: null }), HUB);
    expect(without.argv).not.toContain("-m");
  });

  it("maps effort to KIMI_MODEL_THINKING_EFFORT env (no inventing CLI flags)", async () => {
    const adapter = createKimiAdapter({});
    const withEffort = await adapter.prepare(spec({ effort: "high" }), HUB);
    expect(withEffort.env.KIMI_MODEL_THINKING_EFFORT).toBe("high");
    expect(withEffort.argv).not.toContain("--reasoning-effort");
    expect(withEffort.argv).not.toContain("--effort");
    const without = await adapter.prepare(spec({ effort: null }), HUB);
    expect("KIMI_MODEL_THINKING_EFFORT" in without.env).toBe(false);
  });

  it("maps model onto KIMI_MODEL_NAME env family as well as -m", async () => {
    const plan = await createKimiAdapter({}).prepare(
      spec({ model: "kimi-k2.5" }),
      HUB,
    );
    expect(plan.env.KIMI_MODEL_NAME).toBe("kimi-k2.5");
    expect(plan.argv).toContain("kimi-k2.5");
  });

  it("splices extraArgs into the flags region after known flags", async () => {
    const plan = await createKimiAdapter({}).prepare(
      spec({ extraArgs: ["--add-dir", "/extra", "--verbose"] }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "kimi",
      "-p",
      "do the thing",
      "--output-format",
      "stream-json",
      "--add-dir",
      "/extra",
      "--verbose",
    ]);
  });

  it("honours PARLEY_KIMI_BIN override", async () => {
    const adapter = createKimiAdapter({ PARLEY_KIMI_BIN: "/opt/kimi/kimi" });
    expect((await adapter.prepare(spec(), HUB)).argv[0]).toBe("/opt/kimi/kimi");
  });

  it("never passes legacy --print or -c (continue) as the prompt channel", async () => {
    const plan = await createKimiAdapter({}).prepare(spec(), HUB);
    expect(plan.argv).not.toContain("--print");
    // -c is --continue on current CLI; prompt must be -p only (research §3).
    expect(plan.argv).not.toContain("-c");
    expect(plan.argv).toContain("-p");
  });

  it("uses --plan only for read-only sandbox", async () => {
    const adapter = createKimiAdapter({});
    expect((await adapter.prepare(spec({ sandbox: "read-only" }), HUB)).argv).toContain(
      "--plan",
    );
    expect((await adapter.prepare(spec({ sandbox: "workspace" }), HUB)).argv).not.toContain(
      "--plan",
    );
    expect((await adapter.prepare(spec({ sandbox: "full" }), HUB)).argv).not.toContain(
      "--plan",
    );
  });
});

describe("kimi adapter — isolated home & env (no provider-key passthrough)", () => {
  it("pins KIMI_CODE_HOME under the worktree", async () => {
    const plan = await createKimiAdapter({}).prepare(spec(), HUB);
    expect(plan.env.KIMI_CODE_HOME).toBe(expectedHome());
  });

  it("materializes generated config.toml under the isolated home", async () => {
    const plan = await createKimiAdapter({}).prepare(spec(), HUB);
    const config = plan.files.find((f) => f.path === KIMI_CONFIG_TOML_REL);
    expect(config).toBeDefined();
    expect(config!.contents).toContain("Generated by parley");
    // No hardcoded default model when TaskSpec.model is null (#281).
    expect(config!.contents).not.toContain("default_model");
    expect(config!.contents).not.toContain("kimi-for-coding");
  });

  it("pins default_model in isolated config only when TaskSpec names a model", async () => {
    const plan = await createKimiAdapter({}).prepare(
      spec({ model: "kimi-code/k3" }),
      HUB,
    );
    const config = plan.files.find((f) => f.path === KIMI_CONFIG_TOML_REL);
    expect(config!.contents).toContain('default_model = "kimi-code/k3"');
  });

  it("does not pass shell provider API keys (research §9 — not read by binary)", async () => {
    const plan = await createKimiAdapter({
      KIMI_API_KEY: "should-not-pass",
      ANTHROPIC_API_KEY: "also-not",
      OPENAI_API_KEY: "nope",
    }).prepare(spec(), HUB);
    expect("KIMI_API_KEY" in plan.env).toBe(false);
    expect("ANTHROPIC_API_KEY" in plan.env).toBe(false);
    expect("OPENAI_API_KEY" in plan.env).toBe(false);
  });

  it("forwards parent KIMI_MODEL_* family when set", async () => {
    const plan = await createKimiAdapter({
      KIMI_MODEL_API_KEY: "kimi-model-secret",
      KIMI_MODEL_PROVIDER_TYPE: "kimi",
      KIMI_MODEL_BASE_URL: "https://api.example/v1",
    }).prepare(spec(), HUB);
    expect(plan.env.KIMI_MODEL_API_KEY).toBe("kimi-model-secret");
    expect(plan.env.KIMI_MODEL_PROVIDER_TYPE).toBe("kimi");
    expect(plan.env.KIMI_MODEL_BASE_URL).toBe("https://api.example/v1");
  });

  it("TaskSpec model/effort override ambient KIMI_MODEL_* name/effort", async () => {
    const plan = await createKimiAdapter({
      KIMI_MODEL_NAME: "ambient",
      KIMI_MODEL_THINKING_EFFORT: "low",
    }).prepare(spec({ model: "delegated-model", effort: "high" }), HUB);
    expect(plan.env.KIMI_MODEL_NAME).toBe("delegated-model");
    expect(plan.env.KIMI_MODEL_THINKING_EFFORT).toBe("high");
  });
});

describe("kimi adapter — MCP child channel wiring", () => {
  it("materializes project-scoped .kimi-code/mcp.json with hub + timeouts", async () => {
    const plan = await createKimiAdapter({}).prepare(spec(), HUB);
    const mcp = plan.files.find((f) => f.path === KIMI_MCP_JSON_REL);
    expect(mcp).toBeDefined();
    const body = JSON.parse(mcp!.contents) as {
      mcpServers: {
        parley: {
          url: string;
          headers: Record<string, string>;
          startupTimeoutMs: number;
          toolTimeoutMs: number;
        };
      };
    };
    expect(body.mcpServers.parley.url).toBe("http://127.0.0.1:54321/mcp");
    expect(body.mcpServers.parley.headers["x-parley-task"]).toBe("t160");
    expect(body.mcpServers.parley.startupTimeoutMs).toBe(30_000);
    // answerTimeoutMs 30m + 60s headroom
    expect(body.mcpServers.parley.toolTimeoutMs).toBe(30 * 60 * 1000 + 60_000);
  });

  it("raises toolTimeoutMs with answerTimeoutMs", async () => {
    const plan = await createKimiAdapter({}).prepare(
      spec({ answerTimeoutMs: 120_000 }),
      HUB,
    );
    const body = JSON.parse(
      plan.files.find((f) => f.path === KIMI_MCP_JSON_REL)!.contents,
    ) as { mcpServers: { parley: { toolTimeoutMs: number } } };
    expect(body.mcpServers.parley.toolTimeoutMs).toBe(180_000);
  });
});

describe("kimi adapter — no-resume fallback (fresh semantics)", () => {
  it("resume matches prepare argv (no -S/-r; composition UNVERIFIED)", async () => {
    const adapter = createKimiAdapter({});
    const s = spec({
      prompt: "the answer",
      sessionId: "kimi-sess-stale",
      model: "kimi-for-coding",
      effort: "high",
    });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    expect(resumed.argv).toEqual(prepared.argv);
    expect(resumed.argv).not.toContain("-S");
    expect(resumed.argv).not.toContain("--session");
    expect(resumed.argv).not.toContain("-r");
    expect(resumed.argv).not.toContain("--resume");
    expect(resumed.argv).not.toContain("kimi-sess-stale");
  });

  it("resume re-materializes isolated home + MCP and keeps env posture", async () => {
    const adapter = createKimiAdapter({});
    const s = spec({ sessionId: "sess-1", sandbox: "read-only" as SandboxMode });
    const resumed = await adapter.resume(s, HUB);
    expect(resumed.env.KIMI_CODE_HOME).toBe(expectedHome());
    expect(resumed.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([KIMI_CONFIG_TOML_REL, KIMI_MCP_JSON_REL]),
    );
    expect(resumed.argv).toContain("--plan");
  });

  it("resume without session id still builds a fresh plan (no hard reject)", async () => {
    const plan = await createKimiAdapter({}).resume(spec({ prompt: "follow-up" }), HUB);
    expect(plan.argv[0]).toBe("kimi");
    expect(plan.argv).toContain("-p");
    expect(plan.argv).toContain("follow-up");
  });
});

describe("kimi adapter — parseEvent (docs JSONL shapes)", () => {
  const adapter = createKimiAdapter({});

  it("maps assistant content to message and meta session id", () => {
    expect(
      adapter.parseEvent(
        JSON.stringify({
          role: "meta",
          type: "session.resume_hint",
          session_id: "sid-1",
        }),
      ),
    ).toEqual([{ kind: "session_meta", session_id: "sid-1" }]);
    expect(
      adapter.parseEvent(JSON.stringify({ role: "assistant", content: "Hi" })),
    ).toEqual([{ kind: "message", text: "Hi" }]);
  });

  it("maps tool_calls Shell → command and Write → file_change", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            type: "function",
            id: "tc_1",
            function: { name: "Shell", arguments: '{"command":"ls"}' },
          },
          {
            type: "function",
            id: "tc_2",
            function: { name: "Write", arguments: '{"path":"a"}' },
          },
        ],
      }),
    );
    expect(events).toContainEqual({
      kind: "command",
      text: 'Shell {"command":"ls"}',
    });
    expect(events).toContainEqual({
      kind: "file_change",
      text: 'Write {"path":"a"}',
    });
  });

  it("never invents usage when absent or when fields are null", () => {
    expect(adapter.parseEvent(JSON.stringify({ role: "assistant", content: "x" }))).toEqual([
      { kind: "message", text: "x" },
    ]);
    // Explicit usage record with only nulls → no session_meta usage event.
    expect(
      adapter.parseEvent(
        JSON.stringify({
          type: "usage",
          usage: { input_tokens: null, output_tokens: null },
        }),
      ),
    ).toEqual([]);
  });

  it("keeps numeric usage when actually present on the stream", () => {
    expect(
      adapter.parseEvent(
        JSON.stringify({
          type: "usage",
          usage: { input_tokens: 10, output_tokens: 4, cached_tokens: 2 },
        }),
      ),
    ).toEqual([
      {
        kind: "session_meta",
        usage: { input_tokens: 10, output_tokens: 4, cached_tokens: 2 },
      },
    ]);
  });

  it("treats unrecognized / malformed lines as opaque (raw log preserves them)", () => {
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
    expect(adapter.parseEvent(JSON.stringify({ role: "totally_new", x: 1 }))).toEqual([]);
    expect(adapter.parseEvent(JSON.stringify({ type: "unknown.event" }))).toEqual([]);
  });

  it("surfaces fatal auth-shaped plain text", () => {
    expect(adapter.parseEvent("Error: authentication failed: missing API key")).toEqual([
      {
        kind: "error",
        text: "Error: authentication failed: missing API key",
        fatal: true,
      },
    ]);
  });

  it("scrapes a human kimi -r hint from non-JSON lines", () => {
    expect(adapter.parseEvent("Resume with: kimi -r abc-def-123")).toEqual([
      { kind: "session_meta", session_id: "abc-def-123" },
    ]);
  });
});

describe("kimi adapter — golden JSONL fixtures (docs shapes)", () => {
  function replay(file: string): {
    messages: string[];
    sessionId: string | undefined;
    usage: Record<string, number> | undefined;
    commands: string[];
    fileChanges: string[];
  } {
    const adapter = createKimiAdapter({});
    const lines = fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    let usage: Record<string, number> | undefined;
    for (const e of events) {
      if (e.kind === "session_meta" && e.usage !== undefined) {
        usage = { ...usage, ...e.usage };
      }
    }
    return {
      messages: events.filter((e) => e.kind === "message").map((e) => e.text ?? ""),
      sessionId: adapter.sessionId(events),
      usage,
      commands: events.filter((e) => e.kind === "command").map((e) => e.text ?? ""),
      fileChanges: events.filter((e) => e.kind === "file_change").map((e) => e.text ?? ""),
    };
  }

  it("captures session id and assistant text from a fresh run fixture", () => {
    const { messages, sessionId, usage } = replay("docs-fresh.jsonl");
    expect(sessionId).toBe("kimi-sess-019f4a01-fresh");
    expect(messages).toEqual(["Hello from Kimi Code."]);
    // No usage on stream → honest null (undefined accumulation).
    expect(usage).toBeUndefined();
  });

  it("normalizes tool_calls from the tool-use fixture", () => {
    const { messages, sessionId, commands, fileChanges, usage } = replay("docs-tool-use.jsonl");
    expect(sessionId).toBe("kimi-sess-019f4a02-tools");
    expect(messages.some((m) => m.includes("NOTE.md"))).toBe(true);
    expect(commands.some((c) => c.startsWith("Shell"))).toBe(true);
    expect(fileChanges.some((f) => f.startsWith("Write"))).toBe(true);
    expect(usage).toBeUndefined();
  });

  it("null-usage honesty: docs-no-usage fixture never invents tokens", () => {
    const { sessionId, usage, messages } = replay("docs-no-usage.jsonl");
    expect(sessionId).toBe("kimi-sess-019f4a03-nousage");
    expect(messages).toEqual(["pong"]);
    expect(usage).toBeUndefined();
  });

  it("null-usage honesty: explicit null usage fields stay absent", () => {
    const { sessionId, usage } = replay("docs-usage-nulls.jsonl");
    expect(sessionId).toBe("kimi-sess-019f4a04-nullusage");
    expect(usage).toBeUndefined();
  });
});
