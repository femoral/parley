/**
 * The daemon's wire contract (docs/spec/ui-interface-contract.md): the shapes
 * the HTTP + SSE API exchanges. These are the versioned public surface — a
 * breaking change bumps `@useparley/core` major. The daemon produces values
 * assignable to these types (a compile-time guard in the daemon enforces it);
 * UIs consume them through the typed client and SSE helper.
 */
import type { Posture } from "./adapter.js";

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

// Posture is defined once in adapter.ts (SandboxMode-typed) and reused on the
// wire — SandboxMode is a string union, so JSON consumers still see a string.

/**
 * The report envelope the daemon wraps around a task (spec §4) — the primary
 * task shape on list, watch, and SSE. Storage never appears here: JSON columns
 * are objects, booleans are booleans, and session/recency fields live on the
 * envelope so live consumers need no row backfill. On a transition stream its
 * `state`/`seq` are pinned to the transition, even if the underlying row has
 * since moved on; `updated_at` reflects the storage row's last write.
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
  /** Profile name used at create time, if any (#113). */
  profile: string | null;
  /**
   * Remote runner affinity (`--runner <name>`), if any (#111 / ADR-0012).
   * Null/absent means the task executes in-daemon (default). Optional on the
   * wire so older clients/fixtures remain assignable.
   */
  runner?: string | null;
  posture: Posture;
  session_id: string | null;
  /**
   * Orchestrator-run grouping (CONTEXT.md / `PARLEY_SESSION_ID`). Null when
   * unbound (#208).
   */
  orchestrator_session_id: string | null;
  /** ISO-8601 last activity on the storage row (recency / eviction) (#208). */
  updated_at: string;
  /** ISO-8601 task creation time (#208). */
  created_at: string;
  /** ISO-8601 when the task first entered `running`; null until then (#208). */
  started_at: string | null;
  /** ISO-8601 when the task reached a terminal state; null while live (#208). */
  completed_at: string | null;
  /**
   * Spawn-time orchestrator harness snapshot (#162 / #208). Null when unbound.
   * Optional so older clients remain assignable.
   */
  orch_harness?: string | null;
  /** Spawn-time orchestrator model snapshot (#162 / #208). */
  orch_model?: string | null;
  /** Spawn-time orchestrator effort snapshot (#162 / #208). */
  orch_effort?: string | null;
  usage: Record<string, number> | null;
  duration_ms: number | null;
  state: string;
  report: Report | null;
  /**
   * The report schema actually applied (parley's default when omitted).
   * For a workflow step task this is generated from the node's output ports
   * via `compileOutputPorts` (ADR-0016 / #236) and stored on the same per-task
   * seam — the child still calls `submit_report` once; no new verb.
   */
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
  /** Task size classification (XS|S|M|L|XL); null when unset at delegate time (#118). */
  size: string | null;
  /** Task difficulty (trivial|easy|medium|hard|extreme); null when unset (#118). */
  difficulty: string | null;
  /**
   * Work-domain task type (#151). Always set: omitted at delegate ⇒ `other`.
   */
  type: string;
  /**
   * Prior attempt this envelope reattempts (`parley fix`, #152). Null for first
   * delegations. Optional on the wire so older clients remain assignable.
   */
  parent_task_id?: string | null;
  /** 1-based attempt number in a fix chain (#152). Optional for older clients. */
  attempt?: number;
  /**
   * Whether vendor-session resume was requested for this attempt (#152).
   * Optional for older clients.
   */
  resumed?: boolean;
  /**
   * Vendor-reported cached input tokens (#152). Null when unreported — never
   * guessed. Optional for older clients.
   */
  cached_input_tokens?: number | null;
  /**
   * 1-based FIFO position among tasks waiting on the same concurrency cap
   * (#171). Null when not `queued`. Optional for older clients.
   */
  queue_position?: number | null;
  /**
   * Which cap is currently blocking spawn, e.g. `vendor:fake` or
   * `profile:deep` (or both joined with `+`) (#171). Null when not `queued`.
   */
  blocking_cap?: string | null;
  /**
   * Owning run id when this task is run-owned (ADR-0018 / ADR-0019 / #233).
   * Null for ordinary tasks. On every `task.*` firehose event.
   */
  run_id?: string | null;
  /** Run address node id (#233 / #240). */
  node?: string | null;
  /** Run address iteration (#233 / #240). */
  iteration?: number | null;
  /** Run address slot (#233 / #240). */
  slot?: string | null;
}

/**
 * Storage-shaped task columns as still mirrored on `GET /tasks/:ref`'s
 * deprecated `row` field. List and stream endpoints never ship this shape —
 * they use {@link TaskEnvelope}. Prefer decoded detail sections
 * (`session` / `eval_detail` / `attempts` / `qa`) over reading `row`.
 */
