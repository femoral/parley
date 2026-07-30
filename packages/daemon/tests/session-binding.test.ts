/**
 * #162 / #280 — daemon-side ancestry matching, liveness, multi-live fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import {
  deleteSession,
  getSession,
  insertSession,
  openDatabase,
  type DatabaseHandle,
  type SessionRow,
} from "../src/db.js";
import { TaskEngine } from "../src/engine.js";
import {
  classifySessionLiveness,
  matchSessionByAncestry,
  readMachineId,
  resolveSessionBinding,
  sessionFallbackWarning,
  sessionRequiredMessage,
} from "../src/session-binding.js";

function session(
  overrides: Partial<SessionRow> & Pick<SessionRow, "id">,
): SessionRow {
  return {
    harness: "claude",
    model: "opus",
    effort: "high",
    workspace_root: "/repo",
    anchor_machine: "m1",
    anchor_pid: 100,
    anchor_start: "1000",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    panicked: 0,
    ...overrides,
  };
}

describe("matchSessionByAncestry (#162)", () => {
  it("picks the deepest (closest-to-self) matching session", () => {
    const a = session({
      id: "sess-a",
      anchor_pid: 100,
      anchor_start: "1000",
    });
    const b = session({
      id: "sess-b",
      anchor_pid: 50,
      anchor_start: "500",
    });
    // Caller chain: self(200) → a(100) → b(50) → init
    const chain = [
      { machine_id: "m1", pid: 200, start_time: "2000" },
      { machine_id: "m1", pid: 100, start_time: "1000" },
      { machine_id: "m1", pid: 50, start_time: "500" },
    ];
    expect(matchSessionByAncestry(chain, [a, b])?.id).toBe("sess-a");
  });

  it("never cross-binds two same-cwd sessions (distinct anchors)", () => {
    const a = session({
      id: "orch-1",
      workspace_root: "/same",
      anchor_pid: 111,
      anchor_start: "t1",
    });
    const b = session({
      id: "orch-2",
      workspace_root: "/same",
      anchor_pid: 222,
      anchor_start: "t2",
    });
    // Caller is a descendant of orch-2 only.
    const chain = [
      { machine_id: "m1", pid: 999, start_time: "now" },
      { machine_id: "m1", pid: 222, start_time: "t2" },
      { machine_id: "m1", pid: 1, start_time: "boot" },
    ];
    expect(matchSessionByAncestry(chain, [a, b])?.id).toBe("orch-2");
    // Chain containing only orch-1's anchor binds orch-1.
    const chain1 = [
      { machine_id: "m1", pid: 888, start_time: "now" },
      { machine_id: "m1", pid: 111, start_time: "t1" },
    ];
    expect(matchSessionByAncestry(chain1, [a, b])?.id).toBe("orch-1");
  });

  it("requires machine_id + start_time (pid alone is not enough)", () => {
    const s = session({ id: "s", anchor_pid: 10, anchor_start: "real" });
    // Same pid, wrong start_time → no match (pid recycling).
    expect(
      matchSessionByAncestry(
        [{ machine_id: "m1", pid: 10, start_time: "recycled" }],
        [s],
      ),
    ).toBeNull();
    // Wrong machine → no match (remote namespace).
    expect(
      matchSessionByAncestry(
        [{ machine_id: "other", pid: 10, start_time: "real" }],
        [s],
      ),
    ).toBeNull();
  });
});

describe("classifySessionLiveness (#280)", () => {
  const alive = new Set([10, 20]);
  const isAlive = (pid: number): boolean => alive.has(pid);
  const starts = new Map<number, string>([
    [10, "t10"],
    [20, "t20"],
  ]);
  const readStart = (pid: number): string | null => starts.get(pid) ?? null;

  it("marks same-machine dead pid as dead", () => {
    const s = session({ id: "dead", anchor_machine: "m1", anchor_pid: 99, anchor_start: "x" });
    expect(classifySessionLiveness(s, "m1", isAlive, readStart)).toBe("dead");
  });

  it("marks same-machine live pid as live", () => {
    const s = session({
      id: "live",
      anchor_machine: "m1",
      anchor_pid: 10,
      anchor_start: "t10",
    });
    expect(classifySessionLiveness(s, "m1", isAlive, readStart)).toBe("live");
  });

  it("marks foreign machine as indeterminate (never dead)", () => {
    const s = session({
      id: "remote",
      anchor_machine: "other-host",
      anchor_pid: 99,
      anchor_start: "x",
    });
    expect(classifySessionLiveness(s, "m1", isAlive, readStart)).toBe(
      "indeterminate",
    );
  });

  it("marks pid-reuse (start mismatch) as dead when start is readable", () => {
    const s = session({
      id: "recycled",
      anchor_machine: "m1",
      anchor_pid: 10,
      anchor_start: "old-start",
    });
    expect(classifySessionLiveness(s, "m1", isAlive, readStart)).toBe("dead");
  });

  it("skips start-time check for degraded re-anchor start \"0\"", () => {
    const s = session({
      id: "degraded",
      anchor_machine: "m1",
      anchor_pid: 10,
      anchor_start: "0",
    });
    expect(classifySessionLiveness(s, "m1", isAlive, readStart)).toBe("live");
  });
});

describe("resolveSessionBinding (#162 / #280)", () => {
  const a = session({
    id: "a",
    workspace_root: "/repo",
    anchor_pid: 10,
    anchor_start: "x",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  const b = session({
    id: "b",
    workspace_root: "/repo",
    anchor_pid: 20,
    anchor_start: "y",
    updated_at: "2026-01-02T00:00:00.000Z",
  });
  const other = session({
    id: "c",
    workspace_root: "/other",
    anchor_pid: 30,
    anchor_start: "z",
  });

  it("--session override always wins (known registered id)", () => {
    const r = resolveSessionBinding({
      explicitSessionId: "b",
      ancestryChain: [{ machine_id: "m1", pid: 10, start_time: "x" }],
      workspaceRoot: "/repo",
      sessions: [a, b],
    });
    expect(r).toEqual({ kind: "bound", session: b });
  });

  it("--session override to unknown id is freeform", () => {
    const r = resolveSessionBinding({
      explicitSessionId: "free-form",
      ancestryChain: [],
      workspaceRoot: "/repo",
      sessions: [a],
    });
    expect(r).toEqual({ kind: "freeform", sessionId: "free-form" });
  });

  it("falls back to the single live session for the workspace root", () => {
    const r = resolveSessionBinding({
      explicitSessionId: null,
      ancestryChain: [],
      workspaceRoot: "/repo",
      sessions: [a, other],
    });
    expect(r).toEqual({ kind: "bound", session: a });
  });

  it("binds most-recent live with warning when multiple live sessions (#280)", () => {
    const r = resolveSessionBinding({
      explicitSessionId: null,
      ancestryChain: [],
      workspaceRoot: "/repo",
      sessions: [a, b],
    });
    expect(r.kind).toBe("bound");
    if (r.kind !== "bound") return;
    expect(r.session.id).toBe("b"); // newer updated_at
    expect(r.warning).toBe(sessionFallbackWarning("b", 2));
    expect(r.warning).toMatch(/most recent of 2 live/);
    expect(r.warning).toMatch(/--session/);
  });

  it("excludes dead sessions from fallback; binds sole remaining live (#280)", () => {
    const dead = session({
      id: "dead",
      workspace_root: "/repo",
      anchor_pid: 99,
      updated_at: "2026-01-03T00:00:00.000Z", // newer than a, but dead
    });
    const r = resolveSessionBinding({
      explicitSessionId: null,
      ancestryChain: [],
      workspaceRoot: "/repo",
      sessions: [a, dead],
      isSessionLive: (s) => s.id !== "dead",
    });
    // Sole live → bind without multi-live warning.
    expect(r).toEqual({ kind: "bound", session: a });
  });

  it("most-recent among several live after excluding dead (#280)", () => {
    const dead = session({
      id: "dead",
      workspace_root: "/repo",
      updated_at: "2026-01-09T00:00:00.000Z",
    });
    const r = resolveSessionBinding({
      explicitSessionId: null,
      ancestryChain: [],
      workspaceRoot: "/repo",
      sessions: [a, b, dead],
      isSessionLive: (s) => s.id !== "dead",
    });
    expect(r.kind).toBe("bound");
    if (r.kind !== "bound") return;
    expect(r.session.id).toBe("b");
    expect(r.warning).toMatch(/most recent of 2 live/);
  });

  it("explicit id still binds a dead-stored session", () => {
    const dead = session({ id: "dead-row", workspace_root: "/repo" });
    const r = resolveSessionBinding({
      explicitSessionId: "dead-row",
      ancestryChain: [],
      workspaceRoot: "/repo",
      sessions: [dead],
      isSessionLive: () => false,
    });
    expect(r).toEqual({ kind: "bound", session: dead });
  });

  it("returns unresolved when nothing matches", () => {
    const r = resolveSessionBinding({
      explicitSessionId: null,
      ancestryChain: [],
      workspaceRoot: "/empty",
      sessions: [a],
    });
    expect(r).toEqual({ kind: "unresolved" });
  });

  it("session_required message teaches the command", () => {
    expect(sessionRequiredMessage()).toMatch(/parley session/);
    expect(sessionRequiredMessage()).toMatch(
      /PARLEY_HARNESS|harness plugin|unknown provenance/,
    );
  });
});

describe("reapDeadSessions (#280)", () => {
  let home: string;
  let db: DatabaseHandle;
  let engine: TaskEngine;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-reap-"));
    const paths = homePaths(home);
    db = openDatabase(paths);
    engine = new TaskEngine(db, paths, new Map());
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  function seed(opts: {
    id: string;
    machine: string;
    pid: number;
    start?: string;
  }): void {
    insertSession(db, {
      id: opts.id,
      harness: "h",
      model: "m",
      effort: "e",
      workspace_root: "/repo",
      anchor: {
        machine_id: opts.machine,
        pid: opts.pid,
        start_time: opts.start ?? "t0",
      },
    });
  }

  it("removes same-machine dead-pid sessions", () => {
    seed({ id: "s-dead", machine: "host-a", pid: 999_001 });
    seed({ id: "s-live", machine: "host-a", pid: 42 });
    const removed = engine.reapDeadSessions({
      machineId: "host-a",
      isPidAlive: (pid) => pid === 42,
      readPidStartTime: () => null,
    });
    expect(removed).toEqual(["s-dead"]);
    expect(getSession(db, "s-dead")).toBeUndefined();
    expect(getSession(db, "s-live")).toBeDefined();
  });

  it("does not remove different-machine anchors", () => {
    seed({ id: "s-remote", machine: "other-host", pid: 999_002 });
    const removed = engine.reapDeadSessions({
      machineId: "host-a",
      isPidAlive: () => false,
      readPidStartTime: () => null,
    });
    expect(removed).toEqual([]);
    expect(getSession(db, "s-remote")).toBeDefined();
  });

  it("does not remove live pids", () => {
    seed({ id: "s-live", machine: "host-a", pid: process.pid });
    const removed = engine.reapDeadSessions({
      machineId: "host-a",
      // Default isPidAlive would also pass for process.pid; be explicit.
      isPidAlive: (pid) => pid === process.pid,
      readPidStartTime: () => null,
    });
    expect(removed).toEqual([]);
    expect(getSession(db, "s-live")).toBeDefined();
  });

  it("removes pid-reuse (start mismatch) as dead", () => {
    seed({ id: "s-recycle", machine: "host-a", pid: 7, start: "old" });
    const removed = engine.reapDeadSessions({
      machineId: "host-a",
      isPidAlive: () => true,
      readPidStartTime: () => "new",
    });
    expect(removed).toEqual(["s-recycle"]);
    expect(getSession(db, "s-recycle")).toBeUndefined();
  });

  it("writes one diag line per reap", () => {
    seed({ id: "s-dead", machine: "host-a", pid: 1 });
    engine.reapDeadSessions({
      machineId: "host-a",
      isPidAlive: () => false,
      readPidStartTime: () => null,
    });
    const diag = fs.readFileSync(path.join(home, "diag.log"), "utf8");
    expect(diag).toMatch(/session-reap: deleted dead session s-dead/);
  });

  it("gc path reaps dead sessions (neuter: fails if reap call deleted from gc)", () => {
    // Use the real host machine id so production gc() → reapDeadSessions()
    // classifies this row as dead without test injection.
    const machineId = readMachineId();
    const deadPid = 2_147_483_640; // not a live process
    seed({ id: "s-gc-dead", machine: machineId, pid: deadPid });
    seed({
      id: "s-gc-foreign",
      machine: "other-machine-never-local",
      pid: deadPid,
    });
    engine.gc({ dryRun: false });
    expect(getSession(db, "s-gc-dead")).toBeUndefined();
    // Foreign-machine rows are never reaped on liveness grounds.
    expect(getSession(db, "s-gc-foreign")).toBeDefined();
  });

  it("gc dry-run does not reap", () => {
    const machineId = readMachineId();
    seed({ id: "s-keep", machine: machineId, pid: 2_147_483_641 });
    engine.gc({ dryRun: true });
    expect(getSession(db, "s-keep")).toBeDefined();
    deleteSession(db, "s-keep");
  });
});
