import { describe, expect, it } from "vitest";
import {
  formatChurn,
  projectFileEntry,
  projectReportFiles,
} from "../../src/data/projections/filesChanged.js";

describe("projectReportFiles / projectFileEntry", () => {
  it("handles path-only strings", () => {
    const view = projectReportFiles({
      summary: "ok",
      outcome: "success",
      files_changed: ["a.ts", "b.ts"],
    });
    expect(view.files).toEqual([
      { path: "a.ts", added: null, removed: null, extra: {} },
      { path: "b.ts", added: null, removed: null, extra: {} },
    ]);
    expect(view.hasChurn).toBe(false);
  });

  it("handles object entries with optional churn", () => {
    const view = projectReportFiles({
      summary: "ok",
      outcome: "success",
      files_changed: [
        { path: "a.ts", added: 3, removed: 1 },
        { path: "b.ts" },
      ],
    });
    expect(view.files[0]).toEqual({ path: "a.ts", added: 3, removed: 1, extra: {} });
    expect(view.files[1]).toEqual({ path: "b.ts", added: null, removed: null, extra: {} });
    expect(view.hasChurn).toBe(true);
    expect(formatChurn(view.files[0]!)).toBe("+3 −1");
  });

  it("preserves custom-schema extra keys", () => {
    // Custom report schemas may attach extra keys beyond path/added/removed.
    const entry = projectFileEntry({
      path: "a.txt",
      reason: "refactor",
      reviewer: "kim",
      added: 7,
    } as { path: string; added: number; reason: string; reviewer: string });
    expect(entry).toEqual({
      path: "a.txt",
      added: 7,
      removed: null,
      extra: { reason: "refactor", reviewer: "kim" },
    });
  });

  it("drops empty paths", () => {
    expect(projectFileEntry("")).toBeNull();
    expect(projectFileEntry({ path: "" })).toBeNull();
  });

  it("returns empty for null report", () => {
    expect(projectReportFiles(null)).toEqual({ files: [], hasChurn: false });
  });
});
