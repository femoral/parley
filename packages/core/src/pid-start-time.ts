/**
 * Live-process start-time token (Linux /proc).
 *
 * One reader for both pid-recycle defences: session-state matching (#383)
 * and daemon-advertisement liveness (#384). The ancestry walk already parsed
 * this field when building its chain — that parser lives here so there is
 * only one.
 *
 * The token is `/proc/<pid>/stat` field 22 (clock ticks since boot) as an
 * opaque string. Compare by equality. Never treat it as a parsed timestamp.
 */
import fs from "node:fs";

/** Linux USER_HZ / `sysconf(_SC_CLK_TCK)` — 100 on every Linux we target. */
const LINUX_USER_HZ = 100;

/** Fields the ancestry walk and the start-time reader both need. */
export interface ProcStatFields {
  pid: number;
  ppid: number;
  /** Opaque start-time token (e.g. /proc starttime jiffies). */
  start_time: string;
}

/**
 * Parse one `/proc/<pid>/stat` line into `{ pid, ppid, start_time }`.
 * Field layout: pid (1) comm (2, parenthesized) state (3) ppid (4) … starttime (22).
 * Returns null when the line is truncated or unparseable.
 */
export function parseProcStatLine(line: string): ProcStatFields | null {
  // comm may contain spaces and parentheses; find the closing `)`.
  const close = line.lastIndexOf(")");
  if (close < 0) return null;
  const before = line.slice(0, close);
  const after = line.slice(close + 1).trimStart();
  const pidStr = before.split(/\s+/)[0];
  const rest = after.split(/\s+/);
  // rest[0]=state, rest[1]=ppid, … rest[19]=starttime (field 22 overall).
  const ppidStr = rest[1];
  const startStr = rest[19];
  if (pidStr === undefined || ppidStr === undefined || startStr === undefined) {
    return null;
  }
  const pid = Number(pidStr);
  const ppid = Number(ppidStr);
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
  return { pid, ppid, start_time: startStr };
}

/**
 * Read the opaque start-time token for a live pid from `/proc`.
 * Returns null when /proc is missing, the pid is gone, or the line is
 * unparseable — callers skip the recycle check in that case.
 */
export function readPidStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  return parseProcStatLine(raw)?.start_time ?? null;
}

/**
 * Convert an opaque /proc start-time token to epoch milliseconds.
 * Used only for the `started_at` fallback (tokenless files, #383) and for
 * advertisement liveness (#384) — never for the token-equality check.
 *
 * `nowMs` / `uptimeSec` are injectable so conversion tests need no /proc.
 */
export function pidStartEpochMs(
  token: string,
  opts: { nowMs?: number; uptimeSec?: number } = {},
): number | null {
  if (!/^\d+$/.test(token)) return null;
  const jiffies = Number(token);
  if (!Number.isFinite(jiffies)) return null;

  let uptimeSec = opts.uptimeSec;
  if (uptimeSec === undefined) {
    try {
      const first = fs.readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0];
      uptimeSec = first === undefined ? Number.NaN : Number(first);
    } catch {
      return null;
    }
  }
  if (!Number.isFinite(uptimeSec)) return null;

  const ageSec = uptimeSec - jiffies / LINUX_USER_HZ;
  if (!Number.isFinite(ageSec)) return null;
  return (opts.nowMs ?? Date.now()) - ageSec * 1000;
}

/**
 * Whether the process described by `token` started after `isoTimestamp`.
 * Returns null when the token or timestamp cannot be interpreted — callers
 * treat that as "skip the check".
 */
export function pidStartedAfter(
  token: string,
  isoTimestamp: string,
  opts: { nowMs?: number; uptimeSec?: number } = {},
): boolean | null {
  const startMs = pidStartEpochMs(token, opts);
  if (startMs === null) return null;
  const recorded = Date.parse(isoTimestamp);
  if (!Number.isFinite(recorded)) return null;
  return startMs > recorded;
}
