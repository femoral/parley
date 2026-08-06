/** @vitest-environment happy-dom */
/**
 * HIGH-1 regression: snapshotTasks identity churn must not re-issue
 * GET /runs/:ref/nodes/:node.
 *
 * fetchNodeDetail uses global fetch(client.url(...)) — stub the global, not
 * only ParleyClient's inject (which clientExtras does not use).
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParleyClient } from "@useparley/core";
import { useNodeTasks } from "../../src/data/useNodeTasks.js";
import { envelope } from "../fixtures.js";

function nodeBody(runId: string, nodeId: string): string {
  return JSON.stringify({
    run_id: runId,
    node: {
      node: nodeId,
      kind: "step",
      iteration: 0,
      state: "running",
      tasks_settled: 0,
      tasks_total: 0,
      usage: null,
      duration_ms: null,
      fanout: null,
      tallies: {},
      counts: {},
      summary: null,
      deliverables: [],
      gist: "",
    },
    tasks: [],
    deliverables: [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useNodeTasks fetch gating (HIGH-1)", () => {
  it("does not re-fetch when only snapshotTasks array identity changes", async () => {
    let nodeGets = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.includes("/runs/") && path.includes("/nodes/")) {
        nodeGets += 1;
        return new Response(nodeBody("run-a", "n1"), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const client = new ParleyClient({ baseUrl: "http://daemon.test", fetch: fetchImpl });

    const taskA = envelope({ task_id: "t1", state: "running", run_id: "run-a" });
    const { result, rerender } = renderHook(
      ({ tasks }) =>
        useNodeTasks(client, {
          runRef: "run-a",
          node: "n1",
          snapshotTasks: tasks,
        }),
      { initialProps: { tasks: [taskA] } },
    );

    await waitFor(() => expect(result.current.status).toMatch(/ready|empty/));
    expect(nodeGets).toBe(1);
    const afterMount = nodeGets;

    // 20 identical-content flushes (new array identity, same contents).
    for (let i = 0; i < 20; i++) {
      rerender({ tasks: [{ ...taskA }] });
    }
    // Allow any spurious effects to flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(nodeGets).toBe(afterMount); // still 1 — no storm
    // runTasks still updates from the new snapshot identity.
    expect(result.current.runTasks.map((t) => t.task_id)).toEqual(["t1"]);
  });

  it("re-fetches when runRef or node changes", async () => {
    let nodeGets = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.includes("/nodes/")) {
        nodeGets += 1;
        return new Response(nodeBody("run-a", "n"), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const client = new ParleyClient({ baseUrl: "http://daemon.test", fetch: fetchImpl });
    const tasks = [envelope({ task_id: "t1", state: "running", run_id: "run-a" })];

    const { result, rerender } = renderHook(
      ({ node }) =>
        useNodeTasks(client, {
          runRef: "run-a",
          node,
          snapshotTasks: tasks,
        }),
      { initialProps: { node: "n1" } },
    );

    await waitFor(() => expect(result.current.status).toMatch(/ready|empty/));
    expect(nodeGets).toBe(1);

    rerender({ node: "n2" });
    await waitFor(() => expect(nodeGets).toBe(2));
  });
});
