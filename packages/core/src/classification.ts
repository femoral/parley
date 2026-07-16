/**
 * Task classification enums (#118): size and difficulty set at delegate time.
 * Parley validates the enum but never requires either field.
 */

/** Task size rubric labels (XS–XL). */
export const TASK_SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

/** Task difficulty rubric labels. */
export const TASK_DIFFICULTIES = ["trivial", "easy", "medium", "hard", "extreme"] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

/** Metrics aggregation group dimensions. */
export const METRICS_GROUP_BY = ["vendor", "model", "profile", "size", "difficulty"] as const;
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
