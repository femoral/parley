/**
 * #158 — pure retry helpers: chain budget counting, window age, composed body.
 */
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/db.js";
import {
  CODE_REATTEMPT_WINDOW_EXPIRED,
  CODE_RETRY_LIMIT_EXCEEDED,
  collectAttemptChain,
  composeFreshFixBody,
  countResumedAttempts,
  parentTerminalAgeMs,
  reattemptWindowMessage,
  reportGist,
  retryLimitMessage,
} from "../src/retry.js";

function row(partial: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    name: null,
    vendor: "fake",
    model: null,
    effort: null,
    profile: null,
    runner: null,
    repo: null,
    repo_key: null,
    repo_fetch_url: null,
    state: "completed",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
    prompt: "brief",
    session_id: null,
    orchestrator_session_id: "s",
    usage: null,
    report: null,
    error: null,
    started_at: null,
    completed_at: "2026-01-01T00:00:00.000Z",
    question_id: null,
    question: null,
    worktree: null,
    branch: null,
    base_sha: null,
    sandbox: "workspace",
    network: 1,
    answer_timeout_ms: null,
    report_schema: null,
    seq: 1,
    eval_score: null,
    eval_feedback: null,
    eval_answers: null,
    eval_rubric: null,
    eval_rubric_version: null,
    eval_baseline: null,
    type: "other",
    size: null,
    difficulty: null,
    parent_task_id: null,
    attempt: 1,
    resumed: 0,
    cached_input_tokens: null,
    launch_command: null,
    model_source: null,
    effort_source: null,
    orch_harness: null,
    orch_model: null,
    orch_effort: null,
    eval_session_id: null,
    eval_harness: null,
    eval_model: null,
    eval_effort: null,
    queued_at: null,
    run_id: null,
    node: null,
    iteration: null,
    slot: null,
    ...partial,
  };
}

describe("attempt chain helpers (#158)", () => {
  it("counts only resumed attempts in the chain", () => {
    const tasks = [
      row({ id: "t1", attempt: 1, resumed: 0, prompt: "orig" }),
      row({ id: "t2", attempt: 2, resumed: 1, parent_task_id: "t1", prompt: "fix1" }),
      row({ id: "t3", attempt: 3, resumed: 0, parent_task_id: "t2", prompt: "fresh" }),
      // Unrelated chain must not pollute the count.
      row({ id: "t9", attempt: 1, resumed: 1, prompt: "other" }),
    ];
    expect(countResumedAttempts(tasks, "t2")).toBe(1);
    expect(countResumedAttempts(tasks, "t3")).toBe(1);
    expect(countResumedAttempts(tasks, "t1")).toBe(1);
    expect(countResumedAttempts(tasks, "t9")).toBe(1);
  });

  it("collects the full descendant set of the chain root", () => {
    const tasks = [
      row({ id: "t1", attempt: 1 }),
      row({ id: "t2", attempt: 2, parent_task_id: "t1", resumed: 1 }),
      row({ id: "t3", attempt: 2, parent_task_id: "t1", resumed: 0 }),
    ];
    const chain = collectAttemptChain(tasks, "t2");
    expect(chain.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
    expect(countResumedAttempts(tasks, "t3")).toBe(1);
  });
});

describe("parentTerminalAgeMs", () => {
  it("uses completed_at when present", () => {
    const parent = row({
      id: "t1",
      completed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T01:00:00.000Z",
    });
    const now = Date.parse("2026-01-01T00:00:30.000Z");
    expect(parentTerminalAgeMs(parent, now)).toBe(30_000);
  });
});

describe("composeFreshFixBody", () => {
  it("renders original brief, per-attempt history, and fix request", () => {
    const chain = [
      row({
        id: "t1",
        attempt: 1,
        prompt: "do the thing",
        report: JSON.stringify({
          summary: "did the thing",
          outcome: "success",
          files_changed: [],
        }),
      }),
      row({
        id: "t2",
        attempt: 2,
        parent_task_id: "t1",
        resumed: 1,
        prompt: "fix the edge case",
        report: JSON.stringify({
          summary: "partial fix",
          outcome: "partial",
          files_changed: ["a.ts"],
        }),
      }),
    ];
    const body = composeFreshFixBody(chain, "start over cleanly");
    expect(body).toContain("## Original brief");
    expect(body).toContain("do the thing");
    expect(body).toContain("## Attempt history");
    expect(body).toContain("### Attempt 1 (t1)");
    expect(body).toContain("Brief: do the thing");
    expect(body).toContain("Report: did the thing (outcome: success)");
    expect(body).toContain("### Attempt 2 (t2)");
    expect(body).toContain("Brief: fix the edge case");
    expect(body).toContain("Report: partial fix (outcome: partial)");
    expect(body).toContain("## Fix request");
    expect(body).toContain("start over cleanly");
  });

  it("reportGist handles missing report", () => {
    expect(reportGist(null)).toBe("(no report)");
  });
});

describe("error messages", () => {
  it("point only at --fresh or a new delegate, never at raising limits", () => {
    const limit = retryLimitMessage(1, 1);
    expect(limit).toMatch(/retry limit exceeded/);
    expect(limit).toMatch(/parley fix --fresh/);
    expect(limit).toMatch(/new delegate/);
    // Mentions the configured value for diagnosis, but never coaches raising it.
    expect(limit).toContain("retry.max=1");
    expect(limit.toLowerCase()).not.toMatch(/raise|increase|edit.*config|set retry/);

    const window = reattemptWindowMessage(60_000, 30 * 60 * 1000);
    expect(window).toMatch(/reattempt window expired/);
    expect(window).toMatch(/parley fix --fresh/);
    expect(window).not.toMatch(/retry\.window|retryWindow/);
    expect(window.toLowerCase()).not.toMatch(/raise|increase/);
  });

  it("exports stable code constants", () => {
    expect(CODE_RETRY_LIMIT_EXCEEDED).toBe("retry_limit_exceeded");
    expect(CODE_REATTEMPT_WINDOW_EXPIRED).toBe("reattempt_window_expired");
  });
});
