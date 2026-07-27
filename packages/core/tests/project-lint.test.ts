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

/** Minimal workflow raw that parses far enough for project lint to attach findings. */
function miniWorkflow(id: string): Record<string, unknown> {
  return {
    id,
    version: 1,
    type: "coding",
    inputs: {},
    outputs: {},
    types: {},
    nodes: [
      {
        id: "only",
        kind: "step",
        prompt: "p.md",
        in: {},
        out: {},
      },
    ],
  };
}

describe("lintProjectSurfaces — global workflow shadowing (#251)", () => {
  it("warns when a project workflow id exists in the global layer", () => {
    const file = ".parley/workflows/shared/workflow.json";
    const result = lintProjectSurfaces({
      workflows: [
        {
          id: "shared",
          dir: "/tmp/proj/.parley/workflows/shared",
          file,
          raw: miniWorkflow("shared"),
        },
      ],
      globalWorkflowIds: ["shared", "global-only"],
      layersDeduped: false,
    });
    expect(result.ok).toBe(true);
    const shadow = result.findings.filter((f) =>
      f.message.toLowerCase().includes("shadow"),
    );
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toMatchObject({
      severity: "warning",
      file,
      field: "",
    });
    expect(shadow[0]!.message).toMatch(/global/i);
  });

  it("does not warn when the project workflow id is absent from the global layer", () => {
    const result = lintProjectSurfaces({
      workflows: [
        {
          id: "local-only",
          dir: "/tmp/proj/.parley/workflows/local-only",
          file: ".parley/workflows/local-only/workflow.json",
          raw: miniWorkflow("local-only"),
        },
      ],
      globalWorkflowIds: ["other"],
      layersDeduped: false,
    });
    expect(result.findings.some((f) => f.message.toLowerCase().includes("shadow"))).toBe(
      false,
    );
  });

  it("does not report a finding for a global-only id with no local counterpart", () => {
    const result = lintProjectSurfaces({
      workflows: [],
      globalWorkflowIds: ["global-only"],
      layersDeduped: false,
    });
    expect(result.findings).toEqual([]);
    expect(result.workflows).toEqual([]);
  });

  it("shadowing alone leaves ok true (warning, not error)", () => {
    const result = lintProjectSurfaces({
      workflows: [
        {
          id: "shared",
          dir: "/tmp/proj/.parley/workflows/shared",
          file: ".parley/workflows/shared/workflow.json",
          raw: miniWorkflow("shared"),
        },
      ],
      globalWorkflowIds: new Set(["shared"]),
      layersDeduped: false,
    });
    expect(result.ok).toBe(true);
    expect(result.findings.every((f) => f.severity === "warning")).toBe(true);
  });

  it("emits no shadowing warnings when layers are deduped", () => {
    const result = lintProjectSurfaces({
      workflows: [
        {
          id: "once",
          dir: "/tmp/home/workflows/once",
          file: ".parley/workflows/once/workflow.json",
          raw: miniWorkflow("once"),
        },
      ],
      globalWorkflowIds: ["once"],
      layersDeduped: true,
    });
    expect(result.findings.some((f) => f.message.toLowerCase().includes("shadow"))).toBe(
      false,
    );
  });

  it("treats missing globalWorkflowIds as no global ids", () => {
    const result = lintProjectSurfaces({
      workflows: [
        {
          id: "local",
          dir: "/tmp/proj/.parley/workflows/local",
          file: ".parley/workflows/local/workflow.json",
          raw: miniWorkflow("local"),
        },
      ],
    });
    expect(result.findings.some((f) => f.message.toLowerCase().includes("shadow"))).toBe(
      false,
    );
  });

  it("still warns on a project workflow that fails JSON parse", () => {
    const file = ".parley/workflows/shared/workflow.json";
    const result = lintProjectSurfaces({
      workflows: [
        {
          id: "shared",
          dir: "/tmp/proj/.parley/workflows/shared",
          file,
          jsonError: "Unexpected token",
        },
      ],
      globalWorkflowIds: ["shared"],
      layersDeduped: false,
    });
    expect(result.ok).toBe(false);
    const shadow = result.findings.find((f) =>
      f.message.toLowerCase().includes("shadow"),
    );
    expect(shadow).toMatchObject({ severity: "warning", file });
  });
});
