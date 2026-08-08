/**
 * Orchestrator session provenance binding (#162 / #280).
 *
 * The CLI walks process ancestry client-side and ships the chain; the daemon
 * only matches chains against stored session anchors. Pure functions so unit
 * tests can craft chains without a process table.
 *
 * Dead-anchor liveness (#280): same-machine sessions whose pid is gone are
 * excluded from fallback binding and reaped by the retention sweep. Foreign-
 * machine anchors are indeterminate and never reaped on liveness grounds.
 */
import fs from "node:fs";
import os from "node:os";
import type { ProcessAnchor, SessionRow } from "./db.js";

/** Stable daemon/CLI error code when evals are on and no session resolves. */
export const CODE_SESSION_REQUIRED = "session_required";

/**
 * Stable code when the inbox is asked for a session id the daemon does not
 * know (#256): no registered row and no task/run carrying the id.
 */
export const CODE_UNKNOWN_SESSION = "unknown_session";

/** Teaching message for {@link CODE_UNKNOWN_SESSION}. */
export function unknownSessionMessage(sessionId: string): string {
  return (
    `unknown_session: no registered session, task, or run for ${sessionId}; ` +
    "check --session / PARLEY_SESSION_ID for a typo or purged id"
  );
}

/** Teaching message for {@link CODE_SESSION_REQUIRED}. */
export function sessionRequiredMessage(): string {
  return (
    "session_required: register an orchestrator session first " +
    "(`parley session` with PARLEY_HARNESS/PARLEY_MODEL/PARLEY_EFFORT " +
    "from a harness plugin, or omit them for unknown provenance), " +
    "or set PARLEY_SESSION_ID / pass --session <id> for a known session"
  );
}

/** Warning when multi-live fallback picks the most-recently-updated session (#280). */
export function sessionFallbackWarning(sessionId: string, liveCount: number): string {
  const prefix = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
  return (
    `bound to session ${prefix} (most recent of ${liveCount} live for this workspace); ` +
    "pass --session <id> to target another"
  );
}

/** Normalize free-form provenance strings for grouping (lowercase). */
export function normalizeProvenance(value: string): string {
  return value.trim().toLowerCase();
}

/** Anchor equality: machine-id namespaces; start-time defeats pid recycling. */
export function anchorsEqual(a: ProcessAnchor, b: ProcessAnchor): boolean {
  return (
    a.machine_id === b.machine_id &&
    a.pid === b.pid &&
    a.start_time === b.start_time
  );
}

/** Session row → ProcessAnchor. */
export function sessionAnchor(session: SessionRow): ProcessAnchor {
  return {
    machine_id: session.anchor_machine,
    pid: session.anchor_pid,
    start_time: session.anchor_start,
  };
}

/**
 * Deepest ancestry match: walk the caller's chain from self outward; return
 * the first session whose stored anchor appears in the chain. Closer ancestors
 * win so two same-cwd sessions never cross-bind.
 *
 * `chain` is ordered self → parent → … → root (as the client walks it).
 */
