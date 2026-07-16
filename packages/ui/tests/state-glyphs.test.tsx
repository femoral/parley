/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Mark } from "../src/primitives/Mark.js";
import { STATE_GLYPH_MARKS } from "../src/tokens/state-glyphs.js";
import { STATE_META, type StateKey } from "../src/tokens/state-meta.js";

afterEach(cleanup);

/** Glyph strings that must remain stable for accessible/text consumers. */
const EXPECTED_GLYPHS: Record<StateKey, string> = {
  pending: "⏳",
  running: "⛵",
  awaiting_answer: "🚩",
  stalled: "🧭",
  completed: "🏁",
  failed: "✖",
  cancelled: "⊘",
};

describe("STATE_GLYPH_MARKS — authored state silhouettes", () => {
  it("defines an authored SVG mark for every known state", () => {
    const keys = Object.keys(EXPECTED_GLYPHS) as StateKey[];
    for (const key of keys) {
      const mark = STATE_GLYPH_MARKS[key];
      expect(mark, `missing mark for ${key}`).toBeTruthy();
      expect(mark.kind).toBe("svg");
      if (mark.kind === "svg") {
        expect(mark.viewBox).toBe("0 0 24 24");
        const paths = typeof mark.path === "string" ? [mark.path] : mark.path;
        expect(paths.length).toBeGreaterThan(0);
        for (const d of paths) {
          expect(d.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("is wired onto STATE_META.mark for every state", () => {
    for (const key of Object.keys(EXPECTED_GLYPHS) as StateKey[]) {
      expect(STATE_META[key].mark).toBe(STATE_GLYPH_MARKS[key]);
    }
  });

  it("keeps STATE_META.glyph emoji strings unchanged", () => {
    for (const key of Object.keys(EXPECTED_GLYPHS) as StateKey[]) {
      expect(STATE_META[key].glyph).toBe(EXPECTED_GLYPHS[key]);
    }
  });

  it("renders each state mark as an aria-hidden SVG with currentColor paths", () => {
    for (const key of Object.keys(EXPECTED_GLYPHS) as StateKey[]) {
      const { container, unmount } = render(<Mark mark={STATE_GLYPH_MARKS[key]} size={10} />);
      const svg = container.querySelector("svg");
      expect(svg, `no svg for ${key}`).toBeTruthy();
      expect(svg!.getAttribute("aria-hidden")).toBe("true");
      expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
      const paths = container.querySelectorAll("path");
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path.getAttribute("fill")).toBe("currentColor");
      }
      unmount();
    }
  });
});
