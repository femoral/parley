/**
 * The daemon's wire contract (docs/spec/ui-interface-contract.md): the shapes
 * the HTTP + SSE API exchanges. These are the versioned public surface — a
 * breaking change bumps `@useparley/core` major. The daemon produces values
 * assignable to these types (a compile-time guard in the daemon enforces it);
 * UIs consume them through the typed client and SSE helper.
 */
/** A JSON Schema — an object of keywords, or a boolean schema. */
export type JsonSchema = Record<string, unknown> | boolean;

/** The outcome enum of a report accepted against parley's default schema. */
export type ReportOutcome = "success" | "partial" | "blocked";

/** The body of a report accepted against parley's default schema (spec §4). */
export interface Report {
  summary: string;
  outcome: ReportOutcome;
  files_changed: string[];
}

/** The child's sandbox posture (spec §8): what it may touch and whether it has network. */
export interface Posture {
  /** Normalized sandbox mode (`read-only` | `workspace` | `full`). */
  sandbox: string;
  /** Whether the child may reach the network. */
  network: boolean;
}

/**
 * The report envelope the daemon wraps around a task (spec §4) — the primary
 * task shape a UI renders. On a transition stream its `state`/`seq` are pinned
 * to the transition, even if the underlying row has since moved on.
 */
export interface TaskEnvelope {
  task_id: string;
  name: string | null;
  repo: string | null;
  /** The parley worktree path; null when `--cwd` bypassed worktree creation. */
  worktree: string | null;
  /** The branch parley created; the child's commits live here (parley never merges). */
  branch: string | null;
  vendor: string | null;
  model: string | null;
  /** Opaque reasoning-effort string (spec §9). */
  effort: string | null;
  posture: Posture;
  session_id: string | null;
  usage: Record<string, number> | null;
  duration_ms: number | null;
  state: string;
  report: Report | null;
  /** The report schema actually applied (parley's default when omitted). */
  report_schema: JsonSchema;
  error: string | null;
  /** Directory holding the task's captured vendor output — the diagnostics reference. */
  logs_dir: string | null;
  /** The outstanding question id while `awaiting_answer` (else null). */
  question_id: string | null;
  /** The outstanding question text while `awaiting_answer` (else null). */
  question: string | null;
  /** Global transition seq as of this response (#34); 0 before the first transition. */
  seq: number;
  /** Whether the task's repo declares delegations into it are eval'd (#45). */
  eval_expected: boolean;
}

/**
 * A task row as surfaced by `GET /tasks` and the `row` of `GET /tasks/:ref`.
 * The envelope is the richer view; the row exposes the raw persisted columns a
 * UI's inspector may want (timestamps, prompt, orchestrator session, eval).
 */
export interface TaskRow {
  id: string;
  name: string | null;
  vendor: string | null;
  model: string | null;
  effort: string | null;
  repo: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  cwd: string | null;
  prompt: string | null;
  session_id: string | null;
  orchestrator_session_id: string | null;
  /** JSON string of token usage extracted from the vendor stream. */
  usage: string | null;
  /** JSON string of the validated report body. */
  report: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  question_id: string | null;
  question: string | null;
  worktree: string | null;
  branch: string | null;
  base_sha: string | null;
  /** Normalized sandbox posture (spec §8). */
  sandbox: string;
  /** Network access, stored as SQLite 0/1. */
  network: number;
  answer_timeout_ms: number | null;
  /** JSON string of the caller-supplied report schema; null means the default. */
  report_schema: string | null;
  seq: number;
  eval_score: number | null;
  eval_feedback: string | null;
}

/** `GET /health` — daemon liveness plus its package version (spec stability §). */
export interface HealthResponse {
  status: string;
  pid: number;
  /** The daemon package version, so a UI can detect a contract mismatch. */
  version: string;
  /**
   * ISO-8601 timestamp of when the daemon process started, so a UI can render a
   * live-ticking uptime without a filesystem read of the discovery record. An
   * additive field — older clients that only read `status`/`pid`/`version`
   * ignore it.
   */
  started_at: string;
}

/** `GET /tasks` — every task plus the atomic "start from now" seq baseline. */
export interface TasksResponse {
  tasks: TaskRow[];
  seq: number;
}

/**
 * One orchestrator session known to the daemon via its tasks' 
 * `orchestrator_session_id` (#88). Used by the roster's historical session
 * search — the live task snapshot only surfaces sessions that still have
 * tasks in it; this listing covers every session the daemon has ever seen.
 */
export interface OrchestratorSession {
  /** The orchestrator session id (`PARLEY_SESSION_ID` / `--session`). */
  id: string;
  /** ISO-8601 of the most recent task activity in this session. */
  last_activity_at: string;
  /** Number of tasks currently associated with this session. */
  task_count: number;
}

/**
 * `GET /sessions` — historical orchestrator sessions for the roster selector
 * (#88). Ordered most-recently-active first. Optional `?q=` filters by id
 * substring (case-insensitive).
 */
export interface SessionsResponse {
  sessions: OrchestratorSession[];
}

/**
 * One `ask_orchestrator` turn in a task's durable Q&A history (#79).
 * Detail-only — list envelopes do not carry history. `answer` is null while
 * the question is still outstanding (or was never answered).
 */
export interface QaTurn {
  question: string;
  answer: string | null;
  /** Correlates with the outstanding `question_id` on the envelope/row. */
  question_id: string;
  /** ISO-8601 timestamp when the question was recorded. */
  asked_at: string;
  /** ISO-8601 timestamp when answered; null while outstanding. */
  answered_at: string | null;
}

/**
 * `GET /tasks/:ref` — the task envelope alongside its raw row and the durable
 * Q&A history for the inspector (ask order). List endpoints omit `qa`.
 */
export interface TaskDetailResponse {
  task: TaskEnvelope;
  row: TaskRow;
  /** Per-task `ask_orchestrator` turns in ask order; empty when none. */
  qa: QaTurn[];
}

/** The ack returned by writes that report a task's post-transition state. */
export interface TaskAck {
  task_id: string;
  name: string | null;
  state: string;
  seq: number;
}

/** `POST /clean` — worktrees removed and any that were kept/refused. */
export interface CleanResponse {
  removed: string[];
  kept: string[];
}

/**
 * `GET /tasks/:ref/logs?since=<offset>` — a tail chunk of the task's raw vendor
 * log (spec §"New: per-task logs"). `next` is the offset cursor for the
 * follow-up call — passing it back as `since` never duplicates or drops bytes.
 * `eof` is true once the task has reached a genuinely final state
 * (`completed`, `failed`, `cancelled`) and its vendor process has actually
 * exited, so this response's `chunk` is the log's final tail. `stalled` is
 * deliberately excluded — it's resumable (`parley answer` can revive it and
 * append more to the same log) — and so is a `completed` row whose child
 * hasn't fully exited yet (the post-report fallback can complete before the
 * child exits). While not there yet, `eof` is false even when `chunk` is
 * empty (caught up for now, but more may still land) — a UI tailing a task
 * keeps polling (or re-fetches on SSE transitions) until `eof` flips.
 */
export interface TaskLogResponse {
  chunk: string;
  next: number;
  eof: boolean;
}

/**
 * One decoded SSE message from `GET /events/stream`: the transition seq (the
 * SSE `id`), the watch event name, and the envelope pinned to that transition.
 */
export interface StreamEvent {
  /** The transition seq — the SSE `Last-Event-ID` a reconnect resumes from. */
  seq: number;
  event: string;
  task: TaskEnvelope;
}
