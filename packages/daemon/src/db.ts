import fs from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
import {
  SETTLED_STATES,
  TERMINAL_STATES,
  type HomePaths,
  type TaskState,
  type WorkspaceMode,
} from "@useparley/core";
import type { SandboxMode } from "./adapters/types.js";

/** Re-export core lifecycle type so daemon callers need not dual-import. */
export type { TaskState };

/**
 * Load `node:sqlite`'s DatabaseSync without a static import so we can silence
 * the ExperimentalWarning before the module evaluates (CLI tests and user-facing
 * stderr assert a quiet process). createRequire also keeps vitest/vite from
 * trying to resolve the builtin as a bare `sqlite` package.
 */
function loadDatabaseSync(): new (
  path: string,
) => DatabaseSyncInstance {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.includes("SQLite is an experimental feature")) return;
    return Reflect.apply(original, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite").DatabaseSync as new (
      path: string,
    ) => DatabaseSyncInstance;
  } finally {
    process.emitWarning = original;
  }
}

const DatabaseSync = loadDatabaseSync();

export type DatabaseHandle = DatabaseSyncInstance;

/** A task row as surfaced to the CLI plane (`status` / `list`). */
export interface TaskRow {
  id: string;
  name: string | null;
  vendor: string | null;
  model: string | null;
  /** Opaque reasoning-effort string, passed through to the vendor unchanged. */
  effort: string | null;
  /** Profile name used at create time, if any (#113). */
  profile: string | null;
  /**
   * Remote runner affinity (`--runner <name>`), if any (#111 / ADR-0012).
   * Null means the task executes in-daemon (default).
   */
  runner: string | null;
  repo: string | null;
  /**
   * Normalized repo key (`host/path`) from origin at create time (#313).
   * Null when the repo has no origin or the fetch URL is not a network remote.
   */
  repo_key: string | null;
  /**
   * Exact origin fetch URL at create time (#313). Null when no origin remote.
   */
  repo_fetch_url: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  cwd: string | null;
  prompt: string | null;
  session_id: string | null;
  /** The orchestrator-run identity that spawned this task (`--session` / `PARLEY_SESSION_ID`). */
  orchestrator_session_id: string | null;
  /** JSON: token usage extracted from the vendor stream. */
  usage: string | null;
  /** JSON: the validated report body submitted via `submit_report`. */
  report: string | null;
  error: string | null;
  /**
   * JSON structured failure category (#317), e.g. git-auth detail. Null when
   * unset or the fail was a plain vendor crash (message only).
   */
  error_category: string | null;
  started_at: string | null;
  completed_at: string | null;
  /** The outstanding `ask_orchestrator` question id while `awaiting_answer`. */
  question_id: string | null;
  /** The outstanding question text while `awaiting_answer`. */
  question: string | null;
  /** Absolute path to the parley-created worktree; null when `--cwd` bypassed it. */
  worktree: string | null;
  /** The branch parley created for the task (`parley/<id>-<name>`). */
  branch: string | null;
  /** The commit the worktree branched from — the baseline for auto-remove. */
  base_sha: string | null;
  /** Normalized sandbox posture (spec §8); defaults to `workspace`. */
  sandbox: SandboxMode;
  /** Network access, stored as SQLite 0/1; 1 (on) is the ADR-0006 default. */
  network: number;
  /** Per-task `--answer-timeout` in ms; null means the daemon default (30m). */
  answer_timeout_ms: number | null;
  /** JSON: the caller-supplied report schema; null means parley's default. */
  report_schema: string | null;
  /**
   * Global transition sequence number of this task's most recent state change
   * (#34 / ADR-0007). 0 until the task first transitions out of `pending`.
   * Every task envelope surfaces it; for the inbox it is the event id of the
   * current state (acked via `watch --ack <seq>`).
   */
  seq: number;
  /**
   * Daemon-computed quality score (0-10) via `parley eval --answers` (#157);
   * legacy free-score rows may still hold 1–10 values. Null until set.
   */
  eval_score: number | null;
  /** Orchestrator-recorded feedback text via `parley eval`; null until set. */
  eval_feedback: string | null;
  /**
   * JSON object of per-criterion boolean answers from structured eval (#157).
   * Null until a rubric eval is recorded (legacy free-score rows stay null).
   */
  eval_answers: string | null;
  /** Rubric id used for the structured eval (#157); null until set / legacy. */
  eval_rubric: string | null;
  /** Rubric version used for the structured eval (#157); null until set / legacy. */
  eval_rubric_version: number | null;
  /**
   * Daemon-computed baseline (0–10) for the structured eval (#157). Null until
   * set; legacy free-score rows leave this null.
   */
  eval_baseline: number | null;
  /** Task size classification (XS|S|M|L|XL); null when unset at delegate time (#118). */
  size: string | null;
  /** Task difficulty (trivial|easy|medium|hard|extreme); null when unset (#118). */
  difficulty: string | null;
  /**
   * Work-domain task type (#151). Always set: omitted at delegate ⇒ `other`;
   * backfilled to `other` for pre-migration rows.
   */
  type: string;
  /**
   * Prior attempt this row reattempts (`parley fix`, #152). Null for first
   * delegations (`attempt = 1`).
   */
  parent_task_id: string | null;
  /**
   * 1-based attempt number in a fix chain (#152). First delegations are 1;
   * each `parley fix` increments from its parent.
   */
  attempt: number;
  /**
   * Whether this attempt requested a vendor-session resume (#152). First
   * attempts and `resume.enabled: false` fixes are 0; resumed fixes are 1.
   * Stored as SQLite 0/1.
   */
  resumed: number;
  /**
   * Vendor-reported cached input tokens for this attempt (#152). Null when
   * the vendor never reported a cache count — never guessed as 0.
   */
  cached_input_tokens: number | null;
  /**
   * JSON array of per-spawn launch-command records (#154):
   * `{ argv, cwd, env_names }[]` — prompt elided, env values omitted.
   * Null until the first spawn.
   */
  launch_command: string | null;
  /**
   * Provenance of {@link model}: `resolved` or `vendor`, null when model is
   * unknown (#154).
   */
  model_source: string | null;
  /**
   * Provenance of {@link effort}: `resolved` or `vendor`, null when effort is
   * unknown (#154).
   */
  effort_source: string | null;
  /**
   * Spawn-time orchestrator harness snapshot (#162). Null when no registered
   * session was bound; never rewritten by later session updates.
   */
  orch_harness: string | null;
  /** Spawn-time orchestrator model snapshot (#162). */
  orch_model: string | null;
  /** Spawn-time orchestrator effort snapshot (#162). */
  orch_effort: string | null;
  /**
   * Judging session id at eval time (#162). Null until a structured eval is
   * recorded with a bound session; independent of spawn-time session.
   */
  eval_session_id: string | null;
  /** Judge harness snapshot at eval time (#162). */
  eval_harness: string | null;
  /** Judge model snapshot at eval time (#162). */
  eval_model: string | null;
  /** Judge effort snapshot at eval time (#162). */
  eval_effort: string | null;
  /**
   * When the task entered `queued` (ISO-8601) (#171). Null when never
   * queued or after leaving the queue for a spawn. Orders FIFO restarts.
   */
  queued_at: string | null;
  /**
   * Owning run id when this task is run-owned (ADR-0018 / #233). Null for
   * ordinary `--cwd` / worktree tasks outside a workflow run.
   */
  run_id: string | null;
  /**
   * Run address: node id within the workflow. Null when not run-owned.
   * With {@link iteration} and {@link slot}, forms the task's structural address.
   */
  node: string | null;
  /**
   * Run address: 1-based iteration (0 marks a node inherited by a fork).
   * Null when not run-owned.
   */
  iteration: number | null;
  /**
   * Run address: authored slot name or data-fan-out key. Null when the node
   * has a single task (no fan-out) or the task is not run-owned.
   */
  slot: string | null;
  /**
   * Visible routing wait reason when capable executors exist but none is
   * online (#315 / #304). Null when not waiting on routing.
   */
  queue_reason: string | null;
  /**
   * Absolute ISO-8601 deadline for a pending remote-routed task (#315).
   * Set when the task is waiting for a runner claim (online or offline);
   * cleared on claim / local start / terminal. Survives daemon restart.
   */
  routing_deadline_at: string | null;
  /**
   * Durable placement intent set once at delegate/fix/run-step create (#315).
   * `local` → only in-process; `remote` → only runner claim / wait (never local
   * fallback). Null on legacy rows written before this column existed.
   */
  placement: "local" | "remote" | null;
}

/** Fields the daemon writes when creating a task. */
export interface NewTask {
  /** Pre-allocated short id (worktree creation needs it before insert). */
  id: string;
  name: string | null;
  vendor: string;
  model: string | null;
  /** Opaque reasoning-effort string, passed through to the vendor unchanged. */
  effort: string | null;
  /**
   * Provenance of model at create time (`resolved` when a value was resolved
   * from request/profile/adapter default; null when unknown) (#154).
   */
  model_source?: string | null;
  /**
   * Provenance of effort at create time (same vocabulary as model_source) (#154).
   */
  effort_source?: string | null;
  /** Profile name used at create time, if any (#113). */
  profile: string | null;
  /**
   * Remote runner affinity (`--runner <name>`), if any (#111 / ADR-0012).
   * Null/omitted means the task executes in-daemon (default).
   */
  runner?: string | null;
  repo: string | null;
  /**
   * Normalized repo key from origin at create time (#313). Null/omitted when
   * the repo has no origin.
   */
  repo_key?: string | null;
  /**
   * Exact origin fetch URL at create time (#313). Null/omitted with no origin.
   */
  repo_fetch_url?: string | null;
  cwd: string;
  prompt: string;
  /**
   * The orchestrator-run identity that spawned this task (`parley session`,
   * ancestry binding, `--session` / `PARLEY_SESSION_ID`). Null when evals are
   * off and no session resolved (#162).
   */
  orchestrator_session_id: string | null;
  /**
   * Spawn-time orchestrator provenance snapshots from the bound session (#162).
   * Null when unbound / free-form id with no registration.
   */
  orch_harness?: string | null;
  orch_model?: string | null;
  orch_effort?: string | null;
  worktree: string | null;
  branch: string | null;
  base_sha: string | null;
  /** Normalized sandbox posture (spec §8). */
  sandbox: SandboxMode;
  /** Whether the child may reach the network (ADR-0006 default: true). */
  network: boolean;
  answer_timeout_ms: number | null;
  /** JSON of the caller-supplied report schema; null uses parley's default. */
  report_schema: string | null;
  /** Task size classification (XS|S|M|L|XL); null when unset (#118). */
  size: string | null;
  /** Task difficulty (trivial|easy|medium|hard|extreme); null when unset (#118). */
  difficulty: string | null;
  /**
   * Work-domain task type (#151). Always set: omitted at delegate ⇒ `other`.
   */
  type: string;
  /**
   * Prior attempt this row reattempts (#152). Null/omitted for first
   * delegations. When set, `attempt` should be parent.attempt + 1.
   */
  parent_task_id?: string | null;
  /**
   * 1-based attempt number (#152). Defaults to 1 when omitted.
   */
  attempt?: number;
  /**
   * Whether vendor-session resume was requested for this attempt (#152).
   * Defaults to false when omitted.
   */
  resumed?: boolean;
  /**
   * Seed the vendor session id at insert (resumed fix inherits the parent's
   * session so `buildSpec` can resume immediately). Null/omitted otherwise.
   */
  session_id?: string | null;
  /**
   * Owning run + structural address when the task is run-owned (ADR-0018 /
   * #233). Omitted/null for ordinary delegate tasks. A run-owned task is
   * shaped like `--cwd`: `worktree`/`branch` null, `cwd` set to the run workspace.
   */
  run_id?: string | null;
  node?: string | null;
  iteration?: number | null;
  slot?: string | null;
  /**
   * Durable placement intent (`local` | `remote`) set at create (#315).
   * Null/omitted only for tests and legacy paths; production insert always sets it.
   */
  placement?: "local" | "remote" | null;
}

// ---------------------------------------------------------------------------
// Runs, deliverables, and run-owned task address (#233 / ADR-0016, 0017, 0018)
// ---------------------------------------------------------------------------

/**
 * Run lifecycle states (ADR-0017). Exact vocabulary:
 * - `blocked` = the daemon cannot advance it (gate, loop budget, spawn error)
 * - `failed` = nobody can (workspace gone, definition unparseable)
 * A run never auto-fails into `failed` from the engine; retention uses
 * {@link RunRow.purged_at} rather than inventing a sixth runtime state.
 */
