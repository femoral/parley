import { describe, expect, it } from "vitest";
import {
  HARNESS_COLORS,
  UNKNOWN_HARNESS,
  UNKNOWN_VENDOR,
  VENDOR_EMBLEMS,
  harnessColorFor,
  modelVendorFor,
  vendorEmblemFor,
} from "../src/tokens/factions.js";

/** sRGB channel 0–255 → relative luminance contribution (WCAG 2.1). */
function channelL(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * channelL(r) + 0.7152 * channelL(g) + 0.0722 * channelL(b);
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

function contrastRatio(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const la = relativeLuminance(a.r, a.g, a.b);
  const lb = relativeLuminance(b.r, b.g, b.b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("task identity tokens", () => {
  it("provides distinct authored marks for the required model vendors", () => {
    const required = ["gpt", "claude", "grok", "kimi", "qwen", "gemini"];
    const signatures = required.map((vendor) => JSON.stringify(vendorEmblemFor(vendor).emblem));
    expect(new Set(signatures).size).toBe(required.length);
    expect(Object.keys(VENDOR_EMBLEMS)).toEqual(expect.arrayContaining([...required, "codex", "google"]));
    // Pi (Inflection) no longer ships an authored mark; it resolves as unknown.
    expect(Object.keys(VENDOR_EMBLEMS)).not.toContain("pi");
  });

  it("uses a question mark for absent and unknown vendors", () => {
    expect(vendorEmblemFor("new-model-maker")).toBe(UNKNOWN_VENDOR);
    expect(vendorEmblemFor(null).emblem).toEqual({ kind: "glyph", char: "?" });
  });

  it("provides distinct colours for every built-in harness", () => {
    const builtIns = [
      "fake", "codex", "grok", "claude", "antigravity", "kilo", "goose",
      "openclaw", "cline", "openhands", "opencode", "hermes", "pi", "kimi",
    ];
    expect(Object.keys(HARNESS_COLORS)).toEqual(expect.arrayContaining(builtIns));
    expect(new Set(builtIns.map((harness) => harnessColorFor(harness).coat)).size).toBe(builtIns.length);
  });

  it("uses a non-white brass-frame coat for absent and unknown harnesses", () => {
    expect(harnessColorFor("home-grown")).toBe(UNKNOWN_HARNESS);
    expect(harnessColorFor(undefined)).toBe(UNKNOWN_HARNESS);
    // White coat + --ink-on-coat white blanks the mark (loud empty chip).
    expect(UNKNOWN_HARNESS.coat.toUpperCase()).not.toBe("#FFFFFF");
    // Neutral privateer / brass-frame family (matches ChartKey model-mark chips).
    expect(UNKNOWN_HARNESS.coat.toUpperCase()).toBe("#8A6A34");
  });

  it("unknown-harness coat keeps contrast-safe mark ink (white on coat)", () => {
    // Emblem mark uses --ink-on-coat (#ffffff). Large UI chrome needs ≥3:1.
    const ink = { r: 255, g: 255, b: 255 };
    const coat = parseHex(UNKNOWN_HARNESS.coat);
    expect(contrastRatio(coat, ink)).toBeGreaterThanOrEqual(3);
  });

  it("no registered harness coat is pure white (would blank --ink-on-coat mark)", () => {
    for (const [key, harness] of Object.entries(HARNESS_COLORS)) {
      expect(harness.coat.toUpperCase(), key).not.toBe("#FFFFFF");
    }
    // Grok charcoal stays mid-dark so the shared bright rim treatment still separates it.
    const grok = HARNESS_COLORS.grok!;
    expect(parseHex(grok.coat).r).toBeLessThan(120);
    expect(parseHex(grok.coat).g).toBeLessThan(120);
    expect(parseHex(grok.coat).b).toBeLessThan(130);
  });

  it("normalizes external identity strings", () => {
    expect(vendorEmblemFor(" QWEN ")).toBe(VENDOR_EMBLEMS.qwen);
    expect(harnessColorFor(" OpenCode ")).toBe(HARNESS_COLORS.opencode);
  });

  it("derives the maker from model ids before consulting adapter aliases", () => {
    expect(modelVendorFor("qwen-3-max", "opencode").label).toBe("Qwen");
    expect(modelVendorFor("gpt-5.6-sol", "codex").label).toBe("GPT");
    expect(modelVendorFor("grok-4.5", "opencode").label).toBe("Grok");
    expect(modelVendorFor("claude-sonnet-4", "opencode").label).toBe("Claude");
    expect(modelVendorFor("kimi-k2", "opencode").label).toBe("Kimi");
    expect(modelVendorFor("gemini-3.6-flash", "antigravity").label).toBe("Gemini");
    expect(modelVendorFor("google-gemini-2.5-pro", "opencode").label).toBe("Gemini");
  });


  it("falls back from an opaque model to an adapter alias, then unknown", () => {
    expect(modelVendorFor(null, "grok")).toBe(VENDOR_EMBLEMS.grok);
    expect(modelVendorFor("custom-model", "claude")).toBe(VENDOR_EMBLEMS.claude);
    expect(modelVendorFor(null, null)).toBe(UNKNOWN_VENDOR);
  });
});
