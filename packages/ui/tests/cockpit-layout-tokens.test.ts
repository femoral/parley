/**
 * #272 — COCKPIT_LAYOUT must track the CSS tokens that pin sheet scale.
 *
 * The projector cannot import stylesheets at runtime, so the constants are
 * still numeric. This suite is the enforcement: changing `--region-roster`
 * (or board-inset, gutter, region-right, or the stacking breakpoint) without
 * updating the mirror fails here. A green suite against hand-copied literals
 * alone is the exact defect this replaces.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COCKPIT_LAYOUT,
  minCentreSheetWidthPx,
  sheetScaleFloor,
  CHART_VB_W,
} from "../src/chart/projectChart.js";

function uiPath(...parts: string[]): string {
  const root = process.cwd().endsWith("packages/ui")
    ? process.cwd()
    : resolve(process.cwd(), "packages/ui");
  return resolve(root, ...parts);
}

const TOKENS_CSS = readFileSync(uiPath("src/tokens/tokens.css"), "utf8");
const COCKPIT_CSS = readFileSync(uiPath("src/app/cockpit.css"), "utf8");

/** First `Npx` value for a custom property declaration in a stylesheet. */
function cssPxVar(source: string, name: string): number {
  const re = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*([\\d.]+)px`);
  const m = source.match(re);
  expect(m, `expected ${name}: <n>px in stylesheet`).not.toBeNull();
  return Number(m![1]);
}

/**
 * Stacking breakpoint from `@media (max-width: Npx)`. The cockpit uses a
 * single primary collapse rule; take the first max-width so a comment-only
 * mention cannot invent a second.
 */
function stackBreakpointPx(source: string): number {
  const m = source.match(/@media\s*\(\s*max-width:\s*([\d.]+)px\s*\)/);
  expect(m, "expected @media (max-width: Npx) in cockpit.css").not.toBeNull();
  return Number(m![1]);
}

describe("COCKPIT_LAYOUT mirrors tokens.css / cockpit.css (#272)", () => {
  it("boardInsetPx tracks --board-inset", () => {
    expect(COCKPIT_LAYOUT.boardInsetPx).toBe(cssPxVar(TOKENS_CSS, "--board-inset"));
  });

  it("gutterPx tracks --gutter", () => {
    expect(COCKPIT_LAYOUT.gutterPx).toBe(cssPxVar(TOKENS_CSS, "--gutter"));
  });

  it("regionRosterPx tracks --region-roster", () => {
    expect(COCKPIT_LAYOUT.regionRosterPx).toBe(cssPxVar(TOKENS_CSS, "--region-roster"));
  });

  it("regionRightPx tracks --region-right", () => {
    expect(COCKPIT_LAYOUT.regionRightPx).toBe(cssPxVar(TOKENS_CSS, "--region-right"));
  });

  it("stackBreakpointPx tracks the cockpit stacking media query", () => {
    expect(COCKPIT_LAYOUT.stackBreakpointPx).toBe(stackBreakpointPx(COCKPIT_CSS));
  });

  it("desktopMinWidthPx is one pixel above the stacking breakpoint", () => {
    expect(COCKPIT_LAYOUT.desktopMinWidthPx).toBe(
      COCKPIT_LAYOUT.stackBreakpointPx + 1,
    );
  });
});

describe("minCentreSheetWidthPx stacked vs rail-subtracted (#272)", () => {
  const {
    boardInsetPx,
    gutterPx,
    regionRosterPx,
    regionRightPx,
  } = COCKPIT_LAYOUT;

  const stacked = (vp: number) => vp - 2 * boardInsetPx;
  const railSubtracted = (vp: number) =>
    vp - 2 * boardInsetPx - regionRosterPx - regionRightPx - 2 * gutterPx;

  it.each([
    [320, stacked(320)], // 292 — was clamped to 385
    [360, stacked(360)], // 332
    [390, stacked(390)], // 362
    [412, stacked(412)], // 384
    [413, stacked(413)], // 385
    [1080, stacked(1080)], // 1052 — still stacked at the breakpoint
  ] as const)(
    "at %ipx (≤ breakpoint) returns stacked centre width %i",
    (vp, expected) => {
      expect(minCentreSheetWidthPx(vp)).toBe(expected);
    },
  );

  it.each([
    [1081, railSubtracted(1081)], // 385 — desktop floor, unchanged
    [1280, railSubtracted(1280)], // 584
    [1440, railSubtracted(1440)], // 744
    [1600, railSubtracted(1600)], // 904
    [1920, railSubtracted(1920)], // 1224
  ] as const)(
    "at %ipx (> breakpoint) returns rail-subtracted centre width %i",
    (vp, expected) => {
      expect(minCentreSheetWidthPx(vp)).toBe(expected);
    },
  );

  it("defaults to the narrowest desktop triptych (385px)", () => {
    expect(minCentreSheetWidthPx()).toBe(385);
    expect(minCentreSheetWidthPx()).toBe(railSubtracted(COCKPIT_LAYOUT.desktopMinWidthPx));
  });

  it("sheetScaleFloor is centre width over CHART_VB_W", () => {
    expect(sheetScaleFloor(320)).toBe(minCentreSheetWidthPx(320) / CHART_VB_W);
    expect(sheetScaleFloor()).toBe(385 / CHART_VB_W);
    expect(sheetScaleFloor(1920)).toBe(minCentreSheetWidthPx(1920) / CHART_VB_W);
  });

  it("behaviour at 1081px and above is the prior rail formula (unchanged)", () => {
    // The old clamp-up only affected viewports below the breakpoint; these
    // numbers must stay bit-identical so mark-geometry floors on desktop
    // do not drift with this fix.
    for (const vp of [1081, 1280, 1440, 1600, 1920] as const) {
      expect(minCentreSheetWidthPx(vp)).toBe(railSubtracted(vp));
    }
  });
});