export const RUN_STATES = [
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

/** One of parley's run lifecycle states. */
export type RunState = (typeof RUN_STATES)[number];

/** Terminal run states — the run will not advance again. */
export const RUN_TERMINAL_STATES = ["completed", "failed", "cancelled"] as const;

/** True when a run will not advance again (completed / failed / cancelled). */
export function isRunTerminalState(state: string): boolean {
  return (RUN_TERMINAL_STATES as readonly string[]).includes(state);
}

/** Deliverable storage kind (ADR-0016): inline JSON, or a path reference. */
export const DELIVERABLE_KINDS = ["inline", "file", "dir"] as const;

/** One of the three deliverable kinds. */
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

/** A run row as stored in SQLite (#233 / ADR-0016, 0017). */
export interface RunRow {
  id: string;
  /** Workflow definition id (not a path). */
  workflow: string;
  /** Author-declared workflow `version` at run start. */
  version: number;
  /** Workflow `type` (rubric selector), copied from the definition. */
  type: string;
  /** Workspace mode from the definition — not overridable at run start. */
  workspace: WorkspaceMode;
  /**
   * Repo the run is bound to. Null for `scratch` even when started inside a
   * repo (ADR-0018); also null until a `repo`-mode run is bound.
   */
  repo: string | null;
  state: RunState;
  /** Current node id; null when the run has left the node sequence (e.g. completed). */
  current_node: string | null;
  /**
   * Current iteration of the run cursor (ADR-0017). 1-based for live work;
   * iteration 0 on a forked node's *tasks/deliverables* marks inheritance.
   */
  iteration: number;
  /** Parent run when this row is a fork (ADR-0017); null for first attempts. */
  parent_run_id: string | null;
  /**
   * 1-based run-level attempt in a fork chain (ADR-0017). Reserved word —
   * never a fan-out slot or loop pass (CONTEXT.md).
   */
  attempt: number;
  /** Orchestrator session that started the run; mirrors task grouping. */
  orchestrator_session_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  /** Failure / block detail for operators; null when none recorded. */
  error: string | null;
  /**
   * When retention purged scaffolding for this run (#244). Null while live.
   * Representable now so the query surface can render decay without a sweep.
   */
  purged_at: string | null;
  // ── #243 / ADR-0020: run metrics + whole-run eval ────────────────────────
  /** Optional size classification (XS|S|M|L|XL); null when unset at run start. */
  size: string | null;
  /** Optional difficulty; null when unset at run start. */
  difficulty: string | null;
  /** Spawn-time orchestrator harness snapshot; null when unbound. */
  orch_harness: string | null;
  orch_model: string | null;
  orch_effort: string | null;
  /** Daemon-computed quality score (0–10) via `parley run eval`. */
  eval_score: number | null;
  eval_feedback: string | null;
  /** JSON object of per-criterion boolean answers. */
  eval_answers: string | null;
  eval_rubric: string | null;
  eval_rubric_version: number | null;
  eval_baseline: number | null;
  /** Judging session id at eval time; independent of spawn-time session. */
  eval_session_id: string | null;
  eval_harness: string | null;
  eval_model: string | null;
  eval_effort: string | null;
  // ── #249 / ADR-0022: frozen base at run start ────────────────────────────
  /**
   * Base ref as asked for at start (`--base-ref`, default `HEAD`). Null for
   * `scratch` (which refuses a base ref) and for runs created before #249.
   */
  base_ref: string | null;
  /**
   * Concrete commit `--base-ref` resolved to at start. A fork weeks later can
   * rebuild from this even if the branch has moved (extends ADR-0018). Null
   * for `scratch` and pre-#249 rows.
   */
  base_commit: string | null;
}

/** Fields the daemon writes when creating a run. */
export interface NewRun {
  /** Pre-allocated short id (`r1`, … via {@link nextRunId}). */
  id: string;
  workflow: string;
  version: number;
  type: string;
  workspace: WorkspaceMode;
  /** Null for `scratch` (even inside a repo). */
  repo: string | null;
  /** Initial state; defaults to `running`. */
  state?: RunState;
  current_node: string | null;
  /** Defaults to 1 when omitted. */
  iteration?: number;
  parent_run_id?: string | null;
  /** Defaults to 1 when omitted. */
  attempt?: number;
  orchestrator_session_id?: string | null;
  started_at?: string | null;
  error?: string | null;
  /** Base ref as asked for; null for scratch / omitted. */
  base_ref?: string | null;
  /** Resolved commit of base_ref at start; null for scratch / omitted. */
  base_commit?: string | null;
}

/**
 * A deliverable row: opaque id + structural address node/port/iteration/slot
 * (ADR-0016 / #233). Shares its producing task's retention clock; `purged_at`
 * makes the purged state renderable (sweep is #244).
 */
export interface DeliverableRow {
  id: string;
  run_id: string;
  node: string;
  port: string;
  iteration: number;
  /** Null when the producing node has no fan-out. */
  slot: string | null;
  /**
   * Producing task id. Null after the producing task is gc'd (#244):
   * `ON DELETE SET NULL` — the address survives; the task is provenance only.
   */
  task_id: string | null;
  kind: DeliverableKind;
  /**
   * Inline JSON text when `kind === "inline"`; a path when `kind` is `file`
   * or `dir`. Null when purged (address survives the value).
   */
  value: string | null;
  created_at: string;
  /** ISO-8601 when purged; null while the value is retained. */
  purged_at: string | null;
}

/** Fields the daemon writes when recording a deliverable. */
export interface NewDeliverable {
  /** Pre-allocated short id (`d1`, … via {@link nextDeliverableId}). */
  id: string;
  run_id: string;
  node: string;
  port: string;
  iteration: number;
  slot?: string | null;
  /**
   * Producing task id. Null for fork-inherited copies at iteration 0 (no
   * task ran on this run for that node — ADR-0017 / #242) and after the
   * producing task is gc'd (`ON DELETE SET NULL`, #244).
   */
  task_id: string | null;
  kind: DeliverableKind;
  /** Inline JSON text or path; null only if inserting already-purged (rare). */
  value: string | null;
  purged_at?: string | null;
}

/**
 * Schema migrations, applied in order. Each entry runs once; `user_version`
 * tracks how many have been applied. Future tickets append migrations for
 * questions, worktrees, etc.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE tasks (
     id          TEXT PRIMARY KEY,
     name        TEXT,
     vendor      TEXT,
     model       TEXT,
     repo        TEXT,
     state       TEXT NOT NULL DEFAULT 'pending',
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   );`,
  // #15: delegate spine — task working dir, prompt, vendor session, report
  // envelope fields, lifecycle timestamps, and the short-id counter.
  `ALTER TABLE tasks ADD COLUMN cwd TEXT;
   ALTER TABLE tasks ADD COLUMN prompt TEXT;
   ALTER TABLE tasks ADD COLUMN session_id TEXT;
   ALTER TABLE tasks ADD COLUMN usage TEXT;
   ALTER TABLE tasks ADD COLUMN report TEXT;
   ALTER TABLE tasks ADD COLUMN error TEXT;
   ALTER TABLE tasks ADD COLUMN started_at TEXT;
   ALTER TABLE tasks ADD COLUMN completed_at TEXT;
   CREATE TABLE counters (
     name  TEXT PRIMARY KEY,
     value INTEGER NOT NULL
   );`,
  // #16: Q&A channel — the one outstanding `ask_orchestrator` question per task
  // while it sits `awaiting_answer` (cleared on answer). The blocking child call
  // itself lives in daemon memory; these columns make the question visible to
  // `status` and the long-poll event stream.
  `ALTER TABLE tasks ADD COLUMN question_id TEXT;
   ALTER TABLE tasks ADD COLUMN question TEXT;`,
  // #19: worktree lifecycle — the parley-created worktree path, its branch, and
  // the commit it branched from (the baseline for untouched auto-remove).
  `ALTER TABLE tasks ADD COLUMN worktree TEXT;
   ALTER TABLE tasks ADD COLUMN branch TEXT;
   ALTER TABLE tasks ADD COLUMN base_sha TEXT;`,
  // #20: sandbox posture — the caller's normalized answer to what the child may
  // touch (spec §8, ADR-0006). Defaults match the ADR: workspace write access,
  // network on. Adapters map these to vendor mechanisms in their own tickets.
  `ALTER TABLE tasks ADD COLUMN sandbox TEXT NOT NULL DEFAULT 'workspace';
   ALTER TABLE tasks ADD COLUMN network INTEGER NOT NULL DEFAULT 1;`,
  // #18: stall/resume — the per-task answer timeout (null = daemon default).
  `ALTER TABLE tasks ADD COLUMN answer_timeout_ms INTEGER;`,
  // #17: caller report schemas — the JSON Schema `submit_report` validates
  // against (null = parley's default). Recorded so the envelope can report the
  // schema actually applied.
  `ALTER TABLE tasks ADD COLUMN report_schema TEXT;`,
  // #28: per-vendor reasoning effort — opaque string passed through to the
  // vendor unchanged (same seam as `model`); persisted so `resume` keeps it.
  `ALTER TABLE tasks ADD COLUMN effort TEXT;`,
  // #34: transition sequencing — the global monotonic `seq` (allocated from the
  // `transition_seq` counter) of the task's most recent state change. 0 until a
  // task first transitions; every envelope carries it. ADR-0007 uses seq as the
  // inbox event id (`watch --ack <seq>`).
  `ALTER TABLE tasks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;`,
  // #42: orchestrator session identity — the orchestrator-run id (`--session` /
  // `PARLEY_SESSION_ID`) that spawned this task, distinct from the vendor's own
  // resume `session_id`. Populated at creation so tasks can be grouped by run.
  `ALTER TABLE tasks ADD COLUMN orchestrator_session_id TEXT;`,
  // #44: orchestrator eval — a quality score (1-10) and feedback text recorded
  // against a completed task via `parley eval`, 1:1 with the task.
  `ALTER TABLE tasks ADD COLUMN eval_score INTEGER;
   ALTER TABLE tasks ADD COLUMN eval_feedback TEXT;`,
  // #79: durable per-task Q&A history — every `ask_orchestrator` turn, written
  // at ask time (answer null) and updated in place at answer time. Detail-only
  // on the wire; list envelopes stay small. `ask_ord` is the per-task order.
  `CREATE TABLE qa_turns (
     task_id      TEXT NOT NULL,
     question_id  TEXT NOT NULL,
     question     TEXT NOT NULL,
     answer       TEXT,
     ask_ord      INTEGER NOT NULL,
     asked_at     TEXT NOT NULL,
     answered_at  TEXT,
     PRIMARY KEY (task_id, question_id),
     FOREIGN KEY (task_id) REFERENCES tasks(id)
   );
   CREATE INDEX qa_turns_task_ord ON qa_turns(task_id, ask_ord);`,
  // #91 / ADR-0007: per-task/state ack of inbox events. A task in an actionable
  // state contributes a pending event until its current seq is recorded here
  // for that state. Leaving the state auto-resolves (derived view); acking a
  // superseded seq is a no-op (lookup by current tasks.seq finds nothing).
  `CREATE TABLE event_acks (
     task_id    TEXT NOT NULL,
     state      TEXT NOT NULL,
     acked_seq  INTEGER NOT NULL,
     PRIMARY KEY (task_id, state),
     FOREIGN KEY (task_id) REFERENCES tasks(id)
   );`,
  // #113: agent profiles — the profile name used at create time (null when the
  // caller named a vendor directly). Re-read from config on spawn for args/env.
  `ALTER TABLE tasks ADD COLUMN profile TEXT;`,
  // #111 / ADR-0012: remote runner affinity — tasks tagged for a named runner
  // stay pending until that runner leases them; never picked up by the local
  // engine spawn path. Null means in-daemon execution (default).
  `ALTER TABLE tasks ADD COLUMN runner TEXT;`,
  // #118: task classification for metrics — size (XS|S|M|L|XL) and difficulty
  // (trivial|easy|medium|hard|extreme), optional at delegate time.
  `ALTER TABLE tasks ADD COLUMN size TEXT;
   ALTER TABLE tasks ADD COLUMN difficulty TEXT;`,
  // #153: daemon meta key/value store (e.g. last_gc_at for scheduled retention
  // sweeps). Opaque string values; callers parse.
  `CREATE TABLE meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // #151: work-domain task type — always present; existing rows backfill to
  // `other` via the column default.
  `ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'other';`,
  // #152: attempt chains — each `parley fix` is a first-class task row linked
  // to its parent. Existing rows backfill as attempt 1 (not resumed, no parent,
  // cache unreported).
  `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
   ALTER TABLE tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE tasks ADD COLUMN resumed INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN cached_input_tokens INTEGER;`,
  // #154: launch-command capture + model/effort source tracking — one JSON
  // column of per-spawn records (argv with prompt elided, cwd, env *names*
  // only) and provenance for the resolved model/effort fields.
  `ALTER TABLE tasks ADD COLUMN launch_command TEXT;
   ALTER TABLE tasks ADD COLUMN model_source TEXT;
   ALTER TABLE tasks ADD COLUMN effort_source TEXT;`,
  // #157: structured rubric evaluation — answers + rubric id/version + baseline
  // alongside the existing eval_score / eval_feedback. Historical free-score
  // rows keep eval_score and leave the new columns null.
  `ALTER TABLE tasks ADD COLUMN eval_answers TEXT;
   ALTER TABLE tasks ADD COLUMN eval_rubric TEXT;
   ALTER TABLE tasks ADD COLUMN eval_rubric_version INTEGER;
   ALTER TABLE tasks ADD COLUMN eval_baseline INTEGER;`,
  // #162: orchestrator session provenance — registered sessions with process
  // ancestry anchors; dual snapshots on tasks (spawn-time orchestrator +
  // eval-time judge) so session updates never rewrite history.
  `CREATE TABLE sessions (
     id              TEXT PRIMARY KEY,
     harness         TEXT NOT NULL,
     model           TEXT NOT NULL,
     effort          TEXT NOT NULL,
     workspace_root  TEXT NOT NULL,
     anchor_machine  TEXT NOT NULL,
     anchor_pid      INTEGER NOT NULL,
     anchor_start    TEXT NOT NULL,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL
   );
   CREATE INDEX sessions_workspace ON sessions(workspace_root);
   ALTER TABLE tasks ADD COLUMN orch_harness TEXT;
   ALTER TABLE tasks ADD COLUMN orch_model TEXT;
   ALTER TABLE tasks ADD COLUMN orch_effort TEXT;
   ALTER TABLE tasks ADD COLUMN eval_session_id TEXT;
   ALTER TABLE tasks ADD COLUMN eval_harness TEXT;
   ALTER TABLE tasks ADD COLUMN eval_model TEXT;
   ALTER TABLE tasks ADD COLUMN eval_effort TEXT;`,
  // #171: concurrency queue — durable FIFO order for tasks waiting on a
  // vendor/profile maxConcurrent cap. Null when not (or no longer) queued.
  `ALTER TABLE tasks ADD COLUMN queued_at TEXT;`,
  // #190: env-only session provenance — harness/model/effort may be null when
  // a harness plugin did not inject PARLEY_HARNESS/MODEL/EFFORT (honest unknown).
  // SQLite cannot ALTER column nullability; rebuild sessions with nullable fields.
  `CREATE TABLE sessions_new (
     id              TEXT PRIMARY KEY,
     harness         TEXT,
     model           TEXT,
     effort          TEXT,
     workspace_root  TEXT NOT NULL,
     anchor_machine  TEXT NOT NULL,
     anchor_pid      INTEGER NOT NULL,
     anchor_start    TEXT NOT NULL,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL
   );
   INSERT INTO sessions_new
     (id, harness, model, effort, workspace_root,
      anchor_machine, anchor_pid, anchor_start, created_at, updated_at)
   SELECT id, harness, model, effort, workspace_root,
      anchor_machine, anchor_pid, anchor_start, created_at, updated_at
   FROM sessions;
   DROP TABLE sessions;
   ALTER TABLE sessions_new RENAME TO sessions;
   CREATE INDEX sessions_workspace ON sessions(workspace_root);`,
  // #233: runs, deliverables, and run-owned task address (ADR-0016 / 0017 / 0018).
  // A step stores nothing — its state is a projection over its tasks; no steps
  // table. Deliverable address is node/port/iteration/slot; `purged_at` makes
  // retention decay renderable (the sweep itself is #244).
  `CREATE TABLE runs (
     id                       TEXT PRIMARY KEY,
     workflow                 TEXT NOT NULL,
     version                  INTEGER NOT NULL,
     type                     TEXT NOT NULL,
     workspace                TEXT NOT NULL,
     repo                     TEXT,
     state                    TEXT NOT NULL DEFAULT 'running',
     current_node             TEXT,
     iteration                INTEGER NOT NULL DEFAULT 1,
     parent_run_id            TEXT,
     attempt                  INTEGER NOT NULL DEFAULT 1,
     orchestrator_session_id  TEXT,
     created_at               TEXT NOT NULL,
     updated_at               TEXT NOT NULL,
     started_at               TEXT,
     completed_at             TEXT,
     error                    TEXT,
     purged_at                TEXT,
     FOREIGN KEY (parent_run_id) REFERENCES runs(id)
   );
   CREATE INDEX runs_session ON runs(orchestrator_session_id);
   CREATE INDEX runs_parent ON runs(parent_run_id);
   CREATE INDEX runs_state ON runs(state);

   CREATE TABLE deliverables (
     id          TEXT PRIMARY KEY,
     run_id      TEXT NOT NULL,
     node        TEXT NOT NULL,
     port        TEXT NOT NULL,
     iteration   INTEGER NOT NULL,
     slot        TEXT,
     task_id     TEXT NOT NULL,
     kind        TEXT NOT NULL,
     value       TEXT,
     created_at  TEXT NOT NULL,
     purged_at   TEXT,
     FOREIGN KEY (run_id) REFERENCES runs(id),
     FOREIGN KEY (task_id) REFERENCES tasks(id)
   );
   CREATE UNIQUE INDEX deliverables_address
     ON deliverables(run_id, node, port, iteration, ifnull(slot, ''));
   CREATE INDEX deliverables_run ON deliverables(run_id);
   CREATE INDEX deliverables_task ON deliverables(task_id);

   ALTER TABLE tasks ADD COLUMN run_id TEXT;
   ALTER TABLE tasks ADD COLUMN node TEXT;
   ALTER TABLE tasks ADD COLUMN iteration INTEGER;
   ALTER TABLE tasks ADD COLUMN slot TEXT;
   CREATE INDEX tasks_run ON tasks(run_id);
   CREATE INDEX tasks_run_address ON tasks(run_id, node, iteration, ifnull(slot, ''));`,
  // #244: deliverables.task_id nullable + ON DELETE SET NULL so run retention
  // can keep address rows (and declared-output values) after the producing
  // task expires. SQLite cannot ALTER a FK — rebuild (sessions_new pattern).
  `CREATE TABLE deliverables_new (
     id          TEXT PRIMARY KEY,
     run_id      TEXT NOT NULL,
     node        TEXT NOT NULL,
     port        TEXT NOT NULL,
     iteration   INTEGER NOT NULL,
     slot        TEXT,
     task_id     TEXT,
     kind        TEXT NOT NULL,
     value       TEXT,
     created_at  TEXT NOT NULL,
     purged_at   TEXT,
     FOREIGN KEY (run_id) REFERENCES runs(id),
     FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
   );
   INSERT INTO deliverables_new
     (id, run_id, node, port, iteration, slot, task_id, kind, value, created_at, purged_at)
   SELECT id, run_id, node, port, iteration, slot, task_id, kind, value, created_at, purged_at
   FROM deliverables;
   DROP TABLE deliverables;
   ALTER TABLE deliverables_new RENAME TO deliverables;
   CREATE UNIQUE INDEX deliverables_address
     ON deliverables(run_id, node, port, iteration, ifnull(slot, ''));
   CREATE INDEX deliverables_run ON deliverables(run_id);
   CREATE INDEX deliverables_task ON deliverables(task_id);`,
  // #240 / ADR-0019: runs in the attention inbox, delivery breaker, panicked.
  // - sessions.panicked: sticky enforcing cap (effective concurrency 0).
  // - event_acks generalized to subject_kind+subject_id so runs can be acked
  //   (gates are never acked — only actioned; see inbox.ts).
  // - run_seqs: side table for run event ids + block_reason (ADR-0019 inbox
  //   tier: only `gate` is unackable tier 1; written where the workflow
  //   definition is known — never substring-guessed in the inbox).
  // - event_deliveries: redelivery counter for the delivery breaker (default 10).
  `ALTER TABLE sessions ADD COLUMN panicked INTEGER NOT NULL DEFAULT 0;

   CREATE TABLE event_acks_v2 (
     subject_kind TEXT NOT NULL,
     subject_id   TEXT NOT NULL,
     state        TEXT NOT NULL,
     acked_seq    INTEGER NOT NULL,
     PRIMARY KEY (subject_kind, subject_id, state)
   );
   INSERT INTO event_acks_v2 (subject_kind, subject_id, state, acked_seq)
     SELECT 'task', task_id, state, acked_seq FROM event_acks;
   DROP TABLE event_acks;
   ALTER TABLE event_acks_v2 RENAME TO event_acks;

   CREATE TABLE run_seqs (
     run_id       TEXT PRIMARY KEY,
     seq          INTEGER NOT NULL,
     block_reason TEXT,
     FOREIGN KEY (run_id) REFERENCES runs(id)
   );
   CREATE INDEX run_seqs_seq ON run_seqs(seq);

   CREATE TABLE event_deliveries (
     event_id          INTEGER PRIMARY KEY,
     delivery_count    INTEGER NOT NULL,
     subject_kind      TEXT NOT NULL,
     subject_id        TEXT NOT NULL,
     last_delivered_at TEXT NOT NULL
   );`,
  // #243 / ADR-0020: run metrics dimensions + whole-run eval storage.
  // Mirrors the task eval columns so the same scoreRubric formula applies.
  // size/difficulty/orch_* are filters and group dimensions (no vendor/model/
  // profile — a run has none). Eval columns are null until `parley run eval`.
  `ALTER TABLE runs ADD COLUMN size TEXT;
   ALTER TABLE runs ADD COLUMN difficulty TEXT;
   ALTER TABLE runs ADD COLUMN orch_harness TEXT;
   ALTER TABLE runs ADD COLUMN orch_model TEXT;
   ALTER TABLE runs ADD COLUMN orch_effort TEXT;
   ALTER TABLE runs ADD COLUMN eval_score INTEGER;
   ALTER TABLE runs ADD COLUMN eval_feedback TEXT;
   ALTER TABLE runs ADD COLUMN eval_answers TEXT;
   ALTER TABLE runs ADD COLUMN eval_rubric TEXT;
   ALTER TABLE runs ADD COLUMN eval_rubric_version INTEGER;
   ALTER TABLE runs ADD COLUMN eval_baseline INTEGER;
   ALTER TABLE runs ADD COLUMN eval_session_id TEXT;
   ALTER TABLE runs ADD COLUMN eval_harness TEXT;
   ALTER TABLE runs ADD COLUMN eval_model TEXT;
   ALTER TABLE runs ADD COLUMN eval_effort TEXT;`,
  // #249 / ADR-0022: frozen base ref + resolved commit at run start.
  // Both null for scratch (refuses --base-ref) and for pre-migration rows.
  // Extends ADR-0018: a later fork can rebuild from the recorded commit even
  // when the named branch has moved.
  `ALTER TABLE runs ADD COLUMN base_ref TEXT;
   ALTER TABLE runs ADD COLUMN base_commit TEXT;`,
  // #314 / ADR-0029: persisted remote-runner registration + capability ads.
  // Status (online/offline/stale) is derived from lease long-poll presence +
  // last_seen, not stored. capabilities is JSON RunnerCapabilities.
  `CREATE TABLE runners (
     name TEXT PRIMARY KEY NOT NULL,
     capabilities TEXT NOT NULL,
     protocol_version INTEGER NOT NULL,
     build_version TEXT NOT NULL,
     registered_at TEXT NOT NULL,
     last_seen TEXT NOT NULL
   );`,
  // #313 / #305: repo identity on every task — normalized key + exact origin
  // fetch URL. Local path stays in `repo`. Null when the repo has no origin.
  `ALTER TABLE tasks ADD COLUMN repo_key TEXT;
   ALTER TABLE tasks ADD COLUMN repo_fetch_url TEXT;`,
  // #315 / #304: capability-matched routing — visible wait reason when capable
  // executors exist but none is online; warm-executor last-completion stamp.
  // Requirements are the existing vendor/model columns; hard affinity is the
  // existing `runner` column (set at pin or on claim of an unpinned task).
  `ALTER TABLE tasks ADD COLUMN queue_reason TEXT;
   ALTER TABLE runners ADD COLUMN last_completed_at TEXT;`,
  // #315 durability: absolute ISO deadline for pending remote-routed tasks so
  // restart re-arms or fails on expiry (not an in-memory-only timer).
  `ALTER TABLE tasks ADD COLUMN routing_deadline_at TEXT;`,
  // #315 placement intent: set once at create; dispatchClaim honors it so a
  // remote-routed row never flips to local when runners go offline (and --cwd
  // / workspace-bound never flip to remote on re-dispatch).
  `ALTER TABLE tasks ADD COLUMN placement TEXT;`,
  // #317: git-auth failure category + fail-once-then-avoid routing memory.
  // unreachable_repos: JSON map repo_key → {code, at, operation?}; cleared on
  // re-register. error_category: JSON TaskErrorCategory beside tasks.error.
  `ALTER TABLE runners ADD COLUMN unreachable_repos TEXT;
   ALTER TABLE tasks ADD COLUMN error_category TEXT;`,
];

/** How many schema migrations have been applied — equals `PRAGMA user_version` after open. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Run `fn` inside an explicit SQLite transaction. Commits on success; rolls
 * back and rethrows on failure so each migration step stays atomic.
 */
function withTransaction(db: DatabaseHandle, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back or no active transaction */
    }
    throw err;
  }
}

