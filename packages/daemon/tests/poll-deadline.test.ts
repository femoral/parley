import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LONG_POLL_MS, LONG_POLL_TIMEOUT_MS, homePaths } from "@useparley/core";
import { startServer, type DaemonServer } from "../src/server.js";
import { insertTask, openDatabase, writeTaskState, type DatabaseHandle } from "../src/db.js";

let server: DaemonServer | undefined;
let db: DatabaseHandle | undefined;
let home: string | undefined;
afterEach(async () => {
  await server?.close();
  db?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("keeps the client timeout strictly beyond the server default", () => {
  expect(LONG_POLL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_LONG_POLL_MS);
});

it.each(["inbox", "events"])("bounds %s polls despite continuous foreign-session transitions", async (route) => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-deadline-"));
  vi.stubEnv("PARLEY_LONG_POLL_MS", "200");
  server = await startServer(homePaths(home));
  db = openDatabase(homePaths(home));
  for (let i = 0; i <= 100; i++) {
    insertTask(db, {
      id: `t${i}`, name: null, vendor: "fake", model: null, effort: null, profile: null,
      repo: null, cwd: home, prompt: "quiet", orchestrator_session_id: i === 0 ? "quiet" : "noisy",
      worktree: null, branch: null, base_sha: null, sandbox: "workspace", network: false,
      answer_timeout_ms: null, report_schema: null, size: null, difficulty: null, type: "other",
    });
  }
  writeTaskState(db, "t0", "running");
  const base = `http://127.0.0.1:${server.port}`;
  let next = 1;
  const requests: Promise<unknown>[] = [];
  const chatter = setInterval(() => {
    if (next <= 100) requests.push(fetch(`${base}/tasks/t${next++}/cancel`, { method: "POST" }).then((r) => r.text()));
  }, 10);
  const start = performance.now();
  try {
    const response = await fetch(`${base}/tasks/${route}?ids=t0&session=quiet&since=0&wait=true`);
    expect(response.status).toBe(200);
    expect((await response.json() as { event: unknown }).event).toBeNull();
    expect(performance.now() - start).toBeLessThan(750);
    expect(next).toBeGreaterThan(2);
  } finally {
    clearInterval(chatter);
    await Promise.all(requests);
  }
});
