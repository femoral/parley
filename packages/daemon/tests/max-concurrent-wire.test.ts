/**
 * #350 — effective maxConcurrent on the wire alongside cap identity + position.
 *
 * A queued task's envelope must carry blocking_cap, queue_position, and
 * max_concurrent consistent with daemon config (vendors.*.maxConcurrent /
 * profiles.*.maxConcurrent). Includes a real HTTP surface test so the
 * envelopeFor hookup in server.ts cannot regress undetected.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  getTask,
  insertTask,
  nextTaskId,
  openDatabase,
  writeTaskState,
  type DatabaseHandle,
} from "../src/db.js";
import { TaskEngine } from "../src/engine.js";
import { buildEnvelope } from "../src/report.js";
import { startServer, type DaemonServer } from "../src/server.js";
import { withFakeAllowlist } from "./helpers.js";

const FAKE_VENDOR_BIN = fileURLToPath(
  new URL("../../cli/tests/fake-vendor.mjs", import.meta.url),
);

let home: string;
let db: DatabaseHandle;
let cwd: string;
const liveEngines: TaskEngine[] = [];
let server: DaemonServer | null = null;

function writeParleyConfig(body: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify(withFakeAllowlist(body)));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-maxc-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "parley-maxc-task-"));
  fs.writeFileSync(
    path.join(cwd, ".fake-vendor.json"),
    JSON.stringify([{ exit: 0 }]),
  );
  db = openDatabase(homePaths(home));
  process.env.PARLEY_HOME = home;
  process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
  liveEngines.length = 0;
  server = null;
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  for (const eng of liveEngines) {
    try {
      eng.killChildren();
    } catch {
      /* ignore */
    }
  }
  liveEngines.length = 0;
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

function engine(): TaskEngine {
  const eng = new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
  eng.setHubPort(9);
  liveEngines.push(eng);
  return eng;
}