function migrate(db: DatabaseHandle): void {
  const current = asRow<{ user_version: number }>(db.prepare("PRAGMA user_version").get())
    .user_version;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const statement = MIGRATIONS[version];
    if (statement === undefined) continue;
    withTransaction(db, () => {
      db.exec(statement);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

/**
 * Open (creating on first use) the task-state database and apply migrations.
 * Called by the daemon on start — this is where SQLite is initialized.
 */
export function openDatabase(paths: HomePaths): DatabaseHandle {
  fs.mkdirSync(paths.home, { recursive: true });
  const db = new DatabaseSync(paths.db);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/**
 * Open a database applying only the first `upTo` migrations (target
 * `PRAGMA user_version`). Used by migration tests that need a pre-migration
 * snapshot; production always uses {@link openDatabase}.
 */
export function openDatabaseUpTo(paths: HomePaths, upTo: number): DatabaseHandle {
  fs.mkdirSync(paths.home, { recursive: true });
  const db = new DatabaseSync(paths.db);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const current = asRow<{ user_version: number }>(db.prepare("PRAGMA user_version").get())
    .user_version;
  const target = Math.max(0, Math.min(upTo, MIGRATIONS.length));
  for (let version = current; version < target; version++) {
    const statement = MIGRATIONS[version];
    if (statement === undefined) continue;
    withTransaction(db, () => {
      db.exec(statement);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return db;
}

const TASK_COLUMNS = `id, name, vendor, model, effort, profile, runner, repo, repo_key, repo_fetch_url,
   state, created_at, updated_at,
   cwd, prompt, session_id, usage, report, error, error_category, started_at, completed_at,
   question_id, question, worktree, branch, base_sha, sandbox, network,
   answer_timeout_ms, report_schema, seq, orchestrator_session_id, eval_score, eval_feedback,
   eval_answers, eval_rubric, eval_rubric_version, eval_baseline,
   size, difficulty, type, parent_task_id, attempt, resumed, cached_input_tokens,
   launch_command, model_source, effort_source,
   orch_harness, orch_model, orch_effort,
   eval_session_id, eval_harness, eval_model, eval_effort, queued_at,
   run_id, node, iteration, slot, queue_reason, routing_deadline_at, placement`;

const RUN_COLUMNS = `id, workflow, version, type, workspace, repo, state, current_node, iteration,
   parent_run_id, attempt, orchestrator_session_id, created_at, updated_at,
   started_at, completed_at, error, purged_at,
   size, difficulty, orch_harness, orch_model, orch_effort,
   eval_score, eval_feedback, eval_answers, eval_rubric, eval_rubric_version,
   eval_baseline, eval_session_id, eval_harness, eval_model, eval_effort,
   base_ref, base_commit`;

const DELIVERABLE_COLUMNS = `id, run_id, node, port, iteration, slot, task_id, kind, value,
   created_at, purged_at`;

/** Cast a node:sqlite row result to a domain shape (driver types are untyped maps). */
function asRow<T>(row: unknown): T {
  return row as T;
}

/** List all tasks, newest first. */
export function listTasks(db: DatabaseHandle): TaskRow[] {
  return db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at DESC, id DESC`)
    .all()
    .map((row) => asRow<TaskRow>(row));
}

/**
 * States that occupy a concurrency slot (#171): a live child is (or will be)
 * running. Stalled/pending/queued do not hold a slot.
 */
export const SLOT_HOLDING_STATES: ReadonlySet<string> = new Set([
  "running",
  "awaiting_answer",
]);

/** Queued tasks in FIFO order (`queued_at`, then id) for concurrency drain (#171). */
export function listQueuedTasks(db: DatabaseHandle): TaskRow[] {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE state = 'queued'
       ORDER BY COALESCE(queued_at, created_at) ASC, id ASC`,
    )
    .all()
    .map((row) => asRow<TaskRow>(row));
}

/** Count tasks holding a concurrency slot for a vendor (#171). */
export function countSlotHoldingForVendor(db: DatabaseHandle, vendor: string): number {
  const placeholders = [...SLOT_HOLDING_STATES].map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE vendor = ? AND state IN (${placeholders})`,
    )
    .get(vendor, ...SLOT_HOLDING_STATES);
  return row === undefined ? 0 : asRow<{ n: number }>(row).n;
}

/** Count tasks holding a concurrency slot for a profile (#171). */
export function countSlotHoldingForProfile(db: DatabaseHandle, profile: string): number {
  const placeholders = [...SLOT_HOLDING_STATES].map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE profile = ? AND state IN (${placeholders})`,
    )
    .get(profile, ...SLOT_HOLDING_STATES);
  return row === undefined ? 0 : asRow<{ n: number }>(row).n;
}


/**
 * One orchestrator session aggregated from tasks (#88) — the shape behind
 * `GET /sessions`.
 */
export interface SessionSummary {
  id: string;
  last_activity_at: string;
  task_count: number;
}

/**
 * Distinct orchestrator sessions known via tasks, most-recently-active first
 * (#88). Optional `query` filters by id substring (case-insensitive). Null /
 * empty session ids are excluded.
 */
export function listSessions(db: DatabaseHandle, query?: string): SessionSummary[] {
  const q = query?.trim() ?? "";
  if (q === "") {
    return db
      .prepare(
        `SELECT orchestrator_session_id AS id,
                MAX(updated_at) AS last_activity_at,
                COUNT(*) AS task_count
         FROM tasks
         WHERE orchestrator_session_id IS NOT NULL AND orchestrator_session_id != ''
         GROUP BY orchestrator_session_id
         ORDER BY last_activity_at DESC, id ASC`,
      )
      .all()
      .map((row) => asRow<SessionSummary>(row));
  }
  // SQLite LIKE is case-insensitive for ASCII under the default NOCASE-ish
  // behaviour only with COLLATE NOCASE; bind a lowercased pattern and lower()
  // the column so substring match is case-insensitive regardless of collation.
  return db
    .prepare(
      `SELECT orchestrator_session_id AS id,
              MAX(updated_at) AS last_activity_at,
              COUNT(*) AS task_count
       FROM tasks
       WHERE orchestrator_session_id IS NOT NULL AND orchestrator_session_id != ''
         AND lower(orchestrator_session_id) LIKE ?
       GROUP BY orchestrator_session_id
       ORDER BY last_activity_at DESC, id ASC`,
    )
    .all(`%${q.toLowerCase()}%`)
    .map((row) => asRow<SessionSummary>(row));
}

/** Fetch one task by exact id. */
export function getTask(db: DatabaseHandle, id: string): TaskRow | undefined {
  const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id);
  return row === undefined ? undefined : asRow<TaskRow>(row);
}

/**
 * Resolve a task reference — short id first, then `--name` label (most recent
 * wins on name collisions). Ids and names are interchangeable everywhere.
 */
export function resolveTask(db: DatabaseHandle, ref: string): TaskRow | undefined {
  const byId = getTask(db, ref);
  if (byId) return byId;
  const row = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE name = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(ref);
  return row === undefined ? undefined : asRow<TaskRow>(row);
}

/** Atomically bump (creating on first use) a named monotonic counter. */
function nextCounter(db: DatabaseHandle, name: string): number {
  const row = asRow<{ value: number }>(
    db
      .prepare(
        `INSERT INTO counters (name, value) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .get(name),
  );
  return row.value;
}

/** Allocate the next daemon-assigned short task id (`t1`, `t2`, …). */
export function nextTaskId(db: DatabaseHandle): string {
  return `t${nextCounter(db, "task_id")}`;
}

/** Allocate the next question id (`q1`, `q2`, …) — unique across all tasks. */
export function nextQuestionId(db: DatabaseHandle): string {
  return `q${nextCounter(db, "question_id")}`;
}

/**
 * Stamp a task with the next global transition `seq` (#34) and return it. Called
 * on every state transition so the row always carries the seq of its latest
 * change; the counter is persistent, keeping `seq` monotonic across restarts.
 * Also bumps `updated_at`, since a transition is a mutation.
 */
export function bumpTaskSeq(db: DatabaseHandle, id: string): number {
  const seq = nextCounter(db, "transition_seq");
  db.prepare(`UPDATE tasks SET seq = ?, updated_at = ? WHERE id = ?`).run(
    seq,
    new Date().toISOString(),
    id,
  );
  return seq;
}

/**
 * The current global transition `seq` — the highest seq handed out so far (0
 * before any transition). Read without incrementing; the firehose (`watch
 * --follow`) and SSE stream use it as the "start from now" baseline.
 */
/**
 * Number of tasks still owed work — neither terminal nor stalled. Idle
 * auto-shutdown (#130) gates on this reaching zero: stalled tasks persist
 * their vendor session id, so a later `parley answer` resumes them fine
 * across a daemon restart.
 */
export function countUnsettledTasks(db: DatabaseHandle): number {
  const placeholders = [...SETTLED_STATES].map(() => "?").join(", ");
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state NOT IN (${placeholders})`)
    .get(...[...SETTLED_STATES]);
  return row === undefined ? 0 : asRow<{ n: number }>(row).n;
}

export function currentSeq(db: DatabaseHandle): number {
  const row = db.prepare(`SELECT value FROM counters WHERE name = 'transition_seq'`).get();
  return row === undefined ? 0 : asRow<{ value: number }>(row).value;
}

/**
 * Look up the task whose *current* transition seq is `eventId` (ADR-0007 event
 * id). Returns undefined when no task currently holds that seq — the event was
 * superseded (task moved on) or never existed.
 */
export function getTaskBySeq(db: DatabaseHandle, eventId: number): TaskRow | undefined {
  const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE seq = ?`).get(eventId);
  return row === undefined ? undefined : asRow<TaskRow>(row);
}

/** Subject kind stored in `event_acks` / `event_deliveries` (ADR-0019). */
export type InboxSubjectKind = "task" | "run";

/**
 * Record that the orchestrator handled a subject's current actionable state
 * (ADR-0007 / ADR-0019). Upserts per `(kind, id, state)` so a later re-entry
 * into the same state with a new seq is un-acked again. Caller validates that
 * the event is still current and ackedable (gates are never acked).
 */
export function upsertEventAck(
  db: DatabaseHandle,
  subjectId: string,
  state: string,
  ackedSeq: number,
  subjectKind: InboxSubjectKind = "task",
): void {
  db.prepare(
    `INSERT INTO event_acks (subject_kind, subject_id, state, acked_seq)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(subject_kind, subject_id, state)
     DO UPDATE SET acked_seq = excluded.acked_seq`,
  ).run(subjectKind, subjectId, state, ackedSeq);
}

/**
 * The seq last acked for `(kind, id, state)`, or null when never acked.
 */
export function getEventAck(
  db: DatabaseHandle,
  subjectId: string,
  state: string,
  subjectKind: InboxSubjectKind = "task",
): number | null {
  const row = db
    .prepare(
      `SELECT acked_seq FROM event_acks
       WHERE subject_kind = ? AND subject_id = ? AND state = ?`,
    )
    .get(subjectKind, subjectId, state);
  return row === undefined ? null : asRow<{ acked_seq: number }>(row).acked_seq;
}

/**
 * True when the task's current state has been acked at its current seq — i.e.
 * this actionable state no longer contributes a pending inbox event.
 */
export function isEventAcked(db: DatabaseHandle, task: TaskRow): boolean {
  const acked = getEventAck(db, task.id, task.state, "task");
  return acked !== null && acked === task.seq;
}

/**
 * True when a run's current inbox state has been acked at its current seq.
 * Gates are never acked — callers must not treat gate events as ackedable.
 */
export function isRunEventAcked(
  db: DatabaseHandle,
  runId: string,
  state: string,
  seq: number,
): boolean {
  const acked = getEventAck(db, runId, state, "run");
  return acked !== null && acked === seq;
}

/**
 * Look up the run id whose *current* transition seq is `eventId` (ADR-0019).
 * Returns undefined when no run currently holds that seq.
 */
export function getRunIdBySeq(
  db: DatabaseHandle,
  eventId: number,
): string | undefined {
  const row = db
    .prepare(`SELECT run_id FROM run_seqs WHERE seq = ?`)
    .get(eventId);
  return row === undefined ? undefined : asRow<{ run_id: string }>(row).run_id;
}

/** Current event-id seq for a run, or 0 when never transitioned for the inbox. */
export function getRunSeq(db: DatabaseHandle, runId: string): number {
  const row = db
    .prepare(`SELECT seq FROM run_seqs WHERE run_id = ?`)
    .get(runId);
  return row === undefined ? 0 : asRow<{ seq: number }>(row).seq;
}

/**
 * Stored block reason for a run (`BlockReason` from run-gates), or null when
 * unknown / not blocked. Inbox uses **only** this for gate vs non-gate tier —
 * never the free-text `runs.error` (ADR-0019 / #240 fix).
 */
export function getRunBlockReason(
  db: DatabaseHandle,
  runId: string,
): string | null {
  const row = db
    .prepare(`SELECT block_reason FROM run_seqs WHERE run_id = ?`)
    .get(runId);
  if (row === undefined) return null;
  const reason = asRow<{ block_reason: string | null }>(row).block_reason;
  return reason === null || reason === "" ? null : reason;
}

/**
 * Persist (or clear) the block reason on the run's side-table row without
 * bumping seq. Creates a zero-seq row when none exists yet so a block that
 * has not been firehose-logged is still classified correctly by the inbox.
 */
export function setRunBlockReason(
  db: DatabaseHandle,
  runId: string,
  reason: string | null,
): void {
  db.prepare(
    `INSERT INTO run_seqs (run_id, seq, block_reason) VALUES (?, 0, ?)
     ON CONFLICT(run_id) DO UPDATE SET block_reason = excluded.block_reason`,
  ).run(runId, reason);
}

/**
 * Allocate the next global transition seq and pin it on the run (ADR-0019 event
 * id). Side table so {@link updateRun} stays untouched. When `blockReason` is
 * passed, it is written together with the seq; otherwise any existing
 * `block_reason` is preserved.
 */
export function bumpRunSeq(
  db: DatabaseHandle,
  runId: string,
  opts?: { blockReason?: string | null },
): number {
  const seq = nextCounter(db, "transition_seq");
  if (opts !== undefined && "blockReason" in opts) {
    db.prepare(
      `INSERT INTO run_seqs (run_id, seq, block_reason) VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         seq = excluded.seq,
         block_reason = excluded.block_reason`,
    ).run(runId, seq, opts.blockReason ?? null);
  } else {
    db.prepare(
      `INSERT INTO run_seqs (run_id, seq, block_reason) VALUES (?, ?, NULL)
       ON CONFLICT(run_id) DO UPDATE SET seq = excluded.seq`,
    ).run(runId, seq);
  }
  return seq;
}

/**
 * Default delivery-breaker threshold (ADR-0019): same event id delivered this
 * many times without ack-or-action trips `panicked`.
 */
export const DEFAULT_DELIVERY_BREAKER = 10;

/**
 * Record one delivery of an inbox event. Returns the new delivery count for
 * that event id. Caller trips `panicked` when the count reaches the breaker.
 */
export function recordEventDelivery(
  db: DatabaseHandle,
  eventId: number,
  subjectKind: InboxSubjectKind,
  subjectId: string,
): number {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO event_deliveries
       (event_id, delivery_count, subject_kind, subject_id, last_delivered_at)
     VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       delivery_count = delivery_count + 1,
       last_delivered_at = excluded.last_delivered_at,
       subject_kind = excluded.subject_kind,
       subject_id = excluded.subject_id`,
  ).run(eventId, subjectKind, subjectId, now);
  const row = db
    .prepare(`SELECT delivery_count FROM event_deliveries WHERE event_id = ?`)
    .get(eventId);
  return row === undefined
    ? 1
    : asRow<{ delivery_count: number }>(row).delivery_count;
}

/** Clear delivery tracking for an event id (after ack or action supersedes it). */
export function clearEventDelivery(db: DatabaseHandle, eventId: number): void {
  db.prepare(`DELETE FROM event_deliveries WHERE event_id = ?`).run(eventId);
}

/** Delivery count for an event id, or 0 when never delivered. */
export function getEventDeliveryCount(
  db: DatabaseHandle,
  eventId: number,
): number {
  const row = db
    .prepare(`SELECT delivery_count FROM event_deliveries WHERE event_id = ?`)
    .get(eventId);
  return row === undefined
    ? 0
    : asRow<{ delivery_count: number }>(row).delivery_count;
}

/** True when the session is in the enforcing `panicked` state (ADR-0019). */
export function isSessionPanicked(db: DatabaseHandle, sessionId: string): boolean {
  const row = getSession(db, sessionId);
  return row !== undefined && row.panicked === 1;
}

/**
 * Trip `panicked` on a registered session (sticky, persisted). No-op when the
 * session row does not exist (free-form session ids without registration).
 */
export function setSessionPanicked(db: DatabaseHandle, sessionId: string): void {
  db.prepare(
    `UPDATE sessions SET panicked = 1, updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), sessionId);
}

/**
 * Human-only clear of `panicked` (ADR-0019). Returns false when the session is
 * unknown; true when the row was updated (whether or not it was already clear).
 */
export function clearSessionPanic(db: DatabaseHandle, sessionId: string): boolean {
  const existing = getSession(db, sessionId);
  if (existing === undefined) return false;
  db.prepare(
    `UPDATE sessions SET panicked = 0, updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), sessionId);
  return true;
}

/**
 * Insert a new task in `pending` state and return its row. The id is allocated
 * by the caller (via `nextTaskId`) because worktree creation — which names its
 * branch `parley/<id>-…` — must happen before the row exists.
 */
export function insertTask(db: DatabaseHandle, task: NewTask): TaskRow {
  const now = new Date().toISOString();
  const attempt = task.attempt ?? 1;
  const resumed = task.resumed === true ? 1 : 0;
  db.prepare(
    `INSERT INTO tasks
       (id, name, vendor, model, effort, profile, runner, repo, repo_key, repo_fetch_url,
        state, created_at, updated_at,
        cwd, prompt, session_id, orchestrator_session_id, worktree, branch, base_sha, sandbox,
        network, answer_timeout_ms, report_schema, size, difficulty, type,
        parent_task_id, attempt, resumed, model_source, effort_source,
        orch_harness, orch_model, orch_effort,
        run_id, node, iteration, slot, placement)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.name,
    task.vendor,
    task.model,
    task.effort,
    task.profile,
    task.runner ?? null,
    task.repo,
    task.repo_key ?? null,
    task.repo_fetch_url ?? null,
    now,
    now,
    task.cwd,
    task.prompt,
    task.session_id ?? null,
    task.orchestrator_session_id,
    task.worktree,
    task.branch,
    task.base_sha,
    task.sandbox,
    task.network ? 1 : 0,
    task.answer_timeout_ms,
    task.report_schema,
    task.size,
    task.difficulty,
    task.type,
    task.parent_task_id ?? null,
    attempt,
    resumed,
    task.model_source ?? null,
    task.effort_source ?? null,
    task.orch_harness ?? null,
    task.orch_model ?? null,
    task.orch_effort ?? null,
    task.run_id ?? null,
    task.node ?? null,
    task.iteration ?? null,
    task.slot ?? null,
    task.placement ?? null,
  );
  return getTask(db, task.id)!;
}

/**
 * Capability-matched claim candidate list for one executor (#315 / #304).
 *
 * Replaces the old name-pinned `WHERE runner = ?` query. A candidate is any
 * `pending` task whose vendor the executor advertises and whose hard affinity
 * is either unset or names this executor. Callers apply warm-executor ranking
 * and atomic transition; this is the pure SELECT half.
 *
 * Tasks whose `repo_key` is listed in `unreachableRepoKeys` are excluded
 * (fail-once-then-avoid, #317). Null/`""` repo_key rows are never filtered.
 */
export function listCapablePendingTasks(
  db: DatabaseHandle,
  opts: {
    executorName: string;
    /** Vendor ids this executor advertises. Empty ⇒ no candidates. */
    vendorIds: readonly string[];
    /**
     * Repo keys this executor cannot reach (#317). Omitted/empty ⇒ no filter.
     */
    unreachableRepoKeys?: readonly string[];
  },
): TaskRow[] {
  if (opts.vendorIds.length === 0) return [];
  const placeholders = opts.vendorIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE state = 'pending'
         AND vendor IN (${placeholders})
         AND (runner IS NULL OR runner = '' OR runner = ?)
         AND (placement IS NULL OR placement = 'remote')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(...opts.vendorIds, opts.executorName)
    .map((row) => asRow<TaskRow>(row));
  const blocked = opts.unreachableRepoKeys ?? [];
  if (blocked.length === 0) return rows;
  const blockedSet = new Set(blocked);
  return rows.filter(
    (t) => t.repo_key === null || t.repo_key === "" || !blockedSet.has(t.repo_key),
  );
}

/**
 * Window after task create during which only the warm-preferred online runner
 * may claim an unpinned task (#315). After the window any capable online
 * claimer may take it. Hard pins always match immediately.
 */
export const WARM_CLAIM_RESERVATION_MS = 5_000;

/**
 * Oldest pending task this executor may claim under capability matching
 * (#315 / #304 / #318).
 *
 * Hard-affinity pins always match when capable. Unpinned: within
 * {@link WARM_CLAIM_RESERVATION_MS} of `created_at`, only the warm-preferred
 * online peer may claim; after the window any capable online claimer may take
 * the task. When the preferred peer is not online, any capable claimer may
 * take it immediately.
 *
 * Preference among capable online peers: warm-clone (holds the task's
 * `repo_key` mirror) over warm-executor (most recent `last_completed_at`),
 * then name ASC. Excluded peers (#317) never hold the reservation.
 */
export function selectClaimablePendingTask(
  db: DatabaseHandle,
  opts: {
    executorName: string;
    vendorIds: readonly string[];
    /**
     * Online peers (including self) advertising vendors, for warm ranking.
     * Omit or empty ⇒ this executor claims any candidate it can.
     */
    onlinePeers?: ReadonlyArray<{
      name: string;
      vendorIds: readonly string[];
      last_completed_at: string | null;
      /**
       * Repo keys this peer cannot reach (#317). Peers that cannot reach the
       * candidate's `repo_key` are dropped from warm ranking so they do not
       * hold the reservation for a task they will never claim.
       */
      unreachableRepoKeys?: readonly string[];
      /**
       * Repo keys for which this peer holds a managed mirror (#318).
       * Warm-clone preference ranks holders above cold peers.
       */
      heldMirrors?: readonly string[];
    }>;
    /**
     * Repo keys this executor cannot reach (#317). Forwarded to
     * {@link listCapablePendingTasks}.
     */
    unreachableRepoKeys?: readonly string[];
    /** Override clock for tests (ms since epoch). */
    nowMs?: number;
    /** Override reservation window for tests. */
    reservationMs?: number;
  },
): TaskRow | undefined {
  const candidates = listCapablePendingTasks(db, {
    executorName: opts.executorName,
    vendorIds: opts.vendorIds,
    unreachableRepoKeys: opts.unreachableRepoKeys,
  });
  if (candidates.length === 0) return undefined;
  const peers = opts.onlinePeers ?? [];
  const now = opts.nowMs ?? Date.now();
  const reservationMs = opts.reservationMs ?? WARM_CLAIM_RESERVATION_MS;

  for (const task of candidates) {
    const affinity = task.runner !== null && task.runner !== "" ? task.runner : null;
    if (affinity !== null) return task;

    const vendor = task.vendor ?? "";
    if (vendor === "") continue;

    const repoKey = task.repo_key;
    const capableOnline = peers.filter((p) => {
      if (!p.vendorIds.includes(vendor)) return false;
      // Fail-once-then-avoid: excluded pairings do not hold warm reservation.
      if (
        repoKey !== null &&
        repoKey !== "" &&
        (p.unreachableRepoKeys ?? []).includes(repoKey)
      ) {
        return false;
      }
      return true;
    });
    if (capableOnline.length <= 1) return task;

    const preferred = preferredWarmRunner(capableOnline, repoKey);
    if (preferred === null || preferred === opts.executorName) return task;

    const created = Date.parse(task.created_at);
    const age = Number.isFinite(created) ? now - created : reservationMs + 1;
    // Reservation expired → any capable claimer.
    if (age >= reservationMs) return task;
    // Still reserved for a warmer online peer — leave it.
  }
  return undefined;
}

/**
 * Warm-preferred runner among online peers (#315 / #318):
 * 1. Prefer peers that hold a mirror for `repoKey` (warm-clone)
 * 2. Among the preferred set (or all peers when none hold the mirror), most
 *    recent completion first, then name ASC.
 * Null when the list is empty.
 */
export function preferredWarmRunner(
  peers: ReadonlyArray<{
    name: string;
    last_completed_at: string | null;
    heldMirrors?: readonly string[];
  }>,
  repoKey: string | null = null,
): string | null {
  if (peers.length === 0) return null;
  let pool = peers;
  if (repoKey !== null && repoKey !== "") {
    const withClone = peers.filter((p) => {
      const held = p.heldMirrors;
      return Array.isArray(held) && held.includes(repoKey);
    });
    if (withClone.length > 0) pool = withClone;
  }
  const ranked = [...pool].sort((a, b) => {
    const at = a.last_completed_at ? Date.parse(a.last_completed_at) : 0;
    const bt = b.last_completed_at ? Date.parse(b.last_completed_at) : 0;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name);
  });
  return ranked[0]?.name ?? null;
}

/**
 * Pending tasks waiting on remote routing (#315): any with a durable deadline
 * or a visible queue_reason (capable-but-offline).
 */
export function listRoutingWaitTasks(db: DatabaseHandle): TaskRow[] {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE state = 'pending'
         AND (queue_reason IS NOT NULL OR routing_deadline_at IS NOT NULL)
       ORDER BY created_at ASC, id ASC`,
    )
    .all()
    .map((row) => asRow<TaskRow>(row));
}

/**
 * Startup crash sweep (spec §3): local tasks that held a live child
 * (`running` / `awaiting_answer`) when the previous daemon died are marked
 * `stalled` — their children ran in the daemon's process group and died with
 * it. Terminal and already-stalled tasks are untouched. Questions stay
 * recorded; a stalled task resumes via `parley answer` like any other.
 * Returns the number swept.
 *
 * Runner-affine tasks (#111 / ADR-0012) are excluded: their children live on
 * the remote runner host. Pending tasks (including capability-routing waits,
 * #315) and concurrency-queued tasks (#171) have no child process — they
 * survive restart.
 */
export function sweepInterruptedTasks(db: DatabaseHandle): number {
  // Only states that can hold a local child process.
  const live = db
    .prepare(
      `SELECT id FROM tasks
       WHERE state IN ('running', 'awaiting_answer')
         AND (runner IS NULL OR runner = '')`,
    )
    .all()
    .map((row) => asRow<{ id: string }>(row));
  const result = db
    .prepare(
      `UPDATE tasks SET state = 'stalled', error = ?, updated_at = ?
       WHERE state IN ('running', 'awaiting_answer')
         AND (runner IS NULL OR runner = '')`,
    )
    .run(
      "daemon restarted while the task was live; the child died with the daemon's process group",
      new Date().toISOString(),
    );
  // Bootstrap transition (#206): bulk SQL state write + per-id seq bump only.
  // No in-memory event log / waiter wake — the engine is not constructed until
  // after the sweep. Watchers that attach later see the post-sweep state, never
  // the stall as a live event. Optional `recordExternal` on TaskTransitions can
  // append to the log once the engine exists; today we only stamp seq.
  for (const { id } of live) bumpTaskSeq(db, id);
  // node:sqlite types `changes` as number | bigint; for our UPDATE counts it is a number.
  return Number(result.changes);
}

/**
 * Mutable task fields excluding `state` (#206). Lifecycle state writes go
 * through `writeTaskState` / `TaskTransitions.apply` so seq + notify stay paired.
 */
export type TaskDataPatch = Partial<
  Pick<
    TaskRow,
    | "session_id"
    | "usage"
    | "report"
    | "error"
    | "error_category"
    | "started_at"
    | "completed_at"
    | "question_id"
    | "question"
    | "worktree"
    | "branch"
    /** Claim-time resolved base commit; set when deferred mirror workspace is prepared (#318). */
    | "base_sha"
    /** Cleared with worktree on clean so fix can tell cleaned wt from --cwd (#180). */
    | "cwd"
    | "eval_score"
    | "eval_feedback"
    | "eval_answers"
    | "eval_rubric"
    | "eval_rubric_version"
    | "eval_baseline"
    | "cached_input_tokens"
    | "model"
    | "effort"
    | "model_source"
    | "effort_source"
    | "launch_command"
    | "orch_harness"
    | "orch_model"
    | "orch_effort"
    | "eval_session_id"
    | "eval_harness"
    | "eval_model"
    | "eval_effort"
    | "queued_at"
    | "queue_reason"
    | "routing_deadline_at"
    | "placement"
    | "runner"
  >
>;

/**
 * @deprecated Alias of {@link TaskDataPatch}. Prefer `TaskDataPatch`; `state` is
 * no longer part of the public patch surface (#206).
 */
export type TaskPatch = TaskDataPatch;

/** Patch mutable non-state task fields; bumps `updated_at`. */
export function updateTask(db: DatabaseHandle, id: string, patch: TaskDataPatch): void {
  applyTaskPatch(db, id, patch);
}

/**
 * Privileged lifecycle write: set `state` (+ optional co-fields) in one UPDATE.
 * Intended for `transition.ts` (and tests). Production call sites should use
 * `TaskTransitions.apply` so seq / log / wake stay paired (#206).
 */
export function writeTaskState(
  db: DatabaseHandle,
  id: string,
  state: TaskState,
  fields?: TaskDataPatch,
): void {
  applyTaskPatch(db, id, { ...fields, state });
}

/** Internal SQL patch helper — accepts state only via {@link writeTaskState}. */
function applyTaskPatch(
  db: DatabaseHandle,
  id: string,
  patch: TaskDataPatch & { state?: TaskState },
): void {
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const assignments = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => patch[f as keyof typeof patch] ?? null);
  db.prepare(`UPDATE tasks SET ${assignments}, updated_at = ? WHERE id = ?`).run(
    ...values,
    new Date().toISOString(),
    id,
  );
}

/**
 * One durable Q&A turn (#79) as stored and returned on task detail. Matches the
 * wire {@link import("@useparley/core").QaTurn} floor shape plus ordering keys.
 */
export interface QaTurnRow {
  question_id: string;
  question: string;
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
}

/**
 * Record a new outstanding `ask_orchestrator` turn (answer null) at the end of
 * this task's history. Called when the task enters `awaiting_answer`.
 */
export function insertQaTurn(
  db: DatabaseHandle,
  taskId: string,
  questionId: string,
  question: string,
): void {
  const askedAt = new Date().toISOString();
  const ord = asRow<{ n: number }>(
    db
      .prepare(
        `SELECT COALESCE(MAX(ask_ord), 0) + 1 AS n FROM qa_turns WHERE task_id = ?`,
      )
      .get(taskId),
  ).n;
  db.prepare(
    `INSERT INTO qa_turns (task_id, question_id, question, answer, ask_ord, asked_at, answered_at)
     VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
  ).run(taskId, questionId, question, ord, askedAt);
}

/**
 * Fill in the answer for an existing turn in place. No-op when the turn is
 * missing (e.g. a pre-migration task that never had history recorded).
 */
export function answerQaTurn(
  db: DatabaseHandle,
  taskId: string,
  questionId: string,
  answer: string,
): void {
  db.prepare(
    `UPDATE qa_turns SET answer = ?, answered_at = ?
     WHERE task_id = ? AND question_id = ? AND answer IS NULL`,
  ).run(answer, new Date().toISOString(), taskId, questionId);
}

/** List a task's Q&A history in ask order. Empty for tasks with no turns. */
export function listQaTurns(db: DatabaseHandle, taskId: string): QaTurnRow[] {
  return db
    .prepare(
      `SELECT question_id, question, answer, asked_at, answered_at
       FROM qa_turns WHERE task_id = ? ORDER BY ask_ord ASC`,
    )
    .all(taskId)
    .map((row) => asRow<QaTurnRow>(row));
}

/** Meta key for the last completed retention sweep (#153). ISO-8601 timestamp. */
export const META_LAST_GC_AT = "last_gc_at";

/** Read a meta value, or `null` when unset. */
export function getMeta(db: DatabaseHandle, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
  return row === undefined ? null : asRow<{ value: string }>(row).value;
}

/** Upsert a meta key/value pair. */
export function setMeta(db: DatabaseHandle, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * Permanently delete a task row and its dependent rows (`qa_turns`,
 * `event_acks`). Does not touch the filesystem (logs/worktrees) — callers
 * remove those before or after. Used by retention gc (#153 / #244).
 *
 * Deliverables:
 * - **Standalone** (no `run_id`): hard-deleted with the task (today's #153
 *   behaviour — no run product to retain).
 * - **Run-owned**: left in place. FK is `ON DELETE SET NULL` so `task_id`
 *   becomes null; the address (and declared-output values) survive so the
 *   run can decay rather than expire (#244). Callers decay non-declared
 *   deliverable values *before* calling this.
 */
export function deleteTask(db: DatabaseHandle, taskId: string): void {
  withTransaction(db, () => {
    const task = getTask(db, taskId);
    db.prepare(`DELETE FROM qa_turns WHERE task_id = ?`).run(taskId);
    // event_acks is subject-scoped since #240; a task's acks are subject_kind
    // 'task'. Run acks are keyed by run id and outlive the task.
    db.prepare(
      `DELETE FROM event_acks WHERE subject_kind = 'task' AND subject_id = ?`,
    ).run(taskId);
    // Standalone only — run-owned deliverables ride ON DELETE SET NULL (#244).
    if (task === undefined || task.run_id === null) {
      db.prepare(`DELETE FROM deliverables WHERE task_id = ?`).run(taskId);
    }
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
  });
}

/**
 * Terminal tasks whose `completed_at` is at or before `cutoffIso` (retention
 * expiry). Non-terminal tasks are never returned. Tasks missing `completed_at`
 * fall back to `updated_at` so legacy rows still expire.
 */
export function listExpiredTasks(db: DatabaseHandle, cutoffIso: string): TaskRow[] {
  const placeholders = [...TERMINAL_STATES].map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE state IN (${placeholders})
         AND COALESCE(completed_at, updated_at) <= ?
       ORDER BY COALESCE(completed_at, updated_at) ASC, id ASC`,
    )
    .all(...TERMINAL_STATES, cutoffIso)
    .map((row) => asRow<TaskRow>(row));
}

// ---------------------------------------------------------------------------
// Orchestrator sessions (#162)
// ---------------------------------------------------------------------------

/**
 * A process-ancestry anchor: machine-id namespaces remote daemons; pid +
 * start-time defeats pid recycling. Walked client-side; stored + matched
 * daemon-side.
 */
export interface ProcessAnchor {
  machine_id: string;
  pid: number;
  /** Opaque start-time token from the client process table (e.g. /proc starttime). */
  start_time: string;
}

/** A registered orchestrator session row (#162 / #190). */
export interface SessionRow {
  id: string;
  /** Null when registered without PARLEY_HARNESS (unknown provenance). */
  harness: string | null;
  /** Null when registered without PARLEY_MODEL (unknown provenance). */
  model: string | null;
  /** Null when registered without PARLEY_EFFORT (unknown provenance). */
  effort: string | null;
  workspace_root: string;
  anchor_machine: string;
  anchor_pid: number;
  anchor_start: string;
  created_at: string;
  updated_at: string;
  /**
   * ADR-0019 delivery-breaker trip: 1 when the session is *panicked*
   * (enforcing effective concurrency cap of 0). Sticky across restarts;
   * cleared only by a human ({@link clearSessionPanic}).
   */
  panicked: number;
}

const SESSION_COLUMNS = `id, harness, model, effort, workspace_root,
   anchor_machine, anchor_pid, anchor_start, created_at, updated_at, panicked`;

/** Fetch one registered session by id. */
export function getSession(db: DatabaseHandle, id: string): SessionRow | undefined {
  const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id);
  return row === undefined ? undefined : asRow<SessionRow>(row);
}

/**
 * True when any task is stamped with this orchestrator session id (#256).
 * Free-form bindings (no sessions row) still count as known for watch.
 */
export function sessionHasTasks(db: DatabaseHandle, sessionId: string): boolean {
  if (sessionId === "") return false;
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM tasks WHERE orchestrator_session_id = ? LIMIT 1`,
    )
    .get(sessionId);
  return row !== undefined;
}

/** All registered sessions for a workspace root (live set for fallback). */
export function listSessionsForWorkspace(
  db: DatabaseHandle,
  workspaceRoot: string,
): SessionRow[] {
  return db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE workspace_root = ?
       ORDER BY updated_at DESC, id ASC`,
    )
    .all(workspaceRoot)
    .map((row) => asRow<SessionRow>(row));
}

