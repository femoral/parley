import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLINE_DATA_DIR_ENV,
  CLINE_MCP_SETTINGS_REL,
  CLINE_SESSION_WRAP_REL,
  createClineAdapter,
  providerFlags,
  scrapeClineSessionId,
} from "../src/adapters/cline.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";

/**
 * Golden unit tests for the cline adapter — pure-function exception to the
 * suite's CLI-boundary rule (spec §10). Pins argv/env/files across the
 * sandbox×network matrix and NDJSON normalization against cline 3.0.42
 * (docs/research/cline-cli-automation.md; real lines from research §2 / §8).
 *
 * #107 defect regressions: session scrape, resume refuse, -P provider auto,
 * MCP timeoutMs.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/cline/", import.meta.url));

const HUB: HubInfo = {
  url: "http://127.0.0.1:54321/mcp",
  headers: { "X-Parley-Task": "t102", Authorization: "Bearer secret" },
};

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t102",
    name: null,
    prompt: "do the thing",
    vendor: "cline",
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

/** Absolute data-dir the adapter always pins under task.cwd. */
function expectedDataDir(cwd = "/work/tree"): string {
  return path.resolve(cwd, ".cline-parley");
}

function expectedWrapPath(cwd = "/work/tree"): string {
  return path.resolve(cwd, CLINE_SESSION_WRAP_REL);
}

describe("cline adapter — prepare argv (golden)", () => {
  it("builds the pinned headless --json one-shot via the session-scrape wrapper", async () => {
    const adapter = createClineAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      process.execPath,
      expectedWrapPath(),
      "cline",
      "--json",
      "--auto-approve",
      "true",
      "--data-dir",
      expectedDataDir(),
      "-c",
      "/work/tree",
      "do the thing",
    ]);
    expect(plan.cwd).toBe("/work/tree");
    expect(plan.files.map((f) => f.path)).toContain(CLINE_SESSION_WRAP_REL);
    expect(plan.env[CLINE_DATA_DIR_ENV]).toBe(expectedDataDir());
  });

  it("passes the model through with -m when set, omits it otherwise", async () => {
    const adapter = createClineAdapter({});
    const withModel = await adapter.prepare(spec({ model: "claude-sonnet-4" }), HUB);
    expect(withModel.argv).toContain("-m");
    expect(withModel.argv).toContain("claude-sonnet-4");
    // model flag lands before the positional prompt
    expect(withModel.argv.indexOf("-m")).toBeLessThan(withModel.argv.length - 1);
    expect(withModel.argv[withModel.argv.length - 1]).toBe("do the thing");

    const without = await adapter.prepare(spec({ model: null }), HUB);
    expect(without.argv).not.toContain("-m");
  });

  it("passes effort through with --thinking when set, omits it otherwise", async () => {
    const adapter = createClineAdapter({});
    const withEffort = await adapter.prepare(spec({ effort: "high" }), HUB);
    expect(withEffort.argv).toContain("--thinking");
    expect(withEffort.argv).toContain("high");
    expect(withEffort.argv[withEffort.argv.length - 1]).toBe("do the thing");
    const without = await adapter.prepare(spec({ effort: null }), HUB);
    expect(without.argv).not.toContain("--thinking");
  });

  it("splices extraArgs into the flags region before the positional prompt", async () => {
    const plan = await createClineAdapter({}).prepare(
      spec({ extraArgs: ["--retries", "2", "--foo"] }),
      HUB,
    );
    expect(plan.argv[plan.argv.length - 1]).toBe("do the thing");
    const promptIdx = plan.argv.indexOf("do the thing");
    expect(plan.argv.slice(promptIdx - 3, promptIdx)).toEqual(["--retries", "2", "--foo"]);
  });

  it("honours PARLEY_CLINE_BIN override inside the wrap argv", async () => {
    const adapter = createClineAdapter({ PARLEY_CLINE_BIN: "/opt/cline/cline" });
    const plan = await adapter.prepare(spec(), HUB);
    // argv: [node, wrap, bin, ...]
    expect(plan.argv[2]).toBe("/opt/cline/cline");
  });

  it("does not pass --worktree (Parley owns worktrees)", async () => {
    const plan = await createClineAdapter({}).prepare(spec(), HUB);
    expect(plan.argv).not.toContain("--worktree");
  });
});

