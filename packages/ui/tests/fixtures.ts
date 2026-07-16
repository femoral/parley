/**
 * Shared test fixtures for hook-level tests that stand in for the daemon's
 * SSE stream and wire shapes (`use-snapshot-sse.test.ts`, `inbox-answer-
 * roundtrip.test.ts`) — kept in one place so the two suites' fixtures can't
 * silently drift apart as `TaskEnvelope`/`TaskRow` evolve. Each test file
 * still owns its own `fakeDaemon` fetch stand-in, since the endpoints it
 * serves differ per test.
 */
import type { EventSourceLike, TaskEnvelope, TaskRow } from "@useparley/core";

/**
 * A controllable `EventSource` stand-in (mirrors the shim in
 * `packages/cli/tests/events.test.ts`, minus the real transport): tests grab
 * the live instance and call `emit` directly to simulate a transition
 * arriving over the wire, without a real daemon/fake-vendor process.
 */
export class FakeEventSource implements EventSourceLike {
  static current: FakeEventSource | undefined;
  // Message listeners get `{ data, lastEventId }`; error listeners get `unknown`.
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
    /* no transport to tear down */
  }

  emit(eventName: string, seq: number, task: TaskEnvelope): void {
    for (const cb of this.listeners.get(eventName) ?? []) {
      cb({ data: JSON.stringify(task), lastEventId: String(seq) });
    }
  }

  /** Fire the stream `error` listener (daemon drop / transport fault). */
  emitError(event: unknown = {}): void {
    for (const cb of this.listeners.get("error") ?? []) {
      cb(event);
    }
  }
}

/** A minimal-but-complete `TaskEnvelope` fixture; pass only the overrides a test cares about. */
export function envelope(
  overrides: Partial<TaskEnvelope> & Pick<TaskEnvelope, "task_id" | "state">,
): TaskEnvelope {
  return {
    name: overrides.task_id,
    repo: null,
    worktree: null,
    branch: "feat/x",
    vendor: "codex",
    model: null,
    effort: null,
    posture: { sandbox: "workspace", network: false },
    session_id: null,
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
    ...overrides,
  };
}

/** A minimal-but-complete `TaskRow` fixture; pass only the overrides a test cares about. */
export function row(
  overrides: Partial<TaskRow> & Pick<TaskRow, "id" | "state" | "orchestrator_session_id">,
): TaskRow {
  return {
    name: overrides.id,
    vendor: "codex",
    model: null,
    effort: null,
    repo: null,
    created_at: "",
    updated_at: "",
    cwd: null,
    prompt: null,
    session_id: null,
    usage: null,
    report: null,
    error: null,
    started_at: null,
    completed_at: null,
    question_id: null,
    question: null,
    worktree: null,
    branch: "feat/x",
    base_sha: null,
    sandbox: "workspace",
    network: 0,
    answer_timeout_ms: null,
    report_schema: null,
    seq: 1,
    eval_score: null,
    eval_feedback: null,
    ...overrides,
  };
}