/** Every registered session (for ancestry matching across workspaces). */
export function listAllSessions(db: DatabaseHandle): SessionRow[] {
  return db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC, id ASC`)
    .all()
    .map((row) => asRow<SessionRow>(row));
}

/**
 * Insert a new orchestrator session. Caller allocates `id` (fresh or re-anchor
 * path). Anchor is the registering process's own triple. Harness/model/effort
 * may be null (#190 unknown provenance).
 */
export function insertSession(
  db: DatabaseHandle,
  session: {
    id: string;
    harness: string | null;
    model: string | null;
    effort: string | null;
    workspace_root: string;
    anchor: ProcessAnchor;
  },
): SessionRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions
       (id, harness, model, effort, workspace_root,
        anchor_machine, anchor_pid, anchor_start, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.harness,
    session.model,
    session.effort,
    session.workspace_root,
    session.anchor.machine_id,
    session.anchor.pid,
    session.anchor.start_time,
    now,
    now,
  );
  return getSession(db, session.id)!;
}

/**
 * Re-anchor an existing session and/or update harness/model/effort (#162).
 * Never mutates task dual-snapshot columns. Null provenance is allowed (#190).
 */
export function updateSession(
  db: DatabaseHandle,
  id: string,
  patch: {
    harness: string | null;
    model: string | null;
    effort: string | null;
    workspace_root: string;
    anchor: ProcessAnchor;
  },
): SessionRow {
  db.prepare(
    `UPDATE sessions SET
       harness = ?, model = ?, effort = ?, workspace_root = ?,
       anchor_machine = ?, anchor_pid = ?, anchor_start = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.harness,
    patch.model,
    patch.effort,
    patch.workspace_root,
    patch.anchor.machine_id,
    patch.anchor.pid,
    patch.anchor.start_time,
    new Date().toISOString(),
    id,
  );
  return getSession(db, id)!;
}

