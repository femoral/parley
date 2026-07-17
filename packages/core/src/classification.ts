/**
 * Task classification enums (#118, #151): size, difficulty, and work-domain
 * type set at delegate time. Size/difficulty are fixed shipped enums; task
 * types are project-configurable (with shipped defaults) plus automatic
 * fallback `other`.
 */

/** Task size rubric labels (XS–XL). */
export const TASK_SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

/** Task difficulty rubric labels. */
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

/** Metrics aggregation group dimensions. */
export const METRICS_GROUP_BY = [
  "vendor",
  "model",
  "profile",
  "size",
  "difficulty",
  "type",
] as const;
export type MetricsGroupBy = (typeof METRICS_GROUP_BY)[number];

export function isTaskSize(value: string): value is TaskSize {
  return (TASK_SIZES as readonly string[]).includes(value);
}

export function isTaskDifficulty(value: string): value is TaskDifficulty {
  return (TASK_DIFFICULTIES as readonly string[]).includes(value);
}

export function isMetricsGroupBy(value: string): value is MetricsGroupBy {
  return (METRICS_GROUP_BY as readonly string[]).includes(value);
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
