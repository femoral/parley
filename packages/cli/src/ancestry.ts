/**
 * Client-side process-ancestry walk (#162).
 *
 * The CLI records its `(machine-id, pid, start-time)` ancestor chain and ships
 * it with delegate/fix/eval/session. The daemon only matches chains against
 * stored session anchors — it never walks the process table itself.
 *
 * `walkAncestry` is pure over a synthesized process table so unit tests need
 * no /proc. `readLiveAncestryChain` is the production entry that reads Linux
 * /proc (and degrades to a single self-anchor elsewhere).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** One process in the ancestry chain (self first, then parents toward root). */
export interface ProcessAnchor {
  machine_id: string;
  pid: number;
  /** Opaque start-time token (e.g. /proc starttime jiffies) that defeats pid recycling. */
  start_time: string;
}

/** One row of a synthesized (or live) process table for {@link walkAncestry}. */
export interface ProcessTableEntry {
  pid: number;
  ppid: number;
  start_time: string;
}

/**
 * Walk process ancestry from `startPid` toward the root using `table`.
 * Returns anchors self → parent → … (stops on missing parent, self-parent,
 * or cycle). Pure — no filesystem I/O.
 */
export function walkAncestry(
  table: ReadonlyMap<number, ProcessTableEntry>,
  startPid: number,
  machineId: string,
): ProcessAnchor[] {
  const chain: ProcessAnchor[] = [];
  const seen = new Set<number>();
  let pid: number | null = startPid;
  while (pid !== null && pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    const entry = table.get(pid);
    if (entry === undefined) break;
    chain.push({
      machine_id: machineId,
      pid: entry.pid,
      start_time: entry.start_time,
    });
    if (entry.ppid === entry.pid || entry.ppid <= 0) break;
    pid = entry.ppid;
  }
  return chain;
}

/**
 * Read this host's machine id (Linux `/etc/machine-id`, macOS `kern.uuid`
 * fallback, else hostname). Namespaces anchors for remote daemons.
 */
export function readMachineId(): string {
  try {
    const id = fs.readFileSync("/etc/machine-id", "utf8").trim();
    if (id !== "") return id;
  } catch {
    /* not Linux or unreadable */
  }
  try {
    // macOS: IOPlatformUUID is heavy; hostname is a weaker but usable namespace.
    const host = os.hostname().trim();
    if (host !== "") return `host:${host}`;
  } catch {
    /* ignore */
  }
  return "unknown";
}

/**
 * Parse one `/proc/<pid>/stat` line into `{ pid, ppid, start_time }`.
 * Field layout: pid (1) comm (2, parenthesized) state (3) ppid (4) … starttime (22).
 * Returns null when the line is truncated or unparseable.
 */
export function parseProcStatLine(line: string): ProcessTableEntry | null {
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
  if (pidStr === undefined || ppidStr === undefined || startStr === undefined) return null;
  const pid = Number(pidStr);
  const ppid = Number(ppidStr);
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
  return { pid, ppid, start_time: startStr };
}

/**
 * Build a process table by reading `/proc` (Linux). Empty map when /proc is
 * unavailable — callers still get a self-only chain from {@link readLiveAncestryChain}.
 */
export function readProcTable(): Map<number, ProcessTableEntry> {
  const table = new Map<number, ProcessTableEntry>();
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return table;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    const parsed = parseProcStatLine(raw);
    if (parsed) table.set(parsed.pid, parsed);
  }
  return table;
}

/**
 * Live ancestry chain for this process: walk /proc when available, else a
 * single self-anchor with start_time `"0"` (binding still works for re-anchor
 * within the same process via pid match on platforms without starttime).
 *
 * When `PARLEY_ANCESTRY_CHAIN` is set to a JSON array of anchors, that chain
 * is returned instead — the CLI-seam test injection for crafted chains (#162).
 */
export function readLiveAncestryChain(
  env: NodeJS.ProcessEnv = process.env,
  opts: { pid?: number; machineId?: string } = {},
): ProcessAnchor[] {
  const injected = env.PARLEY_ANCESTRY_CHAIN;
  if (typeof injected === "string" && injected !== "") {
    try {
      const parsed: unknown = JSON.parse(injected);
      if (Array.isArray(parsed)) {
        const chain: ProcessAnchor[] = [];
        for (const entry of parsed) {
          if (
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as ProcessAnchor).machine_id === "string" &&
            typeof (entry as ProcessAnchor).pid === "number" &&
            typeof (entry as ProcessAnchor).start_time === "string"
          ) {
            chain.push({
              machine_id: (entry as ProcessAnchor).machine_id,
              pid: (entry as ProcessAnchor).pid,
              start_time: (entry as ProcessAnchor).start_time,
            });
          }
        }
        if (chain.length > 0) return chain;
      }
    } catch {
      /* fall through to live walk */
    }
  }

  const machineId = opts.machineId ?? readMachineId();
  const pid = opts.pid ?? process.pid;
  const table = readProcTable();
  if (table.size > 0) {
    const chain = walkAncestry(table, pid, machineId);
    if (chain.length > 0) return chain;
  }
  // Non-Linux / empty table: self-only anchor.
  return [{ machine_id: machineId, pid, start_time: "0" }];
}

/**
 * Resolve the workspace root for session binding: git top-level when inside a
 * repo, else the absolute cwd. Mirrors daemon `repoRoot` posture without
 * requiring a git binary failure path for non-repo cwds.
 */
export function resolveWorkspaceRoot(cwd: string = process.cwd()): string {
  try {
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root !== "") return root;
  } catch {
    /* not a git repo */
  }
  return path.resolve(cwd);
}
