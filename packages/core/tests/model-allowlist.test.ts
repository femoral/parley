import { describe, expect, it } from "vitest";
import {
  editDistance,
  formatAllowedCombos,
  formatCliSelectedHint,
  listAllowedCombos,
  ModelAllowlistError,
  noAllowlistMessage,
  resolveAllowedCombo,
  suggestNearestCombo,
} from "../src/model-allowlist.js";
import type { VendorConfig } from "../src/config.js";

const CONFIG_PATH = "/tmp/parley-test/parley.json";

function vendor(models: VendorConfig["models"]): VendorConfig {
  return { models };
}

describe("resolveAllowedCombo — deny-by-default (#185)", () => {
  it("fails when vendor has no allowlist, naming wizard and config path", () => {
    expect(() =>
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: undefined,
        model: "gpt",
        effort: "low",
        configPath: CONFIG_PATH,
      }),
    ).toThrow(ModelAllowlistError);
    try {
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: {},
        model: null,
        effort: null,
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelAllowlistError);
      expect((err as ModelAllowlistError).code).toBe("no_allowlist");
      expect((err as Error).message).toContain("codex");
      expect((err as Error).message).toMatch(/no models configured/i);
      expect((err as Error).message).toContain("/parley-wizard");
      expect((err as Error).message).toContain(CONFIG_PATH);
    }
  });

  it("fails when models map is empty", () => {
    expect(() =>
      resolveAllowedCombo({
        vendor: "fake",
        vendorCfg: { models: {} },
        model: null,
        effort: null,
        configPath: CONFIG_PATH,
      }),
    ).toThrow(/no models configured/);
  });
});

describe("resolveAllowedCombo — default combo", () => {
  const cfg = vendor({
    "gpt-5": {
      efforts: ["low", "medium", "high"],
      default: "medium",
      hint: "daily",
    },
    o3: { efforts: ["high"] },
  });

  it("uses default-flagged combo when -m/-e omitted", () => {
    const r = resolveAllowedCombo({
      vendor: "codex",
      vendorCfg: cfg,
      model: null,
      effort: null,
      configPath: CONFIG_PATH,
    });
    expect(r).toEqual({ model: "gpt-5", effort: "medium", usedDefault: true });
  });

  it("errors when no default is flagged", () => {
    const noDef = vendor({
      "gpt-5": { efforts: ["low"] },
    });
    expect(() =>
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: noDef,
        model: null,
        effort: null,
        configPath: CONFIG_PATH,
      }),
    ).toThrow(/no default model\+effort/);
  });

  it("accepts default: true with a single effort", () => {
    const r = resolveAllowedCombo({
      vendor: "v",
      vendorCfg: vendor({ m: { efforts: ["low"], default: true } }),
      model: null,
      effort: null,
      configPath: CONFIG_PATH,
    });
    expect(r.model).toBe("m");
    expect(r.effort).toBe("low");
  });
});

describe("resolveAllowedCombo — reject + suggest", () => {
  const cfg = vendor({
    "gpt-5": { efforts: ["low", "medium"], default: "low", hint: "main" },
    "gpt-4": { efforts: ["high"] },
  });

  it("rejects unknown model and suggests nearest", () => {
    try {
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: cfg,
        model: "gpt-6",
        effort: "low",
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/not allowed/);
      expect((err as Error).message).toMatch(/Allowed:/);
      expect((err as Error).message).toMatch(/did you mean/);
      expect((err as Error).message).toMatch(/gpt-/);
    }
  });

  it("rejects effort not on the explicit list (max/ultra not implied)", () => {
    try {
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: cfg,
        model: "gpt-5",
        effort: "ultra",
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/ultra/);
      expect((err as Error).message).toMatch(/allowed efforts: low, medium/);
      expect((err as Error).message).toMatch(/did you mean gpt-5@/);
    }
  });

  it("accepts an explicitly listed combo", () => {
    const r = resolveAllowedCombo({
      vendor: "codex",
      vendorCfg: cfg,
      model: "gpt-5",
      effort: "medium",
      configPath: CONFIG_PATH,
    });
    expect(r).toEqual({ model: "gpt-5", effort: "medium", usedDefault: false });
  });

  it("requires effort when model is set and efforts are non-empty", () => {
    expect(() =>
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: cfg,
        model: "gpt-5",
        effort: null,
        configPath: CONFIG_PATH,
      }),
    ).toThrow(/effort is required/);
  });

  it("not_allowed message has no CLI selection line (callers append via formatCliSelectedHint)", () => {
    // resolveAllowedCombo is a pure gate — #284 advisory is appended by
    // engine / run-preflight only. A regression that reintroduces a
    // cliSelected parameter here would invite double-append.
    try {
      resolveAllowedCombo({
        vendor: "goose",
        vendorCfg: cfg,
        model: "gpt-6",
        effort: "low",
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/not allowed/);
      expect(msg).toMatch(/Allowed:/);
      expect(msg).toMatch(/did you mean/);
      expect(msg).not.toMatch(/CLI currently has/);
    }
  });

  it("success path is unchanged regardless of external selection state", () => {
    const r = resolveAllowedCombo({
      vendor: "codex",
      vendorCfg: cfg,
      model: "gpt-5",
      effort: "medium",
      configPath: CONFIG_PATH,
    });
    expect(r).toEqual({ model: "gpt-5", effort: "medium", usedDefault: false });
  });
});

