import { describe, expect, it } from "vitest";
import type { AttemptLineageEntry, QaTurn, TaskDetailResponse } from "@useparley/core";
import {
  formatAttemptScore,
  projectAttemptLineage,
  projectInspector,
} from "../src/app/hooks/inspector.js";
import { toDisplayTask } from "../src/app/hooks/displayTask.js";
import { envelope, row } from "./fixtures.js";

function attemptEntry(
  overrides: Partial<AttemptLineageEntry> = {},
): AttemptLineageEntry {
  return {
    id: "t1",
    name: null,
    attempt: 1,
    parent_task_id: null,
    state: "running",
    resumed: false,
    cached_input_tokens: null,
    cache_hit: null,
    eval_score: null,
    eval_baseline: null,
    eval_rubric: null,
    eval_rubric_version: null,
    eval_legacy: false,
    ...overrides,
  };
}

function detail(
  overrides: Partial<TaskDetailResponse["task"]> = {},
  rowOverrides: Partial<TaskDetailResponse["row"]> = {},
  qa: QaTurn[] = [],
  attempts?: AttemptLineageEntry[],
): TaskDetailResponse {
  const r = row({ id: "t1", state: "running", orchestrator_session_id: "sess-1", ...rowOverrides });
  return {
    task: envelope({ task_id: "t1", state: "running", vendor: "grok", ...overrides }),
    row: r,
    qa,
    attempts:
      attempts ??
      [
        attemptEntry({
          id: r.id,
          name: r.name,
          attempt: r.attempt ?? 1,
          parent_task_id: r.parent_task_id ?? null,
          state: r.state,
          cached_input_tokens: r.cached_input_tokens ?? null,
          eval_score: r.eval_score,
          eval_baseline: r.eval_baseline ?? null,
          eval_rubric: r.eval_rubric ?? null,
          eval_rubric_version: r.eval_rubric_version ?? null,
          eval_legacy: r.eval_score !== null && (r.eval_rubric == null || r.eval_rubric === ""),
        }),
      ],
    session: {
      session_id: r.orchestrator_session_id,
      harness: r.orch_harness ?? null,
      model: r.orch_model ?? null,
      effort: r.orch_effort ?? null,
    },
    eval_detail: null,
  };
}

const NO_LOGS = { lines: [], status: "ended" as const };

describe("projectInspector projects a task's Brief tab (#68)", () => {
  it("carries branch/worktree/model/effort/posture straight from the envelope", () => {
    const view = projectInspector(
      detail({ branch: "feat/bay", worktree: "/tmp/wt", model: "grok-4", effort: "high", posture: { sandbox: "workspace", network: true } }),
      NO_LOGS,
    );
    expect(view.brief).toMatchObject({
      branch: "feat/bay",
      worktree: "/tmp/wt",
      model: "grok-4",
      effort: "high",
      sandbox: "workspace",
      network: true,
    });
  });

  it("uses the row's prompt as the goal", () => {
    const view = projectInspector(detail({}, { prompt: "Chart the northern bay." }), NO_LOGS);
    expect(view.brief.goal).toBe("Chart the northern bay.");
  });

  it("formats duration and usage together", () => {
    const view = projectInspector(
      detail({ duration_ms: 221_000, usage: { input_tokens: 1200, output_tokens: 340 } }),
      NO_LOGS,
    );
    expect(view.brief.duration).toBe("3m 41s");
    expect(view.brief.usage).toBe("1.2k ▸ 340 tok");
  });

  it("carries the vendor emblem and orchestrator harness colour independently", () => {
    const view = projectInspector(detail({ vendor: "opencode", model: "grok-4.5" }, { orch_harness: "codex" }), NO_LOGS);
    const identity = toDisplayTask({
      id: "t1",
      model: "grok-4.5",
      vendor: "opencode",
      branch: null,
    });
    expect(view).toMatchObject({
      coat: identity.coat,
      emblem: identity.emblem,
      faction: identity.faction,
    });
  });

  it("projects the task error field (failure cause) through to the inspector view", () => {
    const view = projectInspector(
      detail({ state: "failed", error: "vendor exited 1: sandbox denied network" }),
      NO_LOGS,
    );
    expect(view.error).toBe("vendor exited 1: sandbox denied network");
    expect(view.state).toBe("failed");
  });

  it("carries a null error when the task has no failure cause", () => {
    const view = projectInspector(detail({ error: null }), NO_LOGS);
    expect(view.error).toBeNull();
  });

  it("carries the eval score/feedback from the row when present", () => {
    const view = projectInspector(detail({}, { eval_score: 8, eval_feedback: "Solid work." }), NO_LOGS);
    expect(view.evalScore).toBe(8);
    expect(view.evalFeedback).toBe("Solid work.");
  });

  it("leaves eval score null when the task hasn't been eval'd", () => {
    const view = projectInspector(detail(), NO_LOGS);
    expect(view.evalScore).toBeNull();
  });
});

describe("projectInspector projects the Report tab (#68)", () => {
  it("is null when the task carries no report", () => {
    const view = projectInspector(detail({ report: null }), NO_LOGS);
    expect(view.report).toBeNull();
  });

  it("maps outcome, summary, and files_changed when a report is present", () => {
    const view = projectInspector(
      detail({
        report: { outcome: "success", summary: "Charted the bay.", files_changed: ["src/a.ts", "src/b.ts"] },
      }),
      NO_LOGS,
    );
    expect(view.report).toEqual({
      outcome: "success",
      summary: "Charted the bay.",
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    });
  });
});

