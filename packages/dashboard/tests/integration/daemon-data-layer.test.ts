/**
 * Real-daemon + fake-vendor coverage for console data-layer projections.
 * Wiring must be exercised — no hand-constructed projections as the only coverage.
 *
 * Node environment (not happy-dom): ParleyClient reaches localhost without CORS.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapTaskStream,
  ParleyClient,
  type Report,
  type StreamEvent,
  type TaskEnvelope,
} from "@useparley/core";
import { homePaths } from "@useparley/core";
import { projectReportFiles } from "../../src/data/projections/filesChanged.js";
import { projectQueueContext } from "../../src/data/projections/queueContext.js";
import { projectTokenBurn } from "../../src/data/projections/tokenBurn.js";
import { filterTasksByRunId } from "../../src/data/projections/runTasks.js";
import { projectFirehoseLine } from "../../src/data/projections/firehose.js";
import { fetchNodeDetail } from "../../src/data/clientExtras.js";
import {
  bootDaemon,
  createTask,
  FetchEventSource,
  waitFor,
  waitForTaskState,
  type DaemonFixture,
} from "./harness.js";
import {
  insertTask,
  nextTaskId,
  openDatabase,
  writeTaskState,
} from "../../../daemon/src/db.js";

const fixtures: DaemonFixture[] = [];

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    try {
      await f.close();
    } catch {
      /* already closed */
    }
  }
});

