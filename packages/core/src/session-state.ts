/**
 * Plugin-written session-state files (ADR-0013 addendum / #196).
 *
 * INTERIM delivery channel for harness provenance when env injection is
 * incomplete or unavailable. Plugins write; parley reads. Path convention:
 *
 *   ~/.parley/vendors/<vendor>/sessions/<harness-session-id>/state.json
 *
 * (`PARLEY_HOME` replaces `~/.parley` when set.) Schema is parley-owned so
 * harness-format churn stays inside each vendor plugin.
 *
 * Write-side recorder (`recordSessionState`, #211): plugins own observation;
 * core owns merge policy, skip-if-unchanged, and atomic I/O. Does not swallow
 * I/O errors — callers choose fail-open.
 */
import fs from "node:fs";
import path from "node:path";

import { resolveHome } from "./home.js";

/**
 * Parley-owned session-state schema written by harness plugins.
 * `model` / `effort` are nullable (honest unknown).
 */
export interface SessionState {
  /** Parley vendor id of the harness (`claude`, `codex`, `grok`, `pi`, …). */
  harness: string;
  /** Harness's own session id — used as parley's orchestrator session id. */
  harness_session_id: string;
  /** Resolved model slug, or null when the harness has not resolved one. */
  model: string | null;
  /** Resolved effort/thinking level, or null when unknown. */
  effort: string | null;
  /** Harness process id — ancestry matching keys off this. */
  pid: number;
  /** ISO-8601 when the plugin first wrote this file for the session. */
  started_at: string;
  /** ISO-8601 of the most recent write (lazy completion / model switch). */
  updated_at: string;
}

/** Optional note callback for unreadable / ineligible files (never throws). */
export type SessionStateNote = (message: string) => void;

/**
 * Absolute path of a session-state file under a resolved parley home.
 * Rejects vendor / session-id segments that would escape the vendors tree.
 */
export function sessionStatePath(
  parleyHome: string,
  vendor: string,
  harnessSessionId: string,
): string {
  assertSafePathSegment(vendor, "vendor");
  assertSafePathSegment(harnessSessionId, "harness_session_id");
  return path.join(
    parleyHome,
    "vendors",
    vendor,
    "sessions",
    harnessSessionId,
    "state.json",
  );
}

function assertSafePathSegment(value: string, label: string): void {
  if (value === "" || value === "." || value === "..") {
    throw new Error(`session-state: invalid ${label}`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`session-state: invalid ${label}`);
  }
}

/**
 * Validate unknown JSON into {@link SessionState}. Returns null when the
 * payload is not an object or lacks required match/identity fields (`pid`,
 * `harness_session_id`). Partial optional fields become honest nulls.
 */
export function parseSessionState(value: unknown): SessionState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const o = value as Record<string, unknown>;

  const harnessSessionId = nonEmptyString(o.harness_session_id);
  if (harnessSessionId === null) return null;

  const pid = parsePid(o.pid);
  if (pid === null) return null;

  const harness = nonEmptyString(o.harness) ?? "";
  const model = nullableString(o.model);
  const effort = nullableString(o.effort);
  const started_at = nonEmptyString(o.started_at) ?? "";
  const updated_at = nonEmptyString(o.updated_at) ?? started_at;

  return {
    harness,
    harness_session_id: harnessSessionId,
    model,
    effort,
    pid,
    started_at,
    updated_at,
  };
}

/** Non-empty trimmed string, or null. Shared by plugins + parser. */
export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Nullable string field: absent / null / blank → null; non-string → null
 * (honest unknown rather than crash).
 */
