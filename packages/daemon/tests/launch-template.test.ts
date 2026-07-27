/**
 * Profile launch templates (#195 / ADR-0015): custom argv, declared provenance,
 * free-form vendor, allowlist exemption, fresh-only reattempts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  insertTask,
  listTasks,
  nextTaskId,
  openDatabase,
  updateTask, writeTaskState,
  type DatabaseHandle,
} from "../src/db.js";
import { TaskEngine } from "../src/engine.js";
import { aggregateMetrics } from "../src/metrics.js";
import { buildInfoConfig, renderInfoProse } from "../src/info.js";
import { startServer, type DaemonServer } from "../src/server.js";
import { parseLaunchCommands } from "../src/trace.js";
import { withFakeAllowlist } from "./helpers.js";

const FAKE_VENDOR_BIN = fileURLToPath(
  new URL("../../cli/tests/fake-vendor.mjs", import.meta.url),
);

let home: string;
let cwd: string;
let db: DatabaseHandle;
let server: DaemonServer | null = null;

function writeConfig(body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify(body));
}

function script(actions: unknown[]): void {
  fs.writeFileSync(path.join(cwd, ".fake-vendor.json"), JSON.stringify(actions));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
  intervalMs = 30,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

/** GET /tasks/:ref returns `{ row, task, ... }`; tests read the row. */
async function fetchTaskRow(
  base: string,
  taskId: string,
): Promise<Record<string, unknown>> {
  const st = await fetch(`${base}/tasks/${taskId}`);
  const body = (await st.json()) as { row: Record<string, unknown> };
  return body.row;
}

function baseRequest(
  overrides: Partial<Parameters<TaskEngine["delegate"]>[0]> = {},
): Parameters<TaskEngine["delegate"]>[0] {
  return {
    prompt: "do the template thing",
    vendor: null,
    profile: "tmpl",
    model: null,
    effort: null,
    name: null,
    orchestratorSessionId: "orch",
    cwd,
    useWorktree: false,
    baseRef: null,
    sandbox: null,
    network: null,
    answerTimeoutMs: null,
    reportSchema: null,
    contexts: [],
    runner: null,
    size: null,
    difficulty: null,
    type: null,
    ...overrides,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-tmpl-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "parley-tmpl-cwd-"));
  db = openDatabase(homePaths(home));
  process.env.PARLEY_HOME = home;
  process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.PARLEY_FAKE_VENDOR_BIN;
  delete process.env.PARLEY_HOME;
});

describe("delegate resolution for launch templates (#195)", () => {
  function engineBare(): TaskEngine {
    return new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
  }

  it("records declared model/effort and skips allowlist", () => {
    writeConfig({
      profiles: {
        tmpl: {
          vendor: "fake",
          model: "not-on-allowlist",
          effort: "ultra",
          template: ["echo", "$PROMPT"],
          hint: "custom launch",
        },
      },
      // No vendors.fake.models — would fail adapter path; template is exempt.
    });
    const row = engineBare().delegate(baseRequest());
    expect(row.model).toBe("not-on-allowlist");
    expect(row.effort).toBe("ultra");
    expect(row.model_source).toBe("declared");
    expect(row.effort_source).toBe("declared");
    expect(row.profile).toBe("tmpl");
  });

  it("allows unregistered vendor only with a template", () => {
    writeConfig({
      profiles: {
        free: {
          vendor: "totally-unknown-tool",
          model: "m",
          template: ["true"],
        },
        bare: { vendor: "totally-unknown-tool" },
      },
    });
    const ok = engineBare().delegate(baseRequest({ profile: "free" }));
    expect(ok.vendor).toBe("totally-unknown-tool");
    expect(ok.model_source).toBe("declared");

    expect(() => engineBare().delegate(baseRequest({ profile: "bare" }))).toThrow(
      /unknown vendor: totally-unknown-tool/,
    );
  });

  it("still enforces allowlist on non-template profiles", () => {
    writeConfig(
      withFakeAllowlist({
        profiles: {
          normal: { vendor: "fake", model: "nope", effort: "low" },
        },
      }),
    );
    expect(() =>
      engineBare().delegate(baseRequest({ profile: "normal" })),
    ).toThrow(/nope|Allowed combos/);
  });
});

