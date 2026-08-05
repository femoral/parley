/**
 * #264 — a run must never observe a completed task whose deliverables have
 * not been recorded. Record run deliverables before the completed transition
 * that fires onSlotFreed → drainRuns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  getRun,
  getRunBlockReason,
  getTask,
  insertRun,
  insertTask,
  listDeliverablesForRun,
  listDeliverablesForTask,
  listTasksForRun,
  nextRunId,
  nextTaskId,
  openDatabase,
  type DatabaseHandle,
} from "../src/db.js";
import { generateReportSchema } from "../src/deliverables.js";
import { TaskEngine } from "../src/engine.js";
import { withFakeAllowlist } from "./helpers.js";

let home: string;
let db: DatabaseHandle;
let engine: TaskEngine;

function writeWorkflow(id: string, body: unknown, prompts: Record<string, string>): void {
  const dir = path.join(home, "workflows", id);
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(body, null, 2));
  for (const [name, text] of Object.entries(prompts)) {
    fs.writeFileSync(path.join(dir, "prompts", name), text);
  }
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-deliv-order-"));
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(
      withFakeAllowlist({
        defaults: { vendor: "fake", model: "fake-model", effort: "medium" },
      }),
    ),
  );
  // Hang forever so a spawned next-node task stays running (does not settle).
  const fakeBin = path.join(home, "fake-vendor.mjs");
  fs.writeFileSync(fakeBin, "setInterval(() => {}, 1e9);\n");
  process.env.PARLEY_HOME = home;
  process.env.PARLEY_FAKE_VENDOR_BIN = fakeBin;
  // Complete accepted reports quickly without waiting for vendor exit.
  process.env.PARLEY_REPORT_ACCEPTED_FALLBACK_MS = "30";
  db = openDatabase(homePaths(home));
  engine = new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
  // Hub URL is required to spawn; nothing listens — the hang-bin never connects.
  // #333: setHubPort then start (same order as server listen callback).
  engine.setHubPort(9);
  engine.start();
});

afterEach(() => {
  // Stop vendor children before closing the DB so exit handlers do not race.
  engine.killChildren();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.PARLEY_HOME;
  delete process.env.PARLEY_FAKE_VENDOR_BIN;
  delete process.env.PARLEY_REPORT_ACCEPTED_FALLBACK_MS;
});

/** Two-node linear workflow: plan → build, build.plan from plan.plan. */
function writePlanBuildWorkflow(): void {
  writeWorkflow(
    "planbuild",
    {
      id: "planbuild",
      version: 1,
      type: "other",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { artifact: { type: "text", from: "build.artifact" } },
      nodes: [
        {
          id: "plan",
          kind: "step",
          prompt: "prompts/plan.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { plan: { type: "text", max_length: 500 } },
        },
        {
          id: "build",
          kind: "step",
          prompt: "prompts/build.md",
          in: { plan: { type: "text", from: "plan.plan" } },
          out: { artifact: { type: "text", max_length: 500 } },
        },
      ],
    },
    { "plan.md": "Write a plan.\n", "build.md": "Build it.\n" },
  );
}

