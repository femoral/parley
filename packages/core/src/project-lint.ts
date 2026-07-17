/**
 * Shared project `.parley` surface validation (#161). Used by standalone
 * `parley lint` and by the daemon's hot-read paths (via the same parse helpers)
 * so lint-clean ⇒ delegate-safe.
 *
 * Surfaces:
 * - `.parley/config.json` (eval/resume/retry/taskTypes)
 * - `.parley/classification.json` (sizes/difficulties with guidance)
 * - `.parley/rubrics/*.json` (schema + task-type resolution + version-bump reminder)
 */
import {
  parseClassification,
  parseTaskTypesSection,
  resolveTaskTypes,
  type TaskTypesMap,
} from "./classification.js";
import {
  getShippedRubric,
  parseRubric,
  resolveRubricIdForType,
  type Criterion,
  type Rubric,
} from "./rubric.js";
import { parseDuration } from "./util/time.js";

/** Lint finding severity. Errors fail CI (exit 1); warnings do not. */
export type LintSeverity = "error" | "warning";

/** One named finding against a project surface. */
export interface LintFinding {
  severity: LintSeverity;
  /** Relative path under the project, e.g. `.parley/config.json`. */
  file: string;
  /** Dotted / indexed field path naming the bad field (empty for file-level). */
  field: string;
  message: string;
}

/** Aggregate lint result for a project root. */
export interface LintResult {
  /** True when there are no error-severity findings (warnings allowed). */
  ok: boolean;
  findings: LintFinding[];
}

/** Relative paths of the three project surfaces under a repo root. */
export const PROJECT_CONFIG_REL = ".parley/config.json";
export const PROJECT_CLASSIFICATION_REL = ".parley/classification.json";
export const PROJECT_RUBRICS_DIR_REL = ".parley/rubrics";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finding(
  severity: LintSeverity,
  file: string,
  field: string,
  message: string,
): LintFinding {
  return { severity, file, field, message };
}

/**
 * Validate the project config object (eval / resume / retry / taskTypes).
 * Missing file is fine; present-but-invalid fields produce named errors.
 * Returns the effective taskTypes map (shipped defaults when absent).
 */
export function lintProjectConfig(
  raw: unknown | undefined,
  findings: LintFinding[],
  file = PROJECT_CONFIG_REL,
): TaskTypesMap {
  if (raw === undefined) return resolveTaskTypes(undefined);
  if (!isRecord(raw)) {
    findings.push(finding("error", file, "", "config must be a JSON object"));
    return resolveTaskTypes(undefined);
  }

  if (raw.eval !== undefined) {
    if (!isRecord(raw.eval)) {
      findings.push(finding("error", file, "eval", "eval must be an object"));
    } else {
      for (const key of ["enabled", "expected"] as const) {
        if (raw.eval[key] !== undefined && typeof raw.eval[key] !== "boolean") {
          findings.push(
            finding("error", file, `eval.${key}`, `eval.${key} must be a boolean`),
          );
        }
      }
    }
  }

  if (raw.resume !== undefined) {
    if (!isRecord(raw.resume)) {
      findings.push(finding("error", file, "resume", "resume must be an object"));
    } else if (
      raw.resume.enabled !== undefined &&
      typeof raw.resume.enabled !== "boolean"
    ) {
      findings.push(
        finding("error", file, "resume.enabled", "resume.enabled must be a boolean"),
      );
    }
  }

  if (raw.retry !== undefined) {
    if (!isRecord(raw.retry)) {
      findings.push(finding("error", file, "retry", "retry must be an object"));
    } else {
      if (raw.retry.max !== undefined) {
        const max = raw.retry.max;
        if (typeof max !== "number" || !Number.isInteger(max) || max < 0) {
          findings.push(
            finding(
              "error",
              file,
              "retry.max",
              "retry.max must be a non-negative integer",
            ),
          );
        }
      }
      if (raw.retry.window !== undefined) {
        const window = raw.retry.window;
        if (typeof window === "string") {
          if (window === "" || parseDuration(window) === null) {
            findings.push(
              finding(
                "error",
                file,
                "retry.window",
                "retry.window must be a duration string (e.g. 30m, 90s) or non-negative number",
              ),
            );
          }
        } else if (typeof window === "number") {
          if (!Number.isFinite(window) || window < 0) {
            findings.push(
              finding(
                "error",
                file,
                "retry.window",
                "retry.window must be a duration string (e.g. 30m, 90s) or non-negative number",
              ),
            );
          }
        } else {
          findings.push(
            finding(
              "error",
              file,
              "retry.window",
              "retry.window must be a duration string (e.g. 30m, 90s) or non-negative number",
            ),
          );
        }
      }
    }
  }

  if (raw.taskTypes !== undefined) {
    try {
      const parsed = parseTaskTypesSection(raw.taskTypes);
      return parsed === null ? resolveTaskTypes(undefined) : parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push(finding("error", file, "taskTypes", msg));
      return resolveTaskTypes(undefined);
    }
  }

  return resolveTaskTypes(undefined);
}

