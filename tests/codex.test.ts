import { describe, expect, it } from "vitest";
import { createCodexAdapter } from "../src/daemon/adapters/codex.js";
import type { HubInfo, TaskSpec } from "../src/daemon/adapters/types.js";

/**
 * Golden unit tests for the codex adapter — the allowed pure-function exception
 * to the suite's CLI-boundary rule (spec §10). They pin the exact argv/env the
 * adapter builds across the sandbox-posture matrix and the exact normalization
 * of codex's JSONL stream, so a flag rename or schema drift fails loudly.
 *
 * Flags/config keys and event shapes are pinned to Codex CLI `0.144.0`
 * (docs/research/codex-cli-automation.md; event schema from codex-rs
 * exec_events.rs at tag rust-v0.144.0).
 */

const HUB: HubInfo = {
  url: "http://127.0.0.1:5555/mcp",
  headers: { "x-parley-task": "t1" },
};

/** A task at the daemon's default 30-minute answer timeout → tool_timeout_sec 1860. */
function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t1",
    name: null,
    prompt: "do the thing",
    vendor: "codex",
    model: null,
    cwd: "/work/wt",
    sandbox: "workspace",
    network: true,
    answerTimeoutMs: 1_800_000,
    ...overrides,
  };
}

/** The `-c` overrides shared by every posture (order matters — golden). */
function mcpOverrides(): string[] {
  return [
    "-c",
    'mcp_servers.parley.url="http://127.0.0.1:5555/mcp"',
    "-c",
    'mcp_servers.parley.http_headers.x-parley-task="t1"',
    "-c",
    "mcp_servers.parley.tool_timeout_sec=1860",
  ];
}

describe("codex prepare — sandbox posture matrix (golden argv)", () => {
  const adapter = createCodexAdapter({});

  it("workspace + network (default): workspace-write with the network override", async () => {
    const plan = await adapter.prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      "-c",
      "sandbox_workspace_write.network_access=true",
      ...mcpOverrides(),
      "do the thing",
    ]);
    expect(plan.cwd).toBe("/work/wt");
    expect(plan.files).toEqual([]);
  });

  it("read-only + --no-network: read-only, no network override", async () => {
    const plan = await adapter.prepare(spec({ sandbox: "read-only", network: false }), HUB);
    expect(plan.argv).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'approval_policy="never"',
      ...mcpOverrides(),
      "do the thing",
    ]);
  });

  it("full: danger-full-access, no network override", async () => {
    const plan = await adapter.prepare(spec({ sandbox: "full", network: true }), HUB);
    expect(plan.argv).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
      ...mcpOverrides(),
      "do the thing",
    ]);
  });

  it("workspace + --no-network: workspace-write, network override omitted", async () => {
    const plan = await adapter.prepare(spec({ sandbox: "workspace", network: false }), HUB);
    expect(plan.argv).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      ...mcpOverrides(),
      "do the thing",
    ]);
  });
});

describe("codex prepare — model, timeout, auth", () => {
  it("passes the model opaquely via -m when set", async () => {
    const plan = await createCodexAdapter({}).prepare(spec({ model: "gpt-5.6-codex" }), HUB);
    const i = plan.argv.indexOf("-m");
    expect(i).toBeGreaterThan(-1);
    expect(plan.argv[i + 1]).toBe("gpt-5.6-codex");
    // Placed after --skip-git-repo-check, before the config overrides.
    expect(plan.argv.slice(0, 6)).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.6-codex",
    ]);
  });

  it("raises tool_timeout_sec strictly above the task's answer timeout", async () => {
    // 5-minute answer timeout → 300s + 60s headroom = 360s, well above codex's 60s default.
    const plan = await createCodexAdapter({}).prepare(spec({ answerTimeoutMs: 300_000 }), HUB);
    expect(plan.argv).toContain("mcp_servers.parley.tool_timeout_sec=360");
    expect(360).toBeGreaterThan(300); // strictly above the answer timeout in seconds
  });

  it("passes CODEX_API_KEY through when present, and nothing when absent", async () => {
    const withKey = await createCodexAdapter({ CODEX_API_KEY: "sk-test" }).prepare(spec(), HUB);
    expect(withKey.env).toEqual({ CODEX_API_KEY: "sk-test" });
    const without = await createCodexAdapter({}).prepare(spec(), HUB);
    expect(without.env).toEqual({});
  });
});

