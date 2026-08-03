import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertAntigravityNetworkPosture,
  createAntigravityAdapter,
  formatPrintTimeout,
  parseAgyModels,
} from "../src/adapters/antigravity.js";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import type { HubInfo, TaskSpec } from "../src/adapters/types.js";

/**
 * Golden unit tests for the antigravity adapter (#286). Pins argv/env/files
 * and stream-json event normalization against agy v1.1.7
 * (docs/research/antigravity-cli-automation.md).
 */

const HUB: HubInfo = {
  url: "http://127.0.0.1:54321/mcp",
  headers: { "x-parley-task": "t286", "X-Parley-Extra": "v" },
};

const tempHomes: string[] = [];

afterEach(() => {
  for (const h of tempHomes.splice(0)) {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

/** Operator home with a seed OAuth token (required for prepare/resume). */
function operatorEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-op-"));
  tempHomes.push(root);
  const cli = path.join(root, "antigravity-cli");
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, "antigravity-oauth-token"), "test-token\n");
  fs.writeFileSync(path.join(cli, "installation_id"), "install-1\n");
  return { PARLEY_ANTIGRAVITY_OPERATOR_HOME: root };
}

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t286",
    name: null,
    prompt: "do the thing",
    vendor: "antigravity",
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

describe("antigravity adapter — registry", () => {
  it("is registered as a built-in with childChannel mcp", () => {
    const registry = createAdapterRegistrySync({});
    const adapter = registry.get("antigravity");
    expect(adapter).toBeDefined();
    expect(adapter!.childChannel).toBe("mcp");
    expect(registry.has("gemini")).toBe(false);
  });
});

describe("antigravity adapter — prepare argv (golden)", () => {
  it("builds the pinned headless stream-json invocation (research §2/§9)", async () => {
    const adapter = createAntigravityAdapter(operatorEnv());
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "agy",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "30m0s",
      "-p",
      "do the thing",
    ]);
    expect(plan.cwd).toBe("/work/tree");
    expect(plan.env.HOME).toBe(path.join("/work/tree", ".parley-antigravity"));
  });

  it("passes --model and --effort as separate flags (never flattened id)", async () => {
    const adapter = createAntigravityAdapter(operatorEnv());
    const plan = await adapter.prepare(
      spec({ model: "gemini-3.6-flash", effort: "low" }),
      HUB,
    );
    expect(plan.argv).toContain("--model");
    expect(plan.argv).toContain("gemini-3.6-flash");
    expect(plan.argv).toContain("--effort");
    expect(plan.argv).toContain("low");
    // Never pass the flattened listing id as --model.
    expect(plan.argv).not.toContain("gemini-3.6-flash-low");
    const modelIdx = plan.argv.indexOf("--model");
    const effortIdx = plan.argv.indexOf("--effort");
    expect(plan.argv[modelIdx + 1]).toBe("gemini-3.6-flash");
    expect(plan.argv[effortIdx + 1]).toBe("low");
  });

  it("omits --effort for suffixless models when effort is null", async () => {
    const adapter = createAntigravityAdapter(operatorEnv());
    const plan = await adapter.prepare(
      spec({ model: "claude-sonnet-4-6", effort: null }),
      HUB,
    );
    expect(plan.argv).toContain("--model");
    expect(plan.argv).toContain("claude-sonnet-4-6");
    expect(plan.argv).not.toContain("--effort");
  });

  it("omits --model and --effort when neither is set (no-model default)", async () => {
    const adapter = createAntigravityAdapter(operatorEnv());
    const plan = await adapter.prepare(spec({ model: null, effort: null }), HUB);
    expect(plan.argv).not.toContain("--model");
    expect(plan.argv).not.toContain("--effort");
  });

  it("honours PARLEY_ANTIGRAVITY_BIN override", async () => {
    const env = { ...operatorEnv(), PARLEY_ANTIGRAVITY_BIN: "/opt/agy/agy" };
    const plan = await createAntigravityAdapter(env).prepare(spec(), HUB);
    expect(plan.argv[0]).toBe("/opt/agy/agy");
  });

  it("splices extraArgs into the flags region (not after -p value)", async () => {
    const plan = await createAntigravityAdapter(operatorEnv()).prepare(
      spec({ extraArgs: ["--verbose"] }),
      HUB,
    );
    const pIdx = plan.argv.indexOf("-p");
    expect(plan.argv[pIdx + 1]).toBe("do the thing");
    expect(plan.argv.indexOf("--verbose")).toBeLessThan(pIdx);
  });

  it("passes --add-dir for gitDir / gitCommonDir", async () => {
    const plan = await createAntigravityAdapter(operatorEnv()).prepare(
      spec({
        gitDir: "/repo/.git/worktrees/t",
        gitCommonDir: "/repo/.git",
      }),
      HUB,
    );
    const idxs = plan.argv
      .map((a, i) => (a === "--add-dir" ? i : -1))
      .filter((i) => i >= 0);
    expect(idxs.length).toBe(2);
    expect(plan.argv[idxs[0]! + 1]).toBe("/repo/.git/worktrees/t");
    expect(plan.argv[idxs[1]! + 1]).toBe("/repo/.git");
  });

  it("formats print-timeout from answerTimeoutMs", () => {
    expect(formatPrintTimeout(30 * 60 * 1000)).toBe("30m0s");
    expect(formatPrintTimeout(90_000)).toBe("1m30s");
    expect(formatPrintTimeout(500)).toBe("0m1s");
  });
});

