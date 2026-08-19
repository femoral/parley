/**
 * Non-local daemon.url path for ensureDaemon (ADR-0010).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  daemonGet,
  discoveryBaseUrl,
  ensureDaemon,
  ensureRemoteDaemon,
  type DaemonLauncher,
  type Discovery,
} from "../src/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function launcherNever(): DaemonLauncher {
  return {
    liveDiscovery: () => {
      throw new Error("should not discover locally");
    },
    readDiscovery: () => null,
    clearDiscovery: () => {},
    isProcessAlive: () => false,
    spawnDaemon: () => {
      throw new Error("should not spawn");
    },
    withLock: async (fn) => fn(),
  };
}

describe("discoveryBaseUrl", () => {
  it("uses url when set", () => {
    expect(discoveryBaseUrl({ port: 1, pid: 2, started_at: "", url: "http://h:9/" })).toBe(
      "http://h:9",
    );
  });

  it("uses loopback port otherwise", () => {
    expect(discoveryBaseUrl({ port: 57123, pid: 1, started_at: "" })).toBe(
      "http://127.0.0.1:57123",
    );
  });
});

describe("ensureRemoteDaemon", () => {
  it("returns a Discovery with url after a healthy probe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ status: "ok", pid: 42, started_at: "2020-01-01T00:00:00.000Z" }), {
          status: 200,
        }),
      ),
    );
    const d = await ensureRemoteDaemon("http://remote:9999/");
    expect(d.url).toBe("http://remote:9999");
    expect(d.pid).toBe(42);
    expect(d.started_at).toBe("2020-01-01T00:00:00.000Z");
  });

  it("attaches bearer token on the health probe and Discovery (#323)", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer fake-client-token-ccc");
      return new Response(JSON.stringify({ status: "ok", pid: 1, started_at: "t" }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const d = await ensureRemoteDaemon("http://remote:9999", {
      token: "fake-client-token-ccc",
      client: "laptop",
    });
    expect(d.token).toBe("fake-client-token-ccc");
    expect(d.client).toBe("laptop");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("names the URL when unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(ensureRemoteDaemon("http://gone:1")).rejects.toThrow(
      /parley daemon at http:\/\/gone:1 is unreachable/,
    );
  });

  it("names the URL when /health is non-OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(ensureRemoteDaemon("http://sick:1")).rejects.toThrow(
      /http:\/\/sick:1.*503/,
    );
  });
});

describe("ensureDaemon with options.url", () => {
  it("skips discovery and spawn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ status: "ok", pid: 7, started_at: "t" }), {
          status: 200,
        }),
      ),
    );
    const d: Discovery = await ensureDaemon(launcherNever(), {
      url: "http://configured:8",
    });
    expect(d.url).toBe("http://configured:8");
  });

  it("forwards token and client for remote auth (#323)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ status: "ok", pid: 7, started_at: "t" }), {
          status: 200,
        }),
      ),
    );
    const d: Discovery = await ensureDaemon(launcherNever(), {
      url: "http://configured:8",
      token: "fake-client-token-ddd",
      client: "ci",
    });
    expect(d.token).toBe("fake-client-token-ddd");
    expect(d.client).toBe("ci");
  });
});

describe("ensureDaemon local advertisement (#384)", () => {
  it("returns a live advertisement with no network round-trip", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const existing: Discovery = { port: 1, pid: 2, started_at: "t" };
    const d = await ensureDaemon({
      liveDiscovery: () => existing,
      readDiscovery: () => existing,
      clearDiscovery: () => {
        throw new Error("should not clear");
      },
      isProcessAlive: () => true,
      spawnDaemon: () => {
        throw new Error("should not spawn");
      },
      withLock: async () => {
        throw new Error("should not lock");
      },
    });
    expect(d).toBe(existing);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears and respawns when the advertisement is stale", async () => {
    let cleared = false;
    let spawned = false;
    const fresh: Discovery = { port: 9, pid: 99, started_at: "now" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
    );
    const d = await ensureDaemon({
      liveDiscovery: () => (spawned ? fresh : null),
      readDiscovery: () => (spawned ? fresh : null),
      clearDiscovery: () => {
        cleared = true;
      },
      isProcessAlive: (pid) => pid === 99,
      spawnDaemon: () => {
        spawned = true;
        return 99;
      },
      withLock: async (fn) => fn(),
    });
    expect(cleared).toBe(true);
    expect(spawned).toBe(true);
    expect(d).toEqual(fresh);
  });
});

describe("daemonGet transport errors (#384)", () => {
  it("names the advertised daemon when fetch fails against a local discovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(
      daemonGet(
        { port: 59999, pid: 42, started_at: "2026-01-01T00:00:00.000Z" },
        "/health",
      ),
    ).rejects.toThrow(
      /advertised parley daemon.*pid 42.*2026-01-01T00:00:00\.000Z/,
    );
  });

  it("does not rewrite fetch errors for a remote url discovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(
      daemonGet(
        { port: 0, pid: 1, started_at: "t", url: "http://remote:9" },
        "/health",
      ),
    ).rejects.toThrow("fetch failed");
  });
});

describe("daemonGet with Discovery.token (#323)", () => {
  it("sends Authorization bearer on subsequent RPC", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer fake-client-token-eee");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const discovery: Discovery = {
      port: 0,
      pid: 1,
      started_at: "t",
      url: "http://remote:9",
      token: "fake-client-token-eee",
    };
    const body = await daemonGet<{ ok: boolean }>(discovery, "/tasks");
    expect(body).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
