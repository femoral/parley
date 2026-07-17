/**
 * #118 / #151 / #161 — classification helpers (project-aware size/difficulty + task types).
 */
import { describe, expect, it } from "vitest";
import {
  defaultClassification,
  defaultTaskTypes,
  FALLBACK_TASK_TYPE,
  formatValidDifficulties,
  formatValidSizes,
  formatValidTaskTypes,
  isMetricsGroupBy,
  isValidDifficulty,
  isValidSize,
  isValidTaskType,
  METRICS_GROUP_BY,
  parseClassification,
  parseTaskTypesSection,
  resolveClassification,
  resolveTaskTypes,
  SHIPPED_TASK_TYPES,
  TASK_DIFFICULTIES,
  TASK_SIZES,
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

  it("includes type and provenance/rubric in metrics group-by dimensions (#164)", () => {
    expect(METRICS_GROUP_BY).toContain("type");
    expect(METRICS_GROUP_BY).toContain("orch_harness");
    expect(METRICS_GROUP_BY).toContain("orch_model");
    expect(METRICS_GROUP_BY).toContain("orch_effort");
    expect(METRICS_GROUP_BY).toContain("eval_harness");
    expect(METRICS_GROUP_BY).toContain("eval_model");
    expect(METRICS_GROUP_BY).toContain("eval_effort");
    expect(METRICS_GROUP_BY).toContain("rubric");
    expect(isMetricsGroupBy("type")).toBe(true);
    expect(isMetricsGroupBy("orch_harness")).toBe(true);
    expect(isMetricsGroupBy("rubric")).toBe(true);
    expect(isMetricsGroupBy("nope")).toBe(false);
  });
});

describe("classification.json (#161)", () => {
  it("ships default sizes and difficulties with non-empty guidance", () => {
    const d = defaultClassification();
    expect(d.sizes.map((s) => s.id)).toEqual([...TASK_SIZES]);
    expect(d.difficulties.map((x) => x.id)).toEqual([...TASK_DIFFICULTIES]);
    for (const s of d.sizes) expect(s.guidance.trim().length).toBeGreaterThan(0);
    for (const x of d.difficulties) expect(x.guidance.trim().length).toBeGreaterThan(0);
    expect(isValidSize("M", d)).toBe(true);
    expect(isValidDifficulty("hard", d)).toBe(true);
    expect(isValidSize("huge", d)).toBe(false);
    expect(formatValidSizes(d)).toBe("XS|S|M|L|XL");
    expect(formatValidDifficulties(d)).toContain("trivial");
  });

  it("parses custom size/difficulty ids", () => {
    const c = parseClassification({
      version: 2,
      sizes: [
        { id: "tiny", guidance: "A few lines." },
        { id: "epic", guidance: "Multi-week effort." },
      ],
      difficulties: [{ id: "routine", guidance: "Known path." }],
    });
    expect(c.version).toBe(2);
    expect(isValidSize("tiny", c)).toBe(true);
    expect(isValidSize("M", c)).toBe(false);
    expect(isValidDifficulty("routine", c)).toBe(true);
    expect(formatValidSizes(c)).toBe("tiny|epic");
  });

  it("missing raw resolves to shipped defaults", () => {
    expect(resolveClassification(undefined)).toEqual(defaultClassification());
    expect(resolveClassification(null)).toEqual(defaultClassification());
  });

  it("rejects empty guidance, duplicate ids, and bad shapes with field names", () => {
    expect(() => parseClassification([])).toThrow(/classification must be a JSON object/);
    expect(() =>
      parseClassification({
        sizes: [{ id: "XS", guidance: "" }],
        difficulties: [{ id: "easy", guidance: "ok" }],
      }),
    ).toThrow(/classification\.sizes\[0\]\.guidance/);
    expect(() =>
      parseClassification({
        sizes: [
          { id: "XS", guidance: "a" },
          { id: "XS", guidance: "b" },
        ],
        difficulties: [{ id: "easy", guidance: "ok" }],
      }),
    ).toThrow(/duplicate id "XS"/);
    expect(() =>
      parseClassification({
        sizes: [{ id: "XS", guidance: "a" }],
        difficulties: [],
      }),
    ).toThrow(/classification\.difficulties must be a non-empty array/);
  });
});
