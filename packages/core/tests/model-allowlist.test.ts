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

  it("enriches not_allowed with CLI selection when outside the allowlist (#284)", () => {
    try {
      resolveAllowedCombo({
        vendor: "goose",
        vendorCfg: cfg,
        model: "gpt-6",
        effort: "low",
        configPath: CONFIG_PATH,
        cliSelected: { model: "claude-sonnet-4-5-20250929", effort: null },
      });
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      // Pre-existing shape intact.
      expect(msg).toMatch(/not allowed/);
      expect(msg).toMatch(/Allowed:/);
      expect(msg).toMatch(/did you mean/);
      // Advisory line only.
      expect(msg).toMatch(
        /CLI currently has claude-sonnet-4-5-20250929 selected \(not on the allowlist\)/,
      );
    }
  });

  it("does not change success path or exit semantics when cliSelected is set", () => {
    const r = resolveAllowedCombo({
      vendor: "codex",
      vendorCfg: cfg,
      model: "gpt-5",
      effort: "medium",
      configPath: CONFIG_PATH,
      cliSelected: { model: "other", effort: "high" },
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

describe("noAllowlistMessage", () => {
  it("includes vendor, wizard, and path", () => {
    const msg = noAllowlistMessage("grok", "/home/u/.parley/parley.json");
    expect(msg).toContain("grok");
    expect(msg).toContain("/parley-wizard");
    expect(msg).toContain("/home/u/.parley/parley.json");
  });
});
