/**
 * Ancestry-matched session-state fallback (#196 / ADR-0013 addendum).
 *
 * Reuses the client-side ancestry chain (self → parent → …) from
 * {@link readLiveAncestryChain}. A state file is eligible when its `pid`
 * appears in that chain and still passes a live-process (and optional
 * start-time) sanity check. Deepest match wins; same-depth ties prefer
 * most-recent `updated_at`; remaining ties / garbage are skipped with a
 * diag note — never a crash.
 */
import {
  scanSessionStates,
  type SessionState,
  type SessionStateNote,
} from "@useparley/core";
import type { ProcessAnchor } from "./ancestry.js";

/** Liveness probe (defaults to `process.kill(pid, 0)`). Injectable for tests. */
export type PidAliveFn = (pid: number) => boolean;

/**
 * Optional start-time re-check: when provided and returns a string, it must
 * equal the ancestry chain's `start_time` for that pid (defeats pid recycle).
 * When it returns null (unreadable /proc), the check is skipped.
 */
export type PidStartTimeFn = (pid: number) => string | null;

/** Default live-process probe (same semantics as daemon discovery). */
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
 * Match a plugin-written session-state file to the caller's ancestry chain.
 * Returns null when nothing is eligible.
 */
export function matchSessionState(
  parleyHome: string,
  ancestryChain: readonly ProcessAnchor[],
  opts: {
    note?: SessionStateNote;
    isAlive?: PidAliveFn;
    readStartTime?: PidStartTimeFn;
  } = {},
): SessionState | null {
  if (ancestryChain.length === 0) return null;

  const isAlive = opts.isAlive ?? isPidAlive;
  const note = opts.note;
  const depthByPid = new Map<number, number>();
  const startByPid = new Map<number, string>();
  for (let i = 0; i < ancestryChain.length; i++) {
    const link = ancestryChain[i]!;
    // First occurrence wins (self is deepest / closest).
    if (!depthByPid.has(link.pid)) {
      depthByPid.set(link.pid, i);
      startByPid.set(link.pid, link.start_time);
    }
  }

  type Candidate = { state: SessionState; depth: number; path: string };
  const candidates: Candidate[] = [];

  for (const { path: filePath, state } of scanSessionStates(parleyHome, note)) {
    const depth = depthByPid.get(state.pid);
    if (depth === undefined) continue;

    if (!isAlive(state.pid)) {
      note?.(`session-state: ignoring dead pid ${state.pid} at ${filePath}`);
      continue;
    }

    if (opts.readStartTime !== undefined) {
      const liveStart = opts.readStartTime(state.pid);
      const chainStart = startByPid.get(state.pid);
      if (
        liveStart !== null &&
        chainStart !== undefined &&
        liveStart !== chainStart
      ) {
        note?.(
          `session-state: start_time mismatch for pid ${state.pid} at ${filePath}`,
        );
        continue;
      }
    }

    candidates.push({ state, depth, path: filePath });
  }

  if (candidates.length === 0) return null;

  // Deepest (smallest chain index) first; then most-recent updated_at.
  candidates.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return compareIsoDesc(a.state.updated_at, b.state.updated_at);
  });

  const best = candidates[0]!;
  // Same depth + same updated_at as another candidate → ambiguous, skip with note.
  const ties = candidates.filter(
    (c) =>
      c.depth === best.depth &&
      c.state.updated_at === best.state.updated_at &&
      c.path !== best.path,
  );
  if (ties.length > 0) {
    note?.(
      `session-state: ambiguous match at depth ${best.depth} ` +
        `(${best.path} vs ${ties[0]!.path}); skipping`,
    );
    return null;
  }

  return best.state;
}

/** ISO compare descending; empty/unparseable sorts last. */
function compareIsoDesc(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  // Lexicographic works for ISO-8601 timestamps.
  return a < b ? 1 : -1;
}

/**
 * Env-first provenance field: non-empty env string, else session-state value,
 * else null. Does not invent defaults (#190 / #196).
 */
export function resolveProvenanceField(
  envValue: string | undefined,
  fromState: string | null | undefined,
): string | null {
  if (typeof envValue === "string") {
    const trimmed = envValue.trim();
    if (trimmed !== "") return trimmed;
  }
  if (typeof fromState === "string") {
    const trimmed = fromState.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/**
 * Session id resolution: `PARLEY_SESSION_ID` > `--session` > state-file
 * `harness_session_id` > null (caller falls through to ancestry / fresh id).
 */
export function resolveOrchestratorSessionId(opts: {
  envSessionId: string | undefined;
  flagSessionId: string | null;
  stateSessionId: string | null | undefined;
}): string | null {
  if (typeof opts.envSessionId === "string") {
    const trimmed = opts.envSessionId.trim();
    if (trimmed !== "") return trimmed;
  }
  if (opts.flagSessionId !== null && opts.flagSessionId !== "") {
    return opts.flagSessionId;
  }
  if (typeof opts.stateSessionId === "string") {
    const trimmed = opts.stateSessionId.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/**
 * Resolve harness/model/effort: env > matched session-state > null.
 * When `matched` is null, all three fall through to env-only (or null).
 */
export function resolveProvenanceFromEnvAndState(
  env: NodeJS.ProcessEnv,
  matched: SessionState | null,
): { harness: string | null; model: string | null; effort: string | null } {
  return {
    harness: resolveProvenanceField(env.PARLEY_HARNESS, matched?.harness),
    model: resolveProvenanceField(env.PARLEY_MODEL, matched?.model),
    effort: resolveProvenanceField(env.PARLEY_EFFORT, matched?.effort),
  };
}

/**
 * Look up a matched session-state for this process (or return null).
 * Centralizes the home/chain/note wiring used by session and id resolution.
 */
export function resolveMatchedSessionState(opts: {
  parleyHome: string;
  ancestryChain: readonly ProcessAnchor[];
  note?: SessionStateNote;
  isAlive?: PidAliveFn;
  readStartTime?: PidStartTimeFn;
}): SessionState | null {
  try {
    return matchSessionState(opts.parleyHome, opts.ancestryChain, {
      note: opts.note,
      isAlive: opts.isAlive,
      readStartTime: opts.readStartTime,
    });
  } catch (err) {
    opts.note?.(
      `session-state: match failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Explicit orchestrator session id for delegate/fix/eval (#190 / #196):
 * `PARLEY_SESSION_ID` > `--session` > ancestry-matched state-file id > null.
 * Skips the filesystem scan when env or flag already resolves (cheap path).
 */
export function resolveExplicitSessionId(opts: {
  env: NodeJS.ProcessEnv;
  flagSessionId: string | null;
  parleyHome: string;
  ancestryChain: readonly ProcessAnchor[];
  note?: SessionStateNote;
  isAlive?: PidAliveFn;
}): string | null {
  const fromEnvFlag = resolveOrchestratorSessionId({
    envSessionId: opts.env.PARLEY_SESSION_ID,
    flagSessionId: opts.flagSessionId,
    stateSessionId: null,
  });
  if (fromEnvFlag !== null) return fromEnvFlag;

  const matched = resolveMatchedSessionState({
    parleyHome: opts.parleyHome,
    ancestryChain: opts.ancestryChain,
    note: opts.note,
    isAlive: opts.isAlive,
  });
  return resolveOrchestratorSessionId({
    envSessionId: undefined,
    flagSessionId: null,
    stateSessionId: matched?.harness_session_id ?? null,
  });
}