function baseRequest(
  overrides: Partial<Parameters<TaskEngine["delegate"]>[0]> = {},
): Parameters<TaskEngine["delegate"]>[0] {
  return {
    prompt: "do it",
    vendor: "fake",
    profile: null,
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

function insertRunningSlot(opts: {
  vendor?: string;
  profile?: string | null;
} = {}): string {
  const id = nextTaskId(db);
  insertTask(db, {
    id,
    name: null,
    vendor: opts.vendor ?? "fake",
    model: null,
    effort: null,
    profile: opts.profile ?? null,
    repo: null,
    cwd,
    prompt: "holder",
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
  writeTaskState(db, id, "running", {
    started_at: new Date().toISOString(),
  });
  return id;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

describe("max_concurrent on the wire (#350)", () => {
  it("queued task envelope carries cap identity, position, and config maxConcurrent", async () => {
    writeParleyConfig({ vendors: { fake: { maxConcurrent: 2 } } });
    const eng = engine();
    insertRunningSlot();
    insertRunningSlot();

    const third = eng.delegate(baseRequest());
    await waitFor(() => getTask(db, third.id)?.state === "queued");

    const enriched = eng.withQueueInfo(getTask(db, third.id)!);
    expect(enriched.state).toBe("queued");
    expect(enriched.queue_position).toBe(1);
    expect(enriched.blocking_cap).toBe("vendor:fake");
    expect(enriched.max_concurrent).toBe(2);

    // Envelope path used by HTTP/SSE (envelopeFor → buildEnvelope).
    const env = buildEnvelope(enriched, eng.logDir(third.id), {
      position: enriched.queue_position,
      blockingCap: enriched.blocking_cap,
      maxConcurrent: enriched.max_concurrent,
    });
    expect(env.state).toBe("queued");
    expect(env.queue_position).toBe(1);
    expect(env.blocking_cap).toBe("vendor:fake");
    expect(env.max_concurrent).toBe(2);

    try {
      eng.cancel(third.id);
    } catch {
      /* ok */
    }
  });

  it("profile cap value surfaces when profile is the blocker", async () => {
    writeParleyConfig({
      vendors: { fake: { maxConcurrent: 4 } },
      profiles: { slow: { vendor: "fake", maxConcurrent: 1 } },
    });
    insertRunningSlot({ profile: "slow" });
    const eng = engine();
    const row = eng.delegate(baseRequest({ profile: "slow", vendor: null }));
    await waitFor(() => getTask(db, row.id)?.state === "queued");

    const enriched = eng.withQueueInfo(getTask(db, row.id)!);
    expect(enriched.blocking_cap).toBe("profile:slow");
    expect(enriched.max_concurrent).toBe(1);

    const env = buildEnvelope(enriched, null, {
      position: enriched.queue_position,
      blockingCap: enriched.blocking_cap,
      maxConcurrent: enriched.max_concurrent,
    });
    expect(env.max_concurrent).toBe(1);
    expect(env.blocking_cap).toBe("profile:slow");

    try {
      eng.cancel(row.id);
    } catch {
      /* ok */
    }
  });

  it("max_concurrent is null when not queued", () => {
    writeParleyConfig({ vendors: { fake: { maxConcurrent: 2 } } });
    const eng = engine();
    const id = insertRunningSlot();
    const enriched = eng.withQueueInfo(getTask(db, id)!);
    expect(enriched.state).toBe("running");
    expect(enriched.max_concurrent).toBeNull();
    expect(enriched.blocking_cap).toBeNull();
    expect(enriched.queue_position).toBeNull();

    const env = buildEnvelope(enriched, null, {
      position: enriched.queue_position,
      blockingCap: enriched.blocking_cap,
      maxConcurrent: enriched.max_concurrent,
    });
    expect(env.max_concurrent).toBeNull();
  });

  /**
   * Real HTTP surface: exercises envelopeFor in server.ts. Hand-passing queue
   * args into buildEnvelope alone leaves the server hookup unguarded.
   */
  it("GET /tasks/:id envelope carries max_concurrent via real server", async () => {
    writeParleyConfig({ vendors: { fake: { maxConcurrent: 2 } } });
    // startServer opens its own DB handle; release ours first.
    db.close();
    server = await startServer(homePaths(home));
    const base = `http://127.0.0.1:${server.port}`;

    // Startup sweep marks pre-existing running tasks interrupted — insert
    // slot holders AFTER boot so they still occupy the vendor cap.
    const side = openDatabase(homePaths(home));
    try {
      for (let i = 0; i < 2; i++) {
        const id = nextTaskId(side);
        insertTask(side, {
          id,
          name: null,
          vendor: "fake",
          model: null,
          effort: null,
          profile: null,
          repo: null,
          cwd,
          prompt: "holder",
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
        writeTaskState(side, id, "running", {
          started_at: new Date().toISOString(),
        });
      }
    } finally {
      side.close();
    }

    const created = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "queue me",
        vendor: "fake",
        cwd,
        orchestrator_session_id: "orch",
      }),
    });
    expect(created.status).toBe(201);
    const taskId = ((await created.json()) as { task_id: string }).task_id;

    // Poll until the third task is durable-queued under the full cap.
    let env: {
      state: string;
      queue_position: number | null;
      blocking_cap: string | null;
      max_concurrent: number | null;
    } | null = null;
    await waitFor(async () => {
      const res = await fetch(`${base}/tasks/${taskId}`);
      if (res.status !== 200) return false;
      const body = (await res.json()) as {
        task: {
          state: string;
          queue_position: number | null;
          blocking_cap: string | null;
          max_concurrent: number | null;
        };
      };
      env = body.task;
      return body.task.state === "queued";
    });

    expect(env).not.toBeNull();
    expect(env!.state).toBe("queued");
    expect(env!.blocking_cap).toBe("vendor:fake");
    expect(env!.queue_position).toBe(1);
    // Assert on the envelope (`task`), not storage `row` — only the envelope
    // path goes through envelopeFor's maxConcurrent wiring.
    expect(env!.max_concurrent).toBe(2);

    // Restore a db handle so afterEach can close cleanly.
    db = openDatabase(homePaths(home));
  });
});
