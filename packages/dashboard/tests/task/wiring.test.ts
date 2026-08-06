/**
 * Neuter proofs for task-inspector wiring.
 * Break the import/call → red. Hand-constructed projections alone are not enough.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const screenDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/screens/task",
);

function read(rel: string): string {
  return fs.readFileSync(path.join(screenDir, rel), "utf8");
}

describe("task inspector wiring guards", () => {
  it("TaskScreen consumes useTaskDetail + useLogTail (not reimplemented)", () => {
    const src = read("TaskScreen.tsx");
    expect(src).toMatch(/\buseTaskDetail\b/);
    expect(src).toMatch(/\buseLogTail\b/);
    expect(src).toMatch(/\buseNodeTasks\b/);
    // Must not reimplement log cursoring.
    expect(src).not.toMatch(/client\.logs\(/);
    expect(src).not.toMatch(/LogAccumulator/);
  });

  it("follow toggle is local and does not reset cursor in the screen", () => {
    const src = read("TaskScreen.tsx");
    expect(src).toMatch(/onFollowChange/);
    expect(src).toMatch(/setFollow/);
    // useLogTail is the only place that owns the cursor.
    expect(src).not.toMatch(/cursor\s*=\s*0/);
  });

  it("report panel projects files via projectReportFiles / formatChurn", () => {
    const panels = read("panels.tsx");
    expect(panels).toMatch(/\bprojectReportFiles\b/);
    expect(panels).toMatch(/\bformatChurn\b/);
    // No fake zeros for missing churn.
    expect(panels).not.toMatch(/\+0\s*[−-]\s*0/);
  });

  it("copy scaffolds hand verbs to the orchestrating agent", () => {
    const scaffolds = read("scaffolds.ts");
    expect(scaffolds).toMatch(/parley answer/);
    expect(scaffolds).toMatch(/parley fix/);
    expect(scaffolds).toMatch(/parley delegate/);
  });

  it("screen CSS is local with pc-task- prefix", () => {
    const css = read("task.css");
    expect(css).toMatch(/\.pc-task\b/);
    expect(css).not.toMatch(/\.pc-shell__/);
  });
});
