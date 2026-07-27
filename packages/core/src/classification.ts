/**
 * Task classification (#118, #151, #161): size, difficulty, and work-domain
 * type set at delegate time. Size/difficulty are project-customizable via
 * `.parley/classification.json` (shipped enums as defaults); task types are
 * project-configurable in `.parley/config.json` plus automatic fallback `other`.
 */

/** Task size rubric labels (XS–XL) — shipped defaults when classification.json is absent. */
export const TASK_SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

/** Task difficulty rubric labels — shipped defaults. */
export const TASK_DIFFICULTIES = ["trivial", "easy", "medium", "hard", "extreme"] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

/**
 * Shipped work-domain task type ids (#151 / #132). Present when the project's
 * `.parley/config.json` omits `taskTypes`; the wizard may trim or extend this
 * set. `other` is never listed here — it is always valid automatically.
 */
export const SHIPPED_TASK_TYPES = [
  "coding",
  "design",
  "research",
  "infrastructure",
  "writing",
  "data",
  "review",
  "planning",
] as const;
export type ShippedTaskType = (typeof SHIPPED_TASK_TYPES)[number];

/** Automatic fallback when `--type` is omitted or the brief fits no category. */
export const FALLBACK_TASK_TYPE = "other" as const;
export type FallbackTaskType = typeof FALLBACK_TASK_TYPE;

/** One configured task type: maps to a rubric name for later eval scoring. */
export interface TaskTypeEntry {
  /** Rubric id this type resolves to (defaults to the type id, or `generic`). */
  rubric: string;
}

/** Project `taskTypes` map: type id → rubric mapping. */
export type TaskTypesMap = Record<string, TaskTypeEntry>;

/**
 * One size or difficulty label in project classification.json (#161).
 * `guidance` is the how-to-classify line (rendered by `parley info` later).
 */
export interface ClassificationEntry {
  id: string;
  guidance: string;
}

/**
 * Project `.parley/classification.json` document. Sizes and difficulties are
 * project-owned; missing file ⇒ {@link defaultClassification}.
 */
export interface ClassificationConfig {
  /** Optional document version (wizard may bump). */
  version?: number;
  sizes: ClassificationEntry[];
  difficulties: ClassificationEntry[];
}

/**
 * Metrics aggregation group dimensions (#118 / #151 / #164).
 * Provenance and rubric keys join the original vendor/model/profile/size/
 * difficulty/type set so comparisons can isolate orchestrator, judge, or
 * rubric version.
 */
export const METRICS_GROUP_BY = [
  "vendor",
  "model",
  "profile",
  "size",
  "difficulty",
  "type",
  /** Spawn-time orchestrator harness snapshot. */
  "orch_harness",
  /** Spawn-time orchestrator model snapshot. */
  "orch_model",
  /** Spawn-time orchestrator effort snapshot. */
  "orch_effort",
  /** Judge harness snapshot at eval time. */
  "eval_harness",
  /** Judge model snapshot at eval time. */
  "eval_model",
  /** Judge effort snapshot at eval time. */
  "eval_effort",
  /**
   * Rubric id+version composite (`coding@1`). Null when no structured eval.
   */
  "rubric",
] as const;
export type MetricsGroupBy = (typeof METRICS_GROUP_BY)[number];

/**
 * Run-metrics group dimensions (#243 / ADR-0020).
 * A run has no vendor, model, or profile — those stay task-only. Group on the
 * composite `workflow` = `id@version`, plus type/rubric/size/difficulty and the
 * six orch_ and eval_ provenance dimensions.
 */
export const RUN_METRICS_GROUP_BY = [
  /** Workflow id+version composite (`coding-1@3`). Mirrors rubricGroupKey. */
  "workflow",
  "type",
  "rubric",
  "size",
  "difficulty",
  "orch_harness",
  "orch_model",
  "orch_effort",
  "eval_harness",
  "eval_model",
  "eval_effort",
] as const;
export type RunMetricsGroupBy = (typeof RUN_METRICS_GROUP_BY)[number];