describe("template spawn argv + wrapping (#195)", () => {
  it("spawns exactly the templated argv with $VAR/$PROMPT expanded; no adapter flags", async () => {
    script([
      {
        submit_report_http: {
          summary: "ok",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);
    writeConfig({
      profiles: {
        tmpl: {
          vendor: "custom-bin",
          model: "declared-m",
          effort: "declared-e",
          sandbox: "read-only",
          network: false,
          env: { MY_FLAG: "from-profile", EXTRA: "p" },
          template: [
            process.execPath,
            FAKE_VENDOR_BIN,
            "$PROMPT",
            "--marker",
            "$MY_FLAG",
            "--task",
            "$PARLEY_TASK_ID",
          ],
          hint: "http template",
        },
      },
      vendors: {
        // Unrelated vendor env must not require an adapter; free-form vendor.
        // Optional vendor env for free-form id is still merged when present.
        "custom-bin": {
          env: { VENDOR_ENV: "v" },
        },
      },
    });

    db.close();
    server = await startServer(homePaths(home));
    const base = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "brief-text",
        profile: "tmpl",
        orchestrator_session_id: "orch",
        cwd,
        use_worktree: false,
      }),
    });
    expect(res.status).toBe(201);
    const ack = (await res.json()) as { task_id: string };
    const taskId = ack.task_id;

    await waitFor(async () => {
      const row = await fetchTaskRow(base, taskId);
      return row.state === "completed" || row.state === "failed";
    });

    const row = await fetchTaskRow(base, taskId);
    expect(row.state).toBe("completed");
    expect(row.model).toBe("declared-m");
    expect(row.model_source).toBe("declared");
    expect(row.effort_source).toBe("declared");
    expect(row.sandbox).toBe("read-only");
    expect(row.network).toBe(0);

    const launches =
      typeof row.launch_command === "string"
        ? parseLaunchCommands(row.launch_command)
        : ((row.launch_command as Array<{ argv: string[]; env_names: string[] }> | null) ??
          []);
    expect(launches).toHaveLength(1);
    const argv = launches[0]!.argv;
    // Template owns argv: node + fake-vendor + prompt elided + marker flags.
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe(FAKE_VENDOR_BIN);
    expect(argv).toContain("<prompt>");
    expect(argv).toContain("--marker");
    expect(argv).toContain("from-profile");
    expect(argv).toContain("--task");
    expect(argv).toContain(taskId);
    // Adapter-composed flags absent (fake adapter would put FAKE_* only in env;
    // argv must not look like `codex exec` / other harness heads).
    expect(argv.join(" ")).not.toMatch(/\bcodex\b/);
    expect(argv.join(" ")).not.toMatch(/\bgrok\b/);
    // Env merge applied (names recorded).
    expect(launches[0]!.env_names).toEqual(
      expect.arrayContaining([
        "MY_FLAG",
        "VENDOR_ENV",
        "PARLEY_SANDBOX",
        "PARLEY_NETWORK",
        "PARLEY_HUB_URL",
        "PARLEY_TASK_ID",
      ]),
    );
  });

  it("non-template profile is unchanged (adapter path + allowlist)", async () => {
    script([
      {
        submit_report: {
          summary: "ok",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);
    writeConfig(
      withFakeAllowlist({
        profiles: {
          deep: {
            vendor: "fake",
            model: "m-profile",
            effort: "high",
            args: ["--extra-from-profile"],
          },
        },
      }),
    );
    db.close();
    server = await startServer(homePaths(home));
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "adapter path",
        profile: "deep",
        orchestrator_session_id: "orch",
        cwd,
        use_worktree: false,
      }),
    });
    expect(res.status).toBe(201);
    const ack = (await res.json()) as { task_id: string };
    await waitFor(async () => {
      const row = await fetchTaskRow(base, ack.task_id);
      return row.state === "completed" || row.state === "failed";
    });
    const row = await fetchTaskRow(base, ack.task_id);
    expect(row.state).toBe("completed");
    expect(row.model).toBe("m-profile");
    expect(row.model_source).toBe("resolved");
    const launches =
      typeof row.launch_command === "string"
        ? parseLaunchCommands(row.launch_command)
        : ((row.launch_command as Array<{ argv: string[] }> | null) ?? []);
    // Fake adapter argv: node, bin, prompt, extraArgs
    expect(launches[0]!.argv).toContain("--extra-from-profile");
    expect(launches[0]!.argv).toContain(FAKE_VENDOR_BIN);
  });

  it("template task can ask/report over HTTP and complete", async () => {
    script([
      { ask_http: "which approach?" },
      {
        submit_report_http: {
          summary: "done after answer",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);
    writeConfig({
      profiles: {
        tmpl: {
          vendor: "http-tool",
          template: [process.execPath, FAKE_VENDOR_BIN, "$PROMPT"],
        },
      },
    });
    db.close();
    server = await startServer(homePaths(home));
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "use http channel",
        profile: "tmpl",
        orchestrator_session_id: "orch",
        cwd,
        use_worktree: false,
        answer_timeout_ms: 30_000,
      }),
    });
    expect(res.status).toBe(201);
    const ack = (await res.json()) as { task_id: string };

    await waitFor(async () => {
      const row = await fetchTaskRow(base, ack.task_id);
      return row.state === "awaiting_answer";
    });

    const ans = await fetch(`${base}/tasks/${ack.task_id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "the simple one" }),
    });
    expect(ans.status).toBe(200);

    await waitFor(async () => {
      const row = await fetchTaskRow(base, ack.task_id);
      return row.state === "completed" || row.state === "failed";
    });
    const row = await fetchTaskRow(base, ack.task_id);
    expect(row.state).toBe("completed");
    expect(String(row.report)).toMatch(/done after answer/);
  });
});

describe("fix on template profile is always fresh (#195)", () => {
  it("does not resume even when parent has a session and resume is on", async () => {
    script([
      {
        submit_report_http: {
          summary: "first",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);
    writeConfig({
      profiles: {
        tmpl: {
          vendor: "http-tool",
          model: "m",
          template: [process.execPath, FAKE_VENDOR_BIN, "$PROMPT"],
        },
      },
      resume: { enabled: true },
    });
    db.close();
    server = await startServer(homePaths(home));
    const base = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "first attempt",
        profile: "tmpl",
        orchestrator_session_id: "orch",
        cwd,
        use_worktree: false,
      }),
    });
    expect(res.status).toBe(201);
    const parent = (await res.json()) as { task_id: string };
    await waitFor(async () => {
      const row = await fetchTaskRow(base, parent.task_id);
      return row.state === "completed" || row.state === "failed";
    });

    // Rewrite script for second attempt before fix spawns.
    script([
      {
        submit_report_http: {
          summary: "fixed",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);

    // Inject a parent vendor session so a non-template path would resume;
    // template profiles must still force fresh (#195).
    await server!.close();
    server = null;
    db = openDatabase(homePaths(home));
    updateTask(db, parent.task_id, { session_id: "sess-parent" });
    db.close();

    server = await startServer(homePaths(home));
    const base2 = `http://127.0.0.1:${server.port}`;
    const fixRes = await fetch(`${base2}/tasks/${parent.task_id}/fix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "please fix",
        orchestrator_session_id: "orch",
      }),
    });
    expect(fixRes.status).toBe(201);
    const fixed = (await fixRes.json()) as {
      task_id: string;
      resumed: boolean;
      attempt: number;
    };
    expect(fixed.resumed).toBe(false);
    expect(fixed.attempt).toBe(2);

    await waitFor(async () => {
      const row = await fetchTaskRow(base2, fixed.task_id);
      return (
        row.state === "completed" ||
        row.state === "failed" ||
        row.state === "running" ||
        row.state === "pending"
      );
    });
    const row = await fetchTaskRow(base2, fixed.task_id);
    expect(row.resumed === 0 || row.resumed === false).toBe(true);
  });
});

describe("eval groups declared separately (#195)", () => {
  it("metrics groupBy model prefixes declared values", () => {
    const a = nextTaskId(db);
    insertTask(db, {
      id: a,
      name: null,
      vendor: "fake",
      model: "same-model",
      effort: "high",
      model_source: "resolved",
      effort_source: "resolved",
      profile: null,
      repo: null,
      cwd,
      prompt: "a",
      orchestrator_session_id: "orch",
      worktree: null,
      branch: null,
      base_sha: null,
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "other",
    });
    writeTaskState(db, a, "completed", {
      completed_at: new Date().toISOString(),
      eval_score: 8,
      eval_baseline: 5,
      eval_rubric: "other",
      eval_rubric_version: 1,
      eval_answers: JSON.stringify({}),
    });
    const b = nextTaskId(db);
    insertTask(db, {
      id: b,
      name: null,
      vendor: "fake",
      model: "same-model",
      effort: "high",
      model_source: "declared",
      effort_source: "declared",
      profile: "tmpl",
      repo: null,
      cwd,
      prompt: "b",
      orchestrator_session_id: "orch",
      worktree: null,
      branch: null,
      base_sha: null,
      sandbox: "workspace",
      network: true,
      answer_timeout_ms: null,
      report_schema: null,
      size: null,
      difficulty: null,
      type: "other",
    });
    writeTaskState(db, b, "completed", {
      completed_at: new Date().toISOString(),
      eval_score: 6,
      eval_baseline: 5,
      eval_rubric: "other",
      eval_rubric_version: 1,
      eval_answers: JSON.stringify({}),
    });

    const { groups } = aggregateMetrics(listTasks(db), { groupBy: "model" });
    const keys = groups.map((g) => g.key).sort();
    expect(keys).toEqual(["declared:same-model", "same-model"]);
    expect(groups.find((g) => g.key === "same-model")!.tasks.total).toBe(1);
    expect(groups.find((g) => g.key === "declared:same-model")!.tasks.total).toBe(1);
  });
});

describe("parley info surfaces template + hint (#195)", () => {
  it("includes template flag, declared combo, and hint in config and prose", () => {
    writeConfig(
      withFakeAllowlist({
        profiles: {
          deep: {
            vendor: "fake",
            model: "m-profile",
            effort: "high",
          },
          custom: {
            vendor: "my-tool",
            model: "m-declared",
            effort: "max",
            template: ["my-tool", "$PROMPT"],
            hint: "for offline one-shots",
          },
        },
      }),
    );
    const paths = homePaths(home);
    const adapters = createAdapterRegistrySync(process.env);
    const config = buildInfoConfig({ projectDir: cwd, paths, adapters });
    const custom = config.profiles.find((p) => p.name === "custom");
    const deep = config.profiles.find((p) => p.name === "deep");
    expect(custom).toMatchObject({
      template: true,
      hint: "for offline one-shots",
      model: "m-declared",
      effort: "max",
    });
    expect(deep).toMatchObject({ template: false, hint: null });

    const prose = renderInfoProse(config);
    expect(prose).toContain("`custom`");
    expect(prose).toContain("template");
    expect(prose).toContain("hint: for offline one-shots");
    expect(prose).toContain("model=m-declared (declared)");
    expect(prose).toMatch(/Launch-template profiles never resume/);
  });
});