/** Sessions whose `updated_at` is at or before `cutoffIso` (retention expiry). */
export function listExpiredSessions(db: DatabaseHandle, cutoffIso: string): SessionRow[] {
  return db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE updated_at <= ?
       ORDER BY updated_at ASC, id ASC`,
    )
    .all(cutoffIso)
    .map((row) => asRow<SessionRow>(row));
}

/** Permanently delete a registered session row. */
export function deleteSession(db: DatabaseHandle, id: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

// ---------------------------------------------------------------------------
// Runs + deliverables (#233 / ADR-0016, 0017, 0018)
// ---------------------------------------------------------------------------

/** Allocate the next short run id (`r1`, `r2`, …). */
export function nextRunId(db: DatabaseHandle): string {
  return `r${nextCounter(db, "run_id")}`;
}

/** Allocate the next short deliverable id (`d1`, `d2`, …). */
export function nextDeliverableId(db: DatabaseHandle): string {
  return `d${nextCounter(db, "deliverable_id")}`;
}

/** Fetch one run by exact id. */
export function getRun(db: DatabaseHandle, id: string): RunRow | undefined {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id);
  return row === undefined ? undefined : asRow<RunRow>(row);
}

/**
 * Resolve a run reference — exact id only for now (runs have no `--name` label).
 * Kept as a seam so the query surface can later accept aliases without
 * changing callers.
 */
export function resolveRun(db: DatabaseHandle, ref: string): RunRow | undefined {
  return getRun(db, ref);
}

/** List all runs, newest first. */
export function listRuns(db: DatabaseHandle): RunRow[] {
  return db
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY created_at DESC, id DESC`)
    .all()
    .map((row) => asRow<RunRow>(row));
}

