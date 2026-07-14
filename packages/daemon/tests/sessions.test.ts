/**
 * #88 — historical orchestrator sessions: DB aggregation + GET /sessions wire.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths, type SessionsResponse } from "@useparley/core";
import { insertTask, listSessions, openDatabase, updateTask, type DatabaseHandle } from "../src/db.js";
import { startServer, type DaemonServer } from "../src/server.js";

let home: string;
let db: DatabaseHandle;

function seedTask(
  id: string,
  session: string,
  extras: { name?: string } = {},
): void {
  insertTask(db, {
    id,
    name: extras.name ?? id,
    vendor: "fake",
    model: null,
    effort: null,
    repo: null,
    cwd: "/tmp",
    prompt: "do it",
    orchestrator_session_id: session,
    worktree: null,
    branch: null,
    base_sha: null,
    sandbox: "workspace",
    network: true,
    answer_timeout_ms: null,
    report_schema: null,
  });
}

/** Seed a task with a null orchestrator_session_id (column allows NULL; NewTask does not). */
function seedTaskNoSession(id: string): void {
  seedTask(id, "placeholder");
  db.prepare(`UPDATE tasks SET orchestrator_session_id = NULL WHERE id = ?`).run(id);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-sessions-"));
  db = openDatabase(homePaths(home));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("listSessions (#88)", () => {
  it("aggregates distinct orchestrator sessions with task counts and last activity", () => {
    seedTask("t1", "sess-alpha");
    seedTask("t2", "sess-alpha");
    seedTask("t3", "sess-beta");
    seedTaskNoSession("t4");

    const sessions = listSessions(db);
    expect(sessions.map((s) => s.id).sort()).toEqual(["sess-alpha", "sess-beta"]);
    expect(sessions.find((s) => s.id === "sess-alpha")!.task_count).toBe(2);
    expect(sessions.find((s) => s.id === "sess-beta")!.task_count).toBe(1);
    for (const s of sessions) {
      expect(typeof s.last_activity_at).toBe("string");
      expect(s.last_activity_at.length).toBeGreaterThan(0);
    }
  });

  it("orders by last activity descending", async () => {
    seedTask("t1", "sess-old");
    // Ensure a measurable gap so MAX(updated_at) differs across sessions.
    await new Promise((r) => setTimeout(r, 5));
    seedTask("t2", "sess-new");
    updateTask(db, "t2", { state: "running" });

    const sessions = listSessions(db);
    expect(sessions.map((s) => s.id)).toEqual(["sess-new", "sess-old"]);
  });

  it("filters by id substring case-insensitively", () => {
    seedTask("t1", "orch-ABC-1");
    seedTask("t2", "orch-xyz-2");
    seedTask("t3", "other-session");

    expect(listSessions(db, "abc").map((s) => s.id)).toEqual(["orch-ABC-1"]);
    expect(listSessions(db, "ORCH").map((s) => s.id).sort()).toEqual([
      "orch-ABC-1",
      "orch-xyz-2",
    ]);
    expect(listSessions(db, "nope")).toEqual([]);
  });

  it("returns empty when no tasks carry a session id", () => {
    seedTaskNoSession("t1");
    expect(listSessions(db)).toEqual([]);
  });
});

describe("GET /sessions (#88)", () => {
  let server: DaemonServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("serves aggregated sessions over the HTTP contract", async () => {
    seedTask("t1", "sess-wire-a");
    seedTask("t2", "sess-wire-b");
    // Close our handle so startServer can open the same DB cleanly.
    db.close();

    server = await startServer(homePaths(home));
    const res = await fetch(`http://127.0.0.1:${server.port}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions.map((s) => s.id).sort()).toEqual(["sess-wire-a", "sess-wire-b"]);
    expect(body.sessions[0]).toMatchObject({
      id: expect.any(String),
      last_activity_at: expect.any(String),
      task_count: expect.any(Number),
    });

    const filtered = await fetch(`http://127.0.0.1:${server.port}/sessions?q=wire-a`);
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as SessionsResponse;
    expect(filteredBody.sessions.map((s) => s.id)).toEqual(["sess-wire-a"]);

    // Re-open for afterEach cleanup of the home dir; startServer closed its own.
    db = openDatabase(homePaths(home));
  });
});
