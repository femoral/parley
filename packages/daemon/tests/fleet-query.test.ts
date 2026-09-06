import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { homePaths } from "@useparley/core";
import { openDatabase, insertTask, insertRun, getTask, getRun, setRunBlockReason, writeTaskState, type DatabaseHandle } from "../src/db.js";
import { fleetPageIds, fleetSummary } from "../src/fleet-query.js";
import { startServer, type DaemonServer } from "../src/server.js";

let db: DatabaseHandle;
let home: string;
let server: DaemonServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; db?.close(); if (home) fs.rmSync(home, { recursive: true, force: true }); });

function setup(n: number) {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-fleet-page-"));
  db = openDatabase(homePaths(home));
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const suffix = String(i).padStart(5, "0");
    insertTask(db, { id: `t${suffix}`, name: null, vendor: "fake", model: null, effort: null, profile: null, repo: null, cwd: home, prompt: "brief ".repeat(200), orchestrator_session_id: i % 2 ? "a" : "b", worktree: null, branch: null, base_sha: null, sandbox: "workspace", network: false, answer_timeout_ms: null, report_schema: null, size: null, difficulty: null, type: "other" });
    writeTaskState(db, `t${suffix}`, i % 3 ? "completed" : "failed", { report: JSON.stringify({ outcome: "success", summary: "report ".repeat(100), files_changed: [] }) });
    insertRun(db, { id: `r${suffix}`, workflow: "example", version: 1, type: "other", workspace: "scratch", repo: null, current_node: null, state: i % 3 ? "completed" : "failed", orchestrator_session_id: i % 2 ? "a" : "b" });
  }
  // Deliberate ties: proves ID breaks ties and no OFFSET rescanning is needed.
  db.exec("UPDATE tasks SET created_at = '2026-01-01T00:00:00.000Z'; UPDATE runs SET created_at = '2026-01-01T00:00:00.000Z'; COMMIT");
}

it("pages exact scoped populations, validates cursors, and does not shift older pages on insert", () => {
  setup(210);
  for (const kind of ["tasks", "runs"] as const) {
    const options = new URLSearchParams({ session: "a", state: "failed", limit: "10" });
    const first = fleetPageIds(db, kind, options);
    expect(first.total).toBe(35);
    expect(first.ids).toHaveLength(10);
    const ids = [...first.ids];
    let cursor = first.next_cursor;
    while (cursor) {
      options.set("cursor", cursor);
      const page = fleetPageIds(db, kind, options);
      ids.push(...page.ids); cursor = page.next_cursor;
    }
    expect(new Set(ids).size).toBe(35);
    expect(ids).toEqual([...ids].sort().reverse());
    options.set("cursor", first.next_cursor!);
    const older = fleetPageIds(db, kind, options);
    if (kind === "tasks") {
      insertTask(db, { ...getTask(db, first.ids[0]!)!, id: "new-task", vendor: "fake", cwd: home, prompt: "new arrival", network: false, resumed: false });
      writeTaskState(db, "new-task", "failed", {});
    } else {
      insertRun(db, { ...getRun(db, first.ids[0]!)!, id: "new-run" });
    }
    expect(fleetPageIds(db, kind, options).ids).toEqual(older.ids);
    options.set("session", "b");
    expect(() => fleetPageIds(db, kind, options)).toThrow(/cursor/);
    expect(() => fleetPageIds(db, kind, new URLSearchParams({ cursor: "bad" }))).toThrow(/cursor/);
    expect(() => fleetPageIds(db, kind, new URLSearchParams({ limit: "101" }))).toThrow(/limit/);
  }
  expect(fleetPageIds(db, "tasks", new URLSearchParams({ state: "gate" })).total).toBe(0);
  expect(fleetPageIds(db, "runs", new URLSearchParams({ state: "awaiting_answer" })).total).toBe(0);
  expect(fleetSummary(db, "a").task_total).toBe(106);
  expect(fleetSummary(db, "a").attention).toBe(36);
});

it("attention is independently ranked and gate filtering excludes other block reasons", () => {
  setup(30);
  writeTaskState(db, "t00001", "awaiting_answer", {});
  writeTaskState(db, "t00002", "stalled", {});
  const attention = fleetPageIds(db, "tasks", new URLSearchParams({ attention: "true", limit: "2" }));
  expect(attention.ids).toEqual(["t00001", "t00002"]);
  expect(attention.total).toBe(12);
  const failures = fleetPageIds(db, "tasks", new URLSearchParams({ attention: "true", limit: "2", cursor: attention.next_cursor! }));
  expect(failures.ids.every((id) => getTask(db, id)!.state === "failed")).toBe(true);
  db.exec("UPDATE runs SET state = 'blocked' WHERE id IN ('r00001', 'r00002')");
  setRunBlockReason(db, "r00001", "gate");
  setRunBlockReason(db, "r00002", "step_failed");
  expect(fleetPageIds(db, "runs", new URLSearchParams({ state: "gate" })).ids).toEqual(["r00001"]);
  expect(fleetSummary(db, "all").held).toBe(1);
  expect(fleetPageIds(db, "runs", new URLSearchParams({ state: "gate", session: "b" })).total).toBe(0);
});

it.each([1000, 10000])("measures bounded HTTP projections against complete lists at %i tasks and runs", async (n) => {
  setup(n);
  server = await startServer(homePaths(home));
  const base = `http://127.0.0.1:${server.port}`;
  const read = async (route: string) => {
    const started = performance.now();
    const response = await fetch(`${base}${route}`);
    const body = await response.text();
    expect(response.status, body.slice(0, 200)).toBe(200);
    return { ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(body), data: JSON.parse(body) };
  };
  for (const kind of ["tasks", "runs"] as const) {
    const before = await read(`/${kind}?all=true`);
    const after = await read(`/fleet/${kind}`);
    const refresh = await read(`/fleet/${kind}`);
    expect(after.data.items).toHaveLength(50);
    expect(after.data.total).toBe(n);
    expect(refresh.data.items).toHaveLength(50);
    expect(refresh.bytes).toBeLessThan(before.bytes / 10);
    expect(after.bytes).toBeLessThan(before.bytes / 10);
    const plans = db.prepare(`EXPLAIN QUERY PLAN SELECT id, created_at FROM ${kind} WHERE orchestrator_session_id = ? AND state = ? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 51`).all("a", "failed", "2026-01-01T00:00:00.000Z", "z");
    expect(JSON.stringify(plans)).toContain(`${kind}_session_state_created`);
    expect(JSON.stringify(plans)).not.toContain("TEMP B-TREE");
    console.log(JSON.stringify({ n, kind, before: { ms: before.ms, bytes: before.bytes, projections: n }, after: { ms: after.ms, bytes: after.bytes, projections: 50 }, refresh: { ms: refresh.ms, bytes: refresh.bytes, projections: 50 }, plans }));
  }
  const summary = await read("/fleet/summary?session=a");
  expect(summary.data.task_total).toBe(n / 2);
  expect(summary.bytes).toBeLessThan(5000);
  console.log(JSON.stringify({ n, summary: { ms: summary.ms, bytes: summary.bytes } }));
});