describe("codex resume — golden argv", () => {
  it("respawns via `exec resume <session-id>` with the answer as the prompt", async () => {
    const adapter = createCodexAdapter({});
    // On resume the persisted answer is the follow-up prompt (engine sets prompt=answer).
    const plan = await adapter.resume(
      spec({ prompt: "use postgres", sessionId: "sess-abc", sandbox: "read-only", network: false }),
      HUB,
    );
    expect(plan.argv).toEqual([
      "codex",
      "exec",
      "resume",
      "sess-abc",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'approval_policy="never"',
      ...mcpOverrides(),
      "use postgres",
    ]);
    expect(plan.cwd).toBe("/work/wt");
  });

  it("maps posture identically to prepare (the resume seam)", async () => {
    const adapter = createCodexAdapter({});
    const s = spec({ sandbox: "workspace", network: true, sessionId: "s1" });
    const prepared = await adapter.prepare(s, HUB);
    const resumed = await adapter.resume(s, HUB);
    // The posture-carrying config overrides are identical in both plans.
    const postureOf = (argv: string[]): string[] =>
      argv.filter(
        (a, i) =>
          a.startsWith("sandbox_mode") ||
          a.startsWith("approval_policy") ||
          a.startsWith("sandbox_workspace_write") ||
          argv[i - 1] === "-c",
      );
    expect(postureOf(resumed.argv)).toEqual(postureOf(prepared.argv));
  });
});

describe("codex parseEvent — golden JSONL fixtures (rust-v0.144.0)", () => {
  const adapter = createCodexAdapter({});

  it("thread.started → session_meta carrying thread_id", () => {
    expect(adapter.parseEvent('{"type":"thread.started","thread_id":"0199-uuid"}')).toEqual([
      { kind: "session_meta", session_id: "0199-uuid" },
    ]);
  });

  it("agent_message item.completed → message", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"all done"}}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "message", text: "all done" }]);
  });

  it("command_execution item.completed → command", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls -la","aggregated_output":"...","exit_code":0,"status":"completed"}}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "command", text: "ls -la" }]);
  });

  it("file_change item.completed → file_change with joined paths", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_2","type":"file_change","status":"completed","changes":[{"path":"src/a.ts","kind":"update"},{"path":"src/b.ts","kind":"add"}]}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "file_change", text: "src/a.ts, src/b.ts" },
    ]);
  });

  it("turn.failed → fatal error carrying the nested message", () => {
    const line = '{"type":"turn.failed","error":{"message":"model overloaded"}}';
    expect(adapter.parseEvent(line)).toEqual([
      { kind: "error", text: "model overloaded", fatal: true },
    ]);
  });

  it("top-level error → fatal error", () => {
    expect(adapter.parseEvent('{"type":"error","message":"fatal boom"}')).toEqual([
      { kind: "error", text: "fatal boom", fatal: true },
    ]);
  });

  it("error item.completed → recoverable (non-fatal) error", () => {
    // A mid-run error item is display-only: the agent may work past it, so it
    // must not become stale task-failure detail (only turn.failed/error are fatal).
    const line =
      '{"type":"item.completed","item":{"id":"i3","type":"error","message":"tool blew up"}}';
    expect(adapter.parseEvent(line)).toEqual([{ kind: "error", text: "tool blew up" }]);
  });

  it("turn.completed → session_meta usage (all numeric fields)", () => {
    const line =
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":5,"reasoning_output_tokens":1}}';
    expect(adapter.parseEvent(line)).toEqual([
      {
        kind: "session_meta",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 5,
          reasoning_output_tokens: 1,
        },
      },
    ]);
  });

  it("unknown item types pass through opaque ([])", () => {
    for (const type of ["reasoning", "mcp_tool_call", "web_search", "todo_list"]) {
      const line = `{"type":"item.completed","item":{"id":"x","type":"${type}"}}`;
      expect(adapter.parseEvent(line)).toEqual([]);
    }
  });

  it("unknown top-level events and item.started/updated pass through opaque ([])", () => {
    expect(adapter.parseEvent('{"type":"turn.started"}')).toEqual([]);
    expect(
      adapter.parseEvent('{"type":"item.started","item":{"id":"i","type":"agent_message"}}'),
    ).toEqual([]);
    expect(adapter.parseEvent('{"type":"item.updated","item":{"id":"i","type":"agent_message"}}')).toEqual([]);
    expect(adapter.parseEvent('{"type":"whatever.new"}')).toEqual([]);
  });

  it("non-JSON and non-object lines pass through opaque ([])", () => {
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("null")).toEqual([]);
  });
});

describe("codex sessionId — extraction from parsed events", () => {
  const adapter = createCodexAdapter({});

  it("returns the thread id from the thread.started event", () => {
    const events = [
      ...adapter.parseEvent('{"type":"thread.started","thread_id":"sess-42"}'),
      ...adapter.parseEvent(
        '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"hi"}}',
      ),
    ];
    expect(adapter.sessionId(events)).toBe("sess-42");
  });

  it("returns undefined when no session id was seen", () => {
    const events = adapter.parseEvent('{"type":"turn.started"}');
    expect(adapter.sessionId(events)).toBeUndefined();
  });
});
