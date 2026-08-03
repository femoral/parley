import Ajv, { type ValidateFunction } from "ajv";
import type {
  JsonSchema as CoreJsonSchema,
  QaTurn as WireQaTurn,
  Report as CoreReport,
  TaskEnvelope,
  TaskRow as WireTaskRow,
} from "@useparley/core";
import { isSyntacticUrl } from "@useparley/core";
import type { QaTurnRow, TaskRow } from "./db.js";
import { readEvalExpected } from "./context.js";

/** A JSON Schema — an object of keywords (or a boolean schema). */
export type JsonSchema = CoreJsonSchema;

/**
 * Parley's default report schema (spec §4): the shape `submit_report` payloads
 * must satisfy when the caller supplies no `--report-schema`.
 *
 *   { summary: markdown, outcome: success|partial|blocked, files_changed: [str] }
 *
 * Workflow step tasks use a different schema: the daemon generates it from the
 * node's output ports via `compileOutputPorts` (ADR-0016 / #236) and stores it
 * on the same `report_schema` column — still one `submit_report` call, no new
 * child verb.
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

/**
 * Resolve the report schema a task validates / advertises against: the value
 * stored on the task row (caller `--report-schema`, or a schema generated from
 * output ports at step spawn), falling back to {@link DEFAULT_REPORT_SCHEMA}.
 * Single fallback path shared by `submitReport`, the MCP tool definition, and
 * envelope/preamble builders — do not reimplement the nullish chain elsewhere.
 */
export function resolveReportSchema(
  reportSchemaColumn: string | null | undefined,
): JsonSchema {
  return parseJsonColumn<JsonSchema>(reportSchemaColumn ?? null) ?? DEFAULT_REPORT_SCHEMA;
}

/** The body of a report accepted against the default schema. */
export type Report = CoreReport;

// Compiling a schema is not free; cache validators keyed by their serialized
// form so repeated `submit_report` calls (and re-validation across tasks that
// share a schema) reuse one compiled function.
const validatorCache = new Map<string, ValidateFunction>();

function makeAjv(): Ajv {
  // A fresh Ajv per distinct schema: two different caller schemas that happen
  // to declare the same `$id` each get their own registry, so neither trips
  // ajv's cross-schema "id already exists" guard. `strict: false` tolerates
  // unknown keywords in caller schemas; `allErrors` surfaces every violation to
  // the child at once (fewer retry round-trips).
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  // `url` ports compile to format:"uri" (ADR-0016). Ajv ships no formats by
  // default — register a syntactic check only; parley never dereferences.
  ajv.addFormat("uri", {
    type: "string",
    validate: (s: string) => isSyntacticUrl(s),
  });
  return ajv;
}

