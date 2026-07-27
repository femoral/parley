/**
 * Project + shipped rubric resolution (#157). Project files under
 * `.parley/rubrics/<id>.json` override built-ins; missing/unknown ids fall
 * back to the generic rubric.
 */
import fs from "node:fs";
import path from "node:path";
import {
  GENERIC_RUBRIC_ID,
  getShippedRubric,
  parseRubric,
  resolveRubricIdForType,
  type Rubric,
  type TaskTypesMap,
} from "@useparley/core";
import { PARLEY_DIR, readProjectTaskTypes } from "./context.js";

/**
 * Load a rubric by id for a project repo. Order: project override file →
 * shipped built-in → generic shipped fallback. Throws when a project file
 * exists but fails schema validation (never silently ignore a bad override).
 */
export function loadRubric(repo: string | null, rubricId: string): Rubric {
  if (repo !== null) {
    const filePath = path.join(repo, PARLEY_DIR, "rubrics", `${rubricId}.json`);
    let rawText: string | undefined;
    try {
      rawText = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (rawText !== undefined) {
      try {
        const parsed = parseRubric(JSON.parse(rawText) as unknown);
        // Prefer the requested id (file basename / mapping key) for storage so
        // status/metrics stay keyed by the resolved type → rubric mapping even
        // when the document's internal `id` field differs.
        return { ...parsed, id: rubricId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`invalid project rubric ${rubricId}: ${msg}`);
      }
    }
  }

  const shipped = getShippedRubric(rubricId);
  if (shipped !== null) return shipped;

  const generic = getShippedRubric(GENERIC_RUBRIC_ID);
  if (generic === null) {
    throw new Error("internal error: shipped generic rubric is missing");
  }
  return generic;
}

/**
 * Resolve the effective rubric for a task: type → rubric id via project
 * `taskTypes` (or shipped defaults), then load with project-override rules.
 * Unmapped types (including `other`) resolve to `generic`.
 */
export function resolveRubricForTask(
  repo: string | null,
  taskType: string,
  taskTypes?: TaskTypesMap,
): Rubric {
  const types = taskTypes ?? readProjectTaskTypes(repo);
  const rubricId = resolveRubricIdForType(taskType, types);
  return loadRubric(repo, rubricId);
}

/**
 * Resolve the effective rubric for a run (#243 / ADR-0020).
 *
 * Same machinery as {@link resolveRubricForTask}: the definition declares
 * `type`, the run inherits it, and type → rubric via the project `taskTypes`
 * map. No new rubric documents. `--type` on `parley run eval` overrides the
 * run's stored type before calling this.
 */
export function resolveRubricForRun(
  repo: string | null,
  runType: string,
  taskTypes?: TaskTypesMap,
): Rubric {
  return resolveRubricForTask(repo, runType, taskTypes);
}