/** Shipped default guidance for each size id (how-to-classify lines). */
export const DEFAULT_SIZE_GUIDANCE: Readonly<Record<TaskSize, string>> = {
  XS: "One file, \u2264 ~30 changed lines, no new dependencies, no schema/API change.",
  S: "\u2264 3 files in one package, \u2264 ~150 lines, no cross-package surface change.",
  M: "One package end-to-end (source + tests + docs), \u2264 ~500 lines.",
  L: "Crosses 2+ packages or changes a public contract/schema.",
  XL: "New package, new subsystem, or a migration touching most of the codebase.",
};

/** Shipped default guidance for each difficulty id. */
export const DEFAULT_DIFFICULTY_GUIDANCE: Readonly<Record<TaskDifficulty, string>> = {
  trivial: "Mechanical; the brief fully determines the diff; established pattern to copy.",
  easy: "Minor judgment; pattern exists nearby; failure is obvious if it happens.",
  medium: "Real design choices among known options; project-specific judgment required.",
  hard: "Unknowns to resolve; cross-cutting invariants (concurrency, migrations, sandbox).",
  extreme: "Research-grade; success uncertain; approach must be discovered.",
};

/** True when `value` is one of the shipped size ids (not project-aware). */
export function isTaskSize(value: string): value is TaskSize {
  return (TASK_SIZES as readonly string[]).includes(value);
}

/** True when `value` is one of the shipped difficulty ids (not project-aware). */
export function isTaskDifficulty(value: string): value is TaskDifficulty {
  return (TASK_DIFFICULTIES as readonly string[]).includes(value);
}

export function isMetricsGroupBy(value: string): value is MetricsGroupBy {
  return (METRICS_GROUP_BY as readonly string[]).includes(value);
}

export function isRunMetricsGroupBy(value: string): value is RunMetricsGroupBy {
  return (RUN_METRICS_GROUP_BY as readonly string[]).includes(value);
}

/** Shipped default `taskTypes` map (each type resolves to a same-named rubric). */
export function defaultTaskTypes(): TaskTypesMap {
  const map: TaskTypesMap = {};
  for (const id of SHIPPED_TASK_TYPES) {
    map[id] = { rubric: id };
  }
  return map;
}

/**
 * Parse a raw `taskTypes` config section into a map. Accepts either
 * `{ "coding": { "rubric": "coding" } }` or the shorthand string form
 * `{ "coding": "coding" }` (string = rubric name). Returns `null` when the
 * section is absent/undefined so callers can fall back to shipped defaults.
 * Throws a descriptive Error on a malformed section (never coerces).
 */
export function parseTaskTypesSection(raw: unknown): TaskTypesMap | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("taskTypes must be an object mapping type ids to rubric entries");
  }
  const map: TaskTypesMap = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (id === "") {
      throw new Error("taskTypes keys must be non-empty strings");
    }
    if (typeof entry === "string") {
      if (entry === "") {
        throw new Error(`taskTypes.${id}: rubric name must be a non-empty string`);
      }
      map[id] = { rubric: entry };
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `taskTypes.${id}: expected a rubric name string or { rubric: string }`,
      );
    }
    const rubric = (entry as { rubric?: unknown }).rubric;
    if (typeof rubric !== "string" || rubric === "") {
      throw new Error(`taskTypes.${id}.rubric must be a non-empty string`);
    }
    map[id] = { rubric };
  }
  return map;
}

/**
 * Effective task-type set for a project: parsed section, or shipped defaults
 * when the section is missing.
 */
export function resolveTaskTypes(raw: unknown): TaskTypesMap {
  const parsed = parseTaskTypesSection(raw);
  return parsed === null ? defaultTaskTypes() : parsed;
}

/**
 * Valid type ids for delegate: configured keys plus automatic `other`
 * (included even when not present in the map). Stable order: configured keys
 * in insertion/sort order, then `other` if absent.
 */