describe("cline adapter — #107 provider -P auto-select (old code never passed -P)", () => {
  it("passes -P anthropic when only ANTHROPIC_API_KEY is set (defect: default stayed cline)", async () => {
    const plan = await createClineAdapter({
      ANTHROPIC_API_KEY: "sk-ant-fake",
    }).prepare(spec({ model: "claude-sonnet-4-20250514" }), HUB);
    expect(plan.argv).toContain("-P");
    expect(plan.argv[plan.argv.indexOf("-P") + 1]).toBe("anthropic");
    // Provider lands before model and prompt.
    expect(plan.argv.indexOf("-P")).toBeLessThan(plan.argv.indexOf("-m"));
  });

  it("passes -P openai when only OPENAI_API_KEY is set", async () => {
    const plan = await createClineAdapter({ OPENAI_API_KEY: "sk-oai" }).prepare(spec(), HUB);
    expect(plan.argv).toContain("-P");
    expect(plan.argv[plan.argv.indexOf("-P") + 1]).toBe("openai");
  });

  it("omits -P when zero or multiple BYOK keys are set", async () => {
    expect((await createClineAdapter({}).prepare(spec(), HUB)).argv).not.toContain("-P");
    const multi = await createClineAdapter({
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
    }).prepare(spec(), HUB);
    expect(multi.argv).not.toContain("-P");
  });

  it("omits auto -P when extraArgs already names a provider", async () => {
    const plan = await createClineAdapter({ ANTHROPIC_API_KEY: "sk" }).prepare(
      spec({ extraArgs: ["-P", "openrouter"] }),
      HUB,
    );
    // Only the explicit extraArgs -P, not a second auto one before it.
    const pIdxs = plan.argv
      .map((a, i) => (a === "-P" ? i : -1))
      .filter((i) => i >= 0);
    expect(pIdxs).toHaveLength(1);
    expect(plan.argv[pIdxs[0]! + 1]).toBe("openrouter");
  });

  it("providerFlags helper: single anthropic key → -P anthropic", () => {
    expect(providerFlags(spec(), { ANTHROPIC_API_KEY: "x" })).toEqual(["-P", "anthropic"]);
    expect(providerFlags(spec(), {})).toEqual([]);
  });
});

describe("cline adapter — #107 resume refuses broken --id (old code shipped --id as if it worked)", () => {
  it("rejects resume even with a scraped session id (3.0.42 headless --id is broken)", async () => {
    const adapter = createClineAdapter({});
    await expect(
      adapter.resume(spec({ prompt: "the answer", sessionId: "1784189583906_bj2xq" }), HUB),
    ).rejects.toThrow(/unsupported on 3\.0\.42|JSON output mode|headless --id/i);
  });

  it("rejects resume without a session id with the same clear error class", async () => {
    const adapter = createClineAdapter({});
    await expect(adapter.resume(spec(), HUB)).rejects.toThrow(/unsupported on 3\.0\.42/);
  });

  it("does not build a broken --id argv on any resume path", async () => {
    const adapter = createClineAdapter({});
    await expect(
      adapter.resume(spec({ sessionId: "sid" }), HUB),
    ).rejects.toThrow();
    // No successful plan with --id (regression: old resume returned that argv).
  });
});

