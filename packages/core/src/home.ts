import os from "node:os";
import path from "node:path";

/**
 * Resolved filesystem layout for a parley home directory.
 *
 * The home dir is where the daemon publishes discovery, holds its lock, and
 * stores task state. It is overridable via the `PARLEY_HOME` env var so tests
 * (and multiple isolated instances) never touch the real `~/.parley`.
 */
export interface HomePaths {
  /** The parley home directory itself. */
  home: string;
  /** Daemon discovery file: `{ port, pid, started_at }`. */
  discovery: string;
  /** Lockfile guarding auto-spawn / double-start races. */
  lock: string;
  /** SQLite task-state database. */
  db: string;
  /** User-patchable model/effort catalog file (`parley models`). */
  models: string;
  /**
   * User-patchable settings file (`ui.*`, `daemon.url`, `vendors.*`,
   * `profiles.*`, `runners.*` — see `config.ts` / ADR-0010 / ADR-0012).
   */
  config: string;
  /** Per-task raw vendor event logs live here (future tickets). */
  tasks: string;
  /** Parley-created git worktrees live here (ADR-0005 / ADR-0018). */
  worktrees: string;
  /**
   * Scratch-mode run workspaces (`workspace: scratch`) live here
   * (`~/.parley/runs/<runId>/` — ADR-0018 / #235).
   */
  runs: string;
}

/** Resolve the parley home directory, honouring the `PARLEY_HOME` override. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PARLEY_HOME;
  if (override && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".parley");
}

/** Compute the full path layout under a resolved parley home directory. */
export function homePaths(home: string): HomePaths {
  return {
    home,
    discovery: path.join(home, "daemon.json"),
    lock: path.join(home, "daemon.lock"),
    db: path.join(home, "parley.db"),
    models: path.join(home, "models.json"),
    config: path.join(home, "parley.json"),
    tasks: path.join(home, "tasks"),
    worktrees: path.join(home, "worktrees"),
    runs: path.join(home, "runs"),
  };
}

/** Convenience: resolve home from env and return its path layout. */
export function homePathsFromEnv(env: NodeJS.ProcessEnv = process.env): HomePaths {
  return homePaths(resolveHome(env));
}
