/**
 * Client auth + opt-in bind beyond loopback (#323 / ADR-0030).
 *
 * Peer-address enforcement: loopback stays tokenless; non-loopback peers need
 * a valid bearer. Tests bind `0.0.0.0` and dial a non-internal host address
 * so `socket.remoteAddress` is not loopback.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import {
  DEFAULT_DAEMON_BIND,
  isLoopbackAddress,
  resolveDaemonBind,
  startServer,
  type DaemonServer,
} from "../src/server.js";
import { withFakeAllowlist } from "./helpers.js";

const homes: string[] = [];
let server: DaemonServer | null = null;

function makeHome(config: Record<string, unknown> = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-client-auth-"));
  homes.push(home);
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(
      withFakeAllowlist({
        clients: {
          laptop: { token: "fake-client-token-laptop" },
          ci: { token: "fake-client-token-ci" },
        },
        runners: { gpu: { token: "fake-runner-token-gpu" } },
        ...config,
      }),
    ),
  );
  return home;
}

async function boot(
  home: string,
  opts: { bind?: string } = {},
): Promise<{ port: number; bind: string; loopbackBase: string }> {
  server = await startServer(homePaths(home), {
    bind: opts.bind,
  });
  return {
    port: server.port,
    bind: server.bind,
    loopbackBase: `http://127.0.0.1:${server.port}`,
  };
}

/** First non-internal IPv4, or null when the host has none (rare CI). */
function nonLoopbackIPv4(): string | null {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const e of entries) {
      if (e.family === "IPv4" && !e.internal) return e.address;
    }
  }
  return null;
}

async function json(
  base: string,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return { status: 204, body: null };
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, body: parsed };
}

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("isLoopbackAddress", () => {
  it("recognizes IPv4 and IPv6 loopback forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.2")).toBe(true);
  });

  it("rejects non-loopback and empty", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe("resolveDaemonBind / default bind", () => {
  it("defaults to 127.0.0.1", () => {
    expect(DEFAULT_DAEMON_BIND).toBe("127.0.0.1");
    expect(resolveDaemonBind({})).toBe("127.0.0.1");
    expect(resolveDaemonBind({ daemon: {} })).toBe("127.0.0.1");
  });

  it("honors daemon.bind", () => {
    expect(resolveDaemonBind({ daemon: { bind: "0.0.0.0" } })).toBe("0.0.0.0");
  });

  it("startServer defaults bind to loopback", async () => {
    const home = makeHome();
    const { bind, loopbackBase } = await boot(home);
    expect(bind).toBe("127.0.0.1");
    const health = await json(loopbackBase, "GET", "/health");
    expect(health.status).toBe(200);
  });

  it("startServer reads daemon.bind from config", async () => {
    const home = makeHome({ daemon: { bind: "0.0.0.0" } });
    const { bind } = await boot(home);
    expect(bind).toBe("0.0.0.0");
  });
});

describe("loopback remains tokenless", () => {
  it("serves client routes without Authorization on 127.0.0.1", async () => {
    const home = makeHome({ daemon: { bind: "0.0.0.0" } });
    const { loopbackBase } = await boot(home, { bind: "0.0.0.0" });
    const health = await json(loopbackBase, "GET", "/health");
    expect(health.status).toBe(200);
    const tasks = await json(loopbackBase, "GET", "/tasks");
    expect(tasks.status).toBe(200);
    const runners = await json(loopbackBase, "GET", "/runners");
    expect(runners.status).toBe(200);
  });

  it("still requires runner token on /runner/* even on loopback", async () => {
    const home = makeHome();
    const { loopbackBase } = await boot(home);
    const lease = await json(loopbackBase, "POST", "/runner/lease", { runner: "gpu" });
    expect(lease.status).toBe(401);
  });
});

describe("non-loopback client auth", () => {
  const hostIp = nonLoopbackIPv4();
  const describeIf = hostIp !== null ? describe : describe.skip;

  describeIf("via host non-loopback address", () => {
    function remoteBase(port: number): string {
      return `http://${hostIp}:${port}`;
    }

    it("accepts a valid client token end-to-end", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const auth = { authorization: "Bearer fake-client-token-laptop" };

      const health = await json(base, "GET", "/health", undefined, auth);
      expect(health.status).toBe(200);

      const tasks = await json(base, "GET", "/tasks", undefined, auth);
      expect(tasks.status).toBe(200);

      const runners = await json(base, "GET", "/runners", undefined, auth);
      expect(runners.status).toBe(200);
    });

    it("returns 401 without token on client routes", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);

      for (const route of ["/health", "/tasks", "/runners", "/config"]) {
        const res = await json(base, "GET", route);
        expect(res.status, route).toBe(401);
      }
    });

    it("returns 401 with wrong client token", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const res = await json(base, "GET", "/health", undefined, {
        authorization: "Bearer wrong-token",
      });
      expect(res.status).toBe(401);
    });

    it("rejects a runner token on client routes", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const res = await json(base, "GET", "/tasks", undefined, {
        authorization: "Bearer fake-runner-token-gpu",
      });
      expect(res.status).toBe(401);
    });

    it("revokes one client without affecting another", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);

      // Both work.
      expect(
        (
          await json(base, "GET", "/health", undefined, {
            authorization: "Bearer fake-client-token-laptop",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await json(base, "GET", "/health", undefined, {
            authorization: "Bearer fake-client-token-ci",
          })
        ).status,
      ).toBe(200);

      // Hot-revoke laptop by rewriting settings (no restart — tokens re-read).
      const configPath = path.join(home, "parley.json");
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        clients: Record<string, { token: string }>;
      };
      delete cfg.clients.laptop;
      fs.writeFileSync(configPath, JSON.stringify(cfg));

      expect(
        (
          await json(base, "GET", "/health", undefined, {
            authorization: "Bearer fake-client-token-laptop",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await json(base, "GET", "/health", undefined, {
            authorization: "Bearer fake-client-token-ci",
          })
        ).status,
      ).toBe(200);
    });
  });
});

