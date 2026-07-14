import { describe, expect, it } from "vitest";
import { formatUptime, formatClock } from "../src/app/hooks/format.js";
import { factionFor, UNALIGNED } from "../src/tokens/factions.js";
import { stateMetaFor } from "../src/tokens/state-meta.js";

describe("formatUptime (cockpit clock phrasing)", () => {
  it("renders the two largest non-zero units", () => {
    expect(formatUptime(41_000)).toBe("41s");
    expect(formatUptime(221_000)).toBe("3m 41s");
    expect(formatUptime(3_723_000)).toBe("1h 02m");
    expect(formatUptime(90_000_000)).toBe("1d 01h");
  });
  it("guards against nonsense input", () => {
    expect(formatUptime(-5)).toBe("—");
    expect(formatUptime(Number.NaN)).toBe("—");
  });
});

describe("formatClock", () => {
  it("zero-pads to HH:MM", () => {
    expect(formatClock(new Date(2026, 0, 1, 9, 4))).toBe("09:04");
    expect(formatClock(new Date(2026, 0, 1, 14, 32))).toBe("14:32");
  });
});

describe("factionFor", () => {
  it("resolves seeded vendors and falls back to Unaligned", () => {
    expect(factionFor("codex").label).toBe("Codex");
    expect(factionFor("codex").coat).toBe("#10a37f");
    expect(factionFor("pi").emblem).toEqual({ kind: "glyph", char: "π" });
    expect(factionFor("grok").emblem.kind).toBe("svg");
    expect(factionFor("brand-new")).toBe(UNALIGNED);
    expect(factionFor(null)).toBe(UNALIGNED);
  });
});

describe("stateMetaFor", () => {
  it("maps known states to their manifest label/colour token", () => {
    expect(stateMetaFor("awaiting_answer").label).toBe("AWAITING");
    expect(stateMetaFor("running").colorVar).toBe("var(--state-running)");
  });
  it("degrades gracefully for an unknown state", () => {
    expect(stateMetaFor("mutinied").label).toBe("MUTINIED");
  });
});
