/** @vitest-environment happy-dom */
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ParleyClient, type MetricsResponse } from "@useparley/core";
import { useMetrics } from "../src/app/hooks/useMetrics.js";
import { metricsRefreshKey, projectSoundings } from "../src/app/hooks/metrics.js";

function metricsFixture(overrides: Partial<MetricsResponse> = {}): MetricsResponse {
  return {
    generated_at: "2026-07-16T12:00:00.000Z",
    groups: [
      {
        key: "codex",
        tasks: {
          total: 2,
          completed: 1,
          failed: 0,
          cancelled: 0,
          running: 1,
          other: 0,
        },
        success_rate: 1,
        evals: {
          count: 1,
          avg: 4.5,
          avg_baseline: 5,
          avg_delta: -0.5,
          below_baseline_rate: 1,
          criterion_failures: {},
          first_attempt: {
            count: 1,
            avg: 4.5,
            avg_baseline: 5,
            avg_delta: -0.5,
            below_baseline_rate: 1,
          },
          fix: {
            count: 0,
            avg: null,
            avg_baseline: null,
            avg_delta: null,
            below_baseline_rate: null,
          },
        },
        evals_by_size: {
          S: {
            count: 1,
            avg: 4.5,
            avg_baseline: 5,
            avg_delta: -0.5,
            below_baseline_rate: 1,
            criterion_failures: {},
            first_attempt: {
              count: 1,
              avg: 4.5,
              avg_baseline: 5,
              avg_delta: -0.5,
              below_baseline_rate: 1,
            },
            fix: {
              count: 0,
              avg: null,
              avg_baseline: null,
              avg_delta: null,
              below_baseline_rate: null,
            },
          },
        },
        evals_by_difficulty: {},
        tokens: { input: 1200, output: 400, cached: 100, tasks_reporting: 1 },
        duration_ms: {
          total: 60_000,
          avg: 60_000,
          p50: 60_000,
          p95: 60_000,
          tasks_reporting: 1,
        },
      },
    ],
    ...overrides,
  };
}

describe("useMetrics (#119)", () => {
  it("stays idle when disabled", () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = new ParleyClient({ baseUrl: "", fetch: fetchFn as typeof fetch });
    const { result } = renderHook(() =>
      useMetrics(client, {
        session: "all",
        groupBy: "vendor",
        refreshKey: "1",
        enabled: false,
      }),
    );
    expect(result.current.status).toBe("idle");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches /metrics with session and group_by query", async () => {
    const body = metricsFixture();
    const urls: string[] = [];
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch,
    });

    const { result } = renderHook(() =>
      useMetrics(client, {
        session: "sess-abc",
        groupBy: "model",
        refreshKey: "k1",
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data?.groups[0]?.key).toBe("codex");
    expect(urls.some((u) => u.includes("/metrics"))).toBe(true);
    expect(urls.some((u) => u.includes("session=sess-abc"))).toBe(true);
    expect(urls.some((u) => u.includes("group_by=model"))).toBe(true);
  });

  it("refetches when groupBy changes with the new query", async () => {
    const urls: string[] = [];
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(JSON.stringify(metricsFixture()), { status: 200 });
      }) as typeof fetch,
    });

    const { result, rerender } = renderHook(
      ({ groupBy }: { groupBy: "vendor" | "size" }) =>
        useMetrics(client, {
          session: "all",
          groupBy,
          refreshKey: "same",
          enabled: true,
        }),
      { initialProps: { groupBy: "vendor" as "vendor" | "size" } },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(urls.some((u) => u.includes("group_by=vendor"))).toBe(true);

    rerender({ groupBy: "size" });
    await waitFor(() => expect(urls.some((u) => u.includes("group_by=size"))).toBe(true));
    expect(result.current.groupBy).toBe("size");
  });

  it("refetches when refreshKey advances (SSE task transition)", async () => {
    let calls = 0;
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify(metricsFixture()), { status: 200 });
      }) as typeof fetch,
    });

    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: string }) =>
        useMetrics(client, {
          session: "all",
          groupBy: "vendor",
          refreshKey,
          enabled: true,
        }),
      { initialProps: { refreshKey: "t1:running" } },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(calls).toBe(1);

    rerender({ refreshKey: "t1:completed" });
    await waitFor(() => expect(calls).toBe(2));
  });

  it("surfaces error status on fetch failure", async () => {
    const client = new ParleyClient({
      baseUrl: "",
      fetch: (async () => {
        throw new Error("unreachable");
      }) as typeof fetch,
    });

    const { result } = renderHook(() =>
      useMetrics(client, {
        session: "all",
        groupBy: "vendor",
        refreshKey: "1",
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toMatch(/unreachable/);
    expect(result.current.data).toBeNull();
  });
});

describe("projectSoundings / metricsRefreshKey", () => {
  it("projects empty ready response to empty status", () => {
    const view = projectSoundings(
      { groups: [], generated_at: "2026-07-16T00:00:00.000Z" },
      "ready",
      null,
      "vendor",
      "All hands",
    );
    expect(view.status).toBe("empty");
    expect(view.groups).toEqual([]);
  });

  it("formats group fields for the plate", () => {
    const view = projectSoundings(metricsFixture(), "ready", null, "vendor", "sess-1");
    expect(view.status).toBe("ready");
    expect(view.groups).toHaveLength(1);
    const g = view.groups[0]!;
    expect(g.label).toBe("codex");
    expect(g.successRate).toBe("100%");
    expect(g.tokens.input).toBe("1.2k");
    expect(g.evalsBySize).toHaveLength(1);
    expect(g.evalsByDifficulty).toHaveLength(0);
    expect(view.sessionLabel).toBe("sess-1");
  });

  it("builds a stable refresh key from id:state pairs", () => {
    expect(metricsRefreshKey([])).toBe("0");
    expect(
      metricsRefreshKey([
        { id: "a", state: "running" },
        { id: "b", state: "failed" },
      ]),
    ).toBe("a:running|b:failed");
  });
});

describe("format helpers used by metrics projection", () => {
  it("formats success rate, eval avg, and duration", async () => {
    const { formatSuccessRate, formatEvalAvg, formatDurationMs, formatTokenCount } =
      await import("../src/app/hooks/format.js");
    expect(formatSuccessRate(0.875)).toBe("87.5%");
    expect(formatSuccessRate(null)).toBe("—");
    expect(formatEvalAvg(4.25, 3)).toBe("4.3 · n=3");
    expect(formatEvalAvg(null, 0)).toBe("—");
    expect(formatDurationMs(125_000)).toBe("2m 05s");
    expect(formatDurationMs(null)).toBe("—");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });
});