describe("formatCliSelectedHint (#284)", () => {
  it("is empty when selection is allowlisted or absent", () => {
    const combos = listAllowedCombos(
      vendor({ "gpt-5": { efforts: ["low", "medium"], default: "low" } }),
    );
    expect(formatCliSelectedHint(null, combos)).toBe("");
    expect(formatCliSelectedHint({ model: "gpt-5", effort: "low" }, combos)).toBe("");
    expect(formatCliSelectedHint({ model: "gpt-5", effort: null }, combos)).toBe("");
  });

  it("JSON.stringifies and length-caps disk-derived model/effort text", () => {
    const combos = listAllowedCombos(
      vendor({ "gpt-5": { efforts: ["low"], default: "low" } }),
    );
    const huge = "x".repeat(500_000);
    const hint = formatCliSelectedHint({ model: huge, effort: "high" }, combos);
    expect(hint.length).toBeLessThan(500);
    expect(hint).toMatch(/CLI currently has "/);
    // Newlines + ANSI in a model id must not open extra terminal lines.
    const sneaky = "legit\n*** approved ***\x1b[32m";
    const sneakyHint = formatCliSelectedHint(
      { model: sneaky, effort: null },
      combos,
    );
    expect(sneakyHint).toContain(JSON.stringify("legit\n*** approved ***\x1b[32m"));
    // The raw control sequence is inside the JSON string, not as free message text
    // that would render as a separate terminal line outside the quote.
    expect(sneakyHint.startsWith(" CLI currently has ")).toBe(true);
    expect(sneakyHint.endsWith(" selected (not on the allowlist).")).toBe(true);
  });

  it("hardens untyped / whitespace-only input to an empty hint", () => {
    const combos = listAllowedCombos(
      vendor({ "gpt-5": { efforts: ["low"], default: "low" } }),
    );
    expect(formatCliSelectedHint({ model: "   ", effort: null }, combos)).toBe("");
    expect(
      formatCliSelectedHint(
        { model: 42, effort: 7 } as unknown as { model: string; effort: string | null },
        combos,
      ),
    ).toBe("");
    expect(
      formatCliSelectedHint(
        { model: undefined, effort: undefined } as unknown as {
          model: string;
          effort: string | null;
        },
        combos,
      ),
    ).toBe("");
  });
});

describe("listAllowedCombos / format / nearest", () => {
  it("expands model×effort and marks default", () => {
    const combos = listAllowedCombos(
      vendor({
        a: { efforts: ["low", "high"], default: "high", hint: "h" },
        b: { efforts: [] },
      }),
    );
    expect(combos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "a", effort: "low", isDefault: false, hint: "h" }),
        expect.objectContaining({ model: "a", effort: "high", isDefault: true }),
        expect.objectContaining({ model: "b", effort: null, isDefault: false }),
      ]),
    );
    expect(formatAllowedCombos(combos)).toMatch(/a@high/);
  });

  it("formatAllowedCombos JSON-escapes adversarial model keys (#284)", () => {
    // Defense in depth: even if a poisoned key lands in config (hand-edit or
    // a future inject bug), rejection text must not open extra terminal lines.
    const combos = listAllowedCombos(
      vendor({
        "legit\n*** ALL MODELS ALLOWED ***\x1b[32m": { efforts: ["low"] },
      }),
    );
    const text = formatAllowedCombos(combos);
    expect(text).toContain(JSON.stringify("legit\n*** ALL MODELS ALLOWED ***\x1b[32m@low"));
    // Bare newline would split the rejection into multiple terminal lines.
    expect(text.includes("\n")).toBe(false);
  });

  it("prefer same model at different effort for nearest", () => {
    const combos = listAllowedCombos(
      vendor({
        m: { efforts: ["low", "high"] },
        n: { efforts: ["medium"] },
      }),
    );
    const near = suggestNearestCombo(combos, "m", "mediu");
    expect(near?.model).toBe("m");
    // "mediu" is closer to... neither low nor high perfectly; still same model.
    expect(near?.effort).toMatch(/low|high/);
  });

  it("editDistance is 0 for equal strings", () => {
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("a", "b")).toBe(1);
  });
});

