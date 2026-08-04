/**
 * Client auth + opt-in bind beyond loopback (#323 / ADR-0030).
 *
 * Deterministic unit tests exercise `authorizeRequest` with a faked
 * remoteAddress (no sockets). Live-dial tests against a non-internal host IP
 * remain as extra coverage when the host has one.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { homePaths, type ParleyConfig } from "@useparley/core";
import {
  authorizeRequest,
  classifyAuthRoute,
  DEFAULT_DAEMON_BIND,
  isLoopbackAddress,
  matchClientToken,
  matchRunnerToken,
  redactConfigKeyValue,
  redactConfigSecrets,
  resolveDaemonBind,
  startServer,
  tokensEqual,
  type DaemonServer,
} from "../src/server.js";
import { withFakeAllowlist } from "./helpers.js";

const homes: string[] = [];
let server: DaemonServer | null = null;

const AUTH_CONFIG: ParleyConfig = {
  clients: {
    laptop: { token: "fake-client-token-laptop" },
    ci: { token: "fake-client-token-ci" },
  },
  runners: {
    gpu: { token: "fake-runner-token-gpu" },
    cpu: { token: "fake-runner-token-cpu" },
  },
};

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

  it("rejects non-loopback and empty (fails closed)", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe("tokensEqual (timing-safe)", () => {
  it("matches equal tokens and rejects unequal", () => {
    expect(tokensEqual("fake-a", "fake-a")).toBe(true);
    expect(tokensEqual("fake-a", "fake-b")).toBe(false);
    expect(tokensEqual("short", "much-longer-token")).toBe(false);
  });
});

describe("classifyAuthRoute", () => {
  it("classifies runner, child, client, and config-admin", () => {
    expect(classifyAuthRoute("POST", "/runner/lease")).toBe("runner");
    expect(classifyAuthRoute("GET", "/child/task")).toBe("child");
    expect(classifyAuthRoute("POST", "/mcp")).toBe("child");
    expect(classifyAuthRoute("GET", "/tasks")).toBe("client");
    expect(classifyAuthRoute("GET", "/config")).toBe("client");
    expect(classifyAuthRoute("PUT", "/config")).toBe("config-admin");
    expect(classifyAuthRoute("POST", "/config/set")).toBe("config-admin");
    expect(classifyAuthRoute("POST", "/config/unset")).toBe("config-admin");
    // #320: show is client-facing; remove mutates config → config-admin.
    expect(classifyAuthRoute("GET", "/runners")).toBe("client");
    expect(classifyAuthRoute("GET", "/runners/gpu")).toBe("client");
    expect(classifyAuthRoute("DELETE", "/runners/gpu")).toBe("config-admin");
    // #318: list is client; prune mutates disk → config-admin.
    expect(classifyAuthRoute("GET", "/clones")).toBe("client");
    expect(classifyAuthRoute("POST", "/clones/prune")).toBe("config-admin");
  });

  it("classifies /xai/* as child, not client (#327)", () => {
    expect(classifyAuthRoute("POST", "/xai/task-1/v1/chat/completions")).toBe(
      "child",
    );
    expect(classifyAuthRoute("POST", "/xai/t-abc/v1/responses")).toBe("child");
    expect(classifyAuthRoute("GET", "/xai/t1/v1/models")).toBe("child");
    // Malformed / bare prefixes still route to the child class so the gate
    // denies them rather than treating them as client-token traffic.
    expect(classifyAuthRoute("POST", "/xai")).toBe("child");
    expect(classifyAuthRoute("POST", "/xai/t1")).toBe("child");
  });
});

describe("authorizeRequest — deterministic gate (no sockets)", () => {
  const remote = "10.0.0.5";

  it("loopback bypasses the gate for every route class", () => {
    for (const [method, path] of [
      ["GET", "/tasks"],
      ["POST", "/runner/lease"],
      ["GET", "/child/task"],
      ["PUT", "/config"],
    ] as const) {
      const d = authorizeRequest({
        remoteAddress: "127.0.0.1",
        method,
        pathname: path,
        authorization: undefined,
        config: AUTH_CONFIG,
      });
      expect(d.ok, path).toBe(true);
      if (d.ok) expect(d.loopback).toBe(true);
    }
  });

  it("undefined remoteAddress fails closed (not loopback)", () => {
    const d = authorizeRequest({
      remoteAddress: undefined,
      method: "GET",
      pathname: "/health",
      authorization: undefined,
      config: AUTH_CONFIG,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(401);
      expect(d.routeClass).toBe("client");
      expect(d.peer).toBe("(unknown)");
    }
  });

  it("non-loopback client route: no token → 401", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "GET",
      pathname: "/tasks",
      authorization: undefined,
      config: AUTH_CONFIG,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(401);
      expect(d.routeClass).toBe("client");
    }
  });

  it("non-loopback client route: wrong token → 401", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "GET",
      pathname: "/health",
      authorization: "Bearer wrong",
      config: AUTH_CONFIG,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(401);
  });

  it("non-loopback client route: runner token rejected → 401", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "GET",
      pathname: "/tasks",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(401);
  });

  it("non-loopback client route: valid client token passes", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "GET",
      pathname: "/tasks",
      authorization: "Bearer fake-client-token-laptop",
      config: AUTH_CONFIG,
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.clientName).toBe("laptop");
      expect(d.runnerName).toBeNull();
      expect(d.loopback).toBe(false);
    }
  });

  it("non-loopback runner route: no token → 401", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/runner/lease",
      authorization: undefined,
      config: AUTH_CONFIG,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(401);
      expect(d.routeClass).toBe("runner");
    }
  });

  it("non-loopback runner route: client token rejected → 401", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/runner/register",
      authorization: "Bearer fake-client-token-laptop",
      config: AUTH_CONFIG,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(401);
  });

  it("non-loopback runner route: valid runner token passes", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/runner/lease",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.runnerName).toBe("gpu");
  });

  it("non-loopback child route: no token → 401", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "GET",
      pathname: "/child/task",
      authorization: undefined,
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "running",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(401);
      expect(d.routeClass).toBe("child");
    }
  });

  it("non-loopback child route: client token rejected → 401 (F2)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/child/report",
      authorization: "Bearer fake-client-token-laptop",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "running",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(401);
      expect(d.error).toMatch(/runner token/);
    }
  });

  it("non-loopback child route: runner without matching lease → 403 (F2)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/child/report",
      authorization: "Bearer fake-runner-token-cpu",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "running",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.error).toMatch(/does not hold the lease/);
    }
  });

  it("non-loopback child route: unleased task → 403 (F2)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/mcp",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: null,
      taskState: "running",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.error).toMatch(/not leased/);
    }
  });

  it("non-loopback child route: missing task → 403 (F2)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "GET",
      pathname: "/child/task",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
      taskFound: false,
      taskRunner: null,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.error).toMatch(/missing or unknown/);
    }
  });

  it("non-loopback child route: lease-holder runner token passes (F2)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/child/report",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "running",
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.runnerName).toBe("gpu");
  });

  it("non-loopback child route: affine runner + pending task → 403 (active lease)", () => {
    // task.runner is submit-time affinity, not a live lease. A pending task
    // must not grant child-channel access to the affine runner.
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/child/report",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "pending",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.error).toMatch(/not actively leased/);
      expect(d.error).toMatch(/pending/);
    }
  });

  it("non-loopback child route: affine runner + queued task → 403 (active lease)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/child/report",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "queued",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.error).toMatch(/not actively leased/);
      expect(d.error).toMatch(/queued/);
    }
  });

  it("non-loopback child route: affine runner + terminal (failed) task → 403 (active lease)", () => {
    // After terminal, the affine runner must not keep indefinite child-channel
    // access (e.g. GET /child/task envelope).
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "GET",
      pathname: "/child/task",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "failed",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.error).toMatch(/already failed/);
    }
  });

  it("non-loopback child route: affine runner + actively running task → pass (active lease)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/child/report",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "running",
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.runnerName).toBe("gpu");
  });

  it("non-loopback child route: affine runner + awaiting_answer → pass (active lease)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/mcp",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "awaiting_answer",
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.runnerName).toBe("gpu");
  });

  // #327: /xai/* is child-class with the same lease-binding semantics, but the
  // runner credential is read from Proxy-Authorization so Authorization can
  // carry the child's xAI API key through to api.x.ai.
  it("non-loopback /xai/*: lease-holding runner token via Proxy-Authorization is allowed (#327)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/xai/task-1/v1/chat/completions",
      authorization: "Bearer xai-child-api-key",
      proxyAuthorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "running",
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.routeClass).toBe("child");
      expect(d.runnerName).toBe("gpu");
    }
  });

  it("non-loopback /xai/*: runner token only in Authorization is denied (#327)", () => {
    // Authorization is the child's xAI key channel — a runner token there
    // must not authorize the gate (and would also leak if forwarded upstream).
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/xai/task-1/v1/chat/completions",
      authorization: "Bearer fake-runner-token-gpu",
      proxyAuthorization: undefined,
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "running",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(401);
      expect(d.routeClass).toBe("child");
    }
  });

  it("non-loopback /xai/*: different runner's Proxy-Authorization is denied (#327)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/xai/task-1/v1/responses",
      authorization: "Bearer xai-child-api-key",
      proxyAuthorization: "Bearer fake-runner-token-cpu",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "running",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.routeClass).toBe("child");
      expect(d.error).toMatch(/does not hold the lease/);
    }
  });

  it("non-loopback /xai/*: client token in Proxy-Authorization is denied (#327)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/xai/task-1/v1/chat/completions",
      authorization: "Bearer xai-child-api-key",
      proxyAuthorization: "Bearer fake-client-token-laptop",
      config: AUTH_CONFIG,
      taskFound: true,
      taskRunner: "gpu",
      taskState: "running",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(401);
      expect(d.routeClass).toBe("child");
      expect(d.error).toMatch(/runner token/);
    }
  });

  it("non-loopback /xai/*: unknown task id is denied (#327)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "POST",
      pathname: "/xai/unknown-task/v1/models",
      authorization: "Bearer xai-child-api-key",
      proxyAuthorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
      taskFound: false,
      taskRunner: null,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.routeClass).toBe("child");
      expect(d.error).toMatch(/missing or unknown/);
    }
  });

  it("non-loopback /xai/*: non-executing task states are denied (#327)", () => {
    for (const state of ["pending", "queued", "failed", "completed"] as const) {
      const d = authorizeRequest({
        remoteAddress: remote,
        method: "POST",
        pathname: "/xai/task-1/v1/responses",
        authorization: "Bearer xai-child-api-key",
        proxyAuthorization: "Bearer fake-runner-token-gpu",
        config: AUTH_CONFIG,
        taskFound: true,
        taskRunner: "gpu",
        taskState: state,
      });
      expect(d.ok, state).toBe(false);
      if (!d.ok) {
        expect(d.status).toBe(403);
        expect(d.routeClass).toBe("child");
      }
    }
  });

  it("non-loopback config-admin always 403 even with valid client token (F1)", () => {
    for (const [method, path] of [
      ["PUT", "/config"],
      ["POST", "/config/set"],
      ["POST", "/config/unset"],
    ] as const) {
      const d = authorizeRequest({
        remoteAddress: remote,
        method,
        pathname: path,
        authorization: "Bearer fake-client-token-laptop",
        config: AUTH_CONFIG,
      });
      expect(d.ok, path).toBe(false);
      if (!d.ok) {
        expect(d.status).toBe(403);
        expect(d.routeClass).toBe("config-admin");
        expect(d.error).toMatch(/loopback/);
      }
    }
  });

  it("non-loopback config-admin 403 even with runner token (F1)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "PUT",
      pathname: "/config",
      authorization: "Bearer fake-runner-token-gpu",
      config: AUTH_CONFIG,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(403);
  });

  it("non-loopback DELETE /runners/:name is config-admin 403 (#320)", () => {
    const d = authorizeRequest({
      remoteAddress: remote,
      method: "DELETE",
      pathname: "/runners/gpu",
      authorization: "Bearer fake-client-token-laptop",
      config: AUTH_CONFIG,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.routeClass).toBe("config-admin");
    }
  });

  it("non-loopback GET /runners/:name requires client token (#320)", () => {
    const noTok = authorizeRequest({
      remoteAddress: remote,
      method: "GET",
      pathname: "/runners/gpu",
      authorization: undefined,
      config: AUTH_CONFIG,
    });
    expect(noTok.ok).toBe(false);
    if (!noTok.ok) {
      expect(noTok.status).toBe(401);
      expect(noTok.routeClass).toBe("client");
    }

    const withClient = authorizeRequest({
      remoteAddress: remote,
      method: "GET",
      pathname: "/runners/gpu",
      authorization: "Bearer fake-client-token-laptop",
      config: AUTH_CONFIG,
    });
    expect(withClient.ok).toBe(true);
    if (withClient.ok) expect(withClient.routeClass).toBe("client");
  });
});

describe("redactConfigSecrets (F1 GET /config)", () => {
  it("redacts clients and runners tokens", () => {
    const redacted = redactConfigSecrets(AUTH_CONFIG);
    expect(redacted.clients?.laptop?.token).toBe("<redacted>");
    expect(redacted.clients?.ci?.token).toBe("<redacted>");
    expect(redacted.runners?.gpu?.token).toBe("<redacted>");
    // Original unchanged.
    expect(AUTH_CONFIG.clients?.laptop?.token).toBe("fake-client-token-laptop");
  });

  it("redacts single-key lookups", () => {
    expect(redactConfigKeyValue("clients.laptop.token", "secret")).toBe("<redacted>");
    expect(redactConfigKeyValue("runners.gpu.token", "secret")).toBe("<redacted>");
    expect(redactConfigKeyValue("clients.laptop", { token: "secret" })).toEqual({
      token: "<redacted>",
    });
    expect(redactConfigKeyValue("daemon.bind", "0.0.0.0")).toBe("0.0.0.0");
  });
});

describe("matchClientToken / matchRunnerToken", () => {
  it("matches and isolates namespaces", () => {
    expect(matchClientToken("fake-client-token-laptop", AUTH_CONFIG)).toBe("laptop");
    expect(matchClientToken("fake-runner-token-gpu", AUTH_CONFIG)).toBeNull();
    expect(matchRunnerToken("fake-runner-token-gpu", AUTH_CONFIG)).toBe("gpu");
    expect(matchRunnerToken("fake-client-token-laptop", AUTH_CONFIG)).toBeNull();
    expect(matchRunnerToken("fake-runner-token-gpu", AUTH_CONFIG, "cpu")).toBeNull();
    expect(matchRunnerToken("fake-runner-token-gpu", AUTH_CONFIG, "gpu")).toBe("gpu");
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

  it("allows config admin from loopback", async () => {
    const home = makeHome();
    const { loopbackBase } = await boot(home);
    const get = await json(loopbackBase, "GET", "/config");
    expect(get.status).toBe(200);
    const body = get.body as { config: ParleyConfig };
    // Loopback GET is unredacted.
    expect(body.config.clients?.laptop?.token).toBe("fake-client-token-laptop");
  });
});

describe("non-loopback live dial (extra coverage)", () => {
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

    it("GET /config redacts tokens off-loopback (F1)", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const res = await json(base, "GET", "/config", undefined, {
        authorization: "Bearer fake-client-token-laptop",
      });
      expect(res.status).toBe(200);
      const body = res.body as { config: ParleyConfig };
      expect(body.config.clients?.laptop?.token).toBe("<redacted>");
      expect(body.config.runners?.gpu?.token).toBe("<redacted>");
    });

    it("PUT /config is 403 off-loopback even with client token (F1)", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const res = await json(
        base,
        "PUT",
        "/config",
        { clients: { evil: { token: "x" } } },
        { authorization: "Bearer fake-client-token-laptop" },
      );
      expect(res.status).toBe(403);
    });

    it("POST /config/set is 403 off-loopback (F1)", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const res = await json(
        base,
        "POST",
        "/config/set",
        { key: "clients.evil.token", value: "x" },
        { authorization: "Bearer fake-client-token-laptop" },
      );
      expect(res.status).toBe(403);
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

    it("rejects client token on child routes off-loopback (F2)", async () => {
      const home = makeHome();
      const { port } = await boot(home, { bind: "0.0.0.0" });
      const base = remoteBase(port);
      const res = await json(base, "GET", "/child/task", undefined, {
        authorization: "Bearer fake-client-token-laptop",
        "x-parley-task": "t-nonexistent",
      });
      expect(res.status).toBe(401);
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
