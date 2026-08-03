import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { TASK_HEADER } from "@useparley/core";
import { startHubProxy, type HubProxy } from "../src/hub-proxy.js";

const proxies: HubProxy[] = [];
const upstreams: http.Server[] = [];

afterEach(async () => {
  while (proxies.length > 0) {
    const p = proxies.pop()!;
    await p.close().catch(() => {});
  }
  while (upstreams.length > 0) {
    const s = upstreams.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  vi.unstubAllGlobals();
});

function listenUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    upstreams.push(server);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("upstream did not bind"));
        return;
      }
      resolve({ url: `http://127.0.0.1:${address.port}`, port: address.port });
    });
  });
}

describe("hub proxy allowlist", () => {
  it("forwards /mcp and /child/* with TASK_HEADER and runner bearer (#323)", async () => {
    const seen: {
      path: string;
      header: string | string[] | undefined;
      authorization: string | string[] | undefined;
    }[] = [];
    const upstream = await listenUpstream((req, res) => {
      seen.push({
        path: req.url ?? "",
        header: req.headers[TASK_HEADER],
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });

    const proxy = await startHubProxy({
      daemonUrl: upstream.url,
      token: "fake-runner-token-proxy",
      taskId: "task-42",
    });
    proxies.push(proxy);

    const mcp = await fetch(`${proxy.url}/mcp`, { method: "POST", body: "{}" });
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toMatchObject({ ok: true, path: "/mcp" });

    const child = await fetch(`${proxy.url}/child/report`, {
      method: "POST",
      body: JSON.stringify({ summary: "x" }),
    });
    expect(child.status).toBe(200);

    expect(seen).toEqual([
      {
        path: "/mcp",
        header: "task-42",
        authorization: "Bearer fake-runner-token-proxy",
      },
      {
        path: "/child/report",
        header: "task-42",
        authorization: "Bearer fake-runner-token-proxy",
      },
    ]);
  });

  it("returns 404 for non-allowlisted paths", async () => {
    const upstreamHits: string[] = [];
    const upstream = await listenUpstream((req, res) => {
      upstreamHits.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });

    const proxy = await startHubProxy({
      daemonUrl: upstream.url,
      token: "t",
      taskId: "t1",
    });
    proxies.push(proxy);

    const blocked = await fetch(`${proxy.url}/runner/lease`, { method: "POST" });
    expect(blocked.status).toBe(404);
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toMatch(/only forwards \/child\/\* and \/mcp/);
    expect(upstreamHits).toEqual([]);

    const tasks = await fetch(`${proxy.url}/tasks`);
    expect(tasks.status).toBe(404);
    expect(upstreamHits).toEqual([]);
  });

  it("injects TASK_HEADER constant equal to x-parley-task", () => {
    expect(TASK_HEADER).toBe("x-parley-task");
  });
});
