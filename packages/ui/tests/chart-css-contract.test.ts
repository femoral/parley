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

  it("key is a title-block row, not a plate positioned on the paper (#267)", () => {
    const key = blockFor(".pc-chart-key");
    // Any positioning scheme puts it back in the plot's space, where its
    // fixed px size cannot be reserved for across the 0.385–1.224 scale range.
    expect(key).not.toMatch(/position:\s*absolute/);
    expect(key).not.toMatch(/position:\s*fixed/);
    // It must still travel with the paper (AC: not pinned to the viewport).
    expect(CHART_CSS).not.toMatch(/\.pc-chart-key\s*\{[^}]*position:\s*fixed/);
  });

  it("plot keeps the projector's aspect ratio exactly (#267)", () => {
    const plot = blockFor(".pc-chart__plot");
    // Stretching the plot to fill leftover sheet height would slide every
    // mark off its viewBox y — the ratio must win over the flex free space.
    expect(plot).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(plot).toMatch(/position:\s*relative/);
  });

  it("sheet stacks title block above plot in flow (#267)", () => {
    const sheet = blockFor(".pc-chart__sheet");
    expect(sheet).toMatch(/display:\s*flex/);
    expect(sheet).toMatch(/flex-direction:\s*column/);
  });
});

describe("chart.css flavour marginalia live in the foot band (#273)", () => {
  it("the foot band is in flow below the plot, not positioned on the paper", () => {
    const band = blockFor(".pc-chart__footnote");
    // `flex: 0 0 auto` in the sheet's column: it pays for its own height
    // rather than floating over paper the projector is using.
    expect(band).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(band).toMatch(/border-top:/);
    expect(band).not.toMatch(/position:\s*absolute/);
  });

  it("keeps the flavour face, quieter than the title block's clause", () => {
    const m = blockFor(".pc-chart-marginalia");
    expect(m).toMatch(/font-family:\s*var\(--font-flavor\)/);
    expect(m).toMatch(/font-style:\s*italic/);
    expect(m).toMatch(/pointer-events:\s*none/);
    expect(m).toMatch(/opacity:\s*0\.62/);
  });

  it("carries no anchoring of any kind — that is the whole point of #273", () => {
    const m = blockFor(".pc-chart-marginalia");
    expect(m).not.toMatch(/position:\s*absolute/);
    expect(m).not.toMatch(/transform:\s*translate/);
    expect(m).not.toMatch(/z-index/);
    // And none of the pre-#268 hardcoded sheet percentages may come back.
    expect(m).not.toMatch(/left:/);
    expect(m).not.toMatch(/top:/);
  });

  it("the tilt variant is gone with the placement", () => {
    expect(() => blockFor(".pc-chart-marginalia--tilt")).toThrow();
  });
});
