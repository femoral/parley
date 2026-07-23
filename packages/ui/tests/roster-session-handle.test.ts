import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HUD_CSS = fs.readFileSync(
  fileURLToPath(new URL("../src/hud/hud.css", import.meta.url)),
  "utf8",
);

describe("roster session handle overflow box", () => {
  it("clips the ellipsis on a bounded flex item box", () => {
    const blocks = [...HUD_CSS.matchAll(/\.pc-roster__session-handle\s*\{([^}]+)\}/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const combined = blocks.map((match) => match[1]).join("\n");
    expect(combined).toMatch(/display:\s*block/);
    expect(combined).toMatch(/flex:\s*0\s+1\s+9em/);
    expect(combined).toMatch(/min-width:\s*0/);
    expect(combined).toMatch(/max-width:\s*9em/);
    expect(combined).toMatch(/overflow:\s*hidden/);
    expect(combined).toMatch(/text-overflow:\s*ellipsis/);
    expect(combined).toMatch(/white-space:\s*nowrap/);
  });
});
