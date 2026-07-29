/** @vitest-environment happy-dom */
/**
 * #262 — list projection carries roster track; poll volume is constant in N live runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  ParleyClient,
  type RunDetailResponse,
  type RunSummary,
  type RunsResponse,
} from "@useparley/core";
import {
  __resetSelectedDeliverableCacheForTests,
  useInspectorRun,
  useRuns,
} from "../src/app/hooks/useRuns.js";
import { projectRosterRun } from "../src/app/hooks/runs.js";

afterEach(() => {
  cleanup();
  __resetSelectedDeliverableCacheForTests();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function liveSummary(
  id: string,
  over: Partial<RunSummary> = {},
): RunSummary {
  return {
    run_id: id,
    workflow: "coding-1",
    workflow_version: 1,
    orchestrator_session_id: "sess-1",
    state: "running",
    block: null,
    current_node: "implement",
    iteration: 1,
    parent_run_id: null,
    attempt: 1,
    tasks_settled: 1,
    tasks_total: 2,
    usage: { input_tokens: 10, output_tokens: 5 },
    duration_ms: 30_000,
    branch: null,
    worktree: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:30.000Z",
    completed_at: null,
    purged_at: null,
    workspace: "repo",
    type: "feature",
    repo: null,
    error: null,
    track_bound: 5,
    track: [
      {
        kind: "step",
        state: "completed",
        tasks_settled: 1,
        tasks_total: 1,
      },
      {
        kind: "step",
        state: "running",
        tasks_settled: 0,
        tasks_total: 1,
      },
    ],
    ...over,
  };
}

function detailFor(summary: RunSummary): RunDetailResponse {
  return {
    run: summary,
    block: summary.block,
    nodes: (summary.track ?? []).map((t, i) => ({
      node: `n${i}`,
      kind: t.kind,
      iteration: 1,
      state: t.state,
      tasks_settled: t.tasks_settled,
      tasks_total: t.tasks_total,
      usage: null,
      duration_ms: null,
      fanout: null,
      tallies: {},
      counts: {},
      summary: null,
      deliverables: [],
      gist: "",
    })),
  };
}

/** Count HTTP hits for one poll tick with N live runs and no selection. */
async function pollRequestCount(liveCount: number): Promise<{
  listHits: number;
  detailHits: number;
  totalHits: number;
  runs: ReturnType<typeof projectRosterRun>[];
}> {
  const runs = Array.from({ length: liveCount }, (_, i) =>
    liveSummary(`r-live-${i}`),
  );
  const listBody: RunsResponse = { seq: 1, runs };
  const hits: string[] = [];

  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    hits.push(url);
    if (url.endsWith("/runs") || url.includes("/runs?")) {
      return jsonResponse(listBody);
    }
    // Detail must not be required for resting roster appearance.
    const m = url.match(/\/runs\/([^/?]+)/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const s = runs.find((r) => r.run_id === id);
      if (s) return jsonResponse(detailFor(s));
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;

  const client = new ParleyClient({ baseUrl: "", fetch: fetchFn });
  const { result, unmount } = renderHook(() =>
    useRuns(client, { pollMs: 60_000, selectedRunId: null }),
  );

  await waitFor(() => {
    expect(result.current.summaries.length).toBe(liveCount);
    expect(result.current.runs.length).toBe(liveCount);
  });

  // Allow any stray concurrent detail fetches a tick to land.
  await new Promise((r) => setTimeout(r, 30));

  const listHits = hits.filter((h) => h.endsWith("/runs") || h.includes("/runs?")).length;
  const detailHits = hits.filter((h) => /\/runs\/[^/?]+/.test(h) && !h.includes("/runs?")).length;

  const snapshot = {
    listHits,
    detailHits,
    totalHits: hits.length,
    runs: result.current.runs,
  };
  unmount();
  return snapshot;
}

describe("useRuns poll volume (#262)", () => {
  it("request count is constant across 1 and 25 live runs (no selection)", async () => {
    const one = await pollRequestCount(1);
    const many = await pollRequestCount(25);

    // Headline criterion: volume does not scale with N live runs.
    expect(one.totalHits).toBe(many.totalHits);
    expect(one.listHits).toBe(1);
    expect(many.listHits).toBe(1);
    // No detail fan-out for unselected live runs.
    expect(one.detailHits).toBe(0);
    expect(many.detailHits).toBe(0);

    // Roster pips still paint from the list track.
    expect(one.runs[0]!.pips.map((p) => p.kind)).toEqual([
      "done",
      "live",
      "empty",
      "empty",
      "empty",
    ]);
    expect(many.runs[24]!.pips.map((p) => p.kind)).toEqual([
      "done",
      "live",
      "empty",
      "empty",
      "empty",
    ]);
  });

  it("selecting a run loads full detail for the inspector", async () => {
    const runId = "r-selected";
    const summary = liveSummary(runId);
    const detail = detailFor(summary);
    const hits: string[] = [];

    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      hits.push(url);
      if (url.endsWith("/runs") || url.includes("/runs?")) {
        return jsonResponse({ seq: 1, runs: [summary] } satisfies RunsResponse);
      }
      if (url.includes(`/runs/${encodeURIComponent(runId)}`)) {
        return jsonResponse(detail);
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const client = new ParleyClient({ baseUrl: "", fetch: fetchFn });
    const { result } = renderHook(() => {
      const runs = useRuns(client, { selectedRunId: runId, pollMs: 60_000 });
      return {
        runs,
        inspector: useInspectorRun(runs.details, runId, Date.now()),
      };
    });

    await waitFor(() => {
      expect(result.current.inspector).not.toBeNull();
      expect(result.current.inspector?.status).toBe("ready");
    });

    expect(hits.some((h) => h.includes(`/runs/${encodeURIComponent(runId)}`))).toBe(
      true,
    );
    const view = result.current.inspector!;
    if (view.status !== "ready") throw new Error("expected ready");
    expect(view.nodes.length).toBe(detail.nodes.length);
    // Roster still works from list alone (same row).
    expect(result.current.runs.runs[0]!.pips[0]!.kind).toBe("done");
  });

  it("unresolvable track never issues a detail fetch", async () => {
    const summary = liveSummary("r-orphan", {
      track_bound: null,
      track: null,
    });
    const hits: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      hits.push(url);
      if (url.endsWith("/runs") || url.includes("/runs?")) {
        return jsonResponse({ seq: 1, runs: [summary] } satisfies RunsResponse);
      }
      return jsonResponse({ error: "should not fetch detail" }, 500);
    }) as typeof fetch;

    const client = new ParleyClient({ baseUrl: "", fetch: fetchFn });
    const { result } = renderHook(() =>
      useRuns(client, { pollMs: 60_000, selectedRunId: null }),
    );

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1);
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(hits.every((h) => h.endsWith("/runs") || h.includes("/runs?"))).toBe(true);
    expect(hits.some((h) => /\/runs\/[^/?]+/.test(h) && !h.includes("/runs?"))).toBe(
      false,
    );
    // Degrades like list-only today (bound 1 live pip).
    expect(result.current.runs[0]!.pips).toEqual(
      projectRosterRun(summary).pips,
    );
    expect(result.current.runs[0]!.pips).toHaveLength(1);
  });
});
