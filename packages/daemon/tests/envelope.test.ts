/**
 * #208 — storage row → public TaskEnvelope mapping at the daemon seam.
 */
import { describe, expect, it } from "vitest";
import type { TaskEnvelope } from "@useparley/core";
import type { TaskRow } from "../src/db.js";
import { buildEnvelope } from "../src/report.js";

function storageRow(partial: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    name: "chart",
    vendor: "fake",
    model: "fake-model",
    effort: "medium",
    profile: null,
    runner: null,
    repo: "/tmp/repo",
    repo_key: null,
    repo_fetch_url: null,
    state: "running",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:05.000Z",
    cwd: "/tmp/repo",
    prompt: "do the work",
    session_id: "vendor-sess",
    orchestrator_session_id: "orch-sess",
    usage: JSON.stringify({ input_tokens: 10, output_tokens: 4 }),
    report: null,
    error: null,
    started_at: "2026-01-01T00:00:01.000Z",
    completed_at: null,
    question_id: null,
    question: null,
    worktree: "/tmp/wt",
    branch: "parley/t1-chart",
    base_sha: "abc",
    sandbox: "workspace",
    network: 1,
    answer_timeout_ms: null,
    report_schema: null,
    seq: 3,
    eval_score: null,
    eval_feedback: null,
    eval_answers: null,
    eval_rubric: null,
    eval_rubric_version: null,
    eval_baseline: null,
    type: "coding",
    size: "M",
    difficulty: "easy",
    parent_task_id: null,
    attempt: 1,
    resumed: 0,
    cached_input_tokens: null,
    launch_command: null,
    model_source: "resolved",
    effort_source: "resolved",
    orch_harness: "claude",
    orch_model: "sonnet",
    orch_effort: "high",
    eval_session_id: null,
    eval_harness: null,
    eval_model: null,
    eval_effort: null,
    queued_at: null,
    run_id: null,
    node: null,
    iteration: null,
    slot: null,
    queue_reason: null,
    routing_deadline_at: null,
    ...partial,
  };
}

describe("buildEnvelope (#208)", () => {
  it("maps session, recency, orch, and decoded presentation fields", () => {
    const env: TaskEnvelope = buildEnvelope(storageRow({ id: "t1" }), "/tmp/logs/t1", {
      position: null,
      blockingCap: null,
    });

    expect(env.task_id).toBe("t1");
    expect(env.orchestrator_session_id).toBe("orch-sess");
    expect(env.updated_at).toBe("2026-01-01T00:00:05.000Z");
    expect(env.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(env.started_at).toBe("2026-01-01T00:00:01.000Z");
    expect(env.completed_at).toBeNull();
    expect(env.orch_harness).toBe("claude");
    expect(env.orch_model).toBe("sonnet");
    expect(env.orch_effort).toBe("high");
    expect(env.posture).toEqual({ sandbox: "workspace", network: true });
    expect(env.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
    expect(env.resumed).toBe(false);
    expect(env.logs_dir).toBe("/tmp/logs/t1");
    expect(env.seq).toBe(3);
    // Storage encodings must never leak onto the wire envelope.
    expect(env).not.toHaveProperty("network");
    expect(env).not.toHaveProperty("id");
    expect(typeof env.usage).toBe("object");
  });

  it("decodes report and computes duration when completed", () => {
    const report = {
      summary: "done",
      outcome: "success" as const,
      files_changed: ["a.ts"],
    };
    const env = buildEnvelope(
      storageRow({
        id: "t2",
        state: "completed",
        report: JSON.stringify(report),
        completed_at: "2026-01-01T00:00:11.000Z",
        started_at: "2026-01-01T00:00:01.000Z",
        network: 0,
        resumed: 1,
      }),
    );
    expect(env.report).toEqual(report);
    expect(env.duration_ms).toBe(10_000);
    expect(env.posture.network).toBe(false);
    expect(env.resumed).toBe(true);
  });

  it("carries queue enrichment while queued", () => {
    const env = buildEnvelope(storageRow({ id: "t3", state: "queued" }), null, {
      position: 2,
      blockingCap: "vendor:fake",
    });
    expect(env.queue_position).toBe(2);
    expect(env.blocking_cap).toBe("vendor:fake");
  });
});