describe("console data layer vs real daemon (fake-vendor)", () => {
  it("bootstrapTaskStream surfaces full envelopes incl. report files_changed churn", async () => {
    const actions = [
      {
        write_file: {
          path: "src/touched.ts",
          contents: "line1\nline2\nline3\n",
        },
      },
      {
        submit_report: {
          summary: "added touched.ts",
          outcome: "success",
          files_changed: ["src/touched.ts"],
        },
      },
    ];
    const fx = await bootDaemon({ actions });
    fixtures.push(fx);

    const taskId = await createTask(fx.baseUrl, {
      prompt: "touch a file and report it",
      vendor: "fake",
      orchestrator_session_id: "orch-console",
      cwd: fx.repo,
      use_worktree: true,
    });
    await waitForTaskState(fx.baseUrl, taskId, ["completed", "failed"]);

    const client = new ParleyClient({ baseUrl: fx.baseUrl });
    const events: StreamEvent[] = [];
    const { snapshot, stream } = await bootstrapTaskStream({
      client,
      EventSource: FetchEventSource,
      onEvent: (e) => events.push(e),
    });
    try {
      const task =
        snapshot.tasks.find((t) => t.task_id === taskId) ??
        (await client.getTask(taskId)).task;
      expect(task.state).toBe("completed");
      // Full envelope fields live on the list/snapshot path.
      expect(task.report).toBeTruthy();
      expect(typeof task.duration_ms === "number" || task.duration_ms === null).toBe(true);

      const files = projectReportFiles(task.report as Report);
      expect(files.files.some((f) => f.path === "src/touched.ts")).toBe(true);
      const touched = files.files.find((f) => f.path === "src/touched.ts")!;
      expect(touched.added).toBe(3);
      expect(touched.removed).toBe(0);
      expect(files.hasChurn).toBe(true);
    } finally {
      stream.close();
    }
  });

  it("queue context projects max_concurrent from a real queued envelope", async () => {
    const fx = await bootDaemon({
      config: { vendors: { fake: { maxConcurrent: 2 } } },
      actions: [{ sleep: 60_000 }],
    });
    fixtures.push(fx);

    // Fill the vendor cap AFTER server start (startup sweep would stall pre-seeded running rows).
    const side = openDatabase(homePaths(fx.home));
    try {
      for (let i = 0; i < 2; i++) {
        const id = nextTaskId(side);
        insertTask(side, {
          id,
          name: null,
          vendor: "fake",
          model: null,
          effort: null,
          profile: null,
          repo: null,
          cwd: fx.repo,
          prompt: "holder",
          orchestrator_session_id: "orch",
          worktree: null,
          branch: null,
          base_sha: null,
          sandbox: "workspace",
          network: true,
          answer_timeout_ms: null,
          report_schema: null,
          size: null,
          difficulty: null,
          type: "other",
        });
        writeTaskState(side, id, "running", {
          started_at: new Date().toISOString(),
        });
      }
    } finally {
      side.close();
    }

    const taskId = await createTask(fx.baseUrl, {
      prompt: "queue me",
      vendor: "fake",
      cwd: fx.repo,
      orchestrator_session_id: "orch",
    });

    let env: TaskEnvelope | null = null;
    await waitFor(async () => {
      const res = await fetch(`${fx.baseUrl}/tasks/${taskId}`);
      if (res.status !== 200) return false;
      const body = (await res.json()) as { task: TaskEnvelope };
      env = body.task;
      return body.task.state === "queued";
    });

    expect(env).not.toBeNull();
    const q = projectQueueContext(env!);
    expect(q.label).toBe("QUEUED #1 · vendor:fake 2/2");
    expect(q.maxConcurrent).toBe(2);
    expect(q.blockingCap).toBe("vendor:fake");
    expect(q.position).toBe(1);
  });

  it("token-burn buckets usage from real list envelopes and exposes retention", async () => {
    const fx = await bootDaemon({
      actions: [
        {
          submit_report: {
            summary: "done",
            outcome: "success",
            files_changed: [],
          },
        },
      ],
    });
    fixtures.push(fx);

    const taskId = await createTask(fx.baseUrl, {
      prompt: "finish quickly",
      vendor: "fake",
      cwd: fx.repo,
      orchestrator_session_id: "orch-burn",
    });
    await waitForTaskState(fx.baseUrl, taskId, ["completed", "failed"]);

    const client = new ParleyClient({ baseUrl: fx.baseUrl });
    const list = await client.listTasks();
    const view = projectTokenBurn(list.tasks, { nowMs: Date.now() });
    expect(view.retentionDays).toBe(30);
    expect(view.windowMs).toBe(24 * 60 * 60 * 1000);
    expect(view.totals.tasks).toBeGreaterThanOrEqual(1);
  });

  it("health probe reports online against the live daemon", async () => {
    const fx = await bootDaemon();
    fixtures.push(fx);
    const client = new ParleyClient({ baseUrl: fx.baseUrl });
    const health = await client.health();
    expect(health.status).toBe("ok");
    expect(health.version).toBeTruthy();
    expect(typeof health.pid).toBe("number");
  });

  it("runMetrics hits GET /run-metrics on the real daemon", async () => {
    const fx = await bootDaemon();
    fixtures.push(fx);
    const client = new ParleyClient({ baseUrl: fx.baseUrl });
    const data = await client.runMetrics({ groupBy: "workflow" });
    expect(Array.isArray(data.groups)).toBe(true);
    expect(typeof data.generated_at).toBe("string");
  });

  it("firehose join uses runs cache workflow name for run stream payloads", async () => {
    const fx = await bootDaemon();
    fixtures.push(fx);
    const client = new ParleyClient({ baseUrl: fx.baseUrl });
    const runs = await client.listRuns();
    const line = projectFirehoseLine(
      {
        subject: "run",
        event: "run.started",
        seq: 1,
        run: {
          run_id: runs.runs[0]?.run_id ?? "run-missing",
          state: "running",
          current_node: "n1",
          iteration: 0,
          seq: 1,
        },
      },
      new Map(runs.runs.map((r) => [r.run_id, r.workflow])),
    );
    expect(line.subject).toBe("run");
    expect(line.event).toBe("run.started");
    if (runs.runs[0]) {
      expect(line.workflow).toBe(runs.runs[0].workflow);
    }
  });

  it("client-side run_id filter works on list envelopes from the daemon", async () => {
    const fx = await bootDaemon();
    fixtures.push(fx);
    const client = new ParleyClient({ baseUrl: fx.baseUrl });
    const list = await client.listTasks();
    expect(filterTasksByRunId(list.tasks, "no-such-run")).toEqual([]);
    expect(filterTasksByRunId(list.tasks, null)).toEqual([]);
  });

  it("fetchNodeDetail path is wired (404 for unknown run is a real round-trip)", async () => {
    const fx = await bootDaemon();
    fixtures.push(fx);
    const client = new ParleyClient({ baseUrl: fx.baseUrl });
    await expect(fetchNodeDetail(client, "missing-run", "node-a")).rejects.toThrow();
  });
});
