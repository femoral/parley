import Ajv, { type ValidateFunction } from "ajv";
import type { TaskRow } from "./db.js";

/** A JSON Schema — an object of keywords (or a boolean schema). */
export type JsonSchema = Record<string, unknown> | boolean;

/**
 * Parley's default report schema (spec §4): the shape `submit_report` payloads
 * must satisfy when the caller supplies no `--report-schema`.
 *
 *   { summary: markdown, outcome: success|partial|blocked, files_changed: [str] }
 */
export const DEFAULT_REPORT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1 },
    outcome: { enum: ["success", "partial", "blocked"] },
    files_changed: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "outcome", "files_changed"],
};

/** The body of a report accepted against the default schema. */
export interface Report {
  summary: string;
  outcome: "success" | "partial" | "blocked";
  files_changed: string[];
}

// Compiling a schema is not free; cache validators keyed by their serialized
// form so repeated `submit_report` calls (and re-validation across tasks that
// share a schema) reuse one compiled function.
const validatorCache = new Map<string, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = validatorCache.get(key);
  if (cached) return cached;
  // A fresh Ajv per distinct schema: two different caller schemas that happen
  // to declare the same `$id` each get their own registry, so neither trips
  // ajv's cross-schema "id already exists" guard. `strict: false` tolerates
  // unknown keywords in caller schemas; `allErrors` surfaces every violation to
  // the child at once (fewer retry round-trips).
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  validatorCache.set(key, validate);
  return validate;
}

/**
 * Assert that a caller-supplied value is itself a valid JSON Schema, throwing a
 * descriptive `Error` if not. Called at delegate time so a bad `--report-schema`
 * is rejected before the task is ever created (spec §5, exit 2).
 */
export function assertValidSchema(schema: unknown): void {
  try {
    compile(schema as JsonSchema);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

/** Render one ajv error as a `path: message` line the child can act on. */
function formatError(error: { instancePath: string; message?: string }): string {
  const where = error.instancePath === "" ? "report" : error.instancePath;
  return `${where}: ${error.message ?? "is invalid"}`;
}

/**
 * Validate a `submit_report` payload against a report schema (the task's own,
 * or the default). Returns the list of violations — empty means valid.
 * Violations bounce back to the child as MCP tool errors so it can retry
 * (ADR-0003).
 */
export function validateReport(
  payload: unknown,
  schema: JsonSchema = DEFAULT_REPORT_SCHEMA,
): string[] {
  let validate: ValidateFunction;
  try {
    validate = compile(schema);
  } catch (err) {
    // A corrupt stored schema should not wedge the child; report it plainly.
    return [`report schema is invalid: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (validate(payload)) return [];
  return (validate.errors ?? []).map(formatError);
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
  session_id: string | null;
  usage: Record<string, number> | null;
  duration_ms: number | null;
  state: string;
  report: Report | null;
  /** The report schema actually applied to this task (default when omitted). */
  report_schema: JsonSchema;
  error: string | null;
  /**
   * Directory holding the task's captured vendor output (`vendor.jsonl`,
   * `stderr.log`) — the diagnostics reference, most useful on a `failed` task.
   */
  logs_dir: string | null;
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

/**
 * Build the report envelope for a task row. `logsDir` is the task's captured
 * output directory (the diagnostics reference); pass null when unknown.
 */
export function buildEnvelope(task: TaskRow, logsDir: string | null = null): Envelope {
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
    session_id: task.session_id,
    usage: parseJsonColumn<Record<string, number>>(task.usage),
    duration_ms: duration,
    state: task.state,
    report: parseJsonColumn<Report>(task.report),
    report_schema: parseJsonColumn<JsonSchema>(task.report_schema) ?? DEFAULT_REPORT_SCHEMA,
    error: task.error,
    logs_dir: logsDir,
    question_id: task.question_id,
    question: task.question,
  };
}
