import { afterEach, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { cleanupHome, makeHome, runCli } from "./helpers.js";

let server: http.Server | undefined;
let home: string | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (home) cleanupHome(home);
});

for (const follow of [false, true]) {
  it.each(["recover", "exhaust", "usage", "malformed"])(`watch follow=${follow} handles %s without corrupting stdout`, async (mode) => {
    home = makeHome();
    const polls: { time: number; url: string }[] = [];
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") { res.end(JSON.stringify({ pid: 1 })); return; }
      if (req.url?.startsWith("/tasks/scope?")) {
        res.end(JSON.stringify({ session: "test-orch-session", seq: 10, task_count: 1, run_count: 0, terminal_count: 0, excluded_unowned_tasks: 0, tasks: [{ task_id: "t1", name: null, state: "running", orchestrator_session_id: "test-orch-session" }] }));
        return;
      }
      polls.push({ time: performance.now(), url: req.url! });
      if (mode === "exhaust" || (mode === "recover" && polls.length < 3)) { req.socket.destroy(); return; }
      if (mode === "usage") { res.statusCode = 400; res.end(JSON.stringify({ error: "invalid watch scope" })); return; }
      if (mode === "malformed") { res.end("not json"); return; }
      res.end(JSON.stringify({ event: "task.completed", seq: 11, subject: "task", task: { task_id: "t1", name: null, state: "completed" }, run: null, all_done: false }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify({ daemon: { url: `http://127.0.0.1:${port}` } }));
    const result = await runCli(["watch", "--json", ...(follow ? ["--follow"] : ["--ack", "7"])], home);
    if (mode === "recover") {
      expect(result.code, result.stderr).toBe(follow ? 0 : 6);
      expect(JSON.parse(result.stdout).seq).toBe(11);
      expect(polls).toHaveLength(3);
      expect(result.stderr).toContain("retry 1/3 in 250ms");
      expect(result.stderr).toContain("retry 2/3 in 500ms");
    } else if (mode === "exhaust") {
      expect(result.code).toBe(1);
      expect(polls).toHaveLength(4);
      expect(result.stderr).toContain("Re-running watch is safe");
      expect(result.stderr).toContain("retry 3/3 in 1000ms");
      expect(result.stdout).toBe("");
    } else {
      expect(result.code).toBe(mode === "usage" ? 2 : 1);
      expect(polls).toHaveLength(1);
      expect(result.stderr).not.toContain("transport retry");
      expect(result.stdout).toBe("");
    }
    for (let i = 1; i < polls.length; i++) {
      expect(polls[i]!.time - polls[i - 1]!.time).toBeGreaterThanOrEqual(250 * 2 ** (i - 1) - 20);
      expect(polls[i]!.url).toBe(polls[0]!.url);
    }
  });
}
