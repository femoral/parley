import fs from "node:fs";
import Database from "better-sqlite3";
import type { HomePaths } from "../home.js";

export type DatabaseHandle = Database.Database;

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
}

/**
 * Schema migrations, applied in order. Each entry runs once; `user_version`
 * tracks how many have been applied. Future tickets (#15+) append migrations
 * for questions, report envelopes, vendor session ids, etc.
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

/** List all tasks, newest first. Empty until the delegate flow lands (#15). */
export function listTasks(db: DatabaseHandle): TaskRow[] {
  return db
    .prepare(
      `SELECT id, name, vendor, model, repo, state, created_at, updated_at
       FROM tasks ORDER BY created_at DESC, id DESC`,
    )
    .all() as TaskRow[];
}