describe("resolveAllowedCombo rejection escaping (#292)", () => {
  /** Full rejection text must never carry raw control bytes (any of 3 sites). */
  function expectNoRawControls(msg: string): void {
    expect(msg.includes("\n")).toBe(false);
    expect(msg.includes("\x1b")).toBe(false);
  }

  it("full rejection with poisoned model id has no raw newline or ESC", () => {
    // Poisoned key can surface via formatAllowedCombos AND "did you mean"
    // (formatCombo site) when it is the nearest suggestion.
    const poisoned = "legit\n*** ALL MODELS ALLOWED ***\x1b[32m";
    const cfg = vendor({
      [poisoned]: { efforts: ["low"], default: "low" },
    });
    try {
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: cfg,
        model: "unknown-model",
        effort: "low",
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expectNoRawControls(msg);
      expect(msg).toMatch(/not allowed/);
      expect(msg).toMatch(/did you mean/);
      // Escaped form appears (JSON) — not the raw control sequence as free text.
      expect(msg).toContain(JSON.stringify(`${poisoned}@low`));
    }
  });

  it("full rejection with poisoned effort id has no raw newline or ESC", () => {
    // Poisoned efforts surface via "allowed efforts:" join AND suggestions.
    const poisonedEffort = "low\n\x1b[31mhack";
    const cfg = vendor({
      "gpt-5": { efforts: [poisonedEffort, "medium"], default: "medium" },
    });
    try {
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: cfg,
        model: "gpt-5",
        effort: null,
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expectNoRawControls(msg);
      expect(msg).toMatch(/effort is required/);
      expect(msg).toMatch(/allowed efforts:/);
      expect(msg).toContain(JSON.stringify(poisonedEffort));
    }

    try {
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: cfg,
        model: "gpt-5",
        effort: "ultra",
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expectNoRawControls(msg);
      expect(msg).toMatch(/not allowed/);
      expect(msg).toMatch(/allowed efforts:/);
      expect(msg).toMatch(/did you mean/);
      expect(msg).toContain(JSON.stringify(poisonedEffort));
    }
  });

  it("clean rejection message renders byte-for-byte unchanged", () => {
    const cfg = vendor({
      "gpt-5": { efforts: ["low", "medium"], default: "low", hint: "main" },
      "gpt-4": { efforts: ["high"] },
    });
    try {
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: cfg,
        model: "gpt-5",
        effort: "ultra",
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe(
        'vendor codex: effort "ultra" is not allowed for model "gpt-5" ' +
          "(allowed efforts: low, medium). Allowed combos: gpt-5@low, gpt-5@medium, gpt-4@high; " +
          "did you mean gpt-5@low?",
      );
    }

    try {
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: cfg,
        model: "gpt-6",
        effort: "low",
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe(
        'vendor codex: model "gpt-6" is not allowed. ' +
          "Allowed: gpt-5@low, gpt-5@medium, gpt-4@high; did you mean gpt-5@low?",
      );
    }
  });
});

describe("noAllowlistMessage", () => {
  it("includes vendor, wizard, and path", () => {
    const msg = noAllowlistMessage("grok", "/home/u/.parley/parley.json");
    expect(msg).toContain("grok");
    expect(msg).toContain("/parley-wizard");
    expect(msg).toContain("/home/u/.parley/parley.json");
  });
});
