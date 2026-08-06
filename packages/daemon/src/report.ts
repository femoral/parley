import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import type {
  JsonSchema as CoreJsonSchema,
  QaTurn as WireQaTurn,
  Report as CoreReport,
  ReportFileChange,
  TaskEnvelope,
  TaskRow as WireTaskRow,
} from "@useparley/core";
import { isSyntacticUrl, parseErrorCategory } from "@useparley/core";
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
 * Children still submit path strings; the daemon normalizes to
 * {@link ReportFileChange} objects and attaches optional +/− line counts at
 * ingestion (#349). Workflow step tasks use a different schema generated from
 * the node's output ports via `compileOutputPorts` (ADR-0016 / #236) and store
 * it on the same `report_schema` column — still one `submit_report` call, no
 * new child verb.
 */
export const DEFAULT_REPORT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1 },
    outcome: { type: "string", enum: ["success", "partial", "blocked"] },
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
 * Normalize one `files_changed` entry from storage or a child payload into a
 * {@link ReportFileChange}. Strings become path-only objects; object entries
 * keep optional `added`/`removed` when they are non-negative integers and
 * **preserve every other key** so custom `--report-schema` fields on file
 * objects (e.g. `reason`, `reviewer`) survive enrichment (#349 review).
 */
export function normalizeFileChangeEntry(raw: unknown): ReportFileChange | null {
  if (typeof raw === "string") {
    return raw === "" ? null : { path: raw };
  }
  if (!isRecord(raw) || typeof raw.path !== "string" || raw.path === "") {
    return null;
  }
  // Spread first so unknown keys survive; then reassert path + sanitize counts.
  const entry = { ...raw, path: raw.path } as ReportFileChange & Record<string, unknown>;
  if (typeof raw.added === "number" && Number.isInteger(raw.added) && raw.added >= 0) {
    entry.added = raw.added;
  } else {
    delete entry.added;
  }
  if (
    typeof raw.removed === "number" &&
    Number.isInteger(raw.removed) &&
    raw.removed >= 0
  ) {
    entry.removed = raw.removed;
  } else {
    delete entry.removed;
  }
  return entry;
}

/** Normalize a `files_changed` array; empty paths and non-entries are dropped. */
export function normalizeFilesChanged(raw: unknown): ReportFileChange[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportFileChange[] = [];
  for (const item of raw) {
    const entry = normalizeFileChangeEntry(item);
    if (entry !== null) out.push(entry);
  }
  return out;
}

/**
 * Parse a stored report JSON column for the envelope. Path strings and
 * {@link ReportFileChange} objects both pass through (#349); custom/port
 * schemas without a path-list `files_changed` are returned as-is.
 */
export function normalizeStoredReport(raw: unknown): Report | null {
  if (!isRecord(raw)) return null;
  return raw as unknown as Report;
}

/**
 * Resolve the post-rename path from a git numstat path field.
 * Handles flat (`old => new`) and braced (`src/{old.ts => new.ts}`,
 * `{a => b}/x`, `p/{a => b}/s`) forms. Production churn uses `--no-renames`
 * so these rarely appear; kept for defensive parsing of raw numstat text.
 */
export function decodeNumstatPath(filePath: string): string {
  const arrow = filePath.indexOf(" => ");
  if (arrow === -1) return filePath;
  const braceOpen = filePath.lastIndexOf("{", arrow);
  if (braceOpen === -1) {
    // Flat rename: everything after " => " is the new path.
    return filePath.slice(arrow + 4);
  }
  const braceClose = filePath.indexOf("}", arrow);
  if (braceClose === -1) {
    return filePath.slice(arrow + 4);
  }
  const prefix = filePath.slice(0, braceOpen);
  const newPart = filePath.slice(arrow + 4, braceClose);
  const suffix = filePath.slice(braceClose + 1);
  return prefix + newPart + suffix;
}

/**
 * Parse `git diff --numstat <base>` output into path → {added, removed}.
 * Binary rows (`-  -  path`) are skipped (counts unknown). Rename lines
 * (flat or braced) map to the new path via {@link decodeNumstatPath}.
 */
export function parseNumstat(output: string): Map<string, { added: number; removed: number }> {
  const map = new Map<string, { added: number; removed: number }>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const tab1 = line.indexOf("\t");
    if (tab1 === -1) continue;
    const tab2 = line.indexOf("\t", tab1 + 1);
    if (tab2 === -1) continue;
    const addedRaw = line.slice(0, tab1);
    const removedRaw = line.slice(tab1 + 1, tab2);
    const filePath = decodeNumstatPath(line.slice(tab2 + 1));
    if (addedRaw === "-" || removedRaw === "-") continue;
    const added = Number(addedRaw);
    const removed = Number(removedRaw);
    if (!Number.isInteger(added) || !Number.isInteger(removed)) continue;
    if (filePath === "") continue;
    map.set(filePath, { added, removed });
  }
  return map;
}

