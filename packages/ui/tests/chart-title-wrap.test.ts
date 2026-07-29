/**
 * CSS-source contract for chart title wrap of unbreakable tokens (#271).
 *
 * happy-dom performs no layout, so it cannot see silent clipping of long
 * workflow-name tokens at the sheet edge. Real evidence lives in
 * `packages/ui/lab/` (clipped probe + glyph rects). This file only pins the
 * CSS break strategy that the measured fix relies on.
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
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]+)\\}",
    "g",
  );
  const matches = [...CHART_CSS.matchAll(re)];
  expect(matches.length, `expected a rule for ${selector}`).toBeGreaterThan(0);
  return matches[matches.length - 1]![1]!;
}

describe("chart.css title wrap contract (#271)", () => {
  it("title allows breaks inside unbreakable tokens (overflow-wrap: anywhere)", () => {
    const title = blockFor(".pc-chart__title");
    // `anywhere` (not merely break-word): soft-wrap opportunities affect
    // min-content sizing so the flex strip can shrink without the token
    // dictating the legend's min width and overflowing the sheet.
    expect(title).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("title does not truncate or ellipsise the workflow name", () => {
    // Strip comments so prose about the sheet's overflow:hidden cannot
    // false-positive a property assertion.
    const title = blockFor(".pc-chart__title").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(title).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(title).not.toMatch(/(?:^|[^-])overflow:\s*hidden/);
    expect(title).not.toMatch(/white-space:\s*nowrap/);
  });

  it("legend keeps min-width: 0 so the flex strip can constrain the title", () => {
    const legend = blockFor(".pc-chart__legend");
    expect(legend).toMatch(/min-width:\s*0/);
  });
});
