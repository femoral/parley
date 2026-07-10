import http from "node:http";
import type { HomePaths } from "../home.js";
import { listTasks, openDatabase, type DatabaseHandle } from "./db.js";

export interface DaemonServer {
  /** The port the server is listening on. */
  port: number;
  /** Close the server and its database. */
  close: () => Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Build the daemon's HTTP request handler — the CLI plane (REST). v1 exposes
 * only the read surface needed by this ticket; the delegate/answer/cancel
 * endpoints and the MCP child channel slot in here in later tickets without
 * changing the daemon lifecycle.
 */
function createHandler(db: DatabaseHandle): http.RequestListener {
  return (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${method} ${url.pathname}`;

    switch (route) {
      case "GET /health":
        sendJson(res, 200, { status: "ok", pid: process.pid });
        return;
      case "GET /tasks":
        sendJson(res, 200, { tasks: listTasks(db) });
        return;
      default:
        sendJson(res, 404, { error: "not_found", route });
        return;
    }
  };
}

/**
 * Start the daemon HTTP server bound to `127.0.0.1:0` (ephemeral port) and open
 * the task-state database. Does not touch the discovery file — the daemon entry
 * point publishes discovery once the port is known.
 */
export function startServer(paths: HomePaths): Promise<DaemonServer> {
  const db = openDatabase(paths);
  const server = http.createServer(createHandler(db));

  return new Promise<DaemonServer>((resolve, reject) => {
    const failed = (err: Error): void => {
      db.close();
      reject(err);
    };
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", failed);
      const address = server.address();
      if (address === null || typeof address === "string") {
        failed(new Error("daemon server did not bind a TCP port"));
        return;
      }
      const port = address.port;
      const close = () =>
        new Promise<void>((resolveClose, rejectClose) => {
          server.close((err) => {
            db.close();
            if (err) rejectClose(err);
            else resolveClose();
          });
        });
      resolve({ port, close });
    });
  });
}
