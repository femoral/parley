import fs from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
import type { HomePaths } from "@useparley/core";
import type { SandboxMode } from "./adapters/types.js";

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

/** Task lifecycle states (spec §2). */
export type TaskState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_answer"
  | "stalled";

/** States from which a task never moves again (v1 tracer subset). */
export const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * States where the task's child is gone and nothing a child says may move the
 * task: the terminal states plus `stalled` (child stopped; only a `parley
 * answer` resume revives it). MCP calls and child exits check against this.
 */
export const SETTLED_STATES: ReadonlySet<string> = new Set([...TERMINAL_STATES, "stalled"]);

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
  /** Orchestrator-recorded quality score (1-10) via `parley eval`; null until set. */
  eval_score: number | null;
  /** Orchestrator-recorded feedback text via `parley eval`; null until set. */
  eval_feedback: string | null;
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
  /** Profile name used at create time, if any (#113). */
  profile: string | null;
  /**
   * Remote runner affinity (`--runner <name>`), if any (#111 / ADR-0012).
   * Null/omitted means the task executes in-daemon (default).
   */
  runner?: string | null;
  repo: string | null;
  cwd: string;
  prompt: string;
  /** The orchestrator-run identity that spawned this task (`--session` / `PARLEY_SESSION_ID`). */
  orchestrator_session_id: string;
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

const TASK_COLUMNS = `id, name, vendor, model, effort, profile, runner, repo, state, created_at, updated_at,
   cwd, prompt, session_id, usage, report, error, started_at, completed_at,
   question_id, question, worktree, branch, base_sha, sandbox, network,
   answer_timeout_ms, report_schema, seq, orchestrator_session_id, eval_score, eval_feedback`;

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

/**
 * Record that the orchestrator handled a task's current actionable state
 * (ADR-0007). Upserts per `(task_id, state)` so a later re-entry into the same
 * state with a new seq is un-acked again. Caller validates that the event is
 * still current and the state is actionable; this is pure persistence.
 */
export function upsertEventAck(
  db: DatabaseHandle,
  taskId: string,
  state: string,
  ackedSeq: number,
): void {
  db.prepare(
    `INSERT INTO event_acks (task_id, state, acked_seq) VALUES (?, ?, ?)
     ON CONFLICT(task_id, state) DO UPDATE SET acked_seq = excluded.acked_seq`,
  ).run(taskId, state, ackedSeq);
}

/**
 * The seq last acked for `(task_id, state)`, or null when never acked. Used to
 * decide whether a task's current actionable state is still pending.
 */
export function getEventAck(
  db: DatabaseHandle,
  taskId: string,
  state: string,
): number | null {
  const row = db
    .prepare(`SELECT acked_seq FROM event_acks WHERE task_id = ? AND state = ?`)
    .get(taskId, state);
  return row === undefined ? null : asRow<{ acked_seq: number }>(row).acked_seq;
}

/**
 * True when the task's current state has been acked at its current seq — i.e.
 * this actionable state no longer contributes a pending inbox event.
 */
export function isEventAcked(db: DatabaseHandle, task: TaskRow): boolean {
  const acked = getEventAck(db, task.id, task.state);
  return acked !== null && acked === task.seq;
}

/**
 * Insert a new task in `pending` state and return its row. The id is allocated
 * by the caller (via `nextTaskId`) because worktree creation — which names its
 * branch `parley/<id>-…` — must happen before the row exists.
 */
export function insertTask(db: DatabaseHandle, task: NewTask): TaskRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks
       (id, name, vendor, model, effort, profile, runner, repo, state, created_at, updated_at,
        cwd, prompt, orchestrator_session_id, worktree, branch, base_sha, sandbox,
        network, answer_timeout_ms, report_schema)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.name,
    task.vendor,
    task.model,
    task.effort,
    task.profile,
    task.runner ?? null,
    task.repo,
    now,
    now,
    task.cwd,
    task.prompt,
    task.orchestrator_session_id,
    task.worktree,
    task.branch,
    task.base_sha,
    task.sandbox,
    task.network ? 1 : 0,
    task.answer_timeout_ms,
    task.report_schema,
  );
  return getTask(db, task.id)!;
}

/**
 * Oldest pending task with the given runner affinity, or undefined when none
 * is waiting. Used by `POST /runner/lease` (#111).
 */
export function claimOldestPendingRunnerTask(
  db: DatabaseHandle,
  runner: string,
): TaskRow | undefined {
  const row = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE state = 'pending' AND runner = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    )
    .get(runner);
  return row === undefined ? undefined : asRow<TaskRow>(row);
}

/**
 * Startup crash sweep (spec §3): tasks recorded live (`pending`, `running`,
 * `awaiting_answer`) when the previous daemon died are marked `stalled` — their
 * children ran in the daemon's process group and died with it. Terminal and
 * already-stalled tasks are untouched. Questions stay recorded; a stalled task
 * resumes via `parley answer` like any other. Returns the number swept.
 *
 * Runner-affine tasks (#111 / ADR-0012) are excluded: their children live on
 * the remote runner host, not in the daemon's process group. Those tasks keep
 * their state; the engine re-arms heartbeat timers after restart.
 */
export function sweepInterruptedTasks(db: DatabaseHandle): number {
  // "Live" is defined as the complement of the settled states, so a future
  // state is swept by default rather than surviving restarts as a zombie.
  // Runner-affine tasks keep their children on the remote host.
  const placeholders = [...SETTLED_STATES].map(() => "?").join(", ");
  const live = db
    .prepare(
      `SELECT id FROM tasks
       WHERE state NOT IN (${placeholders})
         AND (runner IS NULL OR runner = '')`,
    )
    .all(...SETTLED_STATES)
    .map((row) => asRow<{ id: string }>(row));
  const result = db
    .prepare(
      `UPDATE tasks SET state = 'stalled', error = ?, updated_at = ?
       WHERE state NOT IN (${placeholders})
         AND (runner IS NULL OR runner = '')`,
    )
    .run(
      "daemon restarted while the task was live; the child died with the daemon's process group",
      new Date().toISOString(),
      ...SETTLED_STATES,
    );
  // The sweep is a transition too — stamp each swept task with a fresh seq so
  // its envelope reflects the stall (#34). No in-memory event log exists yet
  // (the engine is not constructed until after the sweep), so watchers that
  // attach later simply see the post-sweep state, never the stall as an event.
  for (const { id } of live) bumpTaskSeq(db, id);
  // node:sqlite types `changes` as number | bigint; for our UPDATE counts it is a number.
  return Number(result.changes);
}

/** The mutable task fields `updateTask` accepts. */
export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | "state"
    | "session_id"
    | "usage"
    | "report"
    | "error"
    | "started_at"
    | "completed_at"
    | "question_id"
    | "question"
    | "worktree"
    | "branch"
    | "eval_score"
    | "eval_feedback"
  >
>;

/** Patch mutable task fields; bumps `updated_at`. */
export function updateTask(db: DatabaseHandle, id: string, patch: TaskPatch): void {
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
