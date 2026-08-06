/**
 * Task-inspector fixtures (screen-local).
 */
import type {
  AttemptLineageEntry,
  EvalDetail,
  QaTurn,
  Report,
  TaskDetailResponse,
  TaskEnvelope,
} from "@useparley/core";
import { envelope } from "../fixtures.js";

export function taskEnvelope(
  overrides: Partial<TaskEnvelope> & Pick<TaskEnvelope, "task_id" | "state">,
): TaskEnvelope {
  return envelope({
    name: "inspect-me",
    branch: "parley/t-inspect",
    worktree: "/tmp/worktrees/inspect",
    vendor: "fake",
    model: "fake-model",
    effort: "medium",
    started_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 12_000,
    usage: { input_tokens: 1200, output_tokens: 400, cached_tokens: 100 },
    ...overrides,
  });
}

export function detailResponse(
  overrides: Partial<TaskDetailResponse> & { task: TaskEnvelope },
): TaskDetailResponse {
  return {
    qa: [],
    attempts: [
      {
        id: overrides.task.task_id,
        name: overrides.task.name,
        attempt: 1,
        parent_task_id: null,
        state: overrides.task.state,
        resumed: false,
        cached_input_tokens: null,
        cache_hit: null,
        eval_score: null,
        eval_baseline: null,
        eval_rubric: null,
        eval_rubric_version: null,
        eval_legacy: false,
      },
    ],
    session: {
      session_id: "orch-1",
      harness: "codex",
      model: "gpt-test",
      effort: "medium",
    },
    eval_detail: null,
    row: {
      id: overrides.task.task_id,
      name: overrides.task.name,
      vendor: overrides.task.vendor,
      model: overrides.task.model,
      effort: overrides.task.effort,
      profile: null,
      repo: null,
      state: overrides.task.state,
      created_at: overrides.task.created_at,
      updated_at: overrides.task.updated_at,
      cwd: null,
      prompt: "Fix the inspector layout for long briefs and churn columns.",
      session_id: null,
      orchestrator_session_id: "orch-1",
      usage: null,
      report: null,
      error: overrides.task.error,
      started_at: overrides.task.started_at,
      completed_at: overrides.task.completed_at,
      question_id: overrides.task.question_id,
      question: overrides.task.question,
      worktree: overrides.task.worktree,
      branch: overrides.task.branch,
      base_sha: null,
      sandbox: "workspace",
      network: 0,
      answer_timeout_ms: null,
      report_schema: null,
      seq: 0,
      eval_score: null,
      eval_feedback: null,
      type: "other",
      size: null,
      difficulty: null,
    },
    ...overrides,
  };
}

export function churnReport(): Report {
  return {
    summary: "Added churn-bearing report for the inspector column.",
    outcome: "success",
    files_changed: [
      { path: "packages/dashboard/src/screens/task/TaskScreen.tsx", added: 120, removed: 14 },
      { path: "packages/dashboard/src/screens/task/task.css", added: 80, removed: 0 },
      // Path-only entry — honest absence of counts (not 0/0).
      "packages/dashboard/docs/design/very/long/path/that/should/truncate/gracefully/with/ellipsis/and/title/tooltip.ts",
      { path: "README.md" },
    ],
  };
}

export function pathOnlyReport(): Report {
  return {
    summary: "Legacy report — paths only, predates churn.",
    outcome: "success",
    files_changed: ["src/a.ts", "src/b.ts"],
  };
}

export function failedTask(): TaskEnvelope {
  return taskEnvelope({
    task_id: "t-fail-1",
    state: "failed",
    error: "AssertionError: expected layout not to horizontal-scroll at 1280",
    completed_at: "2026-01-01T00:05:00.000Z",
  });
}

export function awaitingTask(): TaskEnvelope {
  return taskEnvelope({
    task_id: "t-ask-1",
    state: "awaiting_answer",
    question_id: "q-1",
    question: "Should the scaffold show status or daemon origin?",
  });
}

export function qaOutstanding(): QaTurn[] {
  return [
    {
      question_id: "q-0",
      question: "May I touch packages/core?",
      answer: "Keep the change inside packages/dashboard.",
      asked_at: "2026-01-01T00:01:00.000Z",
      answered_at: "2026-01-01T00:01:30.000Z",
    },
    {
      question_id: "q-1",
      question: "Should the scaffold show status or daemon origin?",
      answer: null,
      asked_at: "2026-01-01T00:04:00.000Z",
      answered_at: null,
    },
  ];
}

export function attemptChain(currentId: string): AttemptLineageEntry[] {
  return [
    {
      id: "t-root",
      name: "inspect-me",
      attempt: 1,
      parent_task_id: null,
      state: "failed",
      resumed: false,
      cached_input_tokens: 0,
      cache_hit: false,
      eval_score: 4,
      eval_baseline: 5.2,
      eval_rubric: "coding",
      eval_rubric_version: 1,
      eval_legacy: false,
    },
    {
      id: currentId,
      name: "inspect-me",
      attempt: 2,
      parent_task_id: "t-root",
      state: "running",
      resumed: true,
      cached_input_tokens: 800,
      cache_hit: true,
      eval_score: null,
      eval_baseline: null,
      eval_rubric: null,
      eval_rubric_version: null,
      eval_legacy: false,
    },
  ];
}

export function evalDetail(): EvalDetail {
  return {
    score: 7.5,
    baseline: 5.2,
    delta: 2.3,
    below_baseline: false,
    legacy: false,
    rubric: "coding",
    rubric_version: 1,
    feedback: "Solid coverage of honesty states; watch truncation on long paths.",
    judge: {
      session_id: "j-1",
      harness: "codex",
      model: "judge-model",
      effort: "low",
    },
    criteria: [
      {
        id: "honesty",
        kind: "positive",
        weight: 2,
        text: "Honesty states are first-class",
        answer: true,
        pass: true,
      },
      {
        id: "scroll",
        kind: "negative",
        weight: 1,
        text: "Board-level horizontal scroll",
        answer: false,
        pass: true,
      },
    ],
  };
}