export function matchSessionByAncestry(
  chain: ProcessAnchor[],
  sessions: SessionRow[],
): SessionRow | null {
  if (chain.length === 0 || sessions.length === 0) return null;
  for (const link of chain) {
    for (const session of sessions) {
      if (anchorsEqual(link, sessionAnchor(session))) return session;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Liveness (#280)
// ---------------------------------------------------------------------------

/** Liveness probe (defaults to `process.kill(pid, 0)`). Injectable for tests. */
export type PidAliveFn = (pid: number) => boolean;

/**
 * Optional start-time re-check against /proc (or a fake). When it returns a
 * string that differs from the stored anchor start, the pid was recycled →
 * dead. When it returns null (unreadable), the check is skipped.
 */
export type PidStartTimeFn = (pid: number) => string | null;

/** Default live-process probe (same semantics as daemon discovery / CLI). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read this host's machine id (Linux `/etc/machine-id`, else hostname).
 * Namespaces anchors so foreign-machine rows are never reaped as dead.
 */
export function readMachineId(): string {
  try {
    const id = fs.readFileSync("/etc/machine-id", "utf8").trim();
    if (id !== "") return id;
  } catch {
    /* not Linux or unreadable */
  }
  try {
    const host = os.hostname().trim();
    if (host !== "") return `host:${host}`;
  } catch {
    /* ignore */
  }
  return "unknown";
}

/**
 * Best-effort `/proc/<pid>/stat` starttime (field 22). Returns null when the
 * process table is unreadable — pid-liveness alone still applies.
 */
export function readPidStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const line = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = line.lastIndexOf(")");
    if (close < 0) return null;
    const rest = line.slice(close + 1).trimStart().split(/\s+/);
    // rest[0]=state, rest[1]=ppid, … rest[19]=starttime (field 22 overall).
    const startStr = rest[19];
    if (startStr === undefined || startStr === "") return null;
    return startStr;
  } catch {
    return null;
  }
}

/**
 * Liveness verdict for a stored session anchor (#280).
 *
 * - `dead`: same machine as the daemon and the pid is gone (or recycled —
 *   start-time mismatch when readable). Safe to reap and exclude from fallback.
 * - `indeterminate`: foreign machine id — never reap on liveness grounds;
 *   still counts as a binding candidate.
 * - `live`: same machine and pid is alive (start-time matches when checked).
 *
 * Pid-reuse stance: when the stored start is not the degraded `"0"` re-anchor
 * form and `/proc` yields a starttime that differs, treat as dead. When
 * starttime is unreadable, fall back to pid-liveness alone.
 */
export type SessionLiveness = "live" | "dead" | "indeterminate";

export function classifySessionLiveness(
  session: SessionRow,
  machineId: string,
  isAlive: PidAliveFn = isPidAlive,
  readStart: PidStartTimeFn = readPidStartTime,
): SessionLiveness {
  if (session.anchor_machine !== machineId) return "indeterminate";
  if (!isAlive(session.anchor_pid)) return "dead";
  // Degraded re-anchor form (`start_time: "0"`) cannot defeat pid recycling.
  if (session.anchor_start !== "0") {
    const liveStart = readStart(session.anchor_pid);
    if (liveStart !== null && liveStart !== session.anchor_start) return "dead";
  }
  return "live";
}

/** True when the session is not verifiably dead (live or indeterminate). */
export function isSessionCandidateLive(
  session: SessionRow,
  machineId: string,
  isAlive: PidAliveFn = isPidAlive,
  readStart: PidStartTimeFn = readPidStartTime,
): boolean {
  return classifySessionLiveness(session, machineId, isAlive, readStart) !== "dead";
}

/**
 * Resolve which session binds a call (#162 / #190 / #280 / #372).
 *
 * Precedence (CLI resolves env > flag into `explicitSessionId` before call):
 * 1. Explicit session id (`PARLEY_SESSION_ID` > `--session`) — always overrides.
 *    Known registered id → that row (even if dead); unknown id → free-form.
 * 2. Deepest ancestry match against all registered sessions.
 * 3. Parent-task orchestrator session (#372, fix path) — only when that id is
 *    still registered with the daemon. Never stamps a reaped/unknown id.
 * 4. Workspace fallback over non-dead sessions only:
 *    - exactly one → bind;
 *    - several → bind most-recently-updated, with a warning;
 *    - none → unresolved.
 *
 * The hard ambiguous error is gone: multi-live falls back to most-recent (#280).
 */
export type SessionResolveResult =
  | { kind: "bound"; session: SessionRow; warning?: string }
  | { kind: "freeform"; sessionId: string }
  | { kind: "unresolved" };

export function resolveSessionBinding(opts: {
  /** Explicit id from env/flag resolution (`PARLEY_SESSION_ID` > `--session`). */
  explicitSessionId: string | null;
  /** Caller's process-ancestry chain (self first). */
  ancestryChain: ProcessAnchor[];
  /** Absolute workspace root the call is for. */
  workspaceRoot: string;
  /** All registered sessions (or at least those the daemon knows). */
  sessions: SessionRow[];
  /**
   * Return false for verifiably-dead sessions (excluded from workspace
   * fallback). Default: every session is treated as live (unit tests that
   * do not exercise liveness).
   */
  isSessionLive?: (session: SessionRow) => boolean;
  /**
   * Parent task's orchestrator session id (fix path, #372). Considered only
   * after explicit + ancestry fail; binds only when the id is still present
   * in {@link sessions} (still registered). Unregistered/reaped ids fall
   * through to workspace fallback.
   */
  parentSessionId?: string | null;
}): SessionResolveResult {
  const { explicitSessionId, ancestryChain, workspaceRoot, sessions } = opts;

  if (explicitSessionId !== null && explicitSessionId !== "") {
    const known = sessions.find((s) => s.id === explicitSessionId);
    if (known) return { kind: "bound", session: known };
    return { kind: "freeform", sessionId: explicitSessionId };
  }

  const byAncestry = matchSessionByAncestry(ancestryChain, sessions);
  if (byAncestry) return { kind: "bound", session: byAncestry };

  // Parent inheritance (#372): only still-registered sessions.
  const parentId = opts.parentSessionId;
  if (parentId !== null && parentId !== undefined && parentId !== "") {
    const parentSession = sessions.find((s) => s.id === parentId);
    if (parentSession) return { kind: "bound", session: parentSession };
  }

  const isLive = opts.isSessionLive ?? (() => true);
  const candidates = sessions
    .filter((s) => s.workspace_root === workspaceRoot)
    .filter(isLive)
    .slice()
    .sort(compareSessionRecency);

  if (candidates.length === 1) return { kind: "bound", session: candidates[0]! };
  if (candidates.length > 1) {
    const best = candidates[0]!;
    return {
      kind: "bound",
      session: best,
      warning: sessionFallbackWarning(best.id, candidates.length),
    };
  }
  return { kind: "unresolved" };
}

/** Most-recently-updated first; stable id tie-break (matches listSessionsForWorkspace). */
function compareSessionRecency(a: SessionRow, b: SessionRow): number {
  if (a.updated_at !== b.updated_at) {
    return a.updated_at < b.updated_at ? 1 : -1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Spawn/eval dual-snapshot fields taken from a bound session. */
export interface ProvenanceSnapshot {
  session_id: string;
  /** Null when the session registered without PARLEY_HARNESS (#190). */
  harness: string | null;
  /** Null when the session registered without PARLEY_MODEL (#190). */
  model: string | null;
  /** Null when the session registered without PARLEY_EFFORT (#190). */
  effort: string | null;
}

export function snapshotFromSession(session: SessionRow): ProvenanceSnapshot {
  return {
    session_id: session.id,
    harness: session.harness,
    model: session.model,
    effort: session.effort,
  };
}

/**
 * Normalize optional free-form provenance: trim + lowercase, or null when
 * absent/blank. Never invents a default (#190).
 */
export function normalizeOptionalProvenance(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizeProvenance(value);
  return normalized === "" ? null : normalized;
}