describe("antigravity adapter — resume argv (golden)", () => {
  it("resumes with --conversation and the same HOME", async () => {
    const adapter = createAntigravityAdapter(operatorEnv());
    const plan = await adapter.resume(
      spec({ prompt: "the answer", sessionId: "bfa7ed1b-b6d1-4392-ae88-54d79bde48ad" }),
      HUB,
    );
    expect(plan.argv).toContain("--conversation");
    expect(plan.argv).toContain("bfa7ed1b-b6d1-4392-ae88-54d79bde48ad");
    expect(plan.argv).toContain("-p");
    expect(plan.argv).toContain("the answer");
    expect(plan.env.HOME).toBe(path.join("/work/tree", ".parley-antigravity"));
    // Do not use racy --continue.
    expect(plan.argv).not.toContain("--continue");
    expect(plan.argv).not.toContain("-c");
  });

  it("rejects a resume without a session id", async () => {
    const adapter = createAntigravityAdapter(operatorEnv());
    await expect(adapter.resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });

  it("re-materializes MCP bridge + auth files on resume", async () => {
    const adapter = createAntigravityAdapter(operatorEnv());
    const plan = await adapter.resume(spec({ sessionId: "sess-1" }), HUB);
    const paths = plan.files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith("mcp_config.json"))).toBe(true);
    expect(paths.some((p) => p.endsWith("parley-mcp-bridge.mjs"))).toBe(true);
    expect(paths.some((p) => p.endsWith("antigravity-oauth-token"))).toBe(true);
  });
});

describe("antigravity adapter — sandbox × network posture (golden)", () => {
  it("workspace + network on → dangerously-skip-permissions", async () => {
    const plan = await createAntigravityAdapter(operatorEnv()).prepare(
      spec({ sandbox: "workspace", network: true }),
      HUB,
    );
    expect(plan.argv).toContain("--dangerously-skip-permissions");
    expect(plan.argv).not.toContain("--sandbox");
    expect(plan.argv).not.toContain("--mode");
  });

  it("full + network on → dangerously-skip-permissions, no sandbox", async () => {
    const plan = await createAntigravityAdapter(operatorEnv()).prepare(
      spec({ sandbox: "full", network: true }),
      HUB,
    );
    expect(plan.argv).toContain("--dangerously-skip-permissions");
    expect(plan.argv).not.toContain("--sandbox");
  });

  it("read-only + network on → omit skip-permissions; materialize allow rules", async () => {
    const plan = await createAntigravityAdapter(operatorEnv()).prepare(
      spec({ sandbox: "read-only", network: true }),
      HUB,
    );
    expect(plan.argv).not.toContain("--dangerously-skip-permissions");
    const settings = plan.files.find((f) => f.path.endsWith("settings.json"));
    expect(settings).toBeDefined();
    const json = JSON.parse(settings!.contents) as {
      permissions: { allow: string[] };
    };
    expect(json.permissions.allow).toContain("read_file(*)");
    expect(json.permissions.allow).toContain("call_mcp_tool(*)");
  });

  it("refuses network:false for every sandbox (research §5)", async () => {
    const adapter = createAntigravityAdapter(operatorEnv());
    for (const sandbox of ["workspace", "full", "read-only"] as const) {
      await expect(
        adapter.prepare(spec({ sandbox, network: false }), HUB),
      ).rejects.toThrow(/network:false is not enforced/);
    }
    expect(() =>
      assertAntigravityNetworkPosture(spec({ sandbox: "workspace", network: false })),
    ).toThrow(/network:false is not enforced/);
  });

  it("resume refuses network:false like prepare", async () => {
    const adapter = createAntigravityAdapter(operatorEnv());
    await expect(
      adapter.resume(spec({ sandbox: "workspace", network: false, sessionId: "s1" }), HUB),
    ).rejects.toThrow(/network:false is not enforced/);
  });
});