describe("projectInspector projects the Q&A tab from the server detail response (#79)", () => {
  it("is empty when the detail carries no history", () => {
    const view = projectInspector(detail({ question: null }, {}, []), NO_LOGS);
    expect(view.qa).toEqual([]);
  });

  it("maps server turns into the hud floor shape (id + question + answer + timestamps)", () => {
    const view = projectInspector(
      detail({}, {}, [
        {
          question: "Which shoal?",
          answer: "The northern one.",
          question_id: "q1",
          asked_at: "2026-01-01T00:00:00.000Z",
          answered_at: "2026-01-01T00:01:00.000Z",
        },
        {
          question: "Deep or shallow anchorage?",
          answer: null,
          question_id: "q2",
          asked_at: "2026-01-01T00:02:00.000Z",
          answered_at: null,
        },
      ]),
      NO_LOGS,
    );
    // question_id → id (stable React key); asked_at / answered_at ride through for the tab clocks.
    expect(view.qa).toEqual([
      {
        id: "q1",
        question: "Which shoal?",
        answer: "The northern one.",
        askedAt: "2026-01-01T00:00:00.000Z",
        answeredAt: "2026-01-01T00:01:00.000Z",
      },
      {
        id: "q2",
        question: "Deep or shallow anchorage?",
        answer: null,
        askedAt: "2026-01-01T00:02:00.000Z",
        answeredAt: null,
      },
    ]);
  });

  it("does not invent turns from the outstanding envelope question alone", () => {
    // Pre-#79 clients appended task.question client-side; the server history is
    // now authoritative — an empty `qa` means "no parley yet", even if the
    // envelope still carries a (stale/unrelated) question field.
    const view = projectInspector(
      detail({ question: "Which shoal?", question_id: "q1" }, {}, []),
      NO_LOGS,
    );
    expect(view.qa).toEqual([]);
  });

  it("preserves ask order from the server array as-is", () => {
    const view = projectInspector(
      detail({}, {}, [
        {
          question: "first?",
          answer: "one",
          question_id: "q1",
          asked_at: "2026-01-01T00:00:00.000Z",
          answered_at: "2026-01-01T00:00:01.000Z",
        },
        {
          question: "second?",
          answer: "two",
          question_id: "q2",
          asked_at: "2026-01-01T00:00:02.000Z",
          answered_at: "2026-01-01T00:00:03.000Z",
        },
      ]),
      NO_LOGS,
    );
    expect(view.qa.map((t) => t.question)).toEqual(["first?", "second?"]);
  });
});

describe("projectInspector passes the log view through untouched (#68)", () => {
  it("carries whatever useLogTail produced", () => {
    const logs = { lines: [{ key: 0, kind: "stdout" as const, text: "hello" }], status: "tailing" as const };
    const view = projectInspector(detail(), logs);
    expect(view.logs).toBe(logs);
  });
});

describe("projectAttemptLineage / formatAttemptScore (#166)", () => {
  it("formats structured score as score/baseline and legacy with a tag", () => {
    expect(
      formatAttemptScore(
        attemptEntry({ eval_score: 9, eval_baseline: 5, eval_legacy: false }),
      ),
    ).toBe("9/5");
    expect(
      formatAttemptScore(attemptEntry({ eval_score: 8, eval_baseline: null, eval_legacy: true })),
    ).toBe("8 · legacy");
    expect(formatAttemptScore(attemptEntry({ eval_score: null }))).toBeNull();
  });

  it("projects resumed/cache badges and marks the current task", () => {
    const chain = projectAttemptLineage(
      [
        attemptEntry({
          id: "root",
          attempt: 1,
          state: "completed",
          resumed: false,
          cache_hit: null,
          eval_score: 4,
          eval_baseline: 5,
        }),
        attemptEntry({
          id: "fix1",
          attempt: 2,
          parent_task_id: "root",
          state: "completed",
          resumed: true,
          cache_hit: true,
          cached_input_tokens: 100,
          eval_score: 9,
          eval_baseline: 5,
        }),
      ],
      "fix1",
    );
    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatchObject({
      id: "root",
      attempt: 1,
      resumed: false,
      cacheBadge: null,
      score: "4/5",
      current: false,
      stateLabel: "COMPLETED",
    });
    expect(chain[1]).toMatchObject({
      id: "fix1",
      attempt: 2,
      resumed: true,
      cacheBadge: "cache",
      score: "9/5",
      current: true,
    });
  });

  it("maps cache_hit false to no-cache badge", () => {
    const [item] = projectAttemptLineage(
      [attemptEntry({ id: "t1", cache_hit: false, cached_input_tokens: 0 })],
      "t1",
    );
    expect(item!.cacheBadge).toBe("no-cache");
  });

  it("projectInspector attaches the full attempt chain", () => {
    const view = projectInspector(
      detail(
        { task_id: "fix1", state: "completed" },
        { id: "fix1", state: "completed", eval_score: 9, eval_baseline: 5 },
        [],
        [
          attemptEntry({
            id: "root",
            attempt: 1,
            state: "completed",
            eval_score: 4,
            eval_baseline: 5,
          }),
          attemptEntry({
            id: "fix1",
            attempt: 2,
            parent_task_id: "root",
            state: "completed",
            resumed: true,
            cache_hit: true,
            eval_score: 9,
            eval_baseline: 5,
          }),
        ],
      ),
      NO_LOGS,
    );
    expect(view.attempts.map((a) => a.id)).toEqual(["root", "fix1"]);
    expect(view.attempts[1]!.resumed).toBe(true);
    expect(view.attempts[1]!.cacheBadge).toBe("cache");
    expect(view.attempts[1]!.score).toBe("9/5");
    expect(view.attempts[1]!.current).toBe(true);
  });
});
