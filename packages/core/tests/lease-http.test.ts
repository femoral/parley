import { describe, expect, it, vi } from "vitest";
import {
  createLeaseHttpTransport,
  DEFAULT_ROUTING_QUEUE_TIMEOUT_MS,
  DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_RUNNER_PRESENCE_GRACE_MS,
  DEFAULT_RUNNER_STALE_MS,
  deriveRunnerStatus,
  LOCAL_EXECUTOR_ID,
  RUNNER_PROTOCOL_VERSION,
  TASK_HEADER,
  type RegisterRequest,
  type RunnerLeaseSpec,
} from "../src/lease.js";

function jsonResponse(status: number, body?: unknown): Response {
  if (status === 204) {
    return new Response(null, { status: 204 });
  }
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const sampleLease: RunnerLeaseSpec = {
  task_id: "t1",
  name: null,
  prompt: "do the thing",
  vendor: "fake",
  model: null,
  effort: null,
  profile: null,
  sandbox: "workspace",
  network: true,
  answer_timeout_ms: 60_000,
  report_schema: { type: "object" },
  base_ref: null,
  base_sha: null,
  repo_key: "github.com/org/repo",
  repo_fetch_url: "https://github.com/org/repo.git",
  repo: "/repo",
  contexts: [],
  extra_args: [],
  env: {},
};

describe("lease wire constants", () => {
  it("exports the child correlation header", () => {
    expect(TASK_HEADER).toBe("x-parley-task");
  });

  it("exports the ADR-0012 heartbeat default", () => {
    expect(DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS).toBe(90_000);
  });

  it("exports the registration protocol version", () => {
    expect(RUNNER_PROTOCOL_VERSION).toBe(1);
  });

  it("exports presence grace and stale defaults", () => {
    expect(DEFAULT_RUNNER_PRESENCE_GRACE_MS).toBe(50_000);
    expect(DEFAULT_RUNNER_STALE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("exports routing queue timeout default and local executor id (#315)", () => {
    expect(DEFAULT_ROUTING_QUEUE_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(LOCAL_EXECUTOR_ID).toBe("local");
  });
});

describe("deriveRunnerStatus", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");

  it("is online with an open lease poll", () => {
    expect(
      deriveRunnerStatus({
        hasOpenPoll: true,
        lastSeenIso: "2020-01-01T00:00:00.000Z",
        nowMs: now,
      }),
    ).toBe("online");
  });

  it("is online within the grace window after last_seen", () => {
    expect(
      deriveRunnerStatus({
        hasOpenPoll: false,
        lastSeenIso: new Date(now - 10_000).toISOString(),
        nowMs: now,
        graceMs: 50_000,
      }),
    ).toBe("online");
  });

  it("is offline after grace and before stale", () => {
    expect(
      deriveRunnerStatus({
        hasOpenPoll: false,
        lastSeenIso: new Date(now - 60_000).toISOString(),
        nowMs: now,
        graceMs: 50_000,
        staleMs: 86_400_000,
      }),
    ).toBe("offline");
  });

  it("is stale past the stale window", () => {
    expect(
      deriveRunnerStatus({
        hasOpenPoll: false,
        lastSeenIso: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
        nowMs: now,
        graceMs: 50_000,
        staleMs: 14 * 24 * 60 * 60 * 1000,
      }),
    ).toBe("stale");
  });
});

describe("createLeaseHttpTransport", () => {
  it("POSTs /runner/register with capabilities payload", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        name: "gpu",
        registered_at: "2026-08-03T00:00:00.000Z",
        last_seen: "2026-08-03T00:00:00.000Z",
      }),
    );
    const transport = createLeaseHttpTransport({
      daemonUrl: "http://daemon.example:9/",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const request: RegisterRequest = {
      runner: "gpu",
      protocol_version: RUNNER_PROTOCOL_VERSION,
      build_version: "0.0.4",
      capabilities: {
        vendors: [
          {
            id: "fake",
            models: [
              { id: "fake-model", efforts: ["low", "medium", "high"], default_effort: "medium" },
            ],
          },
        ],
      },
    };
    const res = await transport.register(request);
    expect(res.ok).toBe(true);
    expect(res.name).toBe("gpu");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://daemon.example:9/runner/register");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it("maps register 401 to a runner-auth message", async () => {
    const transport = createLeaseHttpTransport({
      daemonUrl: "http://d",
      token: "bad",
      fetch: (async () => jsonResponse(401, { error: "nope" })) as unknown as typeof fetch,
    });
    await expect(
      transport.register({
        runner: "gpu",
        protocol_version: 1,
        build_version: "0.0.4",
        capabilities: { vendors: [] },
      }),
    ).rejects.toThrow(/runner auth failed \(401\)/);
  });

  it("surfaces register non-OK status with body", async () => {
    const transport = createLeaseHttpTransport({
      daemonUrl: "http://d",
      token: "t",
      fetch: (async () =>
        jsonResponse(400, {
          error: "incompatible runner protocol version: runner sent 0, daemon requires 1",
        })) as unknown as typeof fetch,
    });
    await expect(
      transport.register({
        runner: "gpu",
        protocol_version: 0,
        build_version: "0.0.4",
        capabilities: { vendors: [] },
      }),
    ).rejects.toThrow(/register failed \(400\).*incompatible runner protocol/);
  });

  it("POSTs /runner/lease with bearer auth and runner body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, sampleLease));
    const transport = createLeaseHttpTransport({
      daemonUrl: "http://daemon.example:9/",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const lease = await transport.lease("gpu");
    expect(lease).toEqual(sampleLease);
    // #313: lease wire carries key + fetch URL + local path.
    expect(lease?.repo_key).toBe("github.com/org/repo");
    expect(lease?.repo_fetch_url).toBe("https://github.com/org/repo.git");
    expect(lease?.repo).toBe("/repo");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://daemon.example:9/runner/lease");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
    expect(JSON.parse(String(init?.body))).toEqual({ runner: "gpu" });
  });

  it("maps 204 to null", async () => {
    const transport = createLeaseHttpTransport({
      daemonUrl: "http://d",
      token: "t",
      fetch: (async () => jsonResponse(204)) as unknown as typeof fetch,
    });
    expect(await transport.lease("gpu")).toBeNull();
  });

  it("maps 401 to a runner-auth message", async () => {
    const transport = createLeaseHttpTransport({
      daemonUrl: "http://d",
      token: "bad",
      fetch: (async () => jsonResponse(401, { error: "nope" })) as unknown as typeof fetch,
    });
    await expect(transport.lease("gpu")).rejects.toThrow(
      /runner auth failed \(401\)/,
    );
  });

  it("surfaces non-OK lease status with body", async () => {
    const transport = createLeaseHttpTransport({
      daemonUrl: "http://d",
      token: "t",
      fetch: (async () =>
        new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(transport.lease("gpu")).rejects.toThrow(/lease failed \(500\): boom/);
  });

  it("posts heartbeat / events / branch / fail under task paths", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return jsonResponse(200, {});
    });
    const transport = createLeaseHttpTransport({
      daemonUrl: "http://d",
      token: "t",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await transport.heartbeat("task/1");
    await transport.events("task/1", ["line-a", "line-b"]);
    await transport.branch("task/1", "parley/t1");
    await transport.fail("task/1", "gave up");

    expect(calls.map((c) => c.url)).toEqual([
      "http://d/runner/tasks/task%2F1/heartbeat",
      "http://d/runner/tasks/task%2F1/events",
      "http://d/runner/tasks/task%2F1/branch",
      "http://d/runner/tasks/task%2F1/fail",
    ]);
    expect(JSON.parse(calls[1]!.body)).toEqual({ lines: ["line-a", "line-b"] });
    expect(JSON.parse(calls[2]!.body)).toEqual({ branch: "parley/t1" });
    expect(JSON.parse(calls[3]!.body)).toEqual({ error: "gave up" });
  });

  it("no-ops events when lines is empty", async () => {
    const fetchMock = vi.fn();
    const transport = createLeaseHttpTransport({
      daemonUrl: "http://d",
      token: "t",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await transport.events("t1", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps non-OK verb responses", async () => {
    const transport = createLeaseHttpTransport({
      daemonUrl: "http://d",
      token: "t",
      fetch: (async () =>
        new Response("nope", { status: 409 })) as unknown as typeof fetch,
    });
    await expect(transport.fail("t1", "x")).rejects.toThrow(/fail failed \(409\): nope/);
  });
});
