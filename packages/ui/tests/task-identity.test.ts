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

describe("task identity tokens", () => {
  it("provides distinct authored marks for the required model vendors", () => {
    const required = ["gpt", "claude", "grok", "kimi", "qwen"];
    const signatures = required.map((vendor) => JSON.stringify(vendorEmblemFor(vendor).emblem));
    expect(new Set(signatures).size).toBe(required.length);
    expect(Object.keys(VENDOR_EMBLEMS)).toEqual(expect.arrayContaining([...required, "codex"]));
    // Pi (Inflection) no longer ships an authored mark; it resolves as unknown.
    expect(Object.keys(VENDOR_EMBLEMS)).not.toContain("pi");
  });

  it("uses a question mark for absent and unknown vendors", () => {
    expect(vendorEmblemFor("new-model-maker")).toBe(UNKNOWN_VENDOR);
    expect(vendorEmblemFor(null).emblem).toEqual({ kind: "glyph", char: "?" });
  });

  it("provides distinct colours for every built-in harness", () => {
    const builtIns = [
      "fake", "codex", "grok", "claude", "gemini", "kilo", "goose",
      "openclaw", "cline", "openhands", "opencode", "hermes", "pi", "kimi",
    ];
    expect(Object.keys(HARNESS_COLORS)).toEqual(expect.arrayContaining(builtIns));
    expect(new Set(builtIns.map((harness) => harnessColorFor(harness).coat)).size).toBe(builtIns.length);
  });

  it("uses white for absent and unknown harnesses", () => {
    expect(harnessColorFor("home-grown")).toBe(UNKNOWN_HARNESS);
    expect(harnessColorFor(undefined).coat).toBe("#FFFFFF");
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
  });

  it("falls back from an opaque model to an adapter alias, then unknown", () => {
    expect(modelVendorFor(null, "grok")).toBe(VENDOR_EMBLEMS.grok);
    expect(modelVendorFor("custom-model", "claude")).toBe(VENDOR_EMBLEMS.claude);
    expect(modelVendorFor(null, null)).toBe(UNKNOWN_VENDOR);
  });
});