describe("cline adapter — sandbox×network matrix (closest safe posture)", () => {
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    expectCommandPermissions: boolean;
  }[] = [
    { sandbox: "workspace", network: true, expectCommandPermissions: false },
    { sandbox: "workspace", network: false, expectCommandPermissions: false },
    { sandbox: "read-only", network: true, expectCommandPermissions: true },
    { sandbox: "read-only", network: false, expectCommandPermissions: true },
    { sandbox: "full", network: true, expectCommandPermissions: false },
    // network:false has no Cline mechanism (research §5 UNKNOWN) — no env flag.
    { sandbox: "full", network: false, expectCommandPermissions: false },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network}`, async () => {
      const adapter = createClineAdapter({});
      const plan = await adapter.prepare(spec({ sandbox: c.sandbox, network: c.network }), HUB);
      // Always headless auto-approve + private data-dir.
      expect(plan.argv).toContain("--auto-approve");
      expect(plan.argv).toContain("true");
      expect(plan.argv).toContain("--data-dir");
      expect(plan.argv).toContain(expectedDataDir());
      if (c.expectCommandPermissions) {
        expect(plan.env.CLINE_COMMAND_PERMISSIONS).toBeDefined();
        const perms = JSON.parse(plan.env.CLINE_COMMAND_PERMISSIONS!);
        expect(perms.deny).toContain("*");
      } else {
        expect(plan.env.CLINE_COMMAND_PERMISSIONS).toBeUndefined();
      }
      // No fake network toggle env.
      expect(plan.env).not.toHaveProperty("CLINE_NETWORK");
    });
  }
});

describe("cline adapter — MCP injection (materialized settings)", () => {
  it("writes streamableHttp MCP hub config under the private data-dir", async () => {
    const adapter = createClineAdapter({});
    const plan = await adapter.prepare(spec(), HUB);
    const file = plan.files.find((f) => f.path === CLINE_MCP_SETTINGS_REL);
    expect(file).toBeDefined();
    const json = JSON.parse(file!.contents);
    expect(json.mcpServers.parley.transport).toEqual({
      type: "streamableHttp",
      url: "http://127.0.0.1:54321/mcp",
      headers: {
        "X-Parley-Task": "t102",
        Authorization: "Bearer secret",
      },
    });
  });

  it("sets per-server timeoutMs above answerTimeoutMs (#107 major; old code omitted timeout)", async () => {
    // 5-minute answer → 300_000 + 60_000 = 360_000.
    const plan = await createClineAdapter({}).prepare(spec({ answerTimeoutMs: 300_000 }), HUB);
    const file = plan.files.find((f) => f.path === CLINE_MCP_SETTINGS_REL)!;
    const json = JSON.parse(file.contents) as {
      mcpServers: { parley: { timeoutMs: number } };
    };
    expect(json.mcpServers.parley.timeoutMs).toBe(360_000);
    expect(360_000).toBeGreaterThan(300_000);
  });

  it("points --data-dir at the absolute task-private directory", async () => {
    const plan = await createClineAdapter({}).prepare(spec({ cwd: "/tmp/wt-x" }), HUB);
    const i = plan.argv.indexOf("--data-dir");
    expect(plan.argv[i + 1]).toBe(path.resolve("/tmp/wt-x", ".cline-parley"));
  });
});

describe("cline adapter — auth env passthrough", () => {
  it("forwards only the named keys, only when set in the parent env", async () => {
    const withKeys = await createClineAdapter({
      ANTHROPIC_API_KEY: "sk-ant",
      CLINE_API_KEY: "cline-k",
      OPENAI_API_KEY: "sk-oai",
      OPENROUTER_API_KEY: "or-k",
      AI_GATEWAY_API_KEY: "gw-k",
      V0_API_KEY: "v0-k",
      // Must NOT be forwarded (not in research §6 list / not a cline key we pass).
      CODEX_API_KEY: "nope",
      RANDOM_SECRET: "nope",
    }).prepare(spec(), HUB);
    expect(withKeys.env).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant",
      CLINE_API_KEY: "cline-k",
      OPENAI_API_KEY: "sk-oai",
      OPENROUTER_API_KEY: "or-k",
      AI_GATEWAY_API_KEY: "gw-k",
      V0_API_KEY: "v0-k",
      [CLINE_DATA_DIR_ENV]: expectedDataDir(),
    });
    expect("CODEX_API_KEY" in withKeys.env).toBe(false);
    expect("RANDOM_SECRET" in withKeys.env).toBe(false);

    const without = await createClineAdapter({}).prepare(spec(), HUB);
    expect(without.env).toEqual({
      [CLINE_DATA_DIR_ENV]: expectedDataDir(),
    });
  });
});

describe("cline adapter — parseEvent (3.0.42 envelope)", () => {
  const adapter = createClineAdapter({});

  it("maps agent_event error with recoverable:false to fatal error", () => {
    const line =
      '{"type":"agent_event","event":{"type":"error","error":{"name":"Error","message":"Unauthorized"},"recoverable":false}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "error", text: "Unauthorized", fatal: true },
    ]);
  });

  it("maps agent_event error with recoverable:true to non-fatal error", () => {
    const line =
      '{"type":"agent_event","event":{"type":"error","error":{"message":"retryable"},"recoverable":true}}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "error", text: "retryable", fatal: false }]);
  });

  it("maps top-level type:error to fatal error", () => {
    expect(
      adapter.parseEvent(
        '{"ts":"2026-07-16T08:13:04.255Z","type":"error","message":"Unauthorized: re-authenticate"}',
      ),
    ).toEqual([{ kind: "error", text: "Unauthorized: re-authenticate", fatal: true }]);
  });

  it("tags approval/MCP-cancel errors with VENDOR_DIAG_PREFIX", () => {
    const line =
      '{"type":"error","message":"MCP tool call cancelled: approval required"}';
    const events = adapter.parseEvent(line);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("error");
    expect(events[0]?.text).toMatch(/^PARLEY-DIAG /);
    expect(events[0]?.fatal).toBe(true);
  });

  it("maps run_result usage (preferring aggregateUsage) and fatal on finishReason=error", () => {
    const line = JSON.stringify({
      type: "run_result",
      finishReason: "error",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        totalCost: 0,
      },
      aggregateUsage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 6,
        totalCost: 0.1,
      },
      text: "boom",
    });
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "session_meta",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheWriteTokens: 6,
          totalCost: 0.1,
          input_tokens: 10,
          output_tokens: 20,
          cached_tokens: 5,
        },
      },
      { kind: "error", text: "boom", fatal: true },
    ]);
  });

  it("maps run_result without error finish to usage-only session_meta", () => {
    const line = JSON.stringify({
      type: "run_result",
      finishReason: "stop",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        totalCost: 0.01,
      },
      text: "ok",
    });
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "session_meta",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          totalCost: 0.01,
          input_tokens: 100,
          output_tokens: 50,
          cached_tokens: 10,
        },
      },
    ]);
  });

  it("maps agent_event usage to session_meta", () => {
    const line = JSON.stringify({
      type: "agent_event",
      event: {
        type: "usage",
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 1,
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "session_meta",
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          cacheReadTokens: 1,
          input_tokens: 7,
          output_tokens: 3,
          cached_tokens: 1,
        },
      },
    ]);
  });

  it("maps text content_end to message", () => {
    const line = JSON.stringify({
      type: "agent_event",
      event: { type: "content_end", contentType: "text", text: "hello" },
    });
    expect(adapter.parseEvent(line)).toEqual([{ kind: "message", text: "hello" }]);
  });

  it("maps shell-like tool content to command", () => {
    const line = JSON.stringify({
      type: "agent_event",
      event: {
        type: "content_end",
        contentType: "tool",
        toolName: "execute_command",
        input: "ls -la",
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "command", text: "execute_command ls -la" },
    ]);
  });

  it("maps file-edit tool content to file_change", () => {
    const line = JSON.stringify({
      type: "agent_event",
      event: {
        type: "content_end",
        contentType: "tool",
        toolName: "write_to_file",
        input: "src/a.ts",
      },
    });
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "file_change", text: "write_to_file src/a.ts" },
    ]);
  });

  it("treats hook_event / iteration_* / notice as opaque", () => {
    expect(
      adapter.parseEvent(
        '{"type":"hook_event","hookEventName":"agent_start","agentId":"a","taskId":"t"}',
      ),
    ).toEqual([]);
    expect(
      adapter.parseEvent('{"type":"agent_event","event":{"type":"iteration_start","iteration":1}}'),
    ).toEqual([]);
    expect(adapter.parseEvent('{"type":"agent_event","event":{"type":"notice"}}')).toEqual([]);
  });

  it("never throws on unknown, changed, or malformed shapes", () => {
    expect(adapter.parseEvent('{"type":"say","text":"legacy"}')).toEqual([]);
    expect(adapter.parseEvent('{"type":"totally_new","x":1}')).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
    expect(adapter.parseEvent("null")).toEqual([]);
  });
});

describe("cline adapter — #107 session id from data-dir scrape (old code never emitted session_id)", () => {
  const adapter = createClineAdapter({});

  it("maps parley_session_scrape synthetic line to session_meta (would fail on old code)", () => {
    const line = JSON.stringify({
      type: "parley_session_scrape",
      session_id: "1784193690918_hiozv",
    });
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "session_meta", session_id: "1784193690918_hiozv" },
    ]);
    expect(
      adapter.sessionId(adapter.parseEvent(line)),
    ).toBe("1784193690918_hiozv");
  });

  it("scrapeClineSessionId reads newest sessions/*/*.json session_id (live disk shape)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cline-sess-"));
    try {
      const sid = "1784193690918_hiozv";
      const dir = path.join(root, "sessions", sid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${sid}.json`),
        JSON.stringify({
          version: 1,
          session_id: sid,
          status: "failed",
          provider: "anthropic",
        }),
      );
      expect(scrapeClineSessionId(root)).toBe(sid);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when the stream never carried a session_id (3.0.42 NDJSON alone)", () => {
    const lines = fs
      .readFileSync(path.join(FIXTURES, "v3.0.42-auth-fail.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    // Without the wrap-script scrape line, sessionId stays undefined (old defect).
    expect(adapter.sessionId(events)).toBeUndefined();
  });

  it("returns the last session_meta session_id when present (codex contract)", () => {
    const events = [
      { kind: "session_meta" as const, session_id: "first" },
      { kind: "message" as const, text: "hi" },
      { kind: "session_meta" as const, session_id: "last-sid" },
    ];
    expect(adapter.sessionId(events)).toBe("last-sid");
  });

  it("auth-fail fixture + scrape line: sessionId becomes available (defect regression)", () => {
    const lines = fs
      .readFileSync(path.join(FIXTURES, "v3.0.42-auth-fail.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    const events = [
      ...lines.flatMap((line) => adapter.parseEvent(line)),
      ...adapter.parseEvent(
        JSON.stringify({ type: "parley_session_scrape", session_id: "1784193198730_nqinf" }),
      ),
    ];
    expect(adapter.sessionId(events)).toBe("1784193198730_nqinf");
  });
});

