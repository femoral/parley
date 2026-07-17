/**
 * #157 — rubric schema parse, answer validation, and scoring formula.
 */
import { describe, expect, it } from "vitest";
import {
  GENERIC_RUBRIC_ID,
  getShippedRubric,
  parseRubric,
  resolveRubricIdForType,
  scoreRubric,
  SHIPPED_RUBRIC_IDS,
  SHIPPED_RUBRICS,
  UNIVERSAL_NEGATIVES,
  validateAnswers,
  type Rubric,
  type RubricAnswers,
} from "../src/rubric.js";

function allAnswers(rubric: Rubric, value: boolean): RubricAnswers {
  const out: RubricAnswers = {};
  for (const c of rubric.criteria) out[c.id] = value;
  return out;
}

function answers(
  rubric: Rubric,
  positives: boolean,
  negatives: boolean,
): RubricAnswers {
  const out: RubricAnswers = {};
  for (const c of rubric.criteria) {
    out[c.id] = c.kind === "positive" ? positives : negatives;
  }
  return out;
}

describe("shipped rubrics (#157)", () => {
  it("ships exactly nine rubrics at version 1", () => {
    expect(SHIPPED_RUBRIC_IDS).toHaveLength(9);
    for (const id of SHIPPED_RUBRIC_IDS) {
      const r = getShippedRubric(id);
      expect(r).not.toBeNull();
      expect(r!.id).toBe(id);
      expect(r!.version).toBe(1);
      expect(r!.criteria.length).toBeGreaterThan(0);
    }
    expect(GENERIC_RUBRIC_ID).toBe("generic");
    expect(SHIPPED_RUBRICS.generic).toBeDefined();
  });

  it("every built-in includes the universal negative trio", () => {
    const negIds = UNIVERSAL_NEGATIVES.map((c) => c.id);
    expect(negIds).toEqual(["broke-existing", "fabricated-claim", "scope-creep"]);
    for (const id of SHIPPED_RUBRIC_IDS) {
      const r = SHIPPED_RUBRICS[id]!;
      for (const n of UNIVERSAL_NEGATIVES) {
        const found = r.criteria.find((c) => c.id === n.id);
        expect(found).toEqual(n);
      }
    }
  });
});

describe("parseRubric", () => {
  it("accepts a valid document", () => {
    const r = parseRubric({
      id: "mini",
      version: 2,
      criteria: [
        { id: "a", kind: "positive", weight: 3, text: "A" },
        { id: "b", kind: "negative", weight: 1, text: "B" },
      ],
    });
    expect(r.id).toBe("mini");
    expect(r.version).toBe(2);
    expect(r.criteria).toHaveLength(2);
  });

  it("rejects duplicate criterion ids and bad weights", () => {
    expect(() =>
      parseRubric({
        id: "x",
        version: 1,
        criteria: [
          { id: "a", kind: "positive", weight: 1, text: "A" },
          { id: "a", kind: "negative", weight: 1, text: "B" },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseRubric({
        id: "x",
        version: 1,
        criteria: [{ id: "a", kind: "positive", weight: 0, text: "A" }],
      }),
    ).toThrow(/weight/);
  });
});

describe("validateAnswers", () => {
  const rubric = parseRubric({
    id: "t",
    version: 1,
    criteria: [
      { id: "p1", kind: "positive", weight: 2, text: "P" },
      { id: "n1", kind: "negative", weight: 3, text: "N" },
    ],
  });

  it("accepts exact coverage", () => {
    expect(() => validateAnswers(rubric, { p1: true, n1: false })).not.toThrow();
  });

  it("rejects missing and unknown ids", () => {
    expect(() => validateAnswers(rubric, { p1: true })).toThrow(/missing/);
    expect(() => validateAnswers(rubric, { p1: true, n1: false, extra: true })).toThrow(
      /unknown/,
    );
  });

  it("rejects non-boolean values", () => {
    expect(() => validateAnswers(rubric, { p1: "yes", n1: false })).toThrow(/boolean/);
  });
});

describe("scoreRubric formula (#150 / #133)", () => {
  // baseline_raw = 13, positives = 14 (coding), max = 27
  // baseline = round(10*13/27) = round(4.814…) = 5
  const coding = getShippedRubric("coding")!;

  it("perfect positives + no negatives → score near 10", () => {
    const a = answers(coding, true, false);
    const r = scoreRubric(coding, a);
    // raw = 13 + 14 - 0 = 27; score = round(10*27/27) = 10
    expect(r.raw).toBe(27);
    expect(r.max).toBe(27);
    expect(r.baseline_raw).toBe(13);
    expect(r.score).toBe(10);
    expect(r.baseline).toBe(5);
    expect(r.below_baseline).toBe(false);
  });

  it("all fail + all negatives → score floors at 0", () => {
    const a = answers(coding, false, true);
    const r = scoreRubric(coding, a);
    // raw = 13 + 0 - 13 = 0; score = 0
    expect(r.raw).toBe(0);
    expect(r.score).toBe(0);
    expect(r.baseline).toBe(5);
    expect(r.below_baseline).toBe(true);
  });

  it("no positives no negatives → score equals baseline", () => {
    const a = answers(coding, false, false);
    const r = scoreRubric(coding, a);
    // raw = 13 + 0 - 0 = 13; score = round(10*13/27) = 5
    expect(r.score).toBe(5);
    expect(r.baseline).toBe(5);
    expect(r.below_baseline).toBe(false);
  });

  it("rounds half-up and derives below-baseline as score < baseline", () => {
    // Tiny rubric: pos 1, neg 1 → max=2, baseline_raw=1
    // baseline = round(10*1/2) = 5
    // pass pos, trigger neg: raw = 1+1-1 = 1 → score = round(5) = 5
    // fail pos, trigger neg: raw = 1+0-1 = 0 → score = 0 < 5
    const mini = parseRubric({
      id: "mini",
      version: 1,
      criteria: [
        { id: "p", kind: "positive", weight: 1, text: "P" },
        { id: "n", kind: "negative", weight: 1, text: "N" },
      ],
    });
    expect(scoreRubric(mini, { p: true, n: false })).toEqual({
      score: 10,
      baseline: 5,
      raw: 2,
      max: 2,
      baseline_raw: 1,
      below_baseline: false,
    });
    expect(scoreRubric(mini, { p: false, n: true }).score).toBe(0);
    expect(scoreRubric(mini, { p: false, n: true }).below_baseline).toBe(true);
    // raw = 1 + 0 - 0 = 1 → score = round(5) = 5
    expect(scoreRubric(mini, { p: false, n: false }).score).toBe(5);
  });

  it("generic rubric baseline is ≈ 5/10", () => {
    const g = getShippedRubric("generic")!;
    // positives 5+3+3+2 = 13, baseline_raw = 13, max = 26
    // baseline = round(10*13/26) = 5
    const r = scoreRubric(g, allAnswers(g, false));
    expect(r.baseline).toBe(5);
    expect(r.score).toBe(5);
  });
});

describe("resolveRubricIdForType", () => {
  it("uses the mapped rubric and falls back to generic", () => {
    const types = {
      coding: { rubric: "coding" },
      custom: { rubric: "generic" },
    };
    expect(resolveRubricIdForType("coding", types)).toBe("coding");
    expect(resolveRubricIdForType("custom", types)).toBe("generic");
    expect(resolveRubricIdForType("other", types)).toBe("generic");
    expect(resolveRubricIdForType("unmapped", types)).toBe("generic");
  });
});
