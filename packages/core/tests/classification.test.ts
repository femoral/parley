/**
 * #118 / #151 — classification helpers (size/difficulty fixed enums + task types).
 */
import { describe, expect, it } from "vitest";
import {
  defaultTaskTypes,
  FALLBACK_TASK_TYPE,
  formatValidTaskTypes,
  isMetricsGroupBy,
  isValidTaskType,
  METRICS_GROUP_BY,
  parseTaskTypesSection,
  resolveTaskTypes,
  SHIPPED_TASK_TYPES,
  validTaskTypeIds,
} from "../src/classification.js";

describe("task types (#151)", () => {
  it("ships eight domain types plus automatic other", () => {
    expect(SHIPPED_TASK_TYPES).toEqual([
      "coding",
      "design",
      "research",
      "infrastructure",
      "writing",
      "data",
      "review",
      "planning",
    ]);
    expect(FALLBACK_TASK_TYPE).toBe("other");
    const defaults = defaultTaskTypes();
    expect(Object.keys(defaults)).toEqual([...SHIPPED_TASK_TYPES]);
    expect(defaults.coding).toEqual({ rubric: "coding" });
    expect(isValidTaskType("other", defaults)).toBe(true);
    expect(isValidTaskType("coding", defaults)).toBe(true);
    expect(isValidTaskType("nope", defaults)).toBe(false);
  });

  it("parses object and string-shorthand taskTypes entries", () => {
    const map = parseTaskTypesSection({
      coding: { rubric: "coding" },
      custom: "generic",
    });
    expect(map).toEqual({
      coding: { rubric: "coding" },
      custom: { rubric: "generic" },
    });
  });

  it("treats missing section as null so resolve falls back to defaults", () => {
    expect(parseTaskTypesSection(undefined)).toBeNull();
    expect(parseTaskTypesSection(null)).toBeNull();
    expect(resolveTaskTypes(undefined)).toEqual(defaultTaskTypes());
  });

  it("rejects malformed sections without coercing", () => {
    expect(() => parseTaskTypesSection([])).toThrow(/taskTypes must be an object/);
    expect(() => parseTaskTypesSection({ "": { rubric: "x" } })).toThrow(/non-empty/);
    expect(() => parseTaskTypesSection({ a: 1 })).toThrow(/rubric/);
    expect(() => parseTaskTypesSection({ a: { rubric: "" } })).toThrow(/rubric/);
  });

  it("lists valid ids with other always included", () => {
    const trimmed = resolveTaskTypes({ coding: "coding" });
    expect(validTaskTypeIds(trimmed)).toEqual(["coding", "other"]);
    expect(formatValidTaskTypes(trimmed)).toBe("coding|other");
  });

  it("includes type in metrics group-by dimensions", () => {
    expect(METRICS_GROUP_BY).toContain("type");
    expect(isMetricsGroupBy("type")).toBe(true);
    expect(isMetricsGroupBy("nope")).toBe(false);
  });
});