/**
 * Runs for one orchestrator session, newest first. Empty/null session ids are
 * never matched (same discipline as {@link listSessions}).
 */
export function listRunsForSession(db: DatabaseHandle, sessionId: string): RunRow[] {
  if (sessionId === "") return [];
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs
       WHERE orchestrator_session_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(sessionId)
    .map((row) => asRow<RunRow>(row));
}

/** Fork children of a parent run, ordered by attempt then id. */
export function listChildRuns(db: DatabaseHandle, parentRunId: string): RunRow[] {
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs
       WHERE parent_run_id = ?
       ORDER BY attempt ASC, id ASC`,
    )
    .all(parentRunId)
    .map((row) => asRow<RunRow>(row));
}

/**
 * Insert a new run and return its row. The id is allocated by the caller (via
 * {@link nextRunId}) because workspace layout names paths/branches with the id
 * before the row exists (ADR-0018).
 */
export function insertRun(db: DatabaseHandle, run: NewRun): RunRow {
  const now = new Date().toISOString();
  const state: RunState = run.state ?? "running";
  const iteration = run.iteration ?? 1;
  const attempt = run.attempt ?? 1;
  db.prepare(
    `INSERT INTO runs
       (id, workflow, version, type, workspace, repo, state, current_node, iteration,
        parent_run_id, attempt, orchestrator_session_id, created_at, updated_at,
        started_at, completed_at, error, purged_at, base_ref, base_commit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
  ).run(
    run.id,
    run.workflow,
    run.version,
    run.type,
    run.workspace,
    run.repo,
    state,
    run.current_node,
    iteration,
    run.parent_run_id ?? null,
    attempt,
    run.orchestrator_session_id ?? null,
    now,
    now,
    run.started_at ?? now,
    run.error ?? null,
    run.base_ref ?? null,
    run.base_commit ?? null,
  );
  return getRun(db, run.id)!;
}