export function validTaskTypeIds(types: TaskTypesMap): string[] {
  const ids = Object.keys(types);
  if (!ids.includes(FALLBACK_TASK_TYPE)) ids.push(FALLBACK_TASK_TYPE);
  return ids;
}

/** True when `value` is a configured type or the automatic `other` fallback. */
export function isValidTaskType(value: string, types: TaskTypesMap): boolean {
  return value === FALLBACK_TASK_TYPE || Object.prototype.hasOwnProperty.call(types, value);
}

/** Pipe-joined list of valid types for usage/error messages. */
export function formatValidTaskTypes(types: TaskTypesMap): string {
  return validTaskTypeIds(types).join("|");
}

/** Shipped classification.json defaults (sizes + difficulties with guidance). */
export function defaultClassification(): ClassificationConfig {
  return {
    version: 1,
    sizes: TASK_SIZES.map((id) => ({ id, guidance: DEFAULT_SIZE_GUIDANCE[id] })),
    difficulties: TASK_DIFFICULTIES.map((id) => ({
      id,
      guidance: DEFAULT_DIFFICULTY_GUIDANCE[id],
    })),
  };
}

function parseClassificationEntries(
  field: "sizes" | "difficulties",
  raw: unknown,
): ClassificationEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`classification.${field} must be a non-empty array`);
  }
  const seen = new Set<string>();
  const entries: ClassificationEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`classification.${field}[${i}] must be an object`);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== "string" || obj.id === "") {
      throw new Error(`classification.${field}[${i}].id must be a non-empty string`);
    }
    if (seen.has(obj.id)) {
      throw new Error(`classification.${field}: duplicate id "${obj.id}"`);
    }
    seen.add(obj.id);
    if (typeof obj.guidance !== "string" || obj.guidance.trim() === "") {
      throw new Error(
        `classification.${field}[${i}].guidance must be a non-empty string`,
      );
    }
    entries.push({ id: obj.id, guidance: obj.guidance });
  }
  return entries;
}

/**
 * Parse and validate a raw classification.json document. Throws a descriptive
 * Error naming the field on any schema violation (never coerces).
 */
export function parseClassification(raw: unknown): ClassificationConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("classification must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  let version: number | undefined;
  if (obj.version !== undefined) {
    if (typeof obj.version !== "number" || !Number.isInteger(obj.version) || obj.version < 1) {
      throw new Error("classification.version must be a positive integer");
    }
    version = obj.version;
  }
  const sizes = parseClassificationEntries("sizes", obj.sizes);
  const difficulties = parseClassificationEntries("difficulties", obj.difficulties);
  return version === undefined ? { sizes, difficulties } : { version, sizes, difficulties };
}

/**
 * Effective classification for a project: parsed document, or shipped defaults
 * when the section/file is missing (`null`/`undefined` raw).
 */
export function resolveClassification(raw: unknown): ClassificationConfig {
  if (raw === undefined || raw === null) return defaultClassification();
  return parseClassification(raw);
}

/** Ordered size ids from a classification document. */
export function validSizeIds(classification: ClassificationConfig): string[] {
  return classification.sizes.map((e) => e.id);
}

/** Ordered difficulty ids from a classification document. */
export function validDifficultyIds(classification: ClassificationConfig): string[] {
  return classification.difficulties.map((e) => e.id);
}

/** True when `value` is a configured size id for this project. */
export function isValidSize(value: string, classification: ClassificationConfig): boolean {
  return classification.sizes.some((e) => e.id === value);
}

/** True when `value` is a configured difficulty id for this project. */
export function isValidDifficulty(
  value: string,
  classification: ClassificationConfig,
): boolean {
  return classification.difficulties.some((e) => e.id === value);
}

/** Pipe-joined size ids for usage/error messages. */
export function formatValidSizes(classification: ClassificationConfig): string {
  return validSizeIds(classification).join("|");
}

/** Pipe-joined difficulty ids for usage/error messages. */
export function formatValidDifficulties(classification: ClassificationConfig): string {
  return validDifficultyIds(classification).join("|");
}