describe("non-loopback runner and child auth", () => {
  const hostIp = nonLoopbackIPv4();
  const describeIf = hostIp !== null ? describe : describe.skip;

  describeIf("via host non-loopback address", () => {
    function remoteBase(port: number): string {
      return `http://${hostIp}:${port}`;
    }

    it("returns 401 on runner routes without token", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const res = await json(base, "POST", "/runner/register", {
        runner: "gpu",
        protocol_version: 1,
        build_version: "test",
        capabilities: { vendors: [] },
      });
      expect(res.status).toBe(401);
    });

    it("accepts runner token on runner routes off-loopback", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const res = await json(
        base,
        "POST",
        "/runner/register",
        {
          runner: "gpu",
          protocol_version: 1,
          build_version: "0.0.4-test",
          capabilities: {
            vendors: [{ id: "fake", models: [] }],
          },
        },
        { authorization: "Bearer fake-runner-token-gpu" },
      );
      // 200 on success; protocol may also 400 on version — not 401.
      expect(res.status).not.toBe(401);
      expect([200, 400]).toContain(res.status);
    });

    it("returns 401 on child routes without token", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const res = await json(base, "GET", "/child/task");
      expect(res.status).toBe(401);
    });

    it("accepts runner token on child routes off-loopback", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      // Missing task header → 400-class from child handler, not 401.
      const res = await json(base, "GET", "/child/task", undefined, {
        authorization: "Bearer fake-runner-token-gpu",
      });
      expect(res.status).not.toBe(401);
    });

    it("accepts client token on child routes off-loopback", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const res = await json(base, "GET", "/child/task", undefined, {
        authorization: "Bearer fake-client-token-laptop",
      });
      expect(res.status).not.toBe(401);
    });
  });
});

describe("daemon.bind config drives listen (integration)", () => {
  it("refuses connections on non-loopback when bound to 127.0.0.1", async () => {
    const hostIp = nonLoopbackIPv4();
    if (hostIp === null) return; // nothing to prove without a non-loopback IP

    const home = makeHome();
    const { port } = await boot(home); // default 127.0.0.1
    expect(server!.bind).toBe("127.0.0.1");

    // Connecting to the host IP should fail (nothing listening there).
    await expect(
      new Promise<void>((resolve, reject) => {
        const req = http.get(`http://${hostIp}:${port}/health`, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", reject);
        req.setTimeout(2000, () => {
          req.destroy(new Error("timeout"));
        });
      }),
    ).rejects.toThrow();
  });
});