/** Mutable run fields the engine / retention / eval may patch. */
export type RunDataPatch = Partial<
  Pick<
    RunRow,
    | "state"
    | "current_node"
    | "iteration"
    | "repo"
    | "error"
    | "started_at"
    | "completed_at"
    | "purged_at"
    | "orchestrator_session_id"
    | "size"
    | "difficulty"
    | "orch_harness"
    | "orch_model"
    | "orch_effort"
    | "eval_score"
    | "eval_feedback"
    | "eval_answers"
    | "eval_rubric"
    | "eval_rubric_version"
    | "eval_baseline"
    | "eval_session_id"
    | "eval_harness"
    | "eval_model"
    | "eval_effort"
  >
>;

/** Patch mutable run fields; bumps `updated_at`. */
export function updateRun(db: DatabaseHandle, id: string, patch: RunDataPatch): void {
  const fields = Object.keys(patch) as (keyof RunDataPatch)[];
  if (fields.length === 0) return;
  const assignments = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => patch[f] ?? null);
  db.prepare(`UPDATE runs SET ${assignments}, updated_at = ? WHERE id = ?`).run(
    ...values,
    new Date().toISOString(),
    id,
  );
}

/**
 * Permanently delete a run and its deliverable rows. Tasks owned by the run are
 * *not* deleted — callers must settle and/or delete them first (retention #244
 * owns the full sweep). Fails if deliverable FKs would be left dangling only
 * when tasks still reference the run; SQLite does not enforce `tasks.run_id`.
 */
export function deleteRun(db: DatabaseHandle, runId: string): void {
  withTransaction(db, () => {
    db.prepare(`DELETE FROM deliverables WHERE run_id = ?`).run(runId);
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
  });
}

/** Tasks owned by a run, oldest first (spawn order). */
export function listTasksForRun(db: DatabaseHandle, runId: string): TaskRow[] {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE run_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(runId)
    .map((row) => asRow<TaskRow>(row));
}

/**
 * Tasks for one (run, node, iteration), optional slot filter. Ordered by
 * created_at so retries/fan-out siblings are stable. Used by node projections
 * (step state is derived — never stored).
 */
export function listTasksForRunNode(
  db: DatabaseHandle,
  runId: string,
  node: string,
  iteration: number,
  slot?: string | null,
): TaskRow[] {
  if (slot === undefined) {
    return db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE run_id = ? AND node = ? AND iteration = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(runId, node, iteration)
      .map((row) => asRow<TaskRow>(row));
  }
  if (slot === null) {
    return db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE run_id = ? AND node = ? AND iteration = ? AND slot IS NULL
         ORDER BY created_at ASC, id ASC`,
      )
      .all(runId, node, iteration)
      .map((row) => asRow<TaskRow>(row));
  }
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE run_id = ? AND node = ? AND iteration = ? AND slot = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(runId, node, iteration, slot)
    .map((row) => asRow<TaskRow>(row));
}

/** Fetch one deliverable by exact id. */
export function getDeliverable(
  db: DatabaseHandle,
  id: string,
): DeliverableRow | undefined {
  const row = db
    .prepare(`SELECT ${DELIVERABLE_COLUMNS} FROM deliverables WHERE id = ?`)
    .get(id);
  return row === undefined ? undefined : asRow<DeliverableRow>(row);
}

/**
 * Look up a deliverable by structural address (ADR-0016). `slot` null matches
 * the no-fan-out row (slot IS NULL).
 */
export function getDeliverableByAddress(
  db: DatabaseHandle,
  runId: string,
  node: string,
  port: string,
  iteration: number,
  slot: string | null = null,
): DeliverableRow | undefined {
  const row =
    slot === null
      ? db
          .prepare(
            `SELECT ${DELIVERABLE_COLUMNS} FROM deliverables
             WHERE run_id = ? AND node = ? AND port = ? AND iteration = ?
               AND slot IS NULL`,
          )
          .get(runId, node, port, iteration)
      : db
          .prepare(
            `SELECT ${DELIVERABLE_COLUMNS} FROM deliverables
             WHERE run_id = ? AND node = ? AND port = ? AND iteration = ?
               AND slot = ?`,
          )
          .get(runId, node, port, iteration, slot);
  return row === undefined ? undefined : asRow<DeliverableRow>(row);
}

/** All deliverables for a run, address order. */
export function listDeliverablesForRun(
  db: DatabaseHandle,
  runId: string,
): DeliverableRow[] {
  return db
    .prepare(
      `SELECT ${DELIVERABLE_COLUMNS} FROM deliverables
       WHERE run_id = ?
       ORDER BY node ASC, iteration ASC, ifnull(slot, '') ASC, port ASC, id ASC`,
    )
    .all(runId)
    .map((row) => asRow<DeliverableRow>(row));
}

/** Deliverables produced by one task. */
export function listDeliverablesForTask(
  db: DatabaseHandle,
  taskId: string,
): DeliverableRow[] {
  return db
    .prepare(
      `SELECT ${DELIVERABLE_COLUMNS} FROM deliverables
       WHERE task_id = ?
       ORDER BY port ASC, id ASC`,
    )
    .all(taskId)
    .map((row) => asRow<DeliverableRow>(row));
}

/**
 * Insert a deliverable row. The id is allocated by the caller. Address uniqueness
 * is enforced by the `deliverables_address` unique index (slot null coalesces to '').
 */
export function insertDeliverable(
  db: DatabaseHandle,
  deliverable: NewDeliverable,
): DeliverableRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO deliverables
       (id, run_id, node, port, iteration, slot, task_id, kind, value, created_at, purged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    deliverable.id,
    deliverable.run_id,
    deliverable.node,
    deliverable.port,
    deliverable.iteration,
    deliverable.slot ?? null,
    deliverable.task_id,
    deliverable.kind,
    deliverable.value,
    now,
    deliverable.purged_at ?? null,
  );
  return getDeliverable(db, deliverable.id)!;
}

/**
 * Mark a deliverable purged: clear the value, stamp `purged_at`. The address
 * row remains so the query surface can say what is gone (ADR-0016 / #244).
 * No-op when the id is missing.
 */
export function purgeDeliverable(
  db: DatabaseHandle,
  id: string,
  purgedAt: string = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE deliverables SET value = NULL, purged_at = ? WHERE id = ?`,
  ).run(purgedAt, id);
}

/**
 * Mark a run purged (retention decay, #244). Does not delete the row or its
 * tasks — only stamps `purged_at` so surfaces can render the decayed state.
 */
export function purgeRun(
  db: DatabaseHandle,
  id: string,
  purgedAt: string = new Date().toISOString(),
): void {
  updateRun(db, id, { purged_at: purgedAt });
}

/**
 * Terminal runs past the retention cutoff that have not yet been stamped
 * purged (#244). Same clock as {@link listExpiredTasks}:
 * `COALESCE(completed_at, updated_at) <= cutoffIso`. Live / blocked runs are
 * never returned — a gate may hold a run open past the window.
 */
export function listExpiredRuns(db: DatabaseHandle, cutoffIso: string): RunRow[] {
  const placeholders = [...RUN_TERMINAL_STATES].map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs
       WHERE state IN (${placeholders})
         AND purged_at IS NULL
         AND COALESCE(completed_at, updated_at) <= ?
       ORDER BY COALESCE(completed_at, updated_at) ASC, id ASC`,
    )
    .all(...RUN_TERMINAL_STATES, cutoffIso)
    .map((row) => asRow<RunRow>(row));
}
// ── #241 run query surface ──────────────────────────────────────────────────
// Append-only SELECTs for the query surface. Do not edit above this block.
// Column lists are copied intentionally so this block never touches existing
// constants (sibling ownership on earlier regions of this file).

const RUN_QUERY_RUN_COLUMNS = `id, workflow, version, type, workspace, repo, state, current_node, iteration,
   parent_run_id, attempt, orchestrator_session_id, created_at, updated_at,
   started_at, completed_at, error, purged_at,
   size, difficulty, orch_harness, orch_model, orch_effort,
   eval_score, eval_feedback, eval_answers, eval_rubric, eval_rubric_version,
   eval_baseline, eval_session_id, eval_harness, eval_model, eval_effort,
   base_ref, base_commit`;

const RUN_QUERY_TASK_COLUMNS = `id, name, vendor, model, effort, profile, runner, repo, repo_key, repo_fetch_url,
   state, created_at, updated_at,
   cwd, prompt, session_id, usage, report, error, error_category, started_at, completed_at,
   question_id, question, worktree, branch, base_sha, sandbox, network,
   answer_timeout_ms, report_schema, seq, orchestrator_session_id, eval_score, eval_feedback,
   eval_answers, eval_rubric, eval_rubric_version, eval_baseline,
   size, difficulty, type, parent_task_id, attempt, resumed, cached_input_tokens,
   launch_command, model_source, effort_source,
   orch_harness, orch_model, orch_effort,
   eval_session_id, eval_harness, eval_model, eval_effort, queued_at,
   run_id, node, iteration, slot, queue_reason, routing_deadline_at, placement`;

const RUN_QUERY_DELIVERABLE_COLUMNS = `id, run_id, node, port, iteration, slot, task_id, kind, value,
   created_at, purged_at`;

/** Filters for the run list query surface (#241). */
export interface RunListFilters {
  /** Orchestrator session id; omit for every session. */
  session?: string | null;
  /** Workflow definition id. */
  workflow?: string | null;
  /** Exact run state (`running`|`blocked`|…). */
  state?: string | null;
}

/**
 * List runs with optional session / workflow / state filters, newest first.
 * Used by `GET /runs` and `parley run status`.
 */
export function listRunsFiltered(
  db: DatabaseHandle,
  filters: RunListFilters = {},
): RunRow[] {
  const where: string[] = [];
  const params: (string | number | null)[] = [];
  if (filters.session !== undefined && filters.session !== null && filters.session !== "") {
    where.push("orchestrator_session_id = ?");
    params.push(filters.session);
  }
  if (filters.workflow !== undefined && filters.workflow !== null && filters.workflow !== "") {
    where.push("workflow = ?");
    params.push(filters.workflow);
  }
  if (filters.state !== undefined && filters.state !== null && filters.state !== "") {
    where.push("state = ?");
    params.push(filters.state);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT ${RUN_QUERY_RUN_COLUMNS} FROM runs
       ${clause}
       ORDER BY created_at DESC, id DESC`,
    )
    .all(...params)
    .map((row) => asRow<RunRow>(row));
}

