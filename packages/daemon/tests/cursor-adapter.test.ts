import { describe, expect, it } from "vitest";
import {
  CURSOR_MCP_TOOL_TIMEOUT_MS,
  createCursorAdapter,
  cursorCliConfigJson,
  parseCursorModels,
} from "../src/adapters/cursor.js";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import type { HubInfo, TaskSpec } from "../src/adapters/types.js";

/**
 * Golden unit tests for the cursor adapter (#300 / ADR-0027). Pins argv,
 * materialized files and stream-json normalization against the Cursor CLI
 * surface verified live on 2026-08-03: header-carrying project mcp.json,
 * cli.json deny precedence (holds under --force), the 60s MCP tool cap,
 * --trust as a headless requirement, and opaque effort-less model ids.
 */

const HUB: HubInfo = {
  url: "http://127.0.0.1:54321/mcp",
  headers: { "x-parley-task": "t300" },
};

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t300",
    name: null,
    prompt: "do the thing",
    vendor: "cursor",
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

describe("cursor adapter — registry", () => {
  it("is registered as a built-in with childChannel mcp", () => {
    const registry = createAdapterRegistrySync({});
    const adapter = registry.get("cursor");
    expect(adapter).toBeDefined();
    expect(adapter!.childChannel).toBe("mcp");
  });
});

