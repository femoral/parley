import fs from "node:fs";
import Database from "better-sqlite3";
import type { HomePaths } from "../home.js";
import type { SandboxMode } from "./adapters/types.js";

export type DatabaseHandle = Database.Database;

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
  repo: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  cwd: string | null;
  prompt: string | null;
  session_id: string | null;
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
  repo: string | null;
  cwd: string;
  prompt: string;
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
];

function migrate(db: DatabaseHandle): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const statement = MIGRATIONS[version];
    if (statement === undefined) continue;
    db.transaction(() => {
      db.exec(statement);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

/**
 * Open (creating on first use) the task-state database and apply migrations.
 * Called by the daemon on start — this is where SQLite is initialized.
 */
export function openDatabase(paths: HomePaths): DatabaseHandle {
  fs.mkdirSync(paths.home, { recursive: true });
  const db = new Database(paths.db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

const TASK_COLUMNS = `id, name, vendor, model, effort, repo, state, created_at, updated_at,
   cwd, prompt, session_id, usage, report, error, started_at, completed_at,
   question_id, question, worktree, branch, base_sha, sandbox, network,
   answer_timeout_ms, report_schema`;

/** List all tasks, newest first. */
export function listTasks(db: DatabaseHandle): TaskRow[] {
  return db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at DESC, id DESC`)
    .all() as TaskRow[];
}

/** Fetch one task by exact id. */
export function getTask(db: DatabaseHandle, id: string): TaskRow | undefined {
  return db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined;
}

/**
 * Resolve a task reference — short id first, then `--name` label (most recent
 * wins on name collisions). Ids and names are interchangeable everywhere.
 */
export function resolveTask(db: DatabaseHandle, ref: string): TaskRow | undefined {
  const byId = getTask(db, ref);
  if (byId) return byId;
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE name = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(ref) as TaskRow | undefined;
}

/** Atomically bump (creating on first use) a named monotonic counter. */
function nextCounter(db: DatabaseHandle, name: string): number {
  const row = db
    .prepare(
      `INSERT INTO counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(name) as { value: number };
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
 * Insert a new task in `pending` state and return its row. The id is allocated
 * by the caller (via `nextTaskId`) because worktree creation — which names its
 * branch `parley/<id>-…` — must happen before the row exists.
 */
export function insertTask(db: DatabaseHandle, task: NewTask): TaskRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks
       (id, name, vendor, model, effort, repo, state, created_at, updated_at,
        cwd, prompt, worktree, branch, base_sha, sandbox, network, answer_timeout_ms,
        report_schema)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.name,
    task.vendor,
    task.model,
    task.effort,
    task.repo,
    now,
    now,
    task.cwd,
    task.prompt,
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
 * Startup crash sweep (spec §3): tasks recorded live (`pending`, `running`,
 * `awaiting_answer`) when the previous daemon died are marked `stalled` — their
 * children ran in the daemon's process group and died with it. Terminal and
 * already-stalled tasks are untouched. Questions stay recorded; a stalled task
 * resumes via `parley answer` like any other. Returns the number swept.
 */
export function sweepInterruptedTasks(db: DatabaseHandle): number {
  // "Live" is defined as the complement of the settled states, so a future
  // state is swept by default rather than surviving restarts as a zombie.
  const placeholders = [...SETTLED_STATES].map(() => "?").join(", ");
  const result = db
    .prepare(
      `UPDATE tasks SET state = 'stalled', error = ?, updated_at = ?
       WHERE state NOT IN (${placeholders})`,
    )
    .run(
      "daemon restarted while the task was live; the child died with the daemon's process group",
      new Date().toISOString(),
      ...SETTLED_STATES,
    );
  return result.changes;
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
