/**
 * CSS-source contract for the run chart surface (#253 QC).
 *
 * happy-dom performs no layout, so a 0-width label box (percentage against a
 * zero-width absolute pin) will not fail geometry or DOM tests. Assert the
 * CSS contract that keeps label widths real (BL-1).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CHART_CSS = readFileSync(
  resolve(
    process.cwd(),
    process.cwd().endsWith("packages/ui")
      ? "src/chart/chart.css"
      : "packages/ui/src/chart/chart.css",
  ),
  "utf8",
);

function blockFor(selector: string): string {
  // Last matching rule block wins (cascade order).
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]+)\\}",
    "g",
  );
  const matches = [...CHART_CSS.matchAll(re)];
  expect(matches.length, `expected a rule for ${selector}`).toBeGreaterThan(0);
  return matches[matches.length - 1]![1]!;
}

describe("chart.css label width contract (BL-1)", () => {
  it("sheet is a container so cqw resolves against real width", () => {
    const sheet = blockFor(".pc-chart__sheet");
    expect(sheet).toMatch(/container-type:\s*inline-size/);
  });

  it("mark pin is zero-size (centre anchor) — labels must not use % width", () => {
    const mark = blockFor(".pc-chart-mark");
    expect(mark).toMatch(/width:\s*0/);
    expect(mark).toMatch(/position:\s*absolute/);
  });

  it("seal pin is zero-size — labels must not use % width", () => {
    const seal = blockFor(".pc-chart-seal");
    expect(seal).toMatch(/width:\s*0/);
    expect(seal).toMatch(/position:\s*absolute/);
  });

  it("mark labels size from viewBox units via cqw (not % of the pin)", () => {
    const labels = blockFor(".pc-chart-mark__labels");
    // Must use container query width against the sheet.
    expect(labels).toMatch(/width:\s*calc\(\s*var\(--pc-chart-label-vb/);
    expect(labels).toMatch(/cqw/);
    // Percentage width against the 0-wide pin is the regression.
    expect(labels).not.toMatch(/width:\s*var\(--pc-chart-label-w/);
    expect(labels).not.toMatch(/width:\s*[\d.]+%/);
  });

  it("seal labels use the same cqw contract", () => {
    const labels = blockFor(".pc-chart-seal__labels");
    expect(labels).toMatch(/width:\s*calc\(\s*var\(--pc-chart-label-vb/);
    expect(labels).toMatch(/cqw/);
    expect(labels).not.toMatch(/width:\s*var\(--pc-chart-label-w/);
    expect(labels).not.toMatch(/width:\s*[\d.]+%/);
  });

  it("key sits bottom-left (not under row-0 / compass)", () => {
    const key = blockFor(".pc-chart-key");
    expect(key).toMatch(/left:\s*18px/);
    expect(key).toMatch(/bottom:\s*14px/);
    // Must not reintroduce the top-right overprint position.
    expect(key).not.toMatch(/top:\s*112px/);
  });
});
