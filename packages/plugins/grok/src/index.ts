/**
 * Grok Build session provenance plugin (ADR-0013 / #193).
 *
 * Grok passive hooks cannot inject env into the session (stdout ignored).
 * This plugin writes the interim parley session-state file only:
 *
 *   ~/.parley/vendors/grok/sessions/<harness-session-id>/state.json
 *
 * SessionStart records id + harness pid with null model/effort. Later
 * UserPromptSubmit / Stop events lazy-fill model/effort from the harness's
 * own summary.json (current_model_id / reasoning_effort).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readSessionState,
  resolveHome,
  sessionStatePath,
  writeSessionState,
  type SessionState,
} from "@useparley/core";

export const HARNESS = "grok";

/** Env vars the Grok hook runner (and parley) may set on the hook process. */
export type HookEnv = {
  GROK_SESSION_ID?: string;
  GROK_HOME?: string;
  GROK_WORKSPACE_ROOT?: string;
  HOME?: string;
  PARLEY_HOME?: string;
};

/** Subset of Grok hook stdin JSON we care about. */
export type HookStdin = {
  sessionId?: unknown;
  hookEventName?: unknown;
};

export type RunHookOptions = {
  env?: HookEnv & NodeJS.ProcessEnv;
  /** Raw stdin JSON (already parsed). */
  stdin?: HookStdin;
  /**
   * Harness process pid. Defaults to `process.ppid` (the grok parent of the
   * hook child). Injected in tests.
   */
  harnessPid?: number;
  /** Override clock for tests. */
  now?: () => Date;
};

/**
 * Resolve the harness session id: env `GROK_SESSION_ID` first, then stdin.
 * Returns null when neither yields a non-empty safe id.
 */
export function resolveSessionId(
  env: HookEnv = {},
  stdin: HookStdin = {},
): string | null {
  const fromEnv = optionalNonEmptyString(env.GROK_SESSION_ID);
  if (fromEnv !== null && isSafeSessionId(fromEnv)) return fromEnv;

  const fromStdin = optionalNonEmptyString(stdin.sessionId);
  if (fromStdin !== null && isSafeSessionId(fromStdin)) return fromStdin;

  return null;
}

function isSafeSessionId(id: string): boolean {
  // Reject path segments that would escape the sessions tree.
  if (id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  return true;
}

/** Resolve Grok home (`GROK_HOME` or `~/.grok`). */
export function resolveGrokHome(env: HookEnv = process.env): string {
  const override = optionalNonEmptyString(env.GROK_HOME);
  if (override !== null) return path.resolve(override);
  const home = optionalNonEmptyString(env.HOME) ?? os.homedir();
  return path.join(home, ".grok");
}

/**
 * Locate `summary.json` for a session under `$GROK_HOME/sessions`.
 * Layout (verified): `sessions/<url-encoded-cwd>/<session-id>/summary.json`.
 * Returns null when not found — never throws.
 */
export function findSessionSummaryPath(
  grokHome: string,
  sessionId: string,
): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const sessionsRoot = path.join(grokHome, "sessions");
  let cwdDirs: string[];
  try {
    cwdDirs = fs.readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  for (const cwdDir of cwdDirs) {
    // Skip non-directories cheaply via exists check on the full path.
    const candidate = path.join(sessionsRoot, cwdDir, sessionId, "summary.json");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try next cwd bucket */
    }
  }
  return null;
}

export type SummaryProvenance = {
  model: string | null;
  effort: string | null;
  /** True when the file existed and parsed as a JSON object. */
  found: boolean;
};

/**
 * Read model/effort from a Grok session `summary.json`. Tolerant: missing
 * file, unreadable I/O, malformed JSON, or non-string fields → nulls, never
 * throws.
 */
export function readSummaryProvenance(
  summaryPath: string | null,
): SummaryProvenance {
  if (summaryPath === null) {
    return { model: null, effort: null, found: false };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(summaryPath, "utf8");
  } catch {
    return { model: null, effort: null, found: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { model: null, effort: null, found: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { model: null, effort: null, found: false };
  }
  const o = parsed as Record<string, unknown>;
  return {
    model: optionalNonEmptyString(o.current_model_id),
    effort: optionalNonEmptyString(o.reasoning_effort),
    found: true,
  };
}

function optionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Write or update the parley session-state file for this Grok session.
 * Returns the written state, or null when there is nothing to record
 * (missing session id / invalid pid). Never throws for harness artifact
 * problems; I/O failures from `writeSessionState` propagate.
 */
export function runHook(options: RunHookOptions = {}): SessionState | null {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? {};
  const sessionId = resolveSessionId(env, stdin);
  if (sessionId === null) return null;

  const pid = options.harnessPid ?? process.ppid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const now = (options.now ?? (() => new Date()))().toISOString();
  const parleyHome = resolveHome(env);
  const stateFile = sessionStatePath(parleyHome, HARNESS, sessionId);
  const existing = readSessionState(stateFile);

  const grokHome = resolveGrokHome(env);
  const summaryPath = findSessionSummaryPath(grokHome, sessionId);
  const summary = readSummaryProvenance(summaryPath);

  // When summary is readable, trust its fields (including honest nulls).
  // When missing/unreadable, keep any previously recorded values.
  const model = summary.found ? summary.model : (existing?.model ?? null);
  const effort = summary.found ? summary.effort : (existing?.effort ?? null);

  const state: SessionState = {
    harness: HARNESS,
    harness_session_id: sessionId,
    model,
    effort,
    pid,
    started_at: existing?.started_at && existing.started_at !== ""
      ? existing.started_at
      : now,
    updated_at: now,
  };

  // Skip rewrite when nothing material changed (still first-write always).
  if (
    existing &&
    existing.harness === state.harness &&
    existing.harness_session_id === state.harness_session_id &&
    existing.model === state.model &&
    existing.effort === state.effort &&
    existing.pid === state.pid
  ) {
    return existing;
  }

  writeSessionState(stateFile, state);
  return state;
}
