/**
 * #95 — daemon-local xAI reverse proxy: path routing, body rewrite, SSE/JSON
 * usage extraction, auth passthrough, attribution by task id.
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths, TASK_HEADER } from "@useparley/core";
import { insertTask, openDatabase, type DatabaseHandle, type NewTask } from "../src/db.js";
import { TaskEngine } from "../src/engine.js";
import {
  extractUsageFromJsonBody,
  extractUsageFromSse,
  handleXaiProxyRequest,
  normalizeXaiUsage,
  parseXaiProxyPath,
  rewriteRequestBodyForUsage,
} from "../src/xai-proxy.js";
import type { VendorAdapter } from "../src/adapters/types.js";

const homes: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function listen(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ port: addr.port, server });
    });
  });
}

function baseTask(id: string): NewTask {
  return {
    id,
    name: id,
    vendor: "grok",
    model: null,
    effort: null,
    profile: null,
    repo: null,
    cwd: "/tmp",
    prompt: "do it",
    orchestrator_session_id: "orch",
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
  };
}

function makeEngine(taskIds: string[]): { engine: TaskEngine; db: DatabaseHandle; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-xai-proxy-"));
  homes.push(home);
  const paths = homePaths(home);
  const db = openDatabase(paths);
  for (const id of taskIds) insertTask(db, baseTask(id));
  // Minimal adapter map — proxy never spawns children.
  const adapters = new Map<string, VendorAdapter>();
  const engine = new TaskEngine(db, paths, adapters);
  return { engine, db, home };
}

describe("parseXaiProxyPath", () => {
  it("extracts task id and /v1 rest path", () => {
    expect(parseXaiProxyPath("/xai/t1/v1/responses")).toEqual({
      taskId: "t1",
      rest: "/v1/responses",
    });
    expect(parseXaiProxyPath("/xai/t-abc/v1/chat/completions")).toEqual({
      taskId: "t-abc",
      rest: "/v1/chat/completions",
    });
    expect(parseXaiProxyPath("/xai/t1/v1")).toEqual({ taskId: "t1", rest: "/v1" });
  });

  it("rejects missing task, missing /v1, or non-xai paths", () => {
    expect(parseXaiProxyPath("/xai")).toBeNull();
    expect(parseXaiProxyPath("/xai/t1")).toBeNull();
    expect(parseXaiProxyPath("/xai/t1/other")).toBeNull();
    expect(parseXaiProxyPath("/mcp")).toBeNull();
    expect(parseXaiProxyPath("/")).toBeNull();
  });
});

describe("rewriteRequestBodyForUsage", () => {
  it("forces stream_options.include_usage when stream is true", () => {
    const body = Buffer.from(JSON.stringify({ model: "grok", stream: true, messages: [] }));
    const out = JSON.parse(
      rewriteRequestBodyForUsage(body, "application/json").toString("utf8"),
    ) as Record<string, unknown>;
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("preserves other stream_options fields while setting include_usage", () => {
    const body = Buffer.from(
      JSON.stringify({ stream: true, stream_options: { include_usage: false, foo: 1 } }),
    );
    const out = JSON.parse(
      rewriteRequestBodyForUsage(body, "application/json").toString("utf8"),
    ) as { stream_options: Record<string, unknown> };
    expect(out.stream_options).toEqual({ include_usage: true, foo: 1 });
  });

  it("leaves non-stream JSON and non-JSON bodies untouched", () => {
    const nonStream = Buffer.from(JSON.stringify({ stream: false, model: "x" }));
    expect(rewriteRequestBodyForUsage(nonStream, "application/json").equals(nonStream)).toBe(true);

    const noStream = Buffer.from(JSON.stringify({ model: "x" }));
    expect(rewriteRequestBodyForUsage(noStream, "application/json").equals(noStream)).toBe(true);

    const plain = Buffer.from("not-json");
    expect(rewriteRequestBodyForUsage(plain, "text/plain").equals(plain)).toBe(true);
  });
});

describe("usage extraction", () => {
  it("normalizes OpenAI-style and xAI-style usage fields to canonical keys", () => {
    expect(
      normalizeXaiUsage({
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 3 },
      }),
    ).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      input_tokens: 10,
      output_tokens: 4,
      cached_tokens: 3,
    });

    expect(
      normalizeXaiUsage({
        input_tokens: 5,
        output_tokens: 2,
        cache_read_input_tokens: 7,
      }),
    ).toMatchObject({
      input_tokens: 5,
      output_tokens: 2,
      cached_tokens: 7,
      cache_read_input_tokens: 7,
    });
  });

  it("extracts usage from a non-streaming JSON body", () => {
    const usage = extractUsageFromJsonBody(
      JSON.stringify({
        id: "c1",
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      }),
    );
    expect(usage).toMatchObject({ input_tokens: 11, output_tokens: 2, prompt_tokens: 11 });
  });

  it("extracts the last usage-bearing SSE data chunk", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      "",
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(extractUsageFromSse(sse)).toMatchObject({
      input_tokens: 9,
      output_tokens: 1,
      total_tokens: 10,
    });
  });
});

describe("handleXaiProxyRequest (stub upstream)", () => {
  it("strips the task prefix, forwards method/headers/body, and streams SSE usage", async () => {
    const seen: {
      method?: string;
      url?: string;
      auth?: string;
      body?: string;
    } = {};

    const upstream = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.auth = req.headers.authorization;
        seen.body = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        res.write(
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    const { engine, db } = makeEngine(["task-a"]);
    const proxy = await listen((req, res) => {
      void handleXaiProxyRequest(engine, req, res, {
        upstreamOrigin: `http://127.0.0.1:${upstream.port}`,
      });
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/xai/task-a/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ stream: true, model: "grok-4" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data: [DONE]");
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/v1/chat/completions");
    expect(seen.auth).toBe("Bearer sk-secret");
    const forwarded = JSON.parse(seen.body ?? "{}") as {
      stream: boolean;
      stream_options?: { include_usage?: boolean };
    };
    expect(forwarded.stream).toBe(true);
    expect(forwarded.stream_options?.include_usage).toBe(true);

    // Attribution lands on the task row.
    const row = engine.get("task-a");
    expect(row).toBeDefined();
    const usage = JSON.parse(row!.usage ?? "null") as Record<string, number>;
    expect(usage).toMatchObject({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });

    db.close();
  });

  it("strips Proxy-Authorization before the xAI upstream hop (#327)", async () => {
    // Hub proxy puts the runner credential on Proxy-Authorization; the daemon
    // gate reads it for lease binding, then xai-proxy must strip it so the
    // runner bearer never reaches api.x.ai.
    const seen: {
      authorization?: string | string[];
      proxyAuthorization?: string | string[];
      headerKeys: string[];
    } = { headerKeys: [] };

    const upstream = await listen((req, res) => {
      seen.authorization = req.headers.authorization;
      seen.proxyAuthorization = req.headers["proxy-authorization"];
      seen.headerKeys = Object.keys(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }));
    });

    const { engine, db } = makeEngine(["task-hop"]);
    const proxy = await listen((req, res) => {
      void handleXaiProxyRequest(engine, req, res, {
        upstreamOrigin: `http://127.0.0.1:${upstream.port}`,
      });
    });

    const runnerToken = "fake-runner-token-must-not-leak";
    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/xai/task-hop/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer sk-secret",
          "proxy-authorization": `Bearer ${runnerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "grok-4" }),
      },
    );
    expect(res.status).toBe(200);
    // Child xAI key preserved.
    expect(seen.authorization).toBe("Bearer sk-secret");
    // Runner credential must not survive the hop-by-hop strip.
    expect(seen.proxyAuthorization).toBeUndefined();
    expect(seen.headerKeys.map((k) => k.toLowerCase())).not.toContain("proxy-authorization");

    db.close();
  });

  it("strips TASK_HEADER before the xAI upstream hop (#331)", async () => {
    // Belt-and-braces: even if a client sends the parley correlation header,
    // it must never reach api.x.ai. Path segment remains the correlation source.
    const seen: {
      authorization?: string | string[];
      taskHeader?: string | string[];
      headerKeys: string[];
    } = { headerKeys: [] };

    const upstream = await listen((req, res) => {
      seen.authorization = req.headers.authorization;
      seen.taskHeader = req.headers[TASK_HEADER];
      seen.headerKeys = Object.keys(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }));
    });

    const { engine, db } = makeEngine(["task-corr"]);
    const proxy = await listen((req, res) => {
      void handleXaiProxyRequest(engine, req, res, {
        upstreamOrigin: `http://127.0.0.1:${upstream.port}`,
      });
    });

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/xai/task-corr/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer sk-secret",
          [TASK_HEADER]: "task-corr",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "grok-4" }),
      },
    );
    expect(res.status).toBe(200);
    // Child Authorization passthrough intact.
    expect(seen.authorization).toBe("Bearer sk-secret");
    // Correlation header must not reach the upstream origin.
    expect(seen.taskHeader).toBeUndefined();
    expect(seen.headerKeys.map((k) => k.toLowerCase())).not.toContain(TASK_HEADER.toLowerCase());

    db.close();
  });

  it("attributes non-streaming JSON usage to the task id in the path", async () => {
    const upstream = await listen((req, res) => {
      void (async () => {
        // drain body
        for await (const _ of req) {
          /* ignore */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "resp",
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
              prompt_tokens_details: { cached_tokens: 8 },
            },
          }),
        );
      })();
    });

    const { engine, db } = makeEngine(["t-json"]);
    const proxy = await listen((req, res) => {
      void handleXaiProxyRequest(engine, req, res, {
        upstreamOrigin: `http://127.0.0.1:${upstream.port}`,
      });
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/xai/t-json/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer k",
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(200);
    const usage = JSON.parse(engine.get("t-json")!.usage ?? "null") as Record<string, number>;
    expect(usage).toMatchObject({
      input_tokens: 20,
      output_tokens: 5,
      cached_tokens: 8,
      total_tokens: 25,
    });
    db.close();
  });

  it("returns 404 for an unknown task id", async () => {
    const { engine, db } = makeEngine(["known"]);
    const proxy = await listen((req, res) => {
      void handleXaiProxyRequest(engine, req, res, {
        upstreamOrigin: "http://127.0.0.1:1",
      });
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/xai/unknown/v1/models`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown task/);
    db.close();
  });

  it("returns 404 for a malformed proxy path", async () => {
    const { engine, db } = makeEngine(["t1"]);
    const proxy = await listen((req, res) => {
      void handleXaiProxyRequest(engine, req, res);
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/xai/t1/not-v1`);
    expect(res.status).toBe(404);
    db.close();
  });

  it("does not cross-attribute usage between concurrent tasks", async () => {
    const upstream = await listen((req, res) => {
      void (async () => {
        for await (const _ of req) {
          /* drain */
        }
        // Encode task identity is not available upstream — return fixed usage.
        // Correlation is purely path-based on the proxy side.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      })();
    });

    const { engine, db } = makeEngine(["ta", "tb"]);
    const proxy = await listen((req, res) => {
      void handleXaiProxyRequest(engine, req, res, {
        upstreamOrigin: `http://127.0.0.1:${upstream.port}`,
      });
    });

    await Promise.all([
      fetch(`http://127.0.0.1:${proxy.port}/xai/ta/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer a" },
        body: "{}",
      }),
      fetch(`http://127.0.0.1:${proxy.port}/xai/tb/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer b" },
        body: "{}",
      }),
    ]);

    expect(JSON.parse(engine.get("ta")!.usage ?? "null")).toMatchObject({ input_tokens: 1 });
    expect(JSON.parse(engine.get("tb")!.usage ?? "null")).toMatchObject({ input_tokens: 1 });
    db.close();
  });
});