/**
 * Validate classification.json. Missing file is fine (daemon uses shipped
 * defaults); present file must parse.
 */
export function lintClassification(
  raw: unknown | undefined,
  findings: LintFinding[],
  file = PROJECT_CLASSIFICATION_REL,
): void {
  if (raw === undefined) return;
  try {
    parseClassification(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Pull a field path from messages that already name one.
    const fieldMatch = /^classification\.(\S+)/.exec(msg);
    const field = fieldMatch ? fieldMatch[1]! : "";
    findings.push(finding("error", file, field, msg));
  }
}

/** Serialize criteria for equality checks (order-independent by id). */
function criteriaSignature(criteria: Criterion[]): string {
  return [...criteria]
    .map((c) => `${c.id}\0${c.kind}\0${c.weight}\0${c.text}`)
    .sort()
    .join("\n");
}

/**
 * Validate one rubric document and optionally emit a version-bump reminder
 * when project criteria differ from the shipped rubric at the same version.
 */
export function lintRubricDocument(
  raw: unknown,
  findings: LintFinding[],
  file: string,
  opts: { expectedId?: string } = {},
): Rubric | null {
  let rubric: Rubric;
  try {
    rubric = parseRubric(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fieldMatch = /^rubric\.(\S+)/.exec(msg);
    const field = fieldMatch ? fieldMatch[1]! : "";
    findings.push(finding("error", file, field, msg));
    return null;
  }

  if (opts.expectedId !== undefined && rubric.id !== opts.expectedId) {
    // Non-fatal: loadRubric prefers the basename; still remind authors.
    findings.push(
      finding(
        "warning",
        file,
        "id",
        `rubric.id "${rubric.id}" does not match file basename "${opts.expectedId}"`,
      ),
    );
  }

  const shipped = getShippedRubric(opts.expectedId ?? rubric.id);
  if (shipped !== null) {
    const criteriaChanged =
      criteriaSignature(shipped.criteria) !== criteriaSignature(rubric.criteria);
    if (criteriaChanged && rubric.version <= shipped.version) {
      findings.push(
        finding(
          "warning",
          file,
          "version",
          `rubric criteria differ from shipped ${shipped.id}@v${shipped.version} but version is still ${rubric.version}; bump version when editing criteria`,
        ),
      );
    }
  }

  return rubric;
}

/**
 * Ensure every configured task type's rubric id resolves to a project file or
 * a shipped built-in (not a silent generic fallback for an explicit name).
 */
export function lintTaskTypeRubricResolution(
  taskTypes: TaskTypesMap,
  projectRubricIds: ReadonlySet<string>,
  findings: LintFinding[],
  configFile = PROJECT_CONFIG_REL,
): void {
  for (const [typeId, entry] of Object.entries(taskTypes)) {
    const rubricId = resolveRubricIdForType(typeId, taskTypes);
    // Prefer the entry's explicit rubric (resolve always returns something).
    const named = entry.rubric !== "" ? entry.rubric : rubricId;
    if (projectRubricIds.has(named)) continue;
    if (getShippedRubric(named) !== null) continue;
    findings.push(
      finding(
        "error",
        configFile,
        `taskTypes.${typeId}.rubric`,
        `task type "${typeId}" resolves to rubric "${named}" which is neither a shipped rubric nor present under .parley/rubrics/`,
      ),
    );
  }
}

/**
 * Inputs for pure project lint (filesystem I/O stays in the CLI/daemon caller).
 * `undefined` means the file is absent; a present-but-empty string means bad
 * JSON was already reported by the caller.
 */
export interface ProjectLintInput {
  /** Parsed config.json, or undefined when the file is missing. */
  config?: unknown;
  /** True when config.json exists but is not valid JSON. */
  configJsonError?: string;
  /** Parsed classification.json, or undefined when missing. */
  classification?: unknown;
  /** True when classification.json exists but is not valid JSON. */
  classificationJsonError?: string;
  /**
   * Project rubric files: basename id (without .json) → raw parsed JSON.
   * Omit files that failed JSON parse; pass those via `rubricJsonErrors`.
   */
  rubrics?: Record<string, unknown>;
  /** id → JSON parse error message for unreadable rubric files. */
  rubricJsonErrors?: Record<string, string>;
}

/**
 * Lint all three project surfaces from already-parsed (or absent) inputs.
 * Pure: no filesystem. Callers read files and map I/O errors into the input.
 */
export function lintProjectSurfaces(input: ProjectLintInput): LintResult {
  const findings: LintFinding[] = [];

  if (input.configJsonError !== undefined) {
    findings.push(
      finding("error", PROJECT_CONFIG_REL, "", `invalid JSON: ${input.configJsonError}`),
    );
  }
  if (input.classificationJsonError !== undefined) {
    findings.push(
      finding(
        "error",
        PROJECT_CLASSIFICATION_REL,
        "",
        `invalid JSON: ${input.classificationJsonError}`,
      ),
    );
  }

  const taskTypes =
    input.configJsonError === undefined
      ? lintProjectConfig(input.config, findings)
      : resolveTaskTypes(undefined);

  if (input.classificationJsonError === undefined) {
    lintClassification(input.classification, findings);
  }

  const projectRubricIds = new Set<string>();
  const rubrics = input.rubrics ?? {};
  for (const [id, raw] of Object.entries(rubrics)) {
    const file = `${PROJECT_RUBRICS_DIR_REL}/${id}.json`;
    projectRubricIds.add(id);
    lintRubricDocument(raw, findings, file, { expectedId: id });
  }
  for (const [id, err] of Object.entries(input.rubricJsonErrors ?? {})) {
    const file = `${PROJECT_RUBRICS_DIR_REL}/${id}.json`;
    projectRubricIds.add(id);
    findings.push(finding("error", file, "", `invalid JSON: ${err}`));
  }

  // Only enforce type→rubric resolution when config was parseable; otherwise
  // the taskTypes map is the shipped default and would be noise.
  if (input.configJsonError === undefined) {
    lintTaskTypeRubricResolution(taskTypes, projectRubricIds, findings);
  }

  return {
    ok: findings.every((f) => f.severity !== "error"),
    findings,
  };
}

/**
 * Format a finding for human CLI output: `file: field: message` (field omitted
 * when empty).
 */
export function formatLintFinding(f: LintFinding): string {
  const prefix = f.severity === "warning" ? "warning" : "error";
  if (f.field === "") return `${prefix}: ${f.file}: ${f.message}`;
  return `${prefix}: ${f.file}: ${f.field}: ${f.message}`;
}
