import { describe, expect, it } from "vitest";
import type { QaTurn, TaskDetailResponse } from "@useparley/core";
import { projectInspector } from "../src/app/hooks/inspector.js";
import { envelope, row } from "./fixtures.js";

function detail(
  overrides: Partial<TaskDetailResponse["task"]> = {},
  rowOverrides: Partial<TaskDetailResponse["row"]> = {},
  qa: QaTurn[] = [],
): TaskDetailResponse {
  return {
    task: envelope({ task_id: "t1", state: "running", vendor: "grok", ...overrides }),
    row: row({ id: "t1", state: "running", orchestrator_session_id: "sess-1", ...rowOverrides }),
    qa,
  };
}

const NO_LOGS = { lines: [], live: false };

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

  it("carries the faction coat/emblem from the vendor", () => {
    const view = projectInspector(detail({ vendor: "grok" }), NO_LOGS);
    expect(view.coat).toBe("#2b2b2e");
    expect(view.emblem.kind).toBe("svg");
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

  it("maps server turns into the hud floor shape (question + answer)", () => {
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
    // Wire extras (ids/timestamps) are dropped — hud stays free of contract types.
    expect(view.qa).toEqual([
      { question: "Which shoal?", answer: "The northern one." },
      { question: "Deep or shallow anchorage?", answer: null },
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
    const logs = { lines: [{ key: 0, kind: "stdout" as const, text: "hello" }], live: true };
    const view = projectInspector(detail(), logs);
    expect(view.logs).toBe(logs);
  });
});
