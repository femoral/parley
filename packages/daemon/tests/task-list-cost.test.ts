import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { startServer, type DaemonServer } from "../src/server.js";
import { insertTask, openDatabase, writeTaskState, type DatabaseHandle } from "../src/db.js";

let server: DaemonServer | undefined;
let db: DatabaseHandle | undefined;
let home: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  db?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

it("bounds default listing and resolves config per repo, while scope omits heavy envelopes", async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-list-cost-"));
  server = await startServer(homePaths(home));
  db = openDatabase(homePaths(home));
  const project = path.join(home, "project");
  fs.mkdirSync(path.join(project, ".parley"), { recursive: true });
  const config = path.join(project, ".parley/config.json");
  fs.writeFileSync(config, JSON.stringify({ eval: { expected: true } }));
  db.exec("BEGIN");
  for (let i = 0; i < 1000; i++) {
    const id = `t${i}`;
    insertTask(db, {
      id, name: null, vendor: "fake", model: null, effort: null, profile: null,
      repo: project, cwd: project, prompt: "large brief ".repeat(1000), orchestrator_session_id: i === 0 ? "quiet" : "history",
      worktree: null, branch: null, base_sha: null, sandbox: "workspace", network: false,
      answer_timeout_ms: null, report_schema: null, size: null, difficulty: null, type: "other",
    });
    writeTaskState(db, id, "completed", { report: JSON.stringify({ summary: "large report ".repeat(1000), outcome: "success", files_changed: [] }) });
  }
  db.exec("COMMIT");
  const base = `http://127.0.0.1:${server.port}`;
  const read = vi.spyOn(fs, "readFileSync");
  const listing = await (await fetch(`${base}/tasks`)).json() as { tasks: { eval_expected: boolean }[]; has_more: boolean };
  expect(listing.tasks).toHaveLength(100);
  expect(listing.has_more).toBe(true);
  expect(listing.tasks.every((t) => t.eval_expected)).toBe(true);
  expect(read.mock.calls.filter(([file]) => String(file) === config)).toHaveLength(1);
  fs.writeFileSync(config, JSON.stringify({ eval: { expected: false } }));
  const refreshed = await (await fetch(`${base}/tasks?limit=1`)).json() as typeof listing;
  expect(refreshed.tasks[0]!.eval_expected).toBe(false);
  read.mockClear();
  const scope = await (await fetch(`${base}/tasks/scope?session=quiet`)).json() as { tasks: unknown[]; task_count: number; terminal_count: number };
  expect(scope.tasks).toEqual([{ task_id: "t0", name: null, state: "completed", orchestrator_session_id: "quiet" }]);
  expect(scope.task_count).toBe(1);
  expect(scope.terminal_count).toBe(1);
  expect(read.mock.calls.filter(([file]) => String(file) === config)).toHaveLength(0);
  expect((await fetch(`${base}/tasks?limit=101`)).status).toBe(400);
  const all = await (await fetch(`${base}/tasks?all=true`)).json() as typeof listing;
  expect(all.tasks).toHaveLength(1000);
  expect(all.has_more).toBe(false);
});
