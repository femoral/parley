import type { TaskRow } from "./db.js";
import type { Posture } from "./adapters/types.js";

/**
 * Parley's default report schema (spec §4): the shape `submit_report` payloads
 * must satisfy when the caller supplies no `--report-schema` (which is all of
 * v1's tracer — caller-supplied schemas arrive with a later ticket).
 *
 *   { summary: markdown, outcome: success|partial|blocked, files_changed: [str] }
 */
export interface Report {
  summary: string;
  outcome: "success" | "partial" | "blocked";
  files_changed: string[];
}

const OUTCOMES = new Set(["success", "partial", "blocked"]);

/**
 * Validate a `submit_report` payload against the default schema. Returns the
 * list of violations — empty means valid. Violations bounce back to the child
 * as MCP tool errors so it can retry (ADR-0003).
 */
export function validateReport(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return ["report must be a JSON object"];
  }
  const report = payload as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof report.summary !== "string" || report.summary.length === 0) {
    errors.push("summary: required, must be a non-empty string");
  }
  if (typeof report.outcome !== "string" || !OUTCOMES.has(report.outcome)) {
    errors.push('outcome: required, must be one of "success" | "partial" | "blocked"');
  }
  if (
    !Array.isArray(report.files_changed) ||
    report.files_changed.some((f) => typeof f !== "string")
  ) {
    errors.push("files_changed: required, must be an array of strings");
  }
  return errors;
}

/** The report envelope the daemon wraps around a task's outcome (spec §4). */
export interface Envelope {
  task_id: string;
  name: string | null;
  repo: string | null;
  /** The parley worktree path; null when `--cwd` bypassed worktree creation. */
  worktree: string | null;
  /** The branch parley created; the child's commits live here (parley never merges). */
  branch: string | null;
  vendor: string | null;
  model: string | null;
  /** The child's sandbox posture (spec §8): `{ sandbox, network }`. */
  posture: Posture;
  session_id: string | null;
  usage: Record<string, number> | null;
  duration_ms: number | null;
  state: string;
  report: Report | null;
  error: string | null;
  /** The outstanding question id while `awaiting_answer` (else null). */
  question_id: string | null;
  /** The outstanding question text while `awaiting_answer` (else null). */
  question: string | null;
}

/** Parse a nullable JSON text column; malformed content reads as null. */
export function parseJsonColumn<T>(value: string | null): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Build the report envelope for a task row. */
export function buildEnvelope(task: TaskRow): Envelope {
  const start = task.started_at ?? task.created_at;
  const end = task.completed_at;
  const duration =
    end !== null ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;
  return {
    task_id: task.id,
    name: task.name,
    repo: task.repo,
    worktree: task.worktree,
    branch: task.branch,
    vendor: task.vendor,
    model: task.model,
    posture: { sandbox: task.sandbox, network: task.network === 1 },
    session_id: task.session_id,
    usage: parseJsonColumn<Record<string, number>>(task.usage),
    duration_ms: duration,
    state: task.state,
    report: parseJsonColumn<Report>(task.report),
    error: task.error,
    question_id: task.question_id,
    question: task.question,
  };
}
