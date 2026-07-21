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
 */
import fs from "node:fs";
import path from "node:path";

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

  const harnessSessionId = optionalNonEmptyString(o.harness_session_id);
  if (harnessSessionId === null) return null;

  const pid = parsePid(o.pid);
  if (pid === null) return null;

  const harness = optionalNonEmptyString(o.harness) ?? "";
  const model = nullableString(o.model);
  const effort = nullableString(o.effort);
  const started_at = optionalNonEmptyString(o.started_at) ?? "";
  const updated_at = optionalNonEmptyString(o.updated_at) ?? started_at;

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

/** Non-empty trimmed string, or null. */
function optionalNonEmptyString(value: unknown): string | null {
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
