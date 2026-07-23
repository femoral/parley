import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Region banner legibility — `.pc-region__banner` sits over open water and
 * must meet the sub/chrome-sm tier (≥12px) with AA contrast against the sea.
 */

const SCENE_CSS = fs.readFileSync(
  fileURLToPath(new URL("../src/scene/scene.css", import.meta.url)),
  "utf8",
);

const TOKENS_CSS = fs.readFileSync(
  fileURLToPath(new URL("../src/tokens/tokens.css", import.meta.url)),
  "utf8",
);

describe("region banner legibility (.pc-region__banner)", () => {
  it("uses the sub type tier (12px / --text-sub), not a sub-12px literal", () => {
    // Pull the banner rule block (first match of the selector).
    const match = SCENE_CSS.match(
      /\.pc-region__banner\s*\{([^}]+)\}/,
    );
    expect(match).toBeTruthy();
    const block = match![1]!;
    expect(block).toMatch(/font-size:\s*var\(--text-sub\)/);
    // Guard against regressing to the old 11px chrome-sm literal.
    expect(block).not.toMatch(/font-size:\s*11px/);
    expect(block).not.toMatch(/font-size:\s*var\(--text-chrome-sm\)/);
  });

  it("uses quieter tracking than full caps track", () => {
    const match = SCENE_CSS.match(
      /\.pc-region__banner\s*\{([^}]+)\}/,
    );
    expect(match).toBeTruthy();
    const block = match![1]!;
    expect(block).toMatch(/letter-spacing:\s*var\(--track-micro\)/);
    expect(block).not.toMatch(/letter-spacing:\s*var\(--track-caps\)/);
  });

  it("inks with the sea-legible token (≥4.5:1 on sea)", () => {
    const match = SCENE_CSS.match(
      /\.pc-region__banner\s*\{([^}]+)\}/,
    );
    expect(match).toBeTruthy();
    const block = match![1]!;
    expect(block).toMatch(/color:\s*var\(--ink-on-sea\)/);
    // Token is documented AA against --sea-shallow in tokens.css.
    expect(TOKENS_CSS).toMatch(/--ink-on-sea:\s*#e0cfa4/i);
  });
});
