/** @vitest-environment happy-dom */
/**
 * Regression: live→live task switch must fetch the new task immediately
 * (not wait a full poll interval while status stays "loading").
 *
 * Also: a slow in-flight getTask(A) must not overwrite B after the switch.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParleyClient, TaskEnvelope } from "@useparley/core";
import { useTaskDetail } from "../../src/data/useTaskDetail.js";
import { envelope } from "../fixtures.js";
import { detailResponse } from "../task/fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useTaskDetail live→live switch", () => {
  it("fetches the new non-terminal task immediately (within first poll interval)", async () => {
    const pollMs = 3000;
    const calls: string[] = [];
    const tasks: Record<string, TaskEnvelope> = {
      "task-a": envelope({ task_id: "task-a", state: "running" }),
      "task-b": envelope({ task_id: "task-b", state: "running" }),
    };

    const client = {
      getTask: vi.fn(async (id: string) => {
        calls.push(id);
        // Slight async delay so loading state is observable, still << pollMs.
        await new Promise((r) => setTimeout(r, 5));
        return detailResponse({ task: tasks[id]! });
      }),
    } as unknown as ParleyClient;

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useTaskDetail(client, id, pollMs),
      { initialProps: { id: "task-a" as string | null } },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data?.task.task_id).toBe("task-a");
    expect(calls.filter((c) => c === "task-a").length).toBeGreaterThanOrEqual(1);

    const callsBeforeB = calls.length;
    const t0 = Date.now();

    await act(async () => {
      rerender({ id: "task-b" });
    });

    // Must leave ready and enter loading for the new identity.
    expect(result.current.status).toBe("loading");

    await waitFor(
      () => {
        expect(result.current.status).toBe("ready");
        expect(result.current.data?.task.task_id).toBe("task-b");
      },
      { timeout: 900 },
    );

    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(900);
    // A getTask for B must have been issued well before pollMs.
    expect(calls.slice(callsBeforeB).some((c) => c === "task-b")).toBe(true);
    expect(calls.slice(callsBeforeB).findIndex((c) => c === "task-b")).toBeGreaterThanOrEqual(0);
  });

  it("drops a stale getTask(A) response after switching to task-b", async () => {
    const pollMs = 3000;
    const tasks: Record<string, TaskEnvelope> = {
      "task-a": envelope({ task_id: "task-a", state: "running" }),
      "task-b": envelope({ task_id: "task-b", state: "running" }),
    };

    // First getTask("task-a") is delayed; subsequent A polls (if any) and B are fast.
    let aCallCount = 0;
    let resolveSlowA: (() => void) | undefined;
    const slowAGate = new Promise<void>((resolve) => {
      resolveSlowA = resolve;
    });

    const client = {
      getTask: vi.fn(async (id: string) => {
        if (id === "task-a") {
          aCallCount += 1;
          if (aCallCount === 1) {
            await slowAGate;
          }
        }
        // Small yield so React can process state updates between settles.
        await new Promise((r) => setTimeout(r, 5));
        return detailResponse({ task: tasks[id]! });
      }),
    } as unknown as ParleyClient;

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useTaskDetail(client, id, pollMs),
      { initialProps: { id: "task-a" as string | null } },
    );

    // Let the slow A request start (status loading, not yet ready).
    await waitFor(() => expect(client.getTask).toHaveBeenCalledWith("task-a"));
    expect(result.current.status).toBe("loading");

    // Switch to B while A's first fetch is still in flight.
    await act(async () => {
      rerender({ id: "task-b" });
    });
    expect(result.current.status).toBe("loading");

    // B should land promptly (resetKey immediate fetch).
    await waitFor(
      () => {
        expect(result.current.status).toBe("ready");
        expect(result.current.data?.task.task_id).toBe("task-b");
      },
      { timeout: 900 },
    );

    // Release stale A and wait for its promise to settle.
    await act(async () => {
      resolveSlowA?.();
      // Allow microtasks / setTimeout(5) inside getTask to complete.
      await new Promise((r) => setTimeout(r, 50));
    });

    // Must never flip back to task-a; selection stays on B.
    expect(result.current.status).toBe("ready");
    expect(result.current.data?.task.task_id).toBe("task-b");

    // Hold a beat past any residual scheduling; still B.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(result.current.data?.task.task_id).toBe("task-b");
  });
});
