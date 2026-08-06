/**
 * Shared fixtures for console data-layer tests.
 */
import type { EventSourceLike, TaskEnvelope } from "@useparley/core";

/** Controllable EventSource stand-in for hook unit tests. */
export class FakeEventSource implements EventSourceLike {
  static current: FakeEventSource | undefined;
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();

  constructor(_url: string) {
    FakeEventSource.current = this;
  }

  addEventListener(
    type: string,
    listener: ((e: { data: string; lastEventId: string }) => void) | ((event: unknown) => void),
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (e: unknown) => void);
    this.listeners.set(type, list);
  }

  close(): void {
    /* no transport */
  }

  emit(eventName: string, seq: number, task: TaskEnvelope): void {
    for (const cb of this.listeners.get(eventName) ?? []) {
      cb({ data: JSON.stringify(task), lastEventId: String(seq) });
    }
  }

  emitError(event: unknown = {}): void {
    for (const cb of this.listeners.get("error") ?? []) {
      cb(event);
    }
  }
}

/** Minimal-but-complete TaskEnvelope; pass only the overrides a test cares about. */
export function envelope(
  overrides: Partial<TaskEnvelope> & Pick<TaskEnvelope, "task_id" | "state">,
): TaskEnvelope {
  return {
    name: overrides.task_id,
    repo: null,
    worktree: null,
    branch: "feat/x",
    vendor: "fake",
    model: "fake-model",
    effort: null,
    profile: null,
    posture: { sandbox: "workspace", network: false },
    session_id: null,
    orchestrator_session_id: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    orch_harness: null,
    orch_model: null,
    orch_effort: null,
    usage: null,
    duration_ms: null,
    report: null,
    report_schema: {},
    error: null,
    logs_dir: null,
    question_id: null,
    question: null,
    seq: 0,
    eval_expected: false,
    size: null,
    difficulty: null,
    type: "other",
    parent_task_id: null,
    attempt: 1,
    resumed: false,
    cached_input_tokens: null,
    ...overrides,
  };
}

// Screen tickets: additive-only-at-end. Prefer tests/<screen>/fixtures.ts (see screens/SCREENS.md).