function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parsePid(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

/**
 * Read and validate a session-state file. Missing / unreadable / malformed
 * JSON / schema-invalid payloads return null (never throw).
 */
export function readSessionState(
  filePath: string,
  note?: SessionStateNote,
): SessionState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    note?.(`session-state: unreadable ${filePath}: ${errMessage(err)}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    note?.(`session-state: malformed JSON at ${filePath}`);
    return null;
  }
  const state = parseSessionState(parsed);
  if (state === null) {
    note?.(`session-state: invalid schema at ${filePath}`);
  }
  return state;
}

/**
 * Atomically write a session-state file (write-temp + rename). Creates parent
 * directories. Throws on I/O failure so plugins surface write errors.
 */
export function writeSessionState(filePath: string, state: SessionState): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Scan `parleyHome/vendors/<vendor>/sessions/<id>/state.json` and return
 * validated states with their absolute paths. Unreadable/malformed entries
 * are skipped with an optional note — never throws.
 */
export function scanSessionStates(
  parleyHome: string,
  note?: SessionStateNote,
): { path: string; state: SessionState }[] {
  const vendorsRoot = path.join(parleyHome, "vendors");
  let vendors: string[];
  try {
    vendors = fs.readdirSync(vendorsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    note?.(`session-state: cannot list vendors under ${vendorsRoot}: ${errMessage(err)}`);
    return [];
  }

  const out: { path: string; state: SessionState }[] = [];
  for (const vendor of vendors) {
    const sessionsRoot = path.join(vendorsRoot, vendor, "sessions");
    let sessionIds: string[];
    try {
      sessionIds = fs.readdirSync(sessionsRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      note?.(`session-state: cannot list ${sessionsRoot}: ${errMessage(err)}`);
      continue;
    }
    for (const sessionId of sessionIds) {
      const filePath = path.join(sessionsRoot, sessionId, "state.json");
      const state = readSessionState(filePath, note);
      if (state !== null) out.push({ path: filePath, state });
    }
  }
  return out;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Write-side provenance recorder (#211)
// ---------------------------------------------------------------------------

/**
 * How an observed field combines with a previously written value.
 *
 * - `fill` (default): `observed ?? previous ?? null` — never clobber a known
 *   value with “not available this event” (codex / claude post-start).
 * - `replace`: when the observation *supplies* the field (including explicit
 *   null from a successful read), that value wins (grok summary.found path).
 */
export type FieldMergePolicy = "fill" | "replace";

/**
 * Vendor-agnostic observation the plugin hands the recorder after parsing
 * harness-specific artifacts. Plugins own observation; core owns policy + I/O.
 */
export interface ProvenanceObservation {
  harness: string;
  harness_session_id: string;
  /** Absent or undefined ⇒ treat as “not observed this event”. */
  model?: string | null;
  effort?: string | null;
  pid: number;
  modelPolicy?: FieldMergePolicy; // default "fill"
  effortPolicy?: FieldMergePolicy; // default "fill"
  /**
   * When policy is `replace`, whether this event actually produced a field
   * observation. Grok sets `{ model: true, effort: true }` only when
   * summary.found; otherwise both false and previous is kept.
   */
  observed?: { model?: boolean; effort?: boolean };
}

export interface RecordSessionOptions {
  parleyHome?: string;
  env?: NodeJS.ProcessEnv; // for resolveHome; default process.env
  now?: () => Date;
  /** Default true. First write always lands. */
  skipIfUnchanged?: boolean;
}

export interface RecordSessionResult {
  state: SessionState;
  previous: SessionState | null;
  /** False when skip-if-unchanged suppressed the write. */
  written: boolean;
}

/**
 * Read → merge → skip-if-unchanged → atomic write.
 * Throws only on write I/O failure (same contract as writeSessionState).
 * Returns null only when harness_session_id / pid are invalid.
 */
export function recordSessionState(
  observation: ProvenanceObservation,
  options: RecordSessionOptions = {},
): RecordSessionResult | null {
  const sessionId = nonEmptyString(observation.harness_session_id);
  if (sessionId === null) return null;

  const harness = nonEmptyString(observation.harness);
  if (harness === null) return null;

  if (!isSafePathSegment(sessionId) || !isSafePathSegment(harness)) {
    return null;
  }

  const pid = observation.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const parleyHome =
    options.parleyHome ?? resolveHome(options.env ?? process.env);
  const file = sessionStatePath(parleyHome, harness, sessionId);
  const previous = readSessionState(file);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();

  const model = mergeProvenanceField(
    observation.model,
    previous?.model ?? null,
    observation.modelPolicy ?? "fill",
    observation.observed?.model === true,
  );
  const effort = mergeProvenanceField(
    observation.effort,
    previous?.effort ?? null,
    observation.effortPolicy ?? "fill",
    observation.observed?.effort === true,
  );

  const state: SessionState = {
    harness,
    harness_session_id: sessionId,
    model,
    effort,
    pid,
    started_at:
      previous?.started_at && previous.started_at !== ""
        ? previous.started_at
        : timestamp,
    updated_at: timestamp,
  };

  const skipIfUnchanged = options.skipIfUnchanged !== false;
  if (
    skipIfUnchanged &&
    previous !== null &&
    previous.harness === state.harness &&
    previous.harness_session_id === state.harness_session_id &&
    previous.model === state.model &&
    previous.effort === state.effort &&
    previous.pid === state.pid
  ) {
    return { state: previous, previous, written: false };
  }

  writeSessionState(file, state);
  return { state, previous, written: true };
}

/**
 * Merge one nullable provenance field under fill or replace policy.
 *
 * - fill: non-empty observation wins; else previous; else null.
 * - replace + observed: nonEmpty(observation) wins (may be honest null).
 * - replace without observed: keep previous.
 */
function mergeProvenanceField(
  observed: string | null | undefined,
  previous: string | null,
  policy: FieldMergePolicy,
  fieldObserved: boolean,
): string | null {
  if (policy === "fill") {
    return nonEmptyString(observed) ?? previous ?? null;
  }
  // replace
  if (fieldObserved) {
    return nonEmptyString(observed);
  }
  return previous ?? null;
}

function isSafePathSegment(value: string): boolean {
  if (value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  return true;
}

/** Materialize the four ADR-0013 env names from a resolved state. */
export function provenanceEnvVars(
  state: Pick<
    SessionState,
    "harness_session_id" | "harness" | "model" | "effort"
  >,
): {
  PARLEY_SESSION_ID: string;
  PARLEY_HARNESS: string;
  PARLEY_MODEL?: string;
  PARLEY_EFFORT?: string;
} {
  const out: {
    PARLEY_SESSION_ID: string;
    PARLEY_HARNESS: string;
    PARLEY_MODEL?: string;
    PARLEY_EFFORT?: string;
  } = {
    PARLEY_SESSION_ID: state.harness_session_id,
    PARLEY_HARNESS: state.harness,
  };
  const model = nonEmptyString(state.model);
  if (model !== null) out.PARLEY_MODEL = model;
  const effort = nonEmptyString(state.effort);
  if (effort !== null) out.PARLEY_EFFORT = effort;
  return out;
}

/** Apply provenanceEnvVars onto an env object (default process.env). */
export function applyProvenanceEnv(
  state: Pick<
    SessionState,
    "harness_session_id" | "harness" | "model" | "effort"
  >,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const vars = provenanceEnvVars(state);
  env.PARLEY_SESSION_ID = vars.PARLEY_SESSION_ID;
  env.PARLEY_HARNESS = vars.PARLEY_HARNESS;
  if (vars.PARLEY_MODEL !== undefined) {
    env.PARLEY_MODEL = vars.PARLEY_MODEL;
  } else {
    delete env.PARLEY_MODEL;
  }
  if (vars.PARLEY_EFFORT !== undefined) {
    env.PARLEY_EFFORT = vars.PARLEY_EFFORT;
  } else {
    delete env.PARLEY_EFFORT;
  }
}
