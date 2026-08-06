/**
 * HIGH-2 — render every data-layer hook against a real daemon via bootDaemon.
 * Regex wiring guards alone are not enough: a dead hook with a preserved
 * literal call site must fail these behavioral tests.
 *
 * happy-dom for renderHook; disableSameOriginPolicy is set on the integration
 * project so localhost fetch is not CORS-blocked.
 */
/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { ParleyClient } from "@useparley/core";
import { useHealth } from "../../src/data/useHealth.js";
import { useRuns } from "../../src/data/useRuns.js";
import { useRunners } from "../../src/data/useRunners.js";
import { useLogTail } from "../../src/data/useLogTail.js";
import { useMetrics } from "../../src/data/useMetrics.js";
import { useRunMetrics } from "../../src/data/useRunMetrics.js";
import { useTaskDetail } from "../../src/data/useTaskDetail.js";
import { useNodeTasks } from "../../src/data/useNodeTasks.js";
import { useSnapshot } from "../../src/data/useSnapshot.js";
import {
  bootDaemon,
  createTask,
  installFetchEventSource,
  waitForTaskState,
  type DaemonFixture,
} from "./harness.js";

const fixtures: DaemonFixture[] = [];
let uninstallEs: (() => void) | undefined;

afterEach(async () => {
  uninstallEs?.();
  uninstallEs = undefined;
  for (const f of fixtures.splice(0)) {
    try {
      await f.close();
    } catch {
      /* ignore */
    }
  }
});

describe("hooks against real daemon (HIGH-2 behavioral coverage)", () => {
  it("useHealth / useRuns / useRunners / useMetrics / useRunMetrics land real data", async () => {
    const fx = await bootDaemon();
    fixtures.push(fx);
    const client = new ParleyClient({ baseUrl: fx.baseUrl });

    const health = renderHook(() => useHealth(client, 200));
    await waitFor(() => expect(health.result.current.online).toBe(true), {
      timeout: 10_000,
    });
    expect(health.result.current.version).toBeTruthy();
    expect(health.result.current.pid).toBeTypeOf("number");
    health.unmount();

    const runs = renderHook(() => useRuns(client, { pollMs: 200 }));
    await waitFor(() => expect(runs.result.current.status).toBe("online"), {
      timeout: 10_000,
    });
    expect(Array.isArray(runs.result.current.summaries)).toBe(true);
    runs.unmount();

    const runners = renderHook(() => useRunners(client, 200));
    await waitFor(() => expect(runners.result.current.status).toBe("online"), {
      timeout: 10_000,
    });
    expect(Array.isArray(runners.result.current.runners)).toBe(true);
    runners.unmount();

    const metrics = renderHook(() =>
      useMetrics(client, {
        session: "all",
        groupBy: "vendor",
        refreshKey: "1",
      }),
    );
    await waitFor(
      () => expect(["ready", "empty"]).toContain(metrics.result.current.status),
      { timeout: 10_000 },
    );
    expect(metrics.result.current.data).toBeTruthy();
    expect(Array.isArray(metrics.result.current.data!.groups)).toBe(true);
    metrics.unmount();

    const runMetrics = renderHook(() =>
      useRunMetrics(client, { refreshKey: "1", groupBy: "workflow" }),
    );
    await waitFor(
      () => expect(["ready", "empty"]).toContain(runMetrics.result.current.status),
      { timeout: 10_000 },
    );
    expect(runMetrics.result.current.data).toBeTruthy();
    expect(Array.isArray(runMetrics.result.current.data!.groups)).toBe(true);
    // Must have actually hit the wire — generated_at is server-stamped.
    expect(typeof runMetrics.result.current.data!.generated_at).toBe("string");
    expect(runMetrics.result.current.data!.generated_at.length).toBeGreaterThan(0);
    runMetrics.unmount();
  });

  it("useSnapshot / useTaskDetail / useLogTail / useNodeTasks land real data", async () => {
    const fx = await bootDaemon({
      actions: [
        {
          submit_report: {
            summary: "hook coverage",
            outcome: "success",
            files_changed: ["src/seed.ts"],
          },
        },
      ],
    });
    fixtures.push(fx);
    uninstallEs = installFetchEventSource();

    const taskId = await createTask(fx.baseUrl, {
      prompt: "finish",
      vendor: "fake",
      cwd: fx.repo,
      orchestrator_session_id: "orch-hooks",
    });
    await waitForTaskState(fx.baseUrl, taskId, ["completed", "failed"]);

    const client = new ParleyClient({ baseUrl: fx.baseUrl });

    const snapshot = renderHook(() => useSnapshot(client));
    await waitFor(() => expect(snapshot.result.current.ready).toBe(true), {
      timeout: 10_000,
    });
    expect(snapshot.result.current.connected).toBe(true);
    const hit = snapshot.result.current.tasks.find((t) => t.task_id === taskId);
    expect(hit).toBeTruthy();
    expect(hit!.state).toBe("completed");
    expect(hit!.report?.summary).toBe("hook coverage");

    const detail = renderHook(() => useTaskDetail(client, taskId, 200));
    await waitFor(() => expect(detail.result.current.status).toBe("ready"), {
      timeout: 10_000,
    });
    expect(detail.result.current.data?.task.task_id).toBe(taskId);
    expect(detail.result.current.data?.task.report?.outcome).toBe("success");
    detail.unmount();

    const logs = renderHook(() => useLogTail(client, taskId, true, 100));
    await waitFor(
      () =>
        expect(["tailing", "ended", "connecting"]).toContain(logs.result.current.status),
      { timeout: 10_000 },
    );
    // Eventually settles (eof or unreachable retry). Wait for non-connecting.
    await waitFor(() => expect(logs.result.current.status).not.toBe("connecting"), {
      timeout: 10_000,
    });
    logs.unmount();

    // Node detail: unknown run → error status from real HTTP 404 (wired path).
    const nodes = renderHook(() =>
      useNodeTasks(client, {
        runRef: "no-such-run",
        node: "n1",
        snapshotTasks: snapshot.result.current.tasks,
      }),
    );
    await waitFor(() => expect(nodes.result.current.status).toBe("error"), {
      timeout: 10_000,
    });
    expect(nodes.result.current.error).toBeTruthy();
    nodes.unmount();

    snapshot.unmount();
  });
});