export interface TaskRow {
  id: string;
  name: string | null;
  vendor: string | null;
  model: string | null;
  effort: string | null;
  /** Profile name used at create time, if any (#113). */
  profile: string | null;
  /**
   * Remote runner affinity (`--runner <name>`), if any (#111 / ADR-0012).
   * Null/absent means the task executes in-daemon (default). Optional on the
   * wire so older clients/fixtures remain assignable.
   */
  runner?: string | null;
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
  /**
   * JSON string of the report schema; null means parley's default.
   * Workflow steps store the schema generated from output ports here
   * (ADR-0016 / #236).
   */
  report_schema: string | null;
  seq: number;
  eval_score: number | null;
  eval_feedback: string | null;
  /**
   * Rubric-eval answers JSON (`Record<criterionId, boolean>`), null until a
   * structured eval is recorded (#157). Legacy free-score rows leave this null.
   * Optional on the wire so older fixtures remain assignable.
   */
  eval_answers?: string | null;
  /** Rubric id used for the structured eval (#157); null until set / legacy. */
  eval_rubric?: string | null;
  /** Rubric version used for the structured eval (#157); null until set / legacy. */
  eval_rubric_version?: number | null;
  /**
   * Daemon-computed baseline (0–10) for the structured eval (#157). Null until
   * set; legacy free-score rows leave this null.
   */
  eval_baseline?: number | null;
  /** Task size classification (XS|S|M|L|XL); null when unset at delegate time (#118). */
  size: string | null;
  /** Task difficulty (trivial|easy|medium|hard|extreme); null when unset (#118). */
  difficulty: string | null;
  /**
   * Work-domain task type (#151). Always set: omitted at delegate ⇒ `other`.
   */
  type: string;
  /**
   * Prior attempt this row reattempts (`parley fix`, #152). Null for first
   * delegations. Optional on the wire so older clients remain assignable.
   */
  parent_task_id?: string | null;
  /** 1-based attempt number in a fix chain (#152). Optional for older clients. */
  attempt?: number;
  /**
   * Whether vendor-session resume was requested (#152). Stored as SQLite 0/1
   * on the row. Optional for older clients.
   */
  resumed?: number;
  /**
   * Vendor-reported cached input tokens (#152). Null when unreported.
   * Optional for older clients.
   */
  cached_input_tokens?: number | null;
  /**
   * JSON string of the per-spawn launch-command records (#154): each entry is
   * `{ argv, cwd, env_names }` with the prompt elided and env values omitted.
   * Null until the first spawn. Optional so older fixtures remain assignable.
   */
  launch_command?: string | null;
  /**
   * Provenance of {@link model}: `resolved` (request/profile/adapter default)
   * or `vendor` (stream-confirmed). Null when model is unknown (#154).
   */
  model_source?: string | null;
  /**
   * Provenance of {@link effort}: same vocabulary as {@link model_source} (#154).
   */
  effort_source?: string | null;
  /**
   * Spawn-time orchestrator harness snapshot (#162). Null when unbound.
   * Optional so older fixtures remain assignable.
   */
  orch_harness?: string | null;
  /** Spawn-time orchestrator model snapshot (#162). */
  orch_model?: string | null;
  /** Spawn-time orchestrator effort snapshot (#162). */
  orch_effort?: string | null;
  /**
   * Judging session id at eval time (#162). Null until a structured eval is
   * recorded with a bound session.
   */
  eval_session_id?: string | null;
  /** Judge harness snapshot at eval time (#162). */
  eval_harness?: string | null;
  /** Judge model snapshot at eval time (#162). */
  eval_model?: string | null;
  /** Judge effort snapshot at eval time (#162). */
  eval_effort?: string | null;
  /**
   * When the task entered `queued` (ISO-8601) (#171). Null when never queued
   * or after leaving the queue. Optional for older clients.
   */
  queued_at?: string | null;
  /**
   * 1-based FIFO position among tasks waiting on the same concurrency cap
   * (#171). Null when not `queued`. Computed at response time.
   */
  queue_position?: number | null;
  /**
   * Which cap is currently blocking spawn (#171). Null when not `queued`.
   * Computed at response time.
   */
  blocking_cap?: string | null;
  /**
   * Owning run id when this task is run-owned (ADR-0018 / #233). Null for
   * ordinary tasks. Optional on the wire so older fixtures remain assignable.
   */
  run_id?: string | null;
  /**
   * Run address node id (#233). Null when not run-owned. Optional for older
   * clients.
   */
  node?: string | null;
  /**
   * Run address iteration (#233). Null when not run-owned. Optional for older
   * clients.
   */
  iteration?: number | null;
  /**
   * Run address slot (#233). Null when no fan-out / not run-owned. Optional
   * for older clients.
   */
  slot?: string | null;
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

/**
 * `GET /tasks` — bootstrap snapshot: every task as a {@link TaskEnvelope}
 * plus the atomic "start from now" seq baseline (#208).
 */
export interface TasksResponse {
  tasks: TaskEnvelope[];
  seq: number;
}

/**
 * `GET /tasks/inbox` — one acked attention-inbox long-poll response
 * (ADR-0007 / #91 / #208).
 */
/**
 * Run face on an inbox / follow event (ADR-0019 / #240). Present when the
 * subject is a run (gate / blocked / failed / completed). The exit code still
 * reports only the tier; this payload picks the verb.
 */
export interface RunEnvelope {
  run_id: string;
  workflow: string;
  state: string;
  /** Inbox tier key: gate | blocked | failed | completed (or lifecycle state on follow). */
  tier?: string;
  current_node: string | null;
  iteration: number;
  error: string | null;
  orchestrator_session_id: string | null;
  seq: number;
}

export interface InboxEventResponse {
  /** Watch event name, or null when the poll window elapsed / all-done. */
  event: string | null;
  /** Event id (transition seq) when an event is present; else current global seq. */
  seq: number;
  /**
   * Subject kind (ADR-0019). Absent/`task` on older daemons. Distinguishes
   * "question on task X" from "gate on run R" without a new exit code.
   */
  subject?: "task" | "run";
  task: TaskEnvelope | null;
  /** Present when `subject` is `run`. */
  run?: RunEnvelope | null;
  /**
   * True when the session is finished: every watched subject terminal (runs
   * included) and every event acked (ADR-0019).
   */
  all_done: boolean;
}

/**
 * `GET /tasks/events` — one multi-task transition firehose long-poll response
 * (`watch --follow`, #208 / #240).
 */
export interface FollowEventResponse {
  event: string | null;
  seq: number;
  subject?: "task" | "run";
  task: TaskEnvelope | null;
  run?: RunEnvelope | null;
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
 * `GET /tasks/:ref` — the task envelope plus decoded detail companions for the
 * inspector (ask order). List/stream endpoints omit these sections.
 * #164 adds attempt lineage, eval detail, and spawn-session provenance for Cove.
 * #208: prefer decoded sections over the storage-shaped `row`.
 */
export interface TaskDetailResponse {
  task: TaskEnvelope;
  /**
   * @deprecated Storage-shaped mirror; remove after CLI/UI stop reading it.
   * Prefer `task`, `session`, `eval_detail`, `attempts`, and `qa`.
   */
  row?: TaskRow;
  /** Per-task `ask_orchestrator` turns in ask order; empty when none. */
  qa: QaTurn[];
  /**
   * Full attempt chain containing this task (root → latest) (#164).
   * Always present; a first attempt with no fixes is a one-element array.
   */
  attempts: AttemptLineageEntry[];
  /**
   * Spawn-time orchestrator provenance snapshot (#162 / #164).
   * Fields are null when no session was bound at create time.
   */
  session: SessionProvenance;
  /**
   * Structured (or legacy) eval detail for status/inspector (#164).
   * Null when the task has never been scored.
   */
  eval_detail: EvalDetail | null;
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

/** Task-count breakdown inside a metrics group (#118). */
export interface MetricsTaskCounts {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  other: number;
}

/**
 * Per-criterion failure frequency within a metrics group (#164).
 * A criterion "fails" when a positive answer is false or a negative is true.
 */
export interface MetricsCriterionFailureStats {
  /** Times this criterion failed among rubric evals that answered it. */
  failures: number;
  /** Rubric evals that included an answer for this criterion id. */
  count: number;
  /** failures / count; null when count is 0. */
  rate: number | null;
}

/**
 * First-attempt vs fix split of rubric eval scores (#164).
 * Attempt 1 = first delegation; attempt > 1 = `parley fix` retries.
 */
export interface MetricsAttemptEvalSplit {
  count: number;
  avg: number | null;
  avg_baseline: number | null;
  avg_delta: number | null;
  below_baseline_rate: number | null;
}

/**
 * Rubric-eval aggregate for a metrics group (#164).
 *
 * Only structured rubric evals (eval_rubric set) contribute. Historical free
 * scores (`eval_score` with null rubric fields) are excluded so legacy data
 * never pollutes baseline/delta/criterion math — they remain visible on
 * status as "legacy".
 */
export interface MetricsEvalStats {
  /** Count of rubric-scored tasks in this group. */
  count: number;
  /** Mean score among rubric evals. */
  avg: number | null;
  /** Mean baseline among rubric evals. */
  avg_baseline: number | null;
  /** Mean (score − baseline) among rubric evals. */
  avg_delta: number | null;
  /** Fraction of rubric evals with score < baseline. */
  below_baseline_rate: number | null;
  /** Per-criterion failure frequency among rubric evals. */
  criterion_failures: Record<string, MetricsCriterionFailureStats>;
  /** Rubric evals on first attempts (attempt === 1). */
  first_attempt: MetricsAttemptEvalSplit;
  /** Rubric evals on fix attempts (attempt > 1). */
  fix: MetricsAttemptEvalSplit;
}

/** Token totals after canonical normalizeUsage mapping. */
export interface MetricsTokenTotals {
  input: number;
  output: number;
  cached: number;
  /** Tasks whose usage JSON contributed at least one non-null token field. */
  tasks_reporting: number;
}

/** Duration aggregates from started_at/completed_at (ms). */
export interface MetricsDurationStats {
  total: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  tasks_reporting: number;
}

/**
 * One group in `GET /metrics` (#118 / #151 / #164) — keyed by the active
 * group_by dimension (or null when that column is unset for the bucket).
 */
export interface MetricsGroup {
  key: string | null;
  tasks: MetricsTaskCounts;
  /** completed / (completed + failed); null when neither completed nor failed. */
  success_rate: number | null;
  evals: MetricsEvalStats;
  evals_by_size: Record<string, MetricsEvalStats>;
  evals_by_difficulty: Record<string, MetricsEvalStats>;
  tokens: MetricsTokenTotals;
  duration_ms: MetricsDurationStats;
}

/**
 * `GET /metrics?session=&group_by=&…` — per-group task/eval/token/duration
 * aggregates for the CLI and Cove dashboard (#118 / #119 / #164).
 */
export interface MetricsResponse {
  groups: MetricsGroup[];
  /** ISO-8601 timestamp when the response was generated. */
  generated_at: string;
}

/**
 * One attempt in a fix chain (#152 / #164), root → latest order.
 * Surfaced on `GET /tasks/:ref` so Cove can render attempt lineage.
 */
export interface AttemptLineageEntry {
  id: string;
  name: string | null;
  attempt: number;
  parent_task_id: string | null;
  state: string;
  resumed: boolean;
  cached_input_tokens: number | null;
  /** true when cached > 0, false when 0, null when unreported. */
  cache_hit: boolean | null;
  eval_score: number | null;
  eval_baseline: number | null;
  eval_rubric: string | null;
  eval_rubric_version: number | null;
  /** True when eval_score is set but rubric fields are null (pre-#157 free score). */
  eval_legacy: boolean;
}

/**
 * Spawn-time orchestrator session snapshot on a task (#162 / #164).
 */
export interface SessionProvenance {
  session_id: string | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
}

/**
 * Judge-time session snapshot from a structured eval (#162 / #164).
 */
export interface JudgeProvenance {
  session_id: string | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
}

/**
 * One criterion verdict for status/inspector (#164).
 * `pass` is the "good outcome": positive answered true, or negative answered false.
 */
export interface EvalCriterionDetail {
  id: string;
  kind: "positive" | "negative";
  weight: number;
  text: string;
  answer: boolean;
  pass: boolean;
}

/**
 * Structured eval detail for status / task detail (#164).
 * Null-ish when the task has never been scored; `legacy` free scores set
 * score without rubric/criteria.
 */
export interface EvalDetail {
  score: number | null;
  baseline: number | null;
  /** score − baseline when both present; null otherwise. */
  delta: number | null;
  /** score < baseline when both present; null otherwise. */
  below_baseline: boolean | null;
  /** True when score exists without rubric fields (pre-#157 free score). */
  legacy: boolean;
  rubric: string | null;
  rubric_version: number | null;
  feedback: string | null;
  judge: JudgeProvenance | null;
  /** Per-criterion pass/fail with weights; null for legacy or missing answers. */
  criteria: EvalCriterionDetail[] | null;
}

/**
 * Shared filter params for `GET /metrics` and `GET /tasks` (#164).
 * All fields optional; omitted means no constraint. Boolean flags are true
 * when the query value is `"true"` or `"1"`.
 */
export interface TaskMetricsFilters {
  /** Orchestrator session id; `"all"` / omit for every session (metrics default). */
  session?: string;
  type?: string;
  vendor?: string;
  model?: string;
  profile?: string;
  size?: string;
  difficulty?: string;
  orch_harness?: string;
  orch_model?: string;
  orch_effort?: string;
  eval_harness?: string;
  eval_model?: string;
  eval_effort?: string;
  /** Rubric id (e.g. `coding`). */
  rubric?: string;
  /** Rubric version integer. */
  rubric_version?: number;
  /** When true, only first attempts (attempt === 1 / no parent). */
  first_attempt?: boolean;
  /** When true, only rubric evals with score < baseline. */
  below_baseline?: boolean;
}
