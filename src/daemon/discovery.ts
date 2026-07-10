import fs from "node:fs";
import path from "node:path";
import type { HomePaths } from "../home.js";

/** Contents of the daemon discovery file (`~/.parley/daemon.json`). */
export interface Discovery {
  /** Ephemeral localhost port the daemon's HTTP server is bound to. */
  port: number;
  /** OS process id of the running daemon. */
  pid: number;
  /** ISO-8601 timestamp of when the daemon started. */
  started_at: string;
}

function isDiscovery(value: unknown): value is Discovery {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.port === "number" &&
    Number.isInteger(v.port) &&
    typeof v.pid === "number" &&
    Number.isInteger(v.pid) &&
    typeof v.started_at === "string"
  );
}

/**
 * Read and validate the discovery file. Returns `null` when it is absent or
 * malformed — callers treat both as "no daemon advertised".
 */
export function readDiscovery(paths: HomePaths): Discovery | null {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.discovery, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDiscovery(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomically publish the discovery file (write-temp + rename). */
export function writeDiscovery(paths: HomePaths, discovery: Discovery): void {
  fs.mkdirSync(paths.home, { recursive: true });
  const tmp = `${paths.discovery}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(discovery, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, paths.discovery);
}

/** Remove the discovery file if present; a missing file is not an error. */
export function clearDiscovery(paths: HomePaths): void {
  try {
    fs.unlinkSync(paths.discovery);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Liveness probe for a pid. `kill(pid, 0)` sends no signal but performs the
 * permission/existence check: `ESRCH` means the process is gone (stale),
 * `EPERM` means it exists but is owned by someone else (still alive).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The advertised daemon, but only if its pid is actually alive. A discovery
 * file that points at a dead pid is stale and reported as `null`.
 */
export function liveDiscovery(paths: HomePaths): Discovery | null {
  const discovery = readDiscovery(paths);
  if (discovery && isProcessAlive(discovery.pid)) return discovery;
  return null;
}

/** Resolve the per-task log directory (created lazily by future tickets). */
export function taskLogDir(paths: HomePaths, taskId: string): string {
  return path.join(paths.tasks, taskId);
}
