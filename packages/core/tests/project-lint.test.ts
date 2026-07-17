/**
 * #161 — shared project lint validation (config / classification / rubrics).
 */
import { describe, expect, it } from "vitest";
import { getShippedRubric } from "../src/rubric.js";
import {
  formatLintFinding,
  lintProjectSurfaces,
} from "../src/project-lint.js";

describe("lintProjectSurfaces (#161)", () => {
  it("accepts an empty project (shipped defaults)", () => {
    const result = lintProjectSurfaces({});
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("accepts a valid full fixture", () => {
    const coding = getShippedRubric("coding")!;
    const result = lintProjectSurfaces({
      config: {
        eval: { enabled: true },
        resume: { enabled: true },
        retry: { max: 2, window: "30m" },
        taskTypes: {
          coding: "coding",
          custom: { rubric: "generic" },
        },
      },
      classification: {
        version: 1,
        sizes: [{ id: "S", guidance: "Small." }],
        difficulties: [{ id: "easy", guidance: "Easy." }],
      },
      rubrics: {
        coding: {
          id: "coding",
          version: coding.version,
          criteria: coding.criteria,
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("names field paths for each documented error class", () => {
    const result = lintProjectSurfaces({
      config: {
        eval: { enabled: "yes" },
        retry: { max: -1, window: "nope" },
        taskTypes: {
          coding: { rubric: "missing-rubric" },
        },
      },
      classification: {
        sizes: [{ id: "XS", guidance: "" }],
        difficulties: [{ id: "easy", guidance: "ok" }],
      },
      rubrics: {
        bad: {
          id: "bad",
          version: 1,
          criteria: [
            { id: "a", kind: "positive", weight: 0, text: "zero weight" },
            { id: "a", kind: "negative", weight: 1, text: "dup" },
          ],
        },
      },
    });
    expect(result.ok).toBe(false);
    const fields = result.findings.map((f) => f.field);
    expect(fields).toContain("eval.enabled");
    expect(fields).toContain("retry.max");
    expect(fields).toContain("retry.window");
    expect(fields.some((f) => f.includes("guidance") || f === "sizes[0].guidance")).toBe(
      true,
    );
    expect(fields).toContain("taskTypes.coding.rubric");
    // Rubric weight / duplicate are reported with criteria field paths.
    expect(
      result.findings.some(
        (f) =>
          f.file.includes("bad.json") &&
          (f.message.includes("weight") || f.message.includes("duplicate")),
      ),
    ).toBe(true);
  });

  it("reminds to bump version when project criteria diverge from shipped at same version", () => {
    const coding = getShippedRubric("coding")!;
    const mutated = {
      id: "coding",
      version: coding.version,
      criteria: coding.criteria.map((c, i) =>
        i === 0 ? { ...c, text: "Changed criterion text." } : c,
      ),
    };
    const result = lintProjectSurfaces({
      rubrics: { coding: mutated },
    });
    expect(result.ok).toBe(true); // warning, not error
    const bump = result.findings.find((f) => f.field === "version");
    expect(bump?.severity).toBe("warning");
    expect(bump?.message).toMatch(/bump version/i);
  });

  it("reports invalid JSON via caller-supplied errors", () => {
    const result = lintProjectSurfaces({
      configJsonError: "Unexpected token",
      classificationJsonError: "Unexpected end of JSON",
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.file.includes("config.json"))).toBe(true);
    expect(result.findings.some((f) => f.file.includes("classification.json"))).toBe(
      true,
    );
  });

  it("formatLintFinding includes severity, file, and field", () => {
    expect(
      formatLintFinding({
        severity: "error",
        file: ".parley/config.json",
        field: "retry.max",
        message: "retry.max must be a non-negative integer",
      }),
    ).toBe(
      "error: .parley/config.json: retry.max: retry.max must be a non-negative integer",
    );
  });
});
