/**
 * Orchestrator session provenance binding (#162).
 *
 * The CLI walks process ancestry client-side and ships the chain; the daemon
 * only matches chains against stored session anchors. Pure functions so unit
 * tests can craft chains without a process table.
 */
import type { ProcessAnchor, SessionRow } from "./db.js";

/** Stable daemon/CLI error code when evals are on and no session resolves. */
export const CODE_SESSION_REQUIRED = "session_required";

/** Teaching message for {@link CODE_SESSION_REQUIRED}. */
export function sessionRequiredMessage(): string {
  return (
    "session_required: register an orchestrator session first " +
    "(`parley session --harness/-v <h> --model/-m <m> --effort/-e <e>`), " +
    "or pass --session <id> for a known session"
  );
}

/** Message when multiple live sessions share a workspace and ancestry is silent. */
export function sessionAmbiguousMessage(workspaceRoot: string, count: number): string {
  return (
    `ambiguous orchestrator session: ${count} live sessions for workspace ${workspaceRoot}; ` +
    "pass --session <id> or re-register so ancestry can bind"
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

/**
 * Resolve which session binds a call (#162).
 *
 * Precedence:
 * 1. Explicit session id (`--session` / `PARLEY_SESSION_ID`) — always overrides.
 *    Known registered id → that row; unknown id → free-form stamp (null row).
 * 2. Deepest ancestry match against all registered sessions.
 * 3. Exactly one live session for `workspaceRoot` → that session.
 * 4. Multiple live sessions for the workspace and no ancestry match → ambiguous.
 * 5. None → unresolved.
 */
export type SessionResolveResult =
  | { kind: "bound"; session: SessionRow }
  | { kind: "freeform"; sessionId: string }
  | { kind: "ambiguous"; count: number }
  | { kind: "unresolved" };

export function resolveSessionBinding(opts: {
  /** Explicit override from `--session` / `PARLEY_SESSION_ID`, if any. */
  explicitSessionId: string | null;
  /** Caller's process-ancestry chain (self first). */
  ancestryChain: ProcessAnchor[];
  /** Absolute workspace root the call is for. */
  workspaceRoot: string;
  /** All registered sessions (or at least those the daemon knows). */
  sessions: SessionRow[];
}): SessionResolveResult {
  const { explicitSessionId, ancestryChain, workspaceRoot, sessions } = opts;

  if (explicitSessionId !== null && explicitSessionId !== "") {
    const known = sessions.find((s) => s.id === explicitSessionId);
    if (known) return { kind: "bound", session: known };
    return { kind: "freeform", sessionId: explicitSessionId };
  }

  const byAncestry = matchSessionByAncestry(ancestryChain, sessions);
  if (byAncestry) return { kind: "bound", session: byAncestry };

  const live = sessions.filter((s) => s.workspace_root === workspaceRoot);
  if (live.length === 1) return { kind: "bound", session: live[0]! };
  if (live.length > 1) return { kind: "ambiguous", count: live.length };
  return { kind: "unresolved" };
}

/** Spawn/eval dual-snapshot fields taken from a bound session. */
export interface ProvenanceSnapshot {
  session_id: string;
  harness: string;
  model: string;
  effort: string;
}

export function snapshotFromSession(session: SessionRow): ProvenanceSnapshot {
  return {
    session_id: session.id,
    harness: session.harness,
    model: session.model,
    effort: session.effort,
  };
}
