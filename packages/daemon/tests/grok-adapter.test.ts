import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyGrokProbeError,
  createGrokAdapter,
  decideGrokPermissionProbe,
  formatGrokSandboxUnenforceableError,
  isGrokSandboxRefusalSignature,
  isSandboxedGrokPosture,
} from "../src/adapters/grok.js";
import type { HubInfo, SandboxMode, TaskSpec } from "../src/adapters/types.js";
import { createWorktree, excludeMaterializedFiles } from "../src/worktree.js";
import { makeGitRepo } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/grok/", import.meta.url));
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
    vendor: "grok",
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

/** The five Claude-config scanner vars the adapter turns off per child. */
const SCANNERS = [
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake `grok` whose `inspect --json` succeeds (permission probe happy path).
 * Golden prepare/resume tests must not depend on a real grok or bubblewrap
 * (#247: sandboxed probe failures reject prepare on this host).
 */
function happyGrokBin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-grok-happy-"));
  scratch.push(dir);
  const file = path.join(dir, "grok");
  fs.writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "inspect" ]; then echo '{"permissions":{"loaded":0,"sources":[]}}'; fi\n`,
    { mode: 0o755 },
  );
  return file;
}

/** Adapter with a successful inspect probe unless the caller overrides the bin. */
function adapter(env: NodeJS.ProcessEnv = {}) {
  if (env.PARLEY_GROK_BIN !== undefined) return createGrokAdapter(env);
  return createGrokAdapter({ ...env, PARLEY_GROK_BIN: happyGrokBin() });
}

describe("grok adapter — prepare argv (golden)", () => {
  it("builds the pinned headless streaming-json invocation", async () => {
    const bin = happyGrokBin();
    const plan = await createGrokAdapter({ PARLEY_GROK_BIN: bin }).prepare(spec(), HUB);
    expect(plan.argv).toEqual([
      bin,
      "-p",
      "do the thing",
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--always-approve",
      "--cwd",
      "/work/tree",
    ]);
    expect(plan.cwd).toBe("/work/tree");
  });

  it("passes the model through with -m when set, omits it otherwise", async () => {
    expect((await adapter().prepare(spec({ model: "grok-4.5" }), HUB)).argv).toContain("-m");
    expect((await adapter().prepare(spec({ model: "grok-4.5" }), HUB)).argv).toContain("grok-4.5");
    expect((await adapter().prepare(spec({ model: null }), HUB)).argv).not.toContain("-m");
  });

  it("passes reasoning effort through with --reasoning-effort when set, omits it otherwise", async () => {
    const bin = happyGrokBin();
    const withEffort = await createGrokAdapter({ PARLEY_GROK_BIN: bin }).prepare(
      spec({ effort: "high" }),
      HUB,
    );
    expect(withEffort.argv).toEqual([
      bin,
      "-p",
      "do the thing",
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--always-approve",
      "--cwd",
      "/work/tree",
      "--reasoning-effort",
      "high",
    ]);
    const withoutEffort = await adapter().prepare(spec({ effort: null }), HUB);
    expect(withoutEffort.argv).not.toContain("--reasoning-effort");
  });

  it("carries reasoning effort through resume identically to prepare", async () => {
    const plan = await adapter().resume(
      spec({ prompt: "the answer", sessionId: "sess-1", effort: "low" }),
      HUB,
    );
    expect(plan.argv).toContain("--reasoning-effort");
    expect(plan.argv).toContain("low");
  });

  it("honours PARLEY_GROK_BIN override", async () => {
    // Probe is fail-open on missing binary, so argv is still produced.
    const a = createGrokAdapter({ PARLEY_GROK_BIN: "/opt/grok/grok" });
    expect((await a.prepare(spec({ sandbox: "full" }), HUB)).argv[0]).toBe("/opt/grok/grok");
  });
});

describe("grok adapter — resume argv (golden)", () => {
  it("resumes the persisted session with -r and the answer prompt", async () => {
    const bin = happyGrokBin();
    const plan = await createGrokAdapter({ PARLEY_GROK_BIN: bin }).resume(
      spec({ prompt: "the answer", sessionId: "sess-abc" }),
      HUB,
    );
    expect(plan.argv).toEqual([
      bin,
      "-p",
      "the answer",
      "-r",
      "sess-abc",
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--always-approve",
      "--cwd",
      "/work/tree",
    ]);
  });

  it("re-materializes the MCP config on resume", async () => {
    const plan = await adapter().resume(spec({ sessionId: "sess-abc" }), HUB);
    expect(plan.files.map((f) => f.path)).toContain(".grok/config.toml");
  });

  it("rejects a resume without a session id (would silently start a fresh session)", async () => {
    await expect(adapter().resume(spec(), HUB)).rejects.toThrow(/no session id/);
  });
});

describe("grok adapter — env across the sandbox-posture matrix (golden)", () => {
  const cases: {
    sandbox: SandboxMode;
    network: boolean;
    expectSandbox: string;
    extra: Record<string, string>;
    sandboxToml: boolean;
  }[] = [
    {
      sandbox: "workspace",
      network: true,
      expectSandbox: "workspace",
      extra: { GROK_SANDBOX_AUTO_ALLOW_BASH: "1" },
      sandboxToml: false,
    },
    {
      sandbox: "workspace",
      network: false,
      expectSandbox: "parley-restricted",
      extra: { GROK_SANDBOX_AUTO_ALLOW_BASH: "1" },
      sandboxToml: true,
    },
    {
      sandbox: "read-only",
      network: true,
      expectSandbox: "read-only",
      extra: { GROK_WRITE_FILE: "0" },
      sandboxToml: false,
    },
    {
      sandbox: "read-only",
      network: false,
      expectSandbox: "parley-restricted",
      extra: { GROK_WRITE_FILE: "0" },
      sandboxToml: true,
    },
    { sandbox: "full", network: true, expectSandbox: "off", extra: {}, sandboxToml: false },
    // full ignores network:false — danger-full-access is inherently network-on.
    { sandbox: "full", network: false, expectSandbox: "off", extra: {}, sandboxToml: false },
  ];

  for (const c of cases) {
    it(`${c.sandbox} + network:${c.network} → GROK_SANDBOX=${c.expectSandbox}`, async () => {
      const plan = await adapter().prepare(spec({ sandbox: c.sandbox, network: c.network }), HUB);
      expect(plan.env.GROK_SANDBOX).toBe(c.expectSandbox);
      for (const [k, v] of Object.entries(c.extra)) expect(plan.env[k]).toBe(v);
      // Claude scanners always disabled.
      for (const key of SCANNERS) expect(plan.env[key]).toBe("0");
      // A no-network posture (except full) materializes a custom profile.
      const hasSandboxToml = plan.files.some((f) => f.path === ".grok/sandbox.toml");
      expect(hasSandboxToml).toBe(c.sandboxToml);
    });
  }

  it("resume carries the identical posture env as prepare", async () => {
    const a = adapter();
    const s = spec({ sandbox: "read-only", network: false, sessionId: "sess-1" });
    const prepared = await a.prepare(s, HUB);
    const resumed = await a.resume(s, HUB);
    expect(resumed.env.GROK_SANDBOX).toBe(prepared.env.GROK_SANDBOX);
    expect(resumed.env.GROK_WRITE_FILE).toBe(prepared.env.GROK_WRITE_FILE);
  });
});

describe("grok adapter — env passthrough & leak control", () => {
  it("passes XAI_API_KEY through only when the parent set it", async () => {
    expect((await adapter({ XAI_API_KEY: "xai-secret" }).prepare(spec(), HUB)).env.XAI_API_KEY).toBe(
      "xai-secret",
    );
    expect("XAI_API_KEY" in (await adapter().prepare(spec(), HUB)).env).toBe(false);
  });

  it("gates the Claude-settings permission import on prepare and resume (#179)", async () => {
    // The scanner vars don't cover grok's permission-rule import from
    // ~/.claude/settings.json; a user-scope NotebookEdit deny otherwise maps to
    // deny-all-edits in the child. Verified against grok 0.2.106.
    const a = adapter();
    const prepared = await a.prepare(spec(), HUB);
    expect(prepared.env._GROK_CLAUDE_MARKER_OVERRIDE).toBe("1");
    const resumed = await a.resume(spec({ sessionId: "sess-1" }), HUB);
    expect(resumed.env._GROK_CLAUDE_MARKER_OVERRIDE).toBe("1");
  });

  it("pins MCP_TIMEOUT so a parent (Claude) value cannot leak into the child", async () => {
    // Even when the parent env exports its own MCP_TIMEOUT, the plan overrides it
    // (the engine spreads SpawnPlan.env over process.env, so ours wins).
    expect((await adapter({ MCP_TIMEOUT: "600000" }).prepare(spec(), HUB)).env.MCP_TIMEOUT).toBe(
      "30000",
    );
  });

  it("sets GROK_XAI_API_BASE_URL to the daemon proxy path when parent did not override (#95)", async () => {
    const plan = await adapter().prepare(spec({ id: "t7" }), HUB);
    expect(plan.env.GROK_XAI_API_BASE_URL).toBe("http://127.0.0.1:54321/xai/t7/v1");
  });

  it("omits GROK_XAI_API_BASE_URL from plan.env when the parent already set it", async () => {
    // Parent override must not be clobbered: engine spawn is
    // `{...process.env, ...plan.env}`, so omitting the key keeps the parent value.
    const plan = await adapter({
      GROK_XAI_API_BASE_URL: "https://custom.example/v1",
    }).prepare(spec(), HUB);
    expect("GROK_XAI_API_BASE_URL" in plan.env).toBe(false);
  });

  it("derives the proxy URL from the hub origin + task id on resume too", async () => {
    const hub: HubInfo = {
      url: "http://127.0.0.1:9999/mcp",
      headers: { "x-parley-task": "task-r" },
    };
    const plan = await adapter().resume(spec({ id: "task-r", sessionId: "sess-1" }), hub);
    expect(plan.env.GROK_XAI_API_BASE_URL).toBe("http://127.0.0.1:9999/xai/task-r/v1");
  });
});

describe("grok adapter — materialized .grok/config.toml", () => {
  it("carries the MCP endpoint, correlation header, worktree-never, and approval posture", async () => {
    const plan = await adapter().prepare(spec(), HUB);
    const config = plan.files.find((f) => f.path === ".grok/config.toml");
    expect(config).toBeDefined();
    const toml = config!.contents;
    expect(toml).toContain('new_session_worktree_mode = "never"');
    expect(toml).toContain('permission_mode = "always-approve"');
    expect(toml).toContain("[mcp_servers.parley]");
    expect(toml).toContain('type = "http"');
    expect(toml).toContain('url = "http://127.0.0.1:54321/mcp"');
    expect(toml).toContain("[mcp_servers.parley.headers]");
    expect(toml).toContain('"x-parley-task" = "t7"');
  });

  it("escapes quotes, backslashes, and control characters in TOML values", async () => {
    const hub: HubInfo = {
      url: 'http://127.0.0.1:1/mcp?q="x"\\y',
      headers: { "x-parley-task": "t1\nInjected = true" },
    };
    const plan = await adapter().prepare(spec(), hub);
    const toml = plan.files.find((f) => f.path === ".grok/config.toml")!.contents;
    expect(toml).toContain('url = "http://127.0.0.1:1/mcp?q=\\"x\\"\\\\y"');
    // The newline is escaped, so no injected config line appears.
    expect(toml).toContain('"x-parley-task" = "t1\\u000aInjected = true"');
    expect(toml).not.toMatch(/^Injected = true$/m);
  });

  it("the no-network sandbox.toml extends the base built-in with restrict_network", async () => {
    const plan = await adapter().prepare(spec({ sandbox: "workspace", network: false }), HUB);
    const sb = plan.files.find((f) => f.path === ".grok/sandbox.toml");
    expect(sb).toBeDefined();
    expect(sb!.contents).toContain("[profiles.parley-restricted]");
    expect(sb!.contents).toContain('extends = "workspace"');
    expect(sb!.contents).toContain("restrict_network = true");
  });
});

describe("grok adapter — parseEvent (tolerant)", () => {
  const adapter = createGrokAdapter({});

  it("maps text chunks to messages and end to session_meta", () => {
    expect(adapter.parseEvent('{"type":"text","data":"Hi"}')).toEqual([
      { kind: "message", text: "Hi" },
    ]);
    expect(
      adapter.parseEvent('{"type":"end","stopReason":"EndTurn","sessionId":"sid-9"}'),
    ).toEqual([{ kind: "session_meta", session_id: "sid-9" }]);
  });

  it("treats thought chunks as opaque (no normalized event)", () => {
    expect(adapter.parseEvent('{"type":"thought","data":"hmm"}')).toEqual([]);
  });

  it("never throws on unknown, changed, or malformed shapes", () => {
    expect(adapter.parseEvent('{"type":"totally_new_kind","x":1}')).toEqual([]);
    expect(adapter.parseEvent('{"no":"type"}')).toEqual([]);
    expect(adapter.parseEvent("not json at all")).toEqual([]);
    expect(adapter.parseEvent("42")).toEqual([]);
    expect(adapter.parseEvent("")).toEqual([]);
    expect(adapter.parseEvent('{"type":"end"}')).toEqual([
      { kind: "session_meta", session_id: undefined },
    ]);
  });

  it("surfaces error/fatal events tagged for diag.log (#186)", () => {
    // Tagged with PARLEY-DIAG so they land in diag.log — grok's stream has no
    // structured tool/denial events, so this is its only anomaly channel.
    expect(adapter.parseEvent('{"type":"error","message":"boom"}')).toEqual([
      { kind: "error", fatal: false, text: "PARLEY-DIAG error: boom" },
    ]);
    expect(adapter.parseEvent('{"type":"fatal","message":"dead"}')).toEqual([
      { kind: "error", fatal: true, text: "PARLEY-DIAG fatal: dead" },
    ]);
  });
});

describe("grok adapter — probe classifier pure functions (#247)", () => {
  const BWRAP_MSG =
    "error: this sandbox could not enforce its mount-namespace deny set on Linux " +
    "(bubblewrap missing/unusable). Refusing to start with denied paths unprotected. " +
    "(bwrap exec failed: No such file or directory (os error 2))";

  it("treats workspace and read-only as sandboxed, full as not", () => {
    expect(isSandboxedGrokPosture("workspace")).toBe(true);
    expect(isSandboxedGrokPosture("read-only")).toBe(true);
    expect(isSandboxedGrokPosture("full")).toBe(false);
  });

  it("matches grok's sandbox-refusal signature and ignores unrelated text", () => {
    expect(isGrokSandboxRefusalSignature(BWRAP_MSG)).toBe(true);
    expect(isGrokSandboxRefusalSignature("Command failed: grok inspect --json")).toBe(false);
    expect(isGrokSandboxRefusalSignature("some other error")).toBe(false);
  });

  it("classifies ENOENT and timeout as unavailable, other errors as failed", () => {
    const enoent = Object.assign(new Error("spawn grok ENOENT"), { code: "ENOENT" });
    expect(classifyGrokProbeError(enoent)).toEqual({
      kind: "unavailable",
      reason: "missing_binary",
      message: "spawn grok ENOENT",
    });
    const timeout = Object.assign(new Error("Command timed out"), { killed: true });
    expect(classifyGrokProbeError(timeout)).toEqual({
      kind: "unavailable",
      reason: "timeout",
      message: "Command timed out",
    });
    expect(classifyGrokProbeError(new Error("Command failed: exit 3"))).toEqual({
      kind: "failed",
      message: "Command failed: exit 3",
    });
  });

  it("fail-open: permission hit, shape drift, missing binary, timeout, full+failure", () => {
    expect(decideGrokPermissionProbe({ kind: "ok", loaded: 0, sources: "" }, "workspace")).toEqual({
      action: "quiet",
    });
    const hit = decideGrokPermissionProbe(
      { kind: "ok", loaded: 2, sources: "a" },
      "workspace",
    );
    expect(hit.action).toBe("diagnostic");
    if (hit.action === "diagnostic") {
      expect(hit.text).toMatch(/^PARLEY-DIAG claude_permission_import loaded=2/);
    }

    const shape = decideGrokPermissionProbe(
      { kind: "shape_drift", message: "unrecognized shape" },
      "workspace",
    );
    expect(shape).toEqual({
      action: "diagnostic",
      text: "PARLEY-DIAG permission_probe failed: unrecognized shape",
    });

    const missing = decideGrokPermissionProbe(
      { kind: "unavailable", reason: "missing_binary", message: "ENOENT" },
      "workspace",
    );
    expect(missing.action).toBe("diagnostic");

    const timedOut = decideGrokPermissionProbe(
      { kind: "unavailable", reason: "timeout", message: "timeout" },
      "read-only",
    );
    expect(timedOut.action).toBe("diagnostic");

    const fullFail = decideGrokPermissionProbe(
      { kind: "failed", message: BWRAP_MSG },
      "full",
    );
    expect(fullFail.action).toBe("diagnostic");
  });

  it("fatal path: sandboxed + sandbox-refusal signature → sharp actionable error", () => {
    for (const sandbox of ["workspace", "read-only"] as const) {
      const decision = decideGrokPermissionProbe({ kind: "failed", message: BWRAP_MSG }, sandbox);
      expect(decision.action).toBe("fatal");
      if (decision.action === "fatal") {
        expect(decision.error).toContain(`sandbox posture "${sandbox}"`);
        expect(decision.error).toMatch(/bubblewrap missing or unusable/i);
        expect(decision.error).toContain('sandbox: "full"');
        expect(decision.error).not.toMatch(/apt install/);
        expect(decision.error).toBe(
          formatGrokSandboxUnenforceableError(sandbox, {
            signatureMatched: true,
            probeMessage: BWRAP_MSG,
          }),
        );
      }
    }
  });

  it("drift fallback: sandboxed + failed without signature still fails prepare", () => {
    const raw = "Command failed: grok inspect --json\nsome new refusal wording";
    const decision = decideGrokPermissionProbe({ kind: "failed", message: raw }, "workspace");
    expect(decision.action).toBe("fatal");
    if (decision.action === "fatal") {
      expect(decision.error).toContain('sandbox posture "workspace"');
      expect(decision.error).toContain(raw);
      expect(decision.error).toContain('sandbox: "full"');
      expect(decision.error).not.toMatch(/apt install/);
    }
  });
});

describe("grok adapter — preflight permission probe (#186 / #247)", () => {
  /** A fake `grok` binary whose `inspect --json` prints the given JSON. */
  function stubBin(script: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-grok-stub-"));
    scratch.push(dir);
    const file = path.join(dir, "grok");
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
  }

  function inspectStub(json: string): string {
    return stubBin(`if [ "$1" = "inspect" ]; then echo '${json}'; fi`);
  }

  /** Stub that fails inspect with the given stderr (exit 1). */
  function inspectFailStub(stderr: string): string {
    // Escape for single-quoted shell string.
    const escaped = stderr.replace(/'/g, `'\\''`);
    return stubBin(`if [ "$1" = "inspect" ]; then echo '${escaped}' >&2; exit 1; fi`);
  }

  it("emits a tagged diagnostic when Claude permission rules would load", async () => {
    const bin = inspectStub(
      '{"permissions":{"loaded":9,"sources":["~/.claude/settings.json (settings)"]}}',
    );
    const plan = await createGrokAdapter({ PARLEY_GROK_BIN: bin }).prepare(
      spec({ cwd: os.tmpdir() }),
      HUB,
    );
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics![0]).toMatch(/^PARLEY-DIAG claude_permission_import loaded=9/);
    expect(plan.diagnostics![0]).toContain("~/.claude/settings.json (settings)");
  });

  it("stays quiet when zero rules load (the expected post-#179 state)", async () => {
    const bin = inspectStub('{"permissions":{"loaded":0,"sources":[]}}');
    const plan = await createGrokAdapter({ PARLEY_GROK_BIN: bin }).prepare(
      spec({ cwd: os.tmpdir() }),
      HUB,
    );
    expect(plan.diagnostics).toEqual([]);
  });

  it("probes resumes with the same tripwire", async () => {
    const bin = inspectStub('{"permissions":{"loaded":2,"sources":[]}}');
    const plan = await createGrokAdapter({ PARLEY_GROK_BIN: bin }).resume(
      spec({ cwd: os.tmpdir(), sessionId: "sess-1" }),
      HUB,
    );
    expect(plan.diagnostics![0]).toMatch(/^PARLEY-DIAG claude_permission_import loaded=2/);
  });

  it("is fail-open: missing binary and shape drift become diagnostics under workspace", async () => {
    const cases = [
      path.join(os.tmpdir(), "parley-no-such-grok"), // ENOENT
      inspectStub('{"unexpected":true}'), // shape drift must not disarm the tripwire
    ];
    for (const bin of cases) {
      const plan = await createGrokAdapter({ PARLEY_GROK_BIN: bin }).prepare(
        spec({ cwd: os.tmpdir(), sandbox: "workspace" }),
        HUB,
      );
      expect(plan.argv[0]).toBe(bin); // spawn plan intact
      expect(plan.diagnostics).toHaveLength(1);
      expect(plan.diagnostics![0]).toMatch(/^PARLEY-DIAG permission_probe failed: /);
    }
  });

  it("is fail-open: non-zero exit under sandbox:full stays a diagnostic", async () => {
    const bin = stubBin("exit 3");
    const plan = await createGrokAdapter({ PARLEY_GROK_BIN: bin }).prepare(
      spec({ cwd: os.tmpdir(), sandbox: "full" }),
      HUB,
    );
    expect(plan.argv[0]).toBe(bin);
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics![0]).toMatch(/^PARLEY-DIAG permission_probe failed: /);
  });

  it("fatal: sandbox-refusal under workspace rejects prepare with actionable error", async () => {
    const bin = inspectFailStub(
      "error: this sandbox could not enforce its mount-namespace deny set on Linux " +
        "(bubblewrap missing/unusable). Refusing to start with denied paths unprotected. " +
        "(bwrap exec failed: No such file or directory (os error 2))",
    );
    await expect(
      createGrokAdapter({ PARLEY_GROK_BIN: bin }).prepare(
        spec({ cwd: os.tmpdir(), sandbox: "workspace" }),
        HUB,
      ),
    ).rejects.toThrow(/sandbox posture "workspace".*sandbox: "full"/);
  });

  it("fatal: sandbox-refusal under read-only rejects prepare", async () => {
    const bin = inspectFailStub(
      "error: this sandbox could not enforce its mount-namespace deny set on Linux " +
        "(bubblewrap missing/unusable). (bwrap exec failed)",
    );
    await expect(
      createGrokAdapter({ PARLEY_GROK_BIN: bin }).prepare(
        spec({ cwd: os.tmpdir(), sandbox: "read-only" }),
        HUB,
      ),
    ).rejects.toThrow(/sandbox posture "read-only"/);
  });

  it("drift fallback: non-zero exit under workspace without signature still rejects", async () => {
    const bin = stubBin("echo 'vendor refused for a new reason' >&2; exit 3");
    await expect(
      createGrokAdapter({ PARLEY_GROK_BIN: bin }).prepare(
        spec({ cwd: os.tmpdir(), sandbox: "workspace" }),
        HUB,
      ),
    ).rejects.toThrow(/sandbox posture "workspace".*Preflight probe failed/);
  });

  it("fatal path on resume uses the same gate", async () => {
    const bin = inspectFailStub(
      "bubblewrap missing/unusable — refusing to start with denied paths unprotected",
    );
    await expect(
      createGrokAdapter({ PARLEY_GROK_BIN: bin }).resume(
        spec({ cwd: os.tmpdir(), sandbox: "workspace", sessionId: "sess-1" }),
        HUB,
      ),
    ).rejects.toThrow(/sandbox posture "workspace"/);
  });
});