describe("antigravity adapter — MCP stdio bridge (research §3/§9)", () => {
  it("materializes mcp_config.json with stdio command (not serverUrl/httpUrl)", async () => {
    const plan = await createAntigravityAdapter(operatorEnv()).prepare(spec(), HUB);
    const mcp = plan.files.find((f) => f.path.endsWith("mcp_config.json"));
    expect(mcp).toBeDefined();
    const json = JSON.parse(mcp!.contents) as {
      mcpServers: {
        parley: {
          command: string;
          args: string[];
          env: Record<string, string>;
          serverUrl?: string;
          httpUrl?: string;
          headers?: unknown;
        };
      };
    };
    expect(json.mcpServers.parley.command).toBe("node");
    expect(json.mcpServers.parley.args[0]).toContain("parley-mcp-bridge.mjs");
    expect(json.mcpServers.parley.env.PARLEY_TASK_ID).toBe("t286");
    expect(json.mcpServers.parley.serverUrl).toBeUndefined();
    expect(json.mcpServers.parley.httpUrl).toBeUndefined();
    expect(json.mcpServers.parley.headers).toBeUndefined();
  });

  it("embeds hub base + task correlation in the bridge source", async () => {
    const plan = await createAntigravityAdapter(operatorEnv()).prepare(spec(), HUB);
    const bridge = plan.files.find((f) => f.path.endsWith("parley-mcp-bridge.mjs"));
    expect(bridge).toBeDefined();
    expect(bridge!.contents).toContain("http://127.0.0.1:54321");
    expect(bridge!.contents).toContain("t286");
    expect(bridge!.contents).toContain("submit_report");
    expect(bridge!.contents).toContain("ask_orchestrator");
    expect(bridge!.contents).toContain("/child/report");
  });
});

describe("antigravity adapter — parseEvent stream-json (research §2/§9)", () => {
  const adapter = createAntigravityAdapter({});

  it("init → session_meta with conversation_id", () => {
    expect(
      adapter.parseEvent(
        JSON.stringify({
          event: "init",
          conversation_id: "6e86e734-6975-4c04-a496-4da04312d36f",
          init: {
            model: "gemini-3.6-flash",
            cwd: "/scratch",
            tools: ["view_file"],
            permission_mode: "always-proceed",
          },
        }),
      ),
    ).toEqual([
      {
        kind: "session_meta",
        session_id: "6e86e734-6975-4c04-a496-4da04312d36f",
        model: "gemini-3.6-flash",
      },
    ]);
  });

  it("step_update agent_response → message; tool ACTIVE → command", () => {
    expect(
      adapter.parseEvent(
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "c1",
            step_index: 2,
            state: "ACTIVE",
            step_type: "agent_response",
            text_delta: "OK",
          },
        }),
      ),
    ).toEqual([{ kind: "message", text: "OK" }]);

    expect(
      adapter.parseEvent(
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "c1",
            step_index: 3,
            state: "ACTIVE",
            step_type: "tool",
            tool_name: "write_to_file",
            tool_info: {
              name: "write_to_file",
              parameters: { TargetFile: "/tmp/x" },
            },
          },
        }),
      ),
    ).toEqual([{ kind: "command", text: 'write_to_file {"TargetFile":"/tmp/x"}' }]);
  });

  it("step_update tool DONE / user_input / checkpoint / unknown → opaque", () => {
    for (const step_type of ["user_input", "checkpoint", "unknown", "brand_new"]) {
      expect(
        adapter.parseEvent(
          JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "c1",
              step_index: 0,
              state: "DONE",
              step_type,
            },
          }),
        ),
      ).toEqual([]);
    }
  });

  it("result SUCCESS + non-empty response → session_meta usage", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "6e86e734-6975-4c04-a496-4da04312d36f",
          status: "SUCCESS",
          response: "OK\n",
          duration_seconds: 1.6,
          num_turns: 1,
          usage: {
            input_tokens: 18095,
            output_tokens: 6,
            thinking_tokens: 0,
            cache_read_tokens: 8141,
            total_tokens: 18101,
          },
        },
      }),
    );
    expect(events).toEqual([
      {
        kind: "session_meta",
        session_id: "6e86e734-6975-4c04-a496-4da04312d36f",
        usage: {
          input_tokens: 18095,
          output_tokens: 6,
          thinking_tokens: 0,
          cache_read_tokens: 8141,
          cached_tokens: 8141,
          total_tokens: 18101,
        },
      },
    ]);
  });

  it("result SUCCESS + empty response ⇒ fatal failure (auto-deny triple)", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "c1",
          status: "SUCCESS",
          response: "",
          usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        },
      }),
    );
    expect(events[0]).toMatchObject({
      kind: "error",
      fatal: true,
    });
    expect(events[0]!.text).toMatch(/PARLEY-DIAG/);
    expect(events[0]!.text).toMatch(/empty response|auto-denied/i);
  });

  it("result ERROR → fatal error (+ usage)", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "",
          status: "ERROR",
          response: "",
          error: "authentication failed or timed out",
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      }),
    );
    expect(events[0]).toEqual({
      kind: "error",
      text: "authentication failed or timed out",
      fatal: true,
    });
  });

  it("jetski stderr line ⇒ fatal PARLEY-DIAG failure", () => {
    const line =
      'jetski: no output produced — a tool required the "read_file" permission ' +
      "that headless mode cannot prompt for, so it was auto-denied.";
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "error", text: `PARLEY-DIAG ${line}`, fatal: true },
    ]);
  });

  it("unknown / non-JSON lines pass through opaque ([])", () => {
    expect(adapter.parseEvent('{"event":"totally_new","x":1}')).toEqual([]);
    expect(adapter.parseEvent("not json")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
  });
});