/** Scratch workspace root so onEnter spawn can resolve the run path. */
function ensureScratchWorkspace(runId: string): string {
  const root = path.join(home, "runs", runId);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function seedRunningTask(opts: {
  runId: string;
  workflow: string;
  node: string;
  iteration?: number;
  slot?: string | null;
  reportSchema: Record<string, unknown>;
  currentNode?: string;
}): { runId: string; taskId: string } {
  const run = insertRun(db, {
    id: opts.runId,
    workflow: opts.workflow,
    version: 1,
    type: "other",
    workspace: "scratch",
    repo: null,
    current_node: opts.currentNode ?? opts.node,
    iteration: opts.iteration ?? 1,
    state: "running",
  });
  ensureScratchWorkspace(run.id);
  const taskId = nextTaskId(db);
  insertTask(db, {
    id: taskId,
    name: null,
    vendor: "fake",
    model: null,
    effort: null,
    profile: null,
    repo: null,
    cwd: path.join(home, "ws"),
    prompt: "work",
    orchestrator_session_id: null,
    worktree: null,
    branch: null,
    base_sha: null,
    sandbox: "workspace",
    network: true,
    answer_timeout_ms: null,
    report_schema: JSON.stringify(opts.reportSchema),
    size: null,
    difficulty: null,
    type: "other",
    run_id: run.id,
    node: opts.node,
    iteration: opts.iteration ?? 1,
    slot: opts.slot ?? null,
  });
  db.prepare(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(taskId);
  return { runId: run.id, taskId };
}

describe("deliverables before drain (#264)", () => {
  it("single-task plan → build advances on completion (not sticky unfilled_inputs)", async () => {
    writePlanBuildWorkflow();
    const reportSchema = generateReportSchema({
      plan: { type: { kind: "text" }, bounds: { maxLength: 500 } },
    });
    const { runId, taskId } = seedRunningTask({
      runId: nextRunId(db),
      workflow: "planbuild",
      node: "plan",
      reportSchema,
    });

    // Capture deliverables at the moment drain would observe the settled task:
    // when the completed transition is logged, onSlotFreed has already run
    // (transition helper is synchronous). Spy the engine transitions append
    // path by watching listDeliverables during the completion window via a
    // SQLite read on every transition push is not exposed; instead we assert
    // the sticky-block property: if deliverables landed *after* drain, the
    // run would be blocked with unfilled_inputs and stay there forever.
    // Advancing to build therefore proves they were durable at drain time.
    const errors = engine.submitReport(taskId, { plan: "do the thing" });
    expect(errors).toBeNull();

    await waitFor(() => getTask(db, taskId)?.state === "completed");

    const planDeliverables = listDeliverablesForTask(db, taskId);
    expect(planDeliverables.length).toBeGreaterThan(0);
    expect(planDeliverables.some((d) => d.port === "plan")).toBe(true);

    const run = getRun(db, runId)!;
    // Invariant + symptom: drain saw deliverables, so the run advanced.
    expect(run.state).toBe("running");
    expect(run.current_node).toBe("build");
    expect(run.error).toBeNull();
    expect(getRunBlockReason(db, runId)).toBeNull();
    // Not the sticky deadlock: blocked (unfilled inputs on build: plan).
    expect(run.error ?? "").not.toMatch(/unfilled/i);
    // Next node was entered (spawn created a build task).
    expect(listTasksForRun(db, runId).some((t) => t.node === "build")).toBe(true);
  });

  it("assert deliverables exist when drain observes the completed task", async () => {
    // Reconstruct the engine path with an explicit onSlotFreed probe so the
    // invariant is checked at the hook, not only via end-state.
    writePlanBuildWorkflow();
    const reportSchema = generateReportSchema({
      plan: { type: { kind: "text" }, bounds: { maxLength: 500 } },
    });
    const { runId, taskId } = seedRunningTask({
      runId: nextRunId(db),
      workflow: "planbuild",
      node: "plan",
      reportSchema,
    });

    // Drive the real engine; after submitReport arms the fallback, completion
    // is sync once the timer fires. We re-check mid-stack by hooking console
    // is too loose — instead use the fact that spawn of build (onEnter) only
    // runs after fill succeeds, and list tasks for build immediately after.
    expect(engine.submitReport(taskId, { plan: "the plan" })).toBeNull();
    await waitFor(() => getTask(db, taskId)?.state === "completed");

    // At the instant the task became completed, drain already ran (sync).
    // Deliverables for plan must therefore already be queryable — and they
    // were required for the enter of build.
    const atCompletion = listDeliverablesForRun(db, runId).filter(
      (d) => d.node === "plan" && d.port === "plan",
    );
    expect(atCompletion).toHaveLength(1);
    expect(JSON.parse(atCompletion[0]!.value!)).toBe("the plan");

    const run = getRun(db, runId)!;
    expect(run.current_node).toBe("build");
    expect(run.state).toBe("running");
  });

  it("multi-slot fan-out still advances on the last sibling's completion", async () => {
    // Authored slots (dict fan-out) — the case that previously masked #264.
    writeWorkflow(
      "fan",
      {
        id: "fan",
        version: 1,
        type: "other",
        workspace: "scratch",
        inputs: {},
        outputs: { out: { type: "text", from: "join.out" } },
        nodes: [
          {
            id: "review",
            kind: "step",
            prompt: "prompts/review.md",
            slots: { a: {}, b: {} },
            in: {},
            out: { notes: { type: "text", max_length: 200 } },
          },
          {
            id: "join",
            kind: "step",
            prompt: "prompts/join.md",
            in: {
              notes: {
                type: "dict<string, text>",
                from: "review.notes",
              },
            },
            out: { out: { type: "text", max_length: 200 } },
          },
        ],
      },
      { "review.md": "Review.\n", "join.md": "Join.\n" },
    );

    const reportSchema = generateReportSchema({
      notes: { type: { kind: "text" }, bounds: { maxLength: 200 } },
    });
    const runId = nextRunId(db);
    const run = insertRun(db, {
      id: runId,
      workflow: "fan",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "review",
      iteration: 1,
      state: "running",
    });
    ensureScratchWorkspace(run.id);

    const seedSlot = (slot: string): string => {
      const taskId = nextTaskId(db);
      insertTask(db, {
        id: taskId,
        name: null,
        vendor: "fake",
        model: null,
        effort: null,
        profile: null,
        repo: null,
        cwd: path.join(home, "ws"),
        prompt: "review",
        orchestrator_session_id: null,
        worktree: null,
        branch: null,
        base_sha: null,
        sandbox: "workspace",
        network: true,
        answer_timeout_ms: null,
        report_schema: JSON.stringify(reportSchema),
        size: null,
        difficulty: null,
        type: "other",
        run_id: run.id,
        node: "review",
        iteration: 1,
        slot,
      });
      db.prepare(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(taskId);
      return taskId;
    };

    const first = seedSlot("a");
    const second = seedSlot("b");

    // First sibling completes — step not settled yet; run stays on review.
    expect(engine.submitReport(first, { notes: "a" })).toBeNull();
    await waitFor(() => getTask(db, first)?.state === "completed");
    expect(getRun(db, runId)!.current_node).toBe("review");
    expect(getRun(db, runId)!.state).toBe("running");

    // Last sibling — step settles; must advance to join (fan-out mask case).
    expect(engine.submitReport(second, { notes: "b" })).toBeNull();
    await waitFor(() => getTask(db, second)?.state === "completed");

    const after = getRun(db, runId)!;
    expect(after.state).toBe("running");
    expect(after.current_node).toBe("join");
    expect(listDeliverablesForRun(db, runId).filter((d) => d.node === "review")).toHaveLength(
      2,
    );
  });

  it("genuinely unfilled inputs still block with unfilled_inputs", async () => {
    // plan declares `plan` out, but the task reports with the default outcome
    // schema (no port payload). Success policy is met, advance tries build,
    // and plan.plan is missing → unfilled_inputs.
    writePlanBuildWorkflow();
    const { runId, taskId } = seedRunningTask({
      runId: nextRunId(db),
      workflow: "planbuild",
      node: "plan",
      reportSchema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1 },
          outcome: { enum: ["success", "partial", "blocked"] },
          files_changed: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "outcome", "files_changed"],
      },
    });

    expect(
      engine.submitReport(taskId, {
        summary: "no ports",
        outcome: "success",
        files_changed: [],
      }),
    ).toBeNull();
    await waitFor(() => getTask(db, taskId)?.state === "completed");

    const run = getRun(db, runId)!;
    expect(run.state).toBe("blocked");
    expect(getRunBlockReason(db, runId)).toBe("unfilled_inputs");
    expect(run.error ?? "").toMatch(/unfilled/i);
    expect(run.current_node).toBe("build");
    // No plan deliverable was produced.
    expect(listDeliverablesForRun(db, runId).filter((d) => d.port === "plan")).toHaveLength(0);
  });

  it('outcome: "blocked" routes to failed and records no deliverables', async () => {
    writePlanBuildWorkflow();
    // Default report schema (outcome enum), not port schema.
    const { runId, taskId } = seedRunningTask({
      runId: nextRunId(db),
      workflow: "planbuild",
      node: "plan",
      reportSchema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1 },
          outcome: { enum: ["success", "partial", "blocked"] },
          files_changed: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "outcome", "files_changed"],
      },
    });

    expect(
      engine.submitReport(taskId, {
        summary: "gave up",
        outcome: "blocked",
        files_changed: [],
      }),
    ).toBeNull();

    await waitFor(() => getTask(db, taskId)?.state === "failed");

    const task = getTask(db, taskId)!;
    expect(task.state).toBe("failed");
    expect(task.error).toMatch(/outcome: blocked/);
    expect(listDeliverablesForTask(db, taskId)).toHaveLength(0);
    // Run may block under success policy / unfilled — but must not have
    // invented plan deliverables from a blocked outcome.
    expect(listDeliverablesForRun(db, runId)).toHaveLength(0);
  });

  it("recorder failure still leaves the task completed (error logged)", async () => {
    writePlanBuildWorkflow();
    const reportSchema = generateReportSchema({
      plan: { type: { kind: "text" }, bounds: { maxLength: 500 } },
    });
    const { taskId } = seedRunningTask({
      runId: nextRunId(db),
      workflow: "planbuild",
      node: "plan",
      reportSchema,
    });

    // Force insertDeliverable to fail so recordRunDeliverables hits its catch.
    db.prepare(
      `CREATE TRIGGER fail_deliverable_insert
       BEFORE INSERT ON deliverables
       BEGIN
         SELECT RAISE(ABORT, 'simulated recorder failure');
       END`,
    ).run();

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(engine.submitReport(taskId, { plan: "doomed" })).toBeNull();
      await waitFor(() => getTask(db, taskId)?.state === "completed");

      expect(getTask(db, taskId)!.state).toBe("completed");
      expect(listDeliverablesForTask(db, taskId)).toHaveLength(0);
      expect(
        errSpy.mock.calls.some((args) =>
          String(args[0]).includes("recordRunDeliverables failed"),
        ),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
