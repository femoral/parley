import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { homePaths } from "@useparley/core";
import { startServer, type DaemonServer } from "../src/server.js";

let server: DaemonServer | undefined;
let home: string | undefined;
afterEach(async () => {
  await server?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

it.each([false, true])("returns 413 before an oversized body finishes (chunked=%s)", async (chunked) => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-body-limit-"));
  server = await startServer(homePaths(home));
  const limit = 128 * 1024 * 1024;
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: server!.port, path: "/tasks", method: "POST",
      headers: chunked ? { "transfer-encoding": "chunked" } : { "content-length": limit + 1 },
    }, (res) => {
      res.resume();
      resolve(res.statusCode!);
      req.destroy();
    });
    req.on("error", reject);
    req.flushHeaders();
    if (chunked) {
      const chunk = Buffer.alloc(1024 * 1024, 32);
      let sent = 0;
      const write = (): void => {
        while (sent <= limit && !req.destroyed) {
          sent += chunk.length;
          if (!req.write(chunk)) { req.once("drain", write); return; }
        }
        // Intentionally never end: the daemon must reject before upload EOF.
      };
      write();
    }
  });
  expect(status).toBe(413);
  expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
});
