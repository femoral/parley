/**
 * Real-daemon test harness for console data-layer integration tests.
 * Boots via startServer(homePaths(home)) — same pattern as
 * packages/daemon/tests/max-concurrent-wire.test.ts and report-file-churn.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { homePaths, type EventSourceLike } from "@useparley/core";
// Relative imports: dashboard must not declare a package.json dep on daemon
// (lane constraint). Integration project externalizes node:sqlite.
import { startServer, type DaemonServer } from "../../../daemon/src/server.js";
import { withFakeAllowlist, makeGitRepo } from "../../../daemon/tests/helpers.js";

// Resolve from repo root (vitest cwd).
export const FAKE_VENDOR_BIN = path.resolve(
  process.cwd(),
  "packages/cli/tests/fake-vendor.mjs",
);

export interface DaemonFixture {
  home: string;
  repo: string;
  server: DaemonServer;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 40,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

/**
 * Bootstrap a temp PARLEY_HOME + git repo with fake-vendor actions, start
 * the real daemon server, return base URL + cleanup.
 */
export async function bootDaemon(options: {
  actions?: unknown[];
  config?: Record<string, unknown>;
  seedFiles?: Record<string, string>;
} = {}): Promise<DaemonFixture> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-console-dl-"));
  const actions =
    options.actions ??
    [
      {
        submit_report: {
          summary: "console data layer fixture",
          outcome: "success",
          files_changed: ["src/seed.ts"],
        },
      },
    ];
  const repo = makeGitRepo({
    "src/seed.ts": "seed\n",
    ".fake-vendor.json": JSON.stringify(actions),
    ...(options.seedFiles ?? {}),
  });
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(withFakeAllowlist(options.config ?? {})),
  );
  process.env.PARLEY_HOME = home;
  process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;

  const server = await startServer(homePaths(home));
  const baseUrl = `http://127.0.0.1:${server.port}`;

  return {
    home,
    repo,
    server,
    baseUrl,
    close: async () => {
      try {
        await server.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      delete process.env.PARLEY_FAKE_VENDOR_BIN;
      delete process.env.PARLEY_HOME;
    },
  };
}

/** Create a task via POST /tasks; returns task_id. */
export async function createTask(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    throw new Error(`create task failed: ${res.status} ${await res.text()}`);
  }
  const ack = (await res.json()) as { task_id: string };
  return ack.task_id;
}

export async function waitForTaskState(
  baseUrl: string,
  taskId: string,
  states: string[],
  timeoutMs = 15_000,
): Promise<void> {
  await waitFor(async () => {
    const st = await fetch(`${baseUrl}/tasks/${taskId}`);
    if (st.status !== 200) return false;
    const body = (await st.json()) as { task: { state: string } };
    return states.includes(body.task.state);
  }, timeoutMs);
}

/**
 * Fetch-backed EventSource for Node / happy-dom (browser global may be absent
 * or CORS-hostile). Mirrors packages/cli/tests/events.test.ts.
 */
export class FetchEventSource implements EventSourceLike {
  private readonly listeners = new Map<
    string,
    ((e: { data: string; lastEventId: string }) => void)[]
  >();
  private readonly controller = new AbortController();
  /** Live instances for tests that need to force an error/close. */
  static instances: FetchEventSource[] = [];

  constructor(url: string) {
    FetchEventSource.instances.push(this);
    void this.run(url);
  }

  addEventListener(
    type: string,
    listener: ((e: { data: string; lastEventId: string }) => void) | ((event: unknown) => void),
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (e: { data: string; lastEventId: string }) => void);
    this.listeners.set(type, list);
  }

  close(): void {
    this.controller.abort();
    FetchEventSource.instances = FetchEventSource.instances.filter((i) => i !== this);
  }

  /** Fire the stream error listener (simulates SSE drop). */
  emitError(event: unknown = {}): void {
    for (const cb of this.listeners.get("error") ?? []) {
      (cb as (e: unknown) => void)(event);
    }
  }

  private async run(url: string): Promise<void> {
    try {
      const res = await fetch(url, { signal: this.controller.signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = parseSseFrame(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
          if (frame?.event) {
            for (const cb of this.listeners.get(frame.event) ?? []) {
              cb({ data: frame.data, lastEventId: frame.id ?? "" });
            }
          }
        }
      }
    } catch {
      for (const cb of this.listeners.get("error") ?? []) {
        (cb as (e: unknown) => void)({});
      }
    }
  }
}

function parseSseFrame(
  raw: string,
): { id?: string; event?: string; data: string } | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("event:")) event = line.slice(6).trimStart();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join("\n") };
}

/** Install FetchEventSource as the global EventSource for hook tests. */
export function installFetchEventSource(): () => void {
  const prev = (globalThis as { EventSource?: unknown }).EventSource;
  (globalThis as { EventSource?: unknown }).EventSource = FetchEventSource;
  FetchEventSource.instances = [];
  return () => {
    (globalThis as { EventSource?: unknown }).EventSource = prev;
    for (const i of FetchEventSource.instances.splice(0)) {
      try {
        i.close();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * Stable-URL reverse proxy so a client can survive daemon restart on a new
 * ephemeral port (honesty kill/restart with the same ParleyClient baseUrl).
 */
export interface ForwardProxy {
  url: string;
  setTarget: (baseUrl: string) => void;
  close: () => Promise<void>;
}

export async function createForwardProxy(initialTarget: string): Promise<ForwardProxy> {
  let target = new URL(initialTarget);

  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: `${target.hostname}:${target.port}` };
    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("upstream down");
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    setTarget(baseUrl: string) {
      target = new URL(baseUrl);
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
