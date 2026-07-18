import { describe, expect, it } from "vitest";
import {
  SHIPPED_CATALOG_VENDOR_IDS,
  SHIPPED_MODEL_CATALOG,
  getShippedModelCatalog,
  getShippedVendorModels,
  parseModelCatalog,
  parseModelEntry,
  parseVendorModels,
} from "../src/models.js";

describe("shipped model catalog", () => {
  it("matches the model catalog schema", () => {
    expect(parseModelCatalog(SHIPPED_MODEL_CATALOG)).toEqual(SHIPPED_MODEL_CATALOG);
  });

  it("provides a deep-cloned entry for every shipped vendor", () => {
    const catalog = getShippedModelCatalog();
    expect(Object.keys(catalog)).toEqual(SHIPPED_CATALOG_VENDOR_IDS);

    for (const id of SHIPPED_CATALOG_VENDOR_IDS) {
      const vendor = getShippedVendorModels(id);
      expect(vendor).toEqual(SHIPPED_MODEL_CATALOG[id]);
      expect(vendor).not.toBe(SHIPPED_MODEL_CATALOG[id]);
    }

    catalog.codex!.models[0]!.efforts.push("mutated");
    expect(SHIPPED_MODEL_CATALOG.codex!.models[0]!.efforts).not.toContain("mutated");
    expect(getShippedVendorModels("unknown")).toBeUndefined();
  });

  it("ships fake as a deterministic stub", () => {
    expect(SHIPPED_MODEL_CATALOG.fake).toEqual({
      fetched_at: "2026-07-18",
      source: "stub",
      models: [
        {
          id: "fake-model",
          efforts: ["low", "medium", "high"],
          default_effort: "medium",
        },
      ],
    });
  });
});

describe("model catalog schema", () => {
  it.each([
    null,
    [],
    { id: 1, efforts: [], default_effort: null },
    { id: "model", efforts: "high", default_effort: null },
    { id: "model", efforts: [], default_effort: 1 },
  ])("rejects invalid model entries", (value) => {
    expect(() => parseModelEntry(value)).toThrow(TypeError);
  });

  it.each([
    null,
    [],
    { fetched_at: 1, source: "test", models: [] },
    { fetched_at: null, source: 1, models: [] },
    { fetched_at: null, source: "test", models: {} },
    { fetched_at: null, source: "test", models: [], effort_levels: [1] },
  ])("rejects invalid vendor entries", (value) => {
    expect(() => parseVendorModels(value)).toThrow(TypeError);
  });

  it.each([null, [], { fake: [] }])("rejects invalid catalogs", (value) => {
    expect(() => parseModelCatalog(value)).toThrow(TypeError);
  });
});
