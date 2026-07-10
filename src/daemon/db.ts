import fs from "node:fs";
import Database from "better-sqlite3";
import type { HomePaths } from "../home.js";

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

/** A task row as surfaced to the CLI plane (`status` / `list`). */
export interface TaskRow {
  id: string;
  name: string | null;
  vendor: string | null;
  model: string | null;
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
}

/** Fields the daemon writes when creating a task. */
export interface NewTask {
  name: string | null;
  vendor: string;
  model: string | null;
  repo: string | null;
  cwd: string;
  prompt: string;
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

const TASK_COLUMNS = `id, name, vendor, model, repo, state, created_at, updated_at,
   cwd, prompt, session_id, usage, report, error, started_at, completed_at`;

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

/** Allocate the next daemon-assigned short task id (`t1`, `t2`, …). */
export function nextTaskId(db: DatabaseHandle): string {
  const row = db
    .prepare(
      `INSERT INTO counters (name, value) VALUES ('task_id', 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get() as { value: number };
  return `t${row.value}`;
}

/** Insert a new task in `pending` state and return its row. */
export function insertTask(db: DatabaseHandle, task: NewTask): TaskRow {
  const id = nextTaskId(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, name, vendor, model, repo, state, created_at, updated_at, cwd, prompt)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(id, task.name, task.vendor, task.model, task.repo, now, now, task.cwd, task.prompt);
  return getTask(db, id)!;
}

/** Patch mutable task fields; bumps `updated_at`. */
export function updateTask(
  db: DatabaseHandle,
  id: string,
  patch: Partial<
    Pick<
      TaskRow,
      "state" | "session_id" | "usage" | "report" | "error" | "started_at" | "completed_at"
    >
  >,
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