describe("grok adapter — golden JSONL fixtures (pins observed 0.2.93)", () => {
  function replay(file: string): { messages: string; sessionId: string | undefined } {
    const adapter = createGrokAdapter({});
    const lines = fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
    const events = lines.flatMap((line) => adapter.parseEvent(line));
    const messages = events
      .filter((e) => e.kind === "message")
      .map((e) => e.text ?? "")
      .join("");
    return { messages, sessionId: adapter.sessionId(events) };
  }

  it("reconstructs the assistant message and session id from a fresh run", () => {
    const { messages, sessionId } = replay("v0.2.93-fresh.jsonl");
    expect(messages).toBe("Hi. How can I help?");
    expect(sessionId).toBe("019f49ce-3e6a-72b2-b5a3-2ed48e513384");
  });

  it("reconstructs a resume turn and its (stable) session id", () => {
    const { messages, sessionId } = replay("v0.2.93-resume.jsonl");
    expect(messages).toBe("PLATYPUS");
    expect(sessionId).toBe("019f49cf-09e0-7123-82df-3084a05b6ebd");
  });
});

describe("grok adapter — worktree git-exclude seam (#19)", () => {
  it("keeps materialized .grok plumbing out of the worktree's git status", () => {
    const src = makeGitRepo();
    scratch.push(src);
    const worktreesDir = fs.mkdtempSync(path.join(src, "..", "wt-"));
    scratch.push(worktreesDir);
    const info = createWorktree({
      repoRoot: src,
      worktreesDir,
      taskId: "t1",
      name: null,
      baseRef: null,
    });

    // Simulate what the engine does: exclude, then materialize the vendor files.
    excludeMaterializedFiles(info.path, [".grok/config.toml", ".grok/sandbox.toml"]);
    fs.mkdirSync(path.join(info.path, ".grok"), { recursive: true });
    fs.writeFileSync(path.join(info.path, ".grok", "config.toml"), "x = 1\n");
    fs.writeFileSync(path.join(info.path, ".grok", "sandbox.toml"), "y = 2\n");

    const status = execFileSync("git", ["-C", info.path, "status", "--porcelain"], {
      encoding: "utf8",
    });
    expect(status).toBe("");

    // A resume re-materializes the same files: excluding again must not grow
    // the exclude file (idempotent across respawns).
    const gitDir = execFileSync("git", ["-C", info.path, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
    }).trim();
    const excludeFile = path.join(gitDir, "parley-exclude");
    const before = fs.readFileSync(excludeFile, "utf8");
    excludeMaterializedFiles(info.path, [".grok/config.toml", ".grok/sandbox.toml"]);
    expect(fs.readFileSync(excludeFile, "utf8")).toBe(before);
  });

  it("excludes the exact file paths, not whole directories (child work stays visible)", () => {
    const src = makeGitRepo();
    scratch.push(src);
    const worktreesDir = fs.mkdtempSync(path.join(src, "..", "wt-"));
    scratch.push(worktreesDir);
    const info = createWorktree({
      repoRoot: src,
      worktreesDir,
      taskId: "t1",
      name: null,
      baseRef: null,
    });

    excludeMaterializedFiles(info.path, [".grok/config.toml"]);
    fs.mkdirSync(path.join(info.path, ".grok"), { recursive: true });
    fs.writeFileSync(path.join(info.path, ".grok", "config.toml"), "x = 1\n");
    // A file the CHILD writes into the same directory must still show up.
    fs.writeFileSync(path.join(info.path, ".grok", "child-artifact.txt"), "work\n");

    const status = execFileSync(
      "git",
      ["-C", info.path, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8" },
    );
    expect(status).toContain(".grok/child-artifact.txt");
    expect(status).not.toContain("config.toml");
  });
});