function compile(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = validatorCache.get(key);
  if (cached) return cached;
  const validate = makeAjv().compile(schema);
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

/**
 * Render one ajv error as a `path: message` line the child can act on.
 * Exported so deliverable reference-stat failures share the same bounce shape
 * (ADR-0016 / #236).
 */
export function formatReportError(path: string, message: string): string {
  const where = path === "" || path === "/" ? "report" : path;
  return `${where}: ${message}`;
}

/** Render one ajv error as a `path: message` line the child can act on. */
function formatError(error: { instancePath: string; message?: string }): string {
  const where = error.instancePath === "" ? "report" : error.instancePath;
  return formatReportError(where, error.message ?? "is invalid");
}

/**
 * Validate a `submit_report` payload against a report schema (the task's own,
 * or the default). Returns the list of violations — empty means valid.
 * Violations bounce back to the child as MCP tool errors so it can retry
 * (ADR-0003). Shape check only — file/dir reference stats live in
 * {@link validatePortReferences} (`deliverables.ts`).
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Describe one schema property for the preamble — type, enum, containers, and
 * bounds/descriptions so a child is told every cap it is held to (ADR-0016).
 */
export function describeField(raw: unknown): string {
  if (!isRecord(raw)) return "any";

  const parts: string[] = [];

  if (typeof raw.description === "string" && raw.description.trim() !== "") {
    parts.push(raw.description.trim());
  }

  if (Array.isArray(raw.enum) && raw.enum.length > 0) {
    parts.push(`one of ${raw.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  } else {
    const type = raw.type;
    if (type === "array") {
      const items = isRecord(raw.items) ? raw.items : undefined;
      const itemType =
        items && typeof items.type === "string"
          ? items.type
          : items && Array.isArray(items.enum)
            ? "enum"
            : undefined;
      parts.push(itemType !== undefined ? `array of ${itemType}` : "array");
    } else if (type === "object" && isRecord(raw.additionalProperties)) {
      const valueDesc = describeField(raw.additionalProperties);
      parts.push(`dict of ${valueDesc}`);
    } else if (typeof type === "string") {
      let base = type;
      if (raw.format === "uri") base = "url";
      parts.push(base);
    } else if (parts.length === 0) {
      parts.push("any");
    }
  }

  const constraints: string[] = [];
  if (typeof raw.maxLength === "number") constraints.push(`maxLength ${raw.maxLength}`);
  if (typeof raw.minLength === "number" && raw.minLength > 0) {
    constraints.push(`minLength ${raw.minLength}`);
  }
  if (typeof raw.maxItems === "number") constraints.push(`maxItems ${raw.maxItems}`);
  if (typeof raw.maxProperties === "number") {
    constraints.push(`maxProperties ${raw.maxProperties}`);
  }
  if (constraints.length > 0) parts.push(constraints.join(", "));

  return parts.join("; ");
}

/**
 * A compact, human summary of the report schema a child must satisfy — the
 * "report-schema summary" the protocol preamble teaches (spec §7). Handles the
 * default schema, caller-supplied object schemas, and schemas generated from
 * workflow output ports (ADR-0016). Degrades gracefully for boolean or
 * property-less schemas.
 */
export function summarizeReportSchema(schema: JsonSchema): string {
  if (typeof schema === "boolean") {
    return schema
      ? "Any JSON object is accepted as the report."
      : "No report will be accepted (the schema rejects everything).";
  }
  const props = isRecord(schema.properties) ? schema.properties : undefined;
  if (!props) {
    return "Submit a report satisfying the caller-supplied JSON Schema.";
  }
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const lines = Object.entries(props).map(([key, raw]) => {
    const suffix = required.includes(key) ? " (required)" : "";
    return `- \`${key}\`: ${describeField(raw)}${suffix}`;
  });
  return `Call \`submit_report\` with an object:\n${lines.join("\n")}`;
}

/**
 * @deprecated Use {@link TaskEnvelope} from `@useparley/core`. Kept as an
 * alias so residual deep imports compile during the #208 cutover.
 */
export type Envelope = TaskEnvelope;

/**
 * Compile-time guard that storage rows and Q&A turns remain assignable to the
 * public wire contract in `@useparley/core`. Envelope production is checked by
 * {@link buildEnvelope}'s return type being `TaskEnvelope` directly.
 */
type Assignable<From, To> = From extends To ? true : never;
const _rowMatchesContract: Assignable<TaskRow, WireTaskRow> = true;
const _qaTurnMatchesContract: Assignable<QaTurnRow, WireQaTurn> = true;
void _rowMatchesContract;
void _qaTurnMatchesContract;

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
 * Map one storage row (+ optional queue enrichment) to the public wire
 * envelope. Daemon-internal only — the HTTP/SSE seam is the sole caller.
 * `logsDir` is the task's captured output directory; pass null when unknown.
 */
export function buildEnvelope(
  task: TaskRow,
  logsDir: string | null = null,
  queue: { position: number | null; blockingCap: string | null } | null = null,
): TaskEnvelope {
  const start = task.started_at ?? task.created_at;
  const end = task.completed_at;
  const duration =
    end !== null ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;
  return {
    task_id: task.id,
    name: task.name,
    repo: task.repo,
    repo_key: task.repo_key ?? null,
    repo_fetch_url: task.repo_fetch_url ?? null,
    worktree: task.worktree,
    branch: task.branch,
    vendor: task.vendor,
    model: task.model,
    effort: task.effort,
    profile: task.profile,
    runner: task.runner,
    posture: { sandbox: task.sandbox, network: task.network === 1 },
    session_id: task.session_id,
    orchestrator_session_id: task.orchestrator_session_id,
    updated_at: task.updated_at,
    created_at: task.created_at,
    started_at: task.started_at,
    completed_at: task.completed_at,
    orch_harness: task.orch_harness,
    orch_model: task.orch_model,
    orch_effort: task.orch_effort,
    usage: parseJsonColumn<Record<string, number>>(task.usage),
    duration_ms: duration,
    state: task.state,
    report: parseJsonColumn<Report>(task.report),
    report_schema: parseJsonColumn<JsonSchema>(task.report_schema) ?? DEFAULT_REPORT_SCHEMA,
    error: task.error,
    logs_dir: logsDir,
    question_id: task.question_id,
    question: task.question,
    seq: task.seq,
    eval_expected: readEvalExpected(task.repo),
    size: task.size,
    difficulty: task.difficulty,
    type: task.type,
    parent_task_id: task.parent_task_id,
    attempt: task.attempt,
    resumed: task.resumed === 1,
    cached_input_tokens: task.cached_input_tokens,
    queue_position: queue?.position ?? null,
    blocking_cap: queue?.blockingCap ?? null,
    queue_reason: task.queue_reason ?? null,
  };
}