describe("cursor adapter — prepare argv (golden)", () => {
  it("builds the pinned headless stream-json invocation (prompt positional last)", async () => {
    const adapter = createCursorAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "cursor-agent",
      "-p",
      "--output-format",
      "stream-json",
      "--approve-mcps",
      "--trust",
      "--force",
      "do the thing",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("respects PARLEY_CURSOR_BIN and passes the model id through opaquely", async () => {
    const adapter = createCursorAdapter({ PARLEY_CURSOR_BIN: "/opt/bin/cursor-agent" });
    const plan = await adapter.prepare(
      spec({ model: "claude-opus-5-thinking-high-fast" }),
      HUB,
    );
    expect(plan.argv[0]).toBe("/opt/bin/cursor-agent");
    const modelIdx = plan.argv.indexOf("--model");
    expect(plan.argv[modelIdx + 1]).toBe("claude-opus-5-thinking-high-fast");
  });

  it("omits --force for read-only and keeps --trust (headless trust prompt exits 1)", async () => {
    const adapter = createCursorAdapter({});
    const plan = await adapter.prepare(spec({ sandbox: "read-only" }), HUB);
    expect(plan.argv).not.toContain("--force");
    expect(plan.argv).toContain("--trust");
  });

  it("never passes --sandbox (verified Linux no-op)", async () => {
    const adapter = createCursorAdapter({});
    for (const sandbox of ["read-only", "workspace", "full"] as const) {
      const plan = await adapter.prepare(spec({ sandbox }), HUB);
      expect(plan.argv).not.toContain("--sandbox");
    }
  });

  it("adds worktree git dirs via --add-dir, deduped", async () => {
    const adapter = createCursorAdapter({});
    const plan = await adapter.prepare(
      spec({ gitDir: "/repo/.git/worktrees/wt", gitCommonDir: "/repo/.git" }),
      HUB,
    );
    expect(plan.argv).toContain("/repo/.git/worktrees/wt");
    expect(plan.argv).toContain("/repo/.git");
    const same = await adapter.prepare(
      spec({ gitDir: "/repo/.git", gitCommonDir: "/repo/.git" }),
      HUB,
    );
    expect(same.argv.filter((a) => a === "/repo/.git")).toHaveLength(1);
  });

  it("splices extraArgs into the flags region, before the positional prompt", async () => {
    const adapter = createCursorAdapter({});
    const plan = await adapter.prepare(spec({ extraArgs: ["--plugin-dir", "/x"] }), HUB);
    const promptIdx = plan.argv.indexOf("do the thing");
    expect(plan.argv.indexOf("--plugin-dir")).toBeLessThan(promptIdx);
    expect(promptIdx).toBe(plan.argv.length - 1);
  });

  it("forwards CURSOR_API_KEY only when the daemon has it", async () => {
    const withKey = await createCursorAdapter({ CURSOR_API_KEY: "k" }).prepare(spec(), HUB);
    expect(withKey.env).toEqual({ CURSOR_API_KEY: "k" });
    const without = await createCursorAdapter({}).prepare(spec(), HUB);
    expect(without.env).toEqual({});
  });
});

describe("cursor adapter — materialized files", () => {
  it("writes the hub MCP config with correlation headers (verified honored)", async () => {
    const adapter = createCursorAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    const mcp = plan.files.find((f) => f.path === ".cursor/mcp.json");
    expect(mcp).toBeDefined();
    const parsed = JSON.parse(mcp!.contents) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(parsed.mcpServers.parley!.url).toBe(HUB.url);
    expect(parsed.mcpServers.parley!.headers).toEqual(HUB.headers);
  });

  it("writes posture permissions: read-only denies Write/Shell, allows reads + hub MCP", () => {
    const parsed = JSON.parse(cursorCliConfigJson({ sandbox: "read-only", network: true })) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(parsed.permissions.deny).toEqual(["Write(**)", "Shell(**)"]);
    expect(parsed.permissions.allow).toEqual(["Read(**)", "Mcp(parley:*)"]);
  });

  it("adds the WebFetch deny for network:false in every sandbox mode", () => {
    for (const sandbox of ["read-only", "workspace", "full"] as const) {
      const parsed = JSON.parse(cursorCliConfigJson({ sandbox, network: false })) as {
        permissions: { deny: string[] };
      };
      expect(parsed.permissions.deny).toContain("WebFetch(*)");
    }
  });

  it("materializes cli.json into the task cwd on every spawn", async () => {
    const adapter = createCursorAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.files.map((f) => f.path)).toContain(".cursor/cli.json");
  });
});

describe("cursor adapter — resume", () => {
  it("resumes with --resume <chatId> before the prompt (verified context retention)", async () => {
    const adapter = createCursorAdapter({});
    const plan = await adapter.resume(
      spec({ sessionId: "b64960ec-d7f0-4578-9dc5-9cfa37f63b76", prompt: "the answer" }),
      HUB,
    );
    const resumeIdx = plan.argv.indexOf("--resume");
    expect(plan.argv[resumeIdx + 1]).toBe("b64960ec-d7f0-4578-9dc5-9cfa37f63b76");
    expect(plan.argv[plan.argv.length - 1]).toBe("the answer");
  });

  it("fails loudly without a session id (never silently starts a fresh session)", async () => {
    const adapter = createCursorAdapter({});
    await expect(adapter.resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });
});

describe("cursor adapter — spawn diagnostics", () => {
  it("warns that a set effort is ignored (ADR-0027 opaque ids)", async () => {
    const adapter = createCursorAdapter({});
    const plan = await adapter.prepare(spec({ effort: "high" }), HUB);
    expect(plan.argv).not.toContain("--effort");
    expect(plan.diagnostics!.some((d) => d.includes('effort "high" ignored'))).toBe(true);
  });

  it("warns about the 60s MCP tool cap when answerTimeoutMs exceeds it", async () => {
    const adapter = createCursorAdapter({});
    const slow = await adapter.prepare(spec({ answerTimeoutMs: 30 * 60 * 1000 }), HUB);
    expect(slow.diagnostics!.some((d) => d.includes("MCP tool calls cap at 60s"))).toBe(true);
    const fast = await adapter.prepare(
      spec({ answerTimeoutMs: CURSOR_MCP_TOOL_TIMEOUT_MS }),
      HUB,
    );
    expect(
      (fast.diagnostics ?? []).some((d) => d.includes("MCP tool calls cap")),
    ).toBe(false);
  });

  it("emits posture-gap PARLEY-DIAG lines for weak postures", async () => {
    const adapter = createCursorAdapter({});
    const plan = await adapter.prepare(spec({ sandbox: "workspace", network: false }), HUB);
    const diags = plan.diagnostics ?? [];
    expect(diags.some((d) => d.startsWith("PARLEY-DIAG posture: cursor sandbox=workspace"))).toBe(
      true,
    );
    expect(diags.some((d) => d.startsWith("PARLEY-DIAG posture: cursor network=false"))).toBe(
      true,
    );
  });
});

describe("cursor adapter — parseEvent (verified stream shapes)", () => {
  const adapter = createCursorAdapter({});

  it("captures session_id from system/init", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        type: "system",
        subtype: "init",
        apiKeySource: "login",
        cwd: "/work/tree",
        session_id: "96c630ba-f685-4ac2-b516-897c1325dbcd",
        model: "Auto",
        permissionMode: "default",
      }),
    );
    expect(events).toEqual([
      { kind: "session_meta", session_id: "96c630ba-f685-4ac2-b516-897c1325dbcd" },
    ]);
    // Display label ("Auto") is not an id — must not be reported as model provenance.
    expect(events[0]!.model).toBeUndefined();
  });

  it("normalizes assistant text content blocks to one message", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        session_id: "s",
      }),
    );
    expect(events).toEqual([{ kind: "message", text: "done" }]);
  });

  it("maps shellToolCall started → command", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        tool_call: { shellToolCall: { args: { command: "echo hello-parley" } } },
      }),
    );
    expect(events).toEqual([{ kind: "command", text: "echo hello-parley" }]);
  });

  it("maps editToolCall started → file_change with the path", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        tool_call: {
          editToolCall: { args: { path: "/work/tree/probe.txt", streamContent: "hi\n" } },
        },
      }),
    );
    expect(events).toEqual([{ kind: "file_change", text: "/work/tree/probe.txt" }]);
  });

  it("surfaces MCP tool errors (e.g. the 60s timeout) as non-fatal PARLEY-DIAG", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: {
          mcpToolCall: { result: { error: { error: "MCP error -32001: Request timed out" } } },
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("error");
    expect(events[0]!.fatal).toBeUndefined();
    expect(events[0]!.text).toMatch(/^PARLEY-DIAG mcpToolCall failed: MCP error -32001/);
  });

  it("surfaces permission denials as non-fatal PARLEY-DIAG", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: {
          editToolCall: {
            result: {
              writePermissionDenied: {
                path: "",
                error: "Write permission denied: /work/tree/x.txt: Blocked by permissions configuration",
                isReadonly: false,
              },
            },
          },
        },
      }),
    );
    expect(events[0]!.text).toMatch(/^PARLEY-DIAG editToolCall denied: Write permission denied/);
    expect(events[0]!.fatal).toBeUndefined();
  });

  it("maps the terminal result to session_meta with canonical usage", () => {
    const events = adapter.parseEvent(
      JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 6566,
        is_error: false,
        result: "done",
        session_id: "96c630ba-f685-4ac2-b516-897c1325dbcd",
        usage: { inputTokens: 5761, outputTokens: 161, cacheReadTokens: 38912, cacheWriteTokens: 0 },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.session_id).toBe("96c630ba-f685-4ac2-b516-897c1325dbcd");
    expect(events[0]!.usage).toMatchObject({
      inputTokens: 5761,
      input_tokens: 5761,
      output_tokens: 161,
      cached_tokens: 38912,
    });
  });

  it("marks result is_error as run-terminal fatal", () => {
    const events = adapter.parseEvent(
      JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "boom", session_id: "s" }),
    );
    expect(events.some((e) => e.kind === "error" && e.fatal === true && e.text === "boom")).toBe(
      true,
    );
  });

  it("flags plain-text ActionRequiredError lines as fatal (verified: exit 1, no JSON)", () => {
    const events = adapter.parseEvent(
      "ActionRequiredError: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.",
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fatal).toBe(true);
    expect(events[0]!.text).toContain("PARLEY-DIAG ActionRequiredError");
  });

  it("stays opaque on thinking deltas, user echo and unknown shapes", () => {
    expect(adapter.parseEvent(JSON.stringify({ type: "thinking", subtype: "delta", text: "x" }))).toEqual([]);
    expect(adapter.parseEvent(JSON.stringify({ type: "user", message: {} }))).toEqual([]);
    expect(adapter.parseEvent(JSON.stringify({ type: "wat" }))).toEqual([]);
    expect(adapter.parseEvent("not json")).toEqual([]);
  });

  it("extracts the latest session id from accumulated events", () => {
    const events = [
      { kind: "session_meta" as const, session_id: "first" },
      { kind: "message" as const, text: "hi" },
      { kind: "session_meta" as const, session_id: "last" },
    ];
    expect(adapter.sessionId(events)).toBe("last");
    expect(adapter.sessionId([{ kind: "message", text: "x" }])).toBeUndefined();
  });
});

