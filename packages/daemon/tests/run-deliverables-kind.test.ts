/**
 * #238 fix — recordRunDeliverables uses real PortTypes from the workflow
 * definition so file/dir outs become kind `file`/`dir` path references, not
 * inline JSON of the path string (ADR-0016 / #233).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  getTask,
  insertRun,
  insertTask,
  listDeliverablesForTask,
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

function writeWorkflow(id: string, body: unknown): string {
  // Global layer: {home}/workflows/<id>/
  const dir = path.join(home, "workflows", id);
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(body, null, 2));
  fs.writeFileSync(path.join(dir, "prompts", "ship.md"), "Ship the artifact.\n");
  return dir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-deliv-kind-"));
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(withFakeAllowlist({})),
  );
  process.env.PARLEY_HOME = home;
  // Complete accepted reports quickly without waiting for vendor exit.
  process.env.PARLEY_REPORT_ACCEPTED_FALLBACK_MS = "30";
  db = openDatabase(homePaths(home));
  engine = new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.PARLEY_HOME;
  delete process.env.PARLEY_REPORT_ACCEPTED_FALLBACK_MS;
});

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

describe("recordRunDeliverables — kind fidelity (#238)", () => {
  it("records a declared file output as kind file (path reference), not inline", async () => {
    writeWorkflow("filey", {
      id: "filey",
      version: 1,
      type: "other",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { artifact: { type: "file", from: "ship.artifact" } },
      nodes: [
        {
          id: "ship",
          kind: "step",
          prompt: "prompts/ship.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: {
            artifact: { type: "file" },
            notes: { type: "text", max_length: 200 },
          },
        },
      ],
    });

    const run = insertRun(db, {
      id: nextRunId(db),
      workflow: "filey",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "ship",
      iteration: 1,
      state: "running",
    });

    const reportSchema = generateReportSchema({
      artifact: { type: { kind: "file" } },
      notes: { type: { kind: "text" }, bounds: { maxLength: 200 } },
    });

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
      prompt: "ship it",
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
      node: "ship",
      iteration: 1,
      slot: null,
    });
    // Task must be non-settled for submitReport to accept.
    db.prepare(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(taskId);

    const pathValue = "out/result.bin";
    const errors = engine.submitReport(taskId, {
      artifact: pathValue,
      notes: "done",
    });
    expect(errors).toBeNull();

    await waitFor(() => {
      const t = getTask(db, taskId);
      return t !== undefined && t.state === "completed";
    });

    const rows = listDeliverablesForTask(db, taskId);
    expect(rows).toHaveLength(2);

    const artifact = rows.find((r) => r.port === "artifact");
    expect(artifact).toBeDefined();
    expect(artifact!.kind).toBe("file");
    // Path reference stored as the string itself — not JSON-quoted.
    expect(artifact!.value).toBe(pathValue);
    expect(artifact!.value).not.toBe(JSON.stringify(pathValue));

    const notes = rows.find((r) => r.port === "notes");
    expect(notes).toBeDefined();
    expect(notes!.kind).toBe("inline");
    expect(JSON.parse(notes!.value!)).toBe("done");
  });

  it("records a declared dir output as kind dir", async () => {
    writeWorkflow("diry", {
      id: "diry",
      version: 1,
      type: "other",
      workspace: "scratch",
      inputs: {},
      outputs: { bundle: { type: "dir", from: "pack.bundle" } },
      nodes: [
        {
          id: "pack",
          kind: "step",
          prompt: "prompts/ship.md",
          in: {},
          out: { bundle: { type: "dir" } },
        },
      ],
    });
    // Reuse ship.md from writeWorkflow — writeWorkflow creates prompts/ship.md
    // under diry via the same helper when we call it; pack uses that path.
    fs.writeFileSync(
      path.join(home, "workflows", "diry", "prompts", "ship.md"),
      "Pack.\n",
    );

    const run = insertRun(db, {
      id: nextRunId(db),
      workflow: "diry",
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "pack",
      iteration: 1,
      state: "running",
    });

    const reportSchema = generateReportSchema({
      bundle: { type: { kind: "dir" } },
    });
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
      prompt: "pack",
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
      node: "pack",
      iteration: 1,
      slot: null,
    });
    db.prepare(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(taskId);

    expect(
      engine.submitReport(taskId, { bundle: "artifacts/out" }),
    ).toBeNull();

    await waitFor(() => getTask(db, taskId)?.state === "completed");

    const rows = listDeliverablesForTask(db, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("dir");
    expect(rows[0]!.value).toBe("artifacts/out");
  });
});