function gitText(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Count lines in an untracked (or otherwise un-diffable) text file. Returns
 * null for missing/binary-ish content so callers can omit churn rather than
 * invent numbers.
 */
function countFileLines(absPath: string): number | null {
  try {
    const buf = fs.readFileSync(absPath);
    // Heuristic: if there's a NUL, treat as binary — counts unknown.
    if (buf.includes(0)) return null;
    const text = buf.toString("utf8");
    if (text === "") return 0;
    // Match common line-count: trailing newline does not add an extra line.
    return text.endsWith("\n")
      ? text.slice(0, -1).split("\n").length
      : text.split("\n").length;
  } catch {
    return null;
  }
}

/**
 * Best-effort map of path → line churn for a checkout vs `baseSha`.
 * Includes tracked diffs (`git diff --numstat`) and untracked files (all
 * lines as added). Never throws — empty map on any git/fs failure.
 */
export function computeFileChurn(
  cwd: string,
  baseSha: string,
): Map<string, { added: number; removed: number }> {
  const map = new Map<string, { added: number; removed: number }>();
  if (baseSha === "" || !fs.existsSync(cwd)) return map;

  // quotePath=false: non-ASCII paths as real UTF-8, not C-quoted octal.
  // --no-renames: renames become delete+add rows (no `old => new` / brace form).
  const numstat = gitText(
    ["-c", "core.quotePath=false", "diff", "--numstat", "--no-renames", baseSha],
    cwd,
  );
  if (numstat !== null && numstat !== "") {
    for (const [p, c] of parseNumstat(numstat)) map.set(p, c);
  }

  const untracked = gitText(
    ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"],
    cwd,
  );
  if (untracked !== null && untracked !== "") {
    for (const rel of untracked.split("\0")) {
      if (rel === "" || map.has(rel)) continue;
      const lines = countFileLines(path.join(cwd, rel));
      if (lines === null) continue;
      map.set(rel, { added: lines, removed: 0 });
    }
  }
  return map;
}

/**
 * Options for report-ingestion enrichment (#349): where to look for git
 * diffs and which baseline to compare against.
 */
export interface EnrichReportChurnOptions {
  /** Task worktree or `--cwd` path; null skips git. */
  cwd: string | null;
  /** Task `base_sha`; null/empty skips git. */
  baseSha: string | null;
}

/**
 * Attach per-file +/− counts to `files_changed` when computable (or already
 * carried on object entries). The "ingestion wiring" for #349 — called from
 * `submitReport` after schema validation, before storage.
 *
 * When git context is missing and the child submitted plain path strings, the
 * payload is left unchanged (string[] remains string[]) so legacy consumers
 * and fixtures keep working. When any churn is known, entries are upgraded to
 * {@link ReportFileChange} objects. Never throws.
 */
export function enrichReportFilesChanged(
  payload: unknown,
  opts: EnrichReportChurnOptions,
): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.files_changed)) {
    return payload;
  }
  // Only rewrite when every element looks like a path string or file-change
  // object — leave custom schemas that repurpose the key alone.
  for (const item of payload.files_changed) {
    if (typeof item === "string") continue;
    if (isRecord(item) && typeof item.path === "string") continue;
    return payload;
  }

  const entries = normalizeFilesChanged(payload.files_changed);
  const canCompute =
    opts.cwd !== null &&
    opts.cwd !== "" &&
    opts.baseSha !== null &&
    opts.baseSha !== "";
  const churn = canCompute ? computeFileChurn(opts.cwd!, opts.baseSha!) : null;

  // Only rewrite storage when at least one listed path gets counts (or the
  // child already sent object entries). Otherwise keep path strings so
  // --cwd / no-match reports stay byte-compatible with legacy fixtures —
  // but still drop empty/invalid string entries so malformed handling does
  // not depend on whether churn was found (optional #349 review fix).
  const hadObjects = payload.files_changed.some((item) => typeof item !== "string");
  const anyListedHasChurn =
    churn !== null && entries.some((e) => churn.has(e.path));
  if (!hadObjects && !anyListedHasChurn) {
    if (entries.length === payload.files_changed.length) {
      // All strings were well-formed paths (normalize only dropped nothing).
      // Keep the original string[] identity.
      return payload;
    }
    // Dropped empty/non-path entries only — stay as path strings.
    return {
      ...payload,
      files_changed: entries.map((e) => e.path),
    };
  }

  const files_changed: ReportFileChange[] = entries.map((entry) => {
    if (entry.added !== undefined && entry.removed !== undefined) {
      return entry;
    }
    const c = churn?.get(entry.path);
    if (c === undefined) {
      // Path-only object when a sibling entry carried/gained counts.
      return entry;
    }
    // Spread so custom-schema keys on the entry survive count attachment.
    return {
      ...entry,
      path: entry.path,
      added: entry.added ?? c.added,
      removed: entry.removed ?? c.removed,
    };
  });

  return { ...payload, files_changed };
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
    report: normalizeStoredReport(parseJsonColumn(task.report)),
    report_schema: parseJsonColumn<JsonSchema>(task.report_schema) ?? DEFAULT_REPORT_SCHEMA,
    error: task.error,
    error_category: parseErrorCategory(task.error_category ?? null),
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
