/**
 * #333 — daemon restart must not fail queued (or recovery-spawned) tasks
 * because the hub port is not yet bound.
 *
 * Production order: server listen callback → setHubPort(port) → start().
 * start() drains the concurrency queue and runs; all launch paths share
 * startAdmittedTask → hubFor(), so sequencing recovery after bind covers
 * fresh runs, resumes, fix reattempts, and template children.
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
  listTasks,
  nextTaskId,
  openDatabase,
  writeTaskState,
  type DatabaseHandle,
} from "../src/db.js";
import { TaskEngine } from "../src/engine.js";
import { startServer, type DaemonServer } from "../src/server.js";
import { withFakeAllowlist } from "./helpers.js";

const FAKE_VENDOR_BIN = fileURLToPath(
  new URL("../../cli/tests/fake-vendor.mjs", import.meta.url),
);

const HUB_PORT_ERROR = /no hub port yet/;

let home: string;
let cwd: string;
let db: DatabaseHandle;
let server: DaemonServer | null = null;

function writeConfig(body: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(withFakeAllowlist(body)),
  );
}

function script(actions: unknown[]): void {
  fs.writeFileSync(path.join(cwd, ".fake-vendor.json"), JSON.stringify(actions));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 30,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

function seedQueuedTask(id: string, queuedAt: string): void {
  insertTask(db, {
    id,
    name: null,
    vendor: "fake",
    model: "fake-model",
    effort: "medium",
    profile: null,
    repo: null,
    cwd,
    prompt: `queued work ${id}`,
    orchestrator_session_id: "orch-restart",
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
  writeTaskState(db, id, "queued", { queued_at: queuedAt });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-hub-restart-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "parley-hub-restart-cwd-"));
  writeConfig();
  // Complete via HTTP child channel so the hub must be reachable and bound.
  script([
    {
      submit_report_http: {
        summary: "ok after restart recovery",
        outcome: "success",
        files_changed: [],
      },
    },
  ]);
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
    /* already closed by startServer */
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.PARLEY_HOME;
  delete process.env.PARLEY_FAKE_VENDOR_BIN;
});

describe("hub port before restart recovery (#333)", () => {
  it("start() refuses to run before setHubPort", () => {
    const eng = new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
    expect(() => eng.start()).toThrow(/setHubPort first/);
  });

  it("engine start after setHubPort launches durable queued tasks (none hub-port-fail)", async () => {
    const ids = [nextTaskId(db), nextTaskId(db), nextTaskId(db)];
    ids.forEach((id, i) => {
      seedQueuedTask(id, `2026-01-01T00:00:0${i + 1}.000Z`);
    });
    expect(listTasks(db).filter((t) => t.state === "queued")).toHaveLength(3);

    const eng = new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
    // Pre-start: constructor must not have drained into hubFor (tasks still queued).
    expect(listTasks(db).every((t) => t.state === "queued")).toBe(true);

    eng.setHubPort(9);
    eng.start();

    await waitFor(() =>
      ids.every((id) => {
        const row = getTask(db, id);
        return row !== undefined && row.state !== "queued" && row.state !== "pending";
      }),
    );

    for (const id of ids) {
      const row = getTask(db, id)!;
      // With a dummy port nothing listens; tasks may fail for connection reasons
      // but must never terminal-fail on the hub-port ordering bug.
      expect(row.error ?? "").not.toMatch(HUB_PORT_ERROR);
      expect(row.state).not.toBe("queued");
    }

    eng.killChildren();
  });

  it("startServer with durable queued tasks launches every one (none hub-port-fail)", async () => {
    const ids = [nextTaskId(db), nextTaskId(db), nextTaskId(db)];
    ids.forEach((id, i) => {
      seedQueuedTask(id, `2026-01-01T00:00:1${i}.000Z`);
    });
    expect(listTasks(db).filter((t) => t.state === "queued")).toHaveLength(3);

    // Release the DB so startServer can open it (same as production restart).
    db.close();

    server = await startServer(homePaths(home));
    const base = `http://127.0.0.1:${server.port}`;

    await waitFor(async () => {
      const rows = await Promise.all(
        ids.map(async (id) => {
          const res = await fetch(`${base}/tasks/${id}`);
          const body = (await res.json()) as {
            row: { state: string; error: string | null };
          };
          return body.row;
        }),
      );
      return rows.every((r) => r.state === "completed" || r.state === "failed");
    });

    const finalRows = await Promise.all(
      ids.map(async (id) => {
        const res = await fetch(`${base}/tasks/${id}`);
        const body = (await res.json()) as {
          row: { id: string; state: string; error: string | null };
        };
        return body.row;
      }),
    );

    for (const row of finalRows) {
      expect(row.error ?? "", `task ${row.id} error`).not.toMatch(HUB_PORT_ERROR);
      // Real hub is bound — fake vendor submits report over HTTP and completes.
      expect(row.state, `task ${row.id} state`).toBe("completed");
    }

    // Re-open for afterEach home cleanup.
    db = openDatabase(homePaths(home));
  });
});
