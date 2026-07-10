import fs from "node:fs";
import type { HomePaths } from "../home.js";
import { sleep } from "../util/time.js";
import { isProcessAlive } from "./discovery.js";

interface LockRecord {
  pid: number;
  acquired_at: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_INTERVAL_MS = 25;

/** Best-effort removal of a lock/temp file; a missing file is success. */
function unlinkQuiet(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    // Cleanup of our own file failing is not actionable by the caller.
  }
}

function readLockHolder(lockPath: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockRecord).pid === "number"
    ) {
      return parsed as LockRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run `fn` while holding an exclusive filesystem lock on `paths.lock`.
 *
 * The lock is an `O_EXCL`-created file carrying the holder's pid. A contending
 * process that finds the lock held checks the holder's liveness: a dead holder
 * means a stale lock (the process crashed mid-critical-section), which is
 * removed and retried. This is what makes auto-spawn race-free across parallel
 * CLI invocations — exactly one wins the create, the rest wait then observe the
 * result.
 */
export async function withLock<T>(
  paths: HomePaths,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  fs.mkdirSync(paths.home, { recursive: true });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  // Acquire via a fully-formed temp file linked atomically into place. link()
  // is atomic and fails with EEXIST if the target exists, so contenders never
  // observe a half-written lock (no empty-file window to misread as stale).
  const record: LockRecord = { pid: process.pid, acquired_at: new Date().toISOString() };
  const tmp = `${paths.lock}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));

  try {
    for (;;) {
      try {
        fs.linkSync(tmp, paths.lock);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        const holder = readLockHolder(paths.lock);
        if (!holder || !isProcessAlive(holder.pid)) {
          // Stale lock: the holder is gone. Reclaim it and retry.
          unlinkQuiet(paths.lock);
          continue;
        }

        if (Date.now() >= deadline) {
          throw new Error(
            `timed out after ${timeoutMs}ms waiting for parley lock held by pid ${holder.pid}`,
          );
        }
        await sleep(RETRY_INTERVAL_MS);
      }
    }
  } finally {
    unlinkQuiet(tmp);
  }

  try {
    return await fn();
  } finally {
    unlinkQuiet(paths.lock);
  }
}