describe("cline adapter — golden JSONL fixtures (pins observed 3.0.42)", () => {
  const adapter = createClineAdapter({});

  function replay(file: string) {
    const lines = fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
    return lines.flatMap((line) => adapter.parseEvent(line));
  }

  it("auth-fail run: fatal agent error + run_result usage + top-level error", () => {
    const events = replay("v3.0.42-auth-fail.jsonl");
    const errors = events.filter((e) => e.kind === "error");
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.every((e) => e.fatal === true)).toBe(true);
    expect(errors.some((e) => e.text?.includes("Unauthorized"))).toBe(true);

    const usageEvents = events.filter((e) => e.kind === "session_meta" && e.usage);
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    const usage = usageEvents[0]!.usage!;
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(usage.inputTokens).toBe(0);
    expect(adapter.sessionId(events)).toBeUndefined();
  });

  it("usage-only run_result: prefers aggregateUsage and canonical keys", () => {
    const events = replay("v3.0.42-usage-only.jsonl");
    expect(events).toEqual([
      {
        kind: "session_meta",
        usage: {
          inputTokens: 120,
          outputTokens: 60,
          cacheReadTokens: 12,
          cacheWriteTokens: 6,
          totalCost: 0.012,
          input_tokens: 120,
          output_tokens: 60,
          cached_tokens: 12,
        },
      },
    ]);
  });
});

describe("cline adapter — listModels omitted", () => {
  it("does not implement listModels (no CLI probe, research §7)", () => {
    const adapter = createClineAdapter({});
    expect(adapter.listModels).toBeUndefined();
  });
});