describe("antigravity adapter — sessionId extraction", () => {
  const adapter = createAntigravityAdapter({});

  it("returns conversation_id from the last session_meta", () => {
    const events = [
      ...adapter.parseEvent(
        JSON.stringify({
          event: "init",
          conversation_id: "sess-42",
          init: { model: "gemini-3.6-flash" },
        }),
      ),
      ...adapter.parseEvent(
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "sess-42",
            status: "SUCCESS",
            response: "hi",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
      ),
    ];
    expect(adapter.sessionId(events)).toBe("sess-42");
  });

  it("returns undefined when no session id was seen", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "agent_response",
          state: "ACTIVE",
          text_delta: "hi",
        },
      }),
    );
    expect(adapter.sessionId(events)).toBeUndefined();
  });
});

describe("antigravity adapter — models listing parse (research §7)", () => {
  it("parses piped ids-only form into base ids + efforts", () => {
    const piped = [
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "gemini-3.5-flash-high",
      "gemini-3.5-flash-medium",
      "gemini-3.5-flash-low",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ].join("\n");
    const models = parseAgyModels(piped);
    const byId = new Map(models.map((m) => [m.id, m]));
    expect(byId.get("gemini-3.6-flash")?.efforts).toEqual(["high", "medium", "low"]);
    expect(byId.get("gemini-3.5-flash")?.efforts).toEqual(["high", "medium", "low"]);
    expect(byId.get("gemini-3.1-pro")?.efforts).toEqual(["high", "low"]);
    // Never synthesize medium for gemini-3.1-pro.
    expect(byId.get("gemini-3.1-pro")?.efforts).not.toContain("medium");
    // -thinking is part of the id, not an effort.
    expect(byId.get("claude-opus-4-6-thinking")?.efforts).toEqual([]);
    expect(byId.has("claude-opus-4-6")).toBe(false);
    expect(byId.get("claude-sonnet-4-6")?.efforts).toEqual([]);
    expect(byId.get("gpt-oss-120b")?.efforts).toEqual(["medium"]);
    expect(models).toHaveLength(6);
  });

  it("parses TTY two-column form and preserves labels", () => {
    const tty = [
      "gemini-3.6-flash-high     Gemini 3.6 Flash (High)",
      "gemini-3.6-flash-low      Gemini 3.6 Flash (Low)",
      "claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)",
      "gpt-oss-120b-medium       GPT-OSS 120B (Medium)",
    ].join("\n");
    const models = parseAgyModels(tty);
    const byId = new Map(models.map((m) => [m.id, m]));
    expect(byId.get("gemini-3.6-flash")?.efforts).toEqual(["high", "low"]);
    expect(byId.get("gemini-3.6-flash")?.label).toBe("Gemini 3.6 Flash (High)");
    expect(byId.get("claude-opus-4-6-thinking")?.label).toBe("Claude Opus 4.6 (Thinking)");
    expect(byId.get("gpt-oss-120b")?.label).toBe("GPT-OSS 120B (Medium)");
  });

  it("exposes listModels on the adapter", () => {
    const adapter = createAntigravityAdapter({});
    expect(typeof adapter.listModels).toBe("function");
    expect(typeof adapter.readModels).toBe("function");
  });
});

describe("antigravity adapter — missing auth fails loud (research §6)", () => {
  it("prepare rejects when the OAuth token is absent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-empty-"));
    tempHomes.push(root);
    fs.mkdirSync(path.join(root, "antigravity-cli"), { recursive: true });
    const adapter = createAntigravityAdapter({
      PARLEY_ANTIGRAVITY_OPERATOR_HOME: root,
    });
    await expect(adapter.prepare(spec(), HUB)).rejects.toThrow(/OAuth token|sign in/i);
  });
});