describe("cursor adapter — parseCursorModels (ADR-0027)", () => {
  it("parses ANSI-coloured piped output into opaque effort-less entries", () => {
    const stdout = [
      "\x1b[2mAvailable models\x1b[22m",
      "",
      "\x1b[32mauto\x1b[39m \x1b[2m- Auto\x1b[22m\x1b[2m (current, default)\x1b[22m",
      "\x1b[36mgpt-5.3-codex-low\x1b[39m \x1b[2m- Codex 5.3 Low\x1b[22m",
      "\x1b[36mclaude-opus-5-thinking-high\x1b[39m \x1b[2m- Opus 5 1M Thinking\x1b[22m",
      "",
      "Tip: use --model <id> (or /model <id> in interactive mode) to switch.",
    ].join("\n");
    const models = parseCursorModels(stdout);
    expect(models).toEqual([
      { id: "auto", efforts: [], default_effort: null, label: "Auto (current, default)" },
      { id: "gpt-5.3-codex-low", efforts: [], default_effort: null, label: "Codex 5.3 Low" },
      {
        id: "claude-opus-5-thinking-high",
        efforts: [],
        default_effort: null,
        label: "Opus 5 1M Thinking",
      },
    ]);
  });

  it("never splits effort suffixes out of ids (irregular grammar)", () => {
    const models = parseCursorModels("gpt-5.5-extra-high - GPT-5.5 1M Extra High\n");
    expect(models[0]!.id).toBe("gpt-5.5-extra-high");
    expect(models[0]!.efforts).toEqual([]);
  });

  it("throws when no ids parse (refresh keeps the existing catalog entry)", () => {
    expect(() => parseCursorModels("Available models\n\nTip: whatever\n")).toThrow(
      /no model ids parsed/,
    );
  });
});
