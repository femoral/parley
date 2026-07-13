import fs from "node:fs";

/**
 * Read the bytes appended to a task's raw vendor log since a byte offset —
 * the read side of the offset-cursor tail contract (spec §"New: per-task
 * logs"). Shared by the daemon's `GET /tasks/:ref/logs` route (`server.ts`)
 * and the CLI's `parley logs` command, which reads the same file directly off
 * disk (same machine, no need to round-trip through HTTP) — one
 * implementation so a fix to offset handling (missing file, a cursor past the
 * current length) lands for both.
 *
 * Reads only the new bytes via a positioned `pread` (not the whole file), so
 * cost scales with what changed since `offset`, not with total log size.
 */
export function readLogTail(file: string, offset: number): { bytes: string; next: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { bytes: "", next: offset }; // log not created yet
  }
  // Clamp a cursor past current length (e.g. a stale cursor from before the
  // log was rotated/cleaned) rather than throwing a negative-length read.
  const start = Math.min(offset, stat.size);
  if (stat.size <= start) return { bytes: "", next: start };
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    return { bytes: buffer.toString("utf8", 0, read), next: start + read };
  } finally {
    fs.closeSync(fd);
  }
}
