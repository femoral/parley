/*
 * The chrome-glyph vocabulary: every panel-chrome mark is authored SVG
 * rendered through <Mark>, and the component layers stay free of the emoji
 * chrome the marks replaced (platform emoji render per-OS and the colour ones
 * broke the brass monochrome — the reason the Mark system exists).
 */
/** @vitest-environment happy-dom */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Mark } from "../src/primitives/index.js";
import {
  MARK_ANCHOR,
  MARK_BANNER,
  MARK_COMPASS,
  MARK_LENS,
  MARK_MALLET,
  MARK_RING,
  MARK_SCROLL,
  MARK_SLOOP,
  MARK_SPARK,
  MARK_SPYGLASS,
} from "../src/tokens/chrome-glyphs.js";

const CHROME_MARKS = {
  anchor: MARK_ANCHOR,
  banner: MARK_BANNER,
  compass: MARK_COMPASS,
  lens: MARK_LENS,
  mallet: MARK_MALLET,
  ring: MARK_RING,
  scroll: MARK_SCROLL,
  sloop: MARK_SLOOP,
  spark: MARK_SPARK,
  spyglass: MARK_SPYGLASS,
};

describe("chrome glyph marks", () => {
  afterEach(cleanup);

  it.each(Object.entries(CHROME_MARKS))("%s is authored SVG and renders via Mark", (_name, mark) => {
    expect(mark.kind).toBe("svg");
    const { container } = render(<Mark mark={mark} size={12} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(svg!.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("component layers carry no emoji chrome (replaced by authored marks)", () => {
    // The exact set the marks replaced. tokens/state-meta.ts keeps its glyph
    // strings by contract (accessible/text fallback data, not rendered chrome).
    const banned = /[🚩🧭📜⚑⚓✦⚒⛵◉⌕]/u;
    const roots = ["hud", "scene", "app", "primitives"].map((d) =>
      join(import.meta.dirname, "../src", d),
    );
    const offenders: string[] = [];
    for (const root of roots) {
      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(tsx?|css)$/.test(entry.name)) continue;
        const path = join(entry.parentPath, entry.name);
        if (banned.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