/**
 * Deliverables for one (run, node, iteration), optional port/slot filter.
 * Address order.
 */
export function listDeliverablesForRunNode(
  db: DatabaseHandle,
  runId: string,
  node: string,
  iteration: number,
  port?: string | null,
  slot?: string | null,
): DeliverableRow[] {
  const where = ["run_id = ?", "node = ?", "iteration = ?"];
  const params: (string | number | null)[] = [runId, node, iteration];
  if (port !== undefined && port !== null) {
    where.push("port = ?");
    params.push(port);
  }
  if (slot === null) {
    where.push("slot IS NULL");
  } else if (slot !== undefined) {
    where.push("slot = ?");
    params.push(slot);
  }
  return db
    .prepare(
      `SELECT ${RUN_QUERY_DELIVERABLE_COLUMNS} FROM deliverables
       WHERE ${where.join(" AND ")}
       ORDER BY ifnull(slot, '') ASC, port ASC, id ASC`,
    )
    .all(...params)
    .map((row) => asRow<DeliverableRow>(row));
}

/**
 * Latest iteration that has tasks or deliverables for a node in a run.
 * Null when the node has never been visited.
 */
export function latestNodeIteration(
  db: DatabaseHandle,
  runId: string,
  node: string,
): number | null {
  const fromTasks = db
    .prepare(
      `SELECT MAX(iteration) AS m FROM tasks
       WHERE run_id = ? AND node = ? AND iteration IS NOT NULL`,
    )
    .get(runId, node);
  const fromDels = db
    .prepare(
      `SELECT MAX(iteration) AS m FROM deliverables
       WHERE run_id = ? AND node = ?`,
    )
    .get(runId, node);
  const t = asRow<{ m: number | null }>(fromTasks).m;
  const d = asRow<{ m: number | null }>(fromDels).m;
  if (t === null && d === null) return null;
  return Math.max(t ?? 0, d ?? 0);
}

/**
 * All tasks for a run that belong to a given node (any iteration), oldest first.
 * Optional iteration / slot filters for node-detail zoom.
 */
export function listTasksForRunNodeAny(
  db: DatabaseHandle,
  runId: string,
  node: string,
  iteration?: number | null,
  slot?: string | null,
): TaskRow[] {
  const where = ["run_id = ?", "node = ?"];
  const params: (string | number | null)[] = [runId, node];
  if (iteration !== undefined && iteration !== null) {
    where.push("iteration = ?");
    params.push(iteration);
  }
  if (slot === null) {
    where.push("slot IS NULL");
  } else if (slot !== undefined) {
    where.push("slot = ?");
    params.push(slot);
  }
  return db
    .prepare(
      `SELECT ${RUN_QUERY_TASK_COLUMNS} FROM tasks
       WHERE ${where.join(" AND ")}
       ORDER BY created_at ASC, id ASC`,
    )
    .all(...params)
    .map((row) => asRow<TaskRow>(row));
}

// ── end #241 ──

// ── #243 run metrics + whole-run eval ───────────────────────────────────────
// Append-only helpers. Do not edit the runs section above — sibling #242 owns
// fork/redirect plumbing there. Column lists above already include #243 fields
// so getRun/listRuns return them; helpers below are for eval-specific writes
// and metrics aggregation.

/**
 * Patch only the structured-eval fields on a run (#243). Separated so eval
 * never has to share a write path with engine state transitions.
 */
export function updateRunEval(
  db: DatabaseHandle,
  id: string,
  patch: Pick<
    RunDataPatch,
    | "eval_score"
    | "eval_feedback"
    | "eval_answers"
    | "eval_rubric"
    | "eval_rubric_version"
    | "eval_baseline"
    | "eval_session_id"
    | "eval_harness"
    | "eval_model"
    | "eval_effort"
  >,
): void {
  updateRun(db, id, patch);
}

// ─── Remote runners (ADR-0029 / #314) ───────────────────────────────────────

/**
 * One entry in a runner's fail-once-then-avoid map (#317): claim-time git
 * failure recorded against a repo_key until re-registration clears it.
 */
export interface UnreachableRepoEntry {
  /** Claim-time git failure code (`push_denied`, …). */
  code: string;
  /** ISO-8601 when the failure was recorded. */
  at: string;
  /** Optional operation bucket (`clone` | `fetch` | `push`). */
  operation?: string;
}

/** `repo_key` → unreachability entry. Empty object / null column = no memory. */
export type UnreachableReposMap = Record<string, UnreachableRepoEntry>;

/** A registered remote runner row (capabilities JSON + timestamps). */
export interface RunnerRow {
  name: string;
  /** JSON: RunnerCapabilities from @useparley/core. */
  capabilities: string;
  protocol_version: number;
  build_version: string;
  registered_at: string;
  last_seen: string;
  /**
   * ISO-8601 of the most recent task completion on this runner (#315 warm
   * executor preference). Null until the first completion after registration.
   */
  last_completed_at: string | null;
  /**
   * JSON map of repo_key → {@link UnreachableRepoEntry} (#317). Null/empty
   * when the runner has no recorded unreachability. Cleared on re-register.
   */
  unreachable_repos: string | null;
}

const RUNNER_COLUMNS = `name, capabilities, protocol_version, build_version,
   registered_at, last_seen, last_completed_at, unreachable_repos`;

/** Parse `runners.unreachable_repos` JSON; corrupt / null → empty map. */
export function parseUnreachableRepos(
  raw: string | null | undefined,
): UnreachableReposMap {
  if (raw === null || raw === undefined || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: UnreachableReposMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as Partial<UnreachableRepoEntry>;
      if (typeof entry.code !== "string" || typeof entry.at !== "string") continue;
      out[key] = {
        code: entry.code,
        at: entry.at,
        ...(typeof entry.operation === "string" ? { operation: entry.operation } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Repo keys a runner cannot currently reach (#317). */
export function unreachableRepoKeys(row: RunnerRow): string[] {
  return Object.keys(parseUnreachableRepos(row.unreachable_repos));
}

/** Fetch one registered runner by name. */
export function getRunner(db: DatabaseHandle, name: string): RunnerRow | undefined {
  const row = db
    .prepare(`SELECT ${RUNNER_COLUMNS} FROM runners WHERE name = ?`)
    .get(name);
  return row === undefined ? undefined : asRow<RunnerRow>(row);
}

/** All registered runners, name-sorted. */
export function listRunners(db: DatabaseHandle): RunnerRow[] {
  return db
    .prepare(`SELECT ${RUNNER_COLUMNS} FROM runners ORDER BY name ASC`)
    .all()
    .map((row) => asRow<RunnerRow>(row));
}

/**
 * Idempotent upsert of a runner registration. On first insert `registered_at`
 * is set; on re-register it is preserved and last_seen / capabilities refresh.
 * Re-registration **clears** `unreachable_repos` so eligibility is restored
 * after restart or periodic re-fingerprint (#317).
 */
export function upsertRunner(
  db: DatabaseHandle,
  runner: {
    name: string;
    capabilities: string;
    protocol_version: number;
    build_version: string;
  },
): RunnerRow {
  const now = new Date().toISOString();
  const existing = getRunner(db, runner.name);
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO runners
         (name, capabilities, protocol_version, build_version, registered_at, last_seen,
          unreachable_repos)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      runner.name,
      runner.capabilities,
      runner.protocol_version,
      runner.build_version,
      now,
      now,
    );
  } else {
    db.prepare(
      `UPDATE runners
       SET capabilities = ?, protocol_version = ?, build_version = ?, last_seen = ?,
           unreachable_repos = NULL
       WHERE name = ?`,
    ).run(
      runner.capabilities,
      runner.protocol_version,
      runner.build_version,
      now,
      runner.name,
    );
  }
  return getRunner(db, runner.name)!;
}

/** Max repo_key length accepted into unreachable memory (#317 wire hygiene). */
export const UNREACHABLE_REPO_KEY_MAX_LEN = 512;
/** Cap map size so a pathological flood cannot bloat claim polls (#317). */
export const UNREACHABLE_REPOS_MAX_ENTRIES = 64;

/**
 * Record that a runner cannot reach `repoKey` after a claim-time git failure
 * (#317). Merges into the existing map (other keys preserved). Oversize keys
 * and maps beyond {@link UNREACHABLE_REPOS_MAX_ENTRIES} are refused (no-op).
 */
export function markRunnerUnreachable(
  db: DatabaseHandle,
  name: string,
  repoKey: string,
  entry: UnreachableRepoEntry,
): void {
  if (repoKey === "" || repoKey.length > UNREACHABLE_REPO_KEY_MAX_LEN) return;
  // Codes/operations are closed enums on the fail wire; still clamp free text.
  if (entry.code.length === 0 || entry.code.length > 64) return;
  if (entry.operation !== undefined && entry.operation.length > 16) return;
  const row = getRunner(db, name);
  if (row === undefined) return;
  const map = parseUnreachableRepos(row.unreachable_repos);
  if (!(repoKey in map) && Object.keys(map).length >= UNREACHABLE_REPOS_MAX_ENTRIES) {
    return;
  }
  map[repoKey] = {
    code: entry.code,
    at: entry.at,
    ...(entry.operation !== undefined ? { operation: entry.operation } : {}),
  };
  db.prepare(`UPDATE runners SET unreachable_repos = ? WHERE name = ?`).run(
    JSON.stringify(map),
    name,
  );
}

/** Refresh last_seen only (presence / long-poll / task-traffic contact). */
export function touchRunnerLastSeen(db: DatabaseHandle, name: string): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE runners SET last_seen = ? WHERE name = ?`).run(now, name);
}

/** Delete a persisted runner row (operator remove / stale sweep, #320). */
export function deleteRunner(db: DatabaseHandle, name: string): boolean {
  const result = db.prepare(`DELETE FROM runners WHERE name = ?`).run(name);
  return (result.changes as number) > 0;
}

/** Stamp last_completed_at for warm-executor ranking (#315). */
export function markRunnerCompleted(db: DatabaseHandle, name: string, atIso?: string): void {
  const now = atIso ?? new Date().toISOString();
  db.prepare(`UPDATE runners SET last_completed_at = ? WHERE name = ?`).run(now, name);
}

/**
 * Delete registration rows whose `last_seen` is strictly older than the ISO
 * cutoff (lazy stale auto-cleanup, #320). Returns the deleted names.
 *
 * `excludeNames` skips runners that still have an in-process open lease poll
 * (presence is not stored in SQLite). Used by the daemon's single sweep path.
 *
 * Semantics: `last_seen < olderThanIso` matches `now - last > staleMs` when
 * `olderThanIso = new Date(now - staleMs).toISOString()`.
 */
export function deleteStaleRunners(
  db: DatabaseHandle,
  olderThanIso: string,
  excludeNames?: ReadonlySet<string>,
): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM runners WHERE last_seen < ? ORDER BY name ASC`,
    )
    .all(olderThanIso) as Array<{ name: string }>;
  const del = db.prepare(`DELETE FROM runners WHERE name = ?`);
  const deleted: string[] = [];
  for (const { name } of rows) {
    if (excludeNames !== undefined && excludeNames.has(name)) continue;
    del.run(name);
    deleted.push(name);
  }
  return deleted;
}

/**
 * Recent tasks with runner affinity `runner` (read-only; #320 show surface).
 * Newest `updated_at` first. Does not touch claim / state-machine logic.
 */
export function listRecentTasksForRunner(
  db: DatabaseHandle,
  runner: string,
  limit = 20,
): TaskRow[] {
  const cap = Math.max(0, Math.min(Math.floor(limit), 100));
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE runner = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(runner, cap)
    .map((row) => asRow<TaskRow>(row));
}

/** Test/helper: set last_seen on a runner row (stale-sweep tests, #320). */
export function setRunnerLastSeen(
  db: DatabaseHandle,
  name: string,
  lastSeenIso: string,
): void {
  db.prepare(`UPDATE runners SET last_seen = ? WHERE name = ?`).run(lastSeenIso, name);
}

// ── end #243 ──
