import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayVendorPath, refreshCatalog } from "@useparley/core";
import {
  createHermesAdapter,
  HERMES_HOME_REL,
  HERMES_MODEL_CATALOG_MAX_BYTES,
  HERMES_MODEL_CATALOG_REL,
  HERMES_PROVIDER_MODELS_CACHE_FILE,
  hermesModelsCatalogSource,
  hermesRowsToModelEntries,
  intersectHermesRowsWithProviderCache,
  parseHermesModelCatalog,
  parseHermesProviderModelsCache,
} from "../src/adapters/hermes.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/hermes/", import.meta.url));
const HYGIENE_SENTINEL = "PARLEY_FIXTURE_SENTINEL_MUST_NOT_LEAK";

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function makeOperatorHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parley-hermes-home-"));
}

/** Write model_catalog.json under home/cache/. */
function writeCatalog(home: string, fixtureName: string): void {
  const cacheDir = path.join(home, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "model_catalog.json"), readFixture(fixtureName));
}

describe("parseHermesModelCatalog", () => {
  it("maps well-formed catalog entries (41 openrouter + 32 nous = 73)", () => {
    const text = readFixture("model_catalog.well-formed.json");
    expect(text).toContain(HYGIENE_SENTINEL);
    const { models, rows, version, updatedAt, error } = parseHermesModelCatalog(text);
    expect(error).toBeNull();
    expect(version).toBe(1);
    expect(updatedAt).toBe("2026-07-15T12:00:00Z");
    expect(rows).toHaveLength(73);
    expect(models).toHaveLength(73);
    // Non-overlapping fixture ids survive by-id collapse at 73.
    expect(new Set(models.map((m) => m.id)).size).toBe(73);

    // Every hermes model has empty efforts and null default_effort.
    for (const m of models) {
      expect(m.efforts).toEqual([]);
      expect(m.default_effort).toBeNull();
    }

    // Per-provider default markers land in notes, never default_effort.
    const defaults = models.filter((m) => m.notes?.includes("default_for="));
    expect(defaults).toHaveLength(2);
    expect(defaults.every((m) => m.default_effort === null)).toBe(true);
    expect(defaults.some((m) => m.notes?.includes("default_for=openrouter"))).toBe(true);
    expect(defaults.some((m) => m.notes?.includes("default_for=nous"))).toBe(true);

    // Description surfaces via notes for openrouter default.
    const orDefault = models.find((m) => m.id === "openrouter/model-00");
    expect(orDefault?.notes).toContain("recommended");
    expect(orDefault?.notes).toContain("default_for=openrouter");
    expect(orDefault?.default_effort).toBeNull();
  });

  it("unions default_for across providers for the same model id (does not collapse providers)", () => {
    // Surveyed home: both openrouter and nous marked the *same* model id as
    // default. We emit one entry with both providers listed in notes — never
    // force either into default_effort.
    const { models, rows, error } = parseHermesModelCatalog(
      readFixture("model_catalog.shared-default.json"),
    );
    expect(error).toBeNull();
    expect(rows).toHaveLength(4);
    expect(models).toHaveLength(3); // shared id collapsed once
    const shared = models.find((m) => m.id === "shared/default-model");
    expect(shared).toBeDefined();
    expect(shared!.default_effort).toBeNull();
    expect(shared!.efforts).toEqual([]);
    expect(shared!.notes).toContain("default_for=openrouter,nous");
    // First non-empty description wins.
    expect(shared!.notes).toContain("recommended");
    expect(JSON.stringify(models)).not.toContain(HYGIENE_SENTINEL);
  });

  it("never surfaces co-located credential values (secret hygiene)", () => {
    const text = readFixture("model_catalog.well-formed.json");
    expect(text).toContain(HYGIENE_SENTINEL);
    const result = parseHermesModelCatalog(text);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(HYGIENE_SENTINEL);
    expect(serialized).not.toContain("api_key");
  });

  it("returns empty models for an empty-but-valid catalog", () => {
    const { models, rows, error } = parseHermesModelCatalog(
      readFixture("model_catalog.empty.json"),
    );
    expect(error).toBeNull();
    expect(models).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("flags malformed / truncated JSON as present-but-unusable", () => {
    expect(parseHermesModelCatalog(readFixture("model_catalog.malformed.json"))).toEqual({
      rows: [],
      models: [],
      version: null,
      updatedAt: null,
      error: "malformed model_catalog.json",
    });
    expect(parseHermesModelCatalog("not json at all")).toEqual({
      rows: [],
      models: [],
      version: null,
      updatedAt: null,
      error: "malformed model_catalog.json",
    });
    expect(JSON.stringify(parseHermesModelCatalog(readFixture("model_catalog.malformed.json")))).not.toContain(
      HYGIENE_SENTINEL,
    );
  });

  it("flags valid JSON with unexpected shape as present-but-unusable", () => {
    const { models, error } = parseHermesModelCatalog(
      readFixture("model_catalog.unexpected.json"),
    );
    expect(models).toEqual([]);
    expect(error).toBe("unexpected model_catalog.json shape");
    expect(JSON.stringify({ models, error })).not.toContain(HYGIENE_SENTINEL);
  });

  it("skips entries with empty ids and ignores unknown free-form fields", () => {
    const json = JSON.stringify({
      version: 1,
      updated_at: "t",
      providers: {
        openrouter: {
          models: [
            { id: "keep-me", description: "ok", extra: "ignored" },
            { id: "  ", description: "blank" },
            { id: "", description: "empty" },
            { not_id: "nope" },
            "not-an-object",
          ],
        },
      },
    });
    const { models, error } = parseHermesModelCatalog(json);
    expect(error).toBeNull();
    expect(models).toEqual([
      { id: "keep-me", efforts: [], default_effort: null, notes: "ok" },
    ]);
  });
});

describe("hermesModelsCatalogSource / displayVendorPath", () => {
  it("surfaces version and updated_at when present", () => {
    expect(
      hermesModelsCatalogSource("~/.hermes/cache/model_catalog.json", 1, "2026-07-15T12:00:00Z"),
    ).toBe("~/.hermes/cache/model_catalog.json (version=1, updated_at=2026-07-15T12:00:00Z)");
    expect(hermesModelsCatalogSource("~/.hermes/cache/model_catalog.json", null, null)).toBe(
      "~/.hermes/cache/model_catalog.json",
    );
  });

  it("tilde-collapses against os.homedir() when HOME is unset or empty", () => {
    const realHome = os.homedir();
    const abs = path.join(realHome, ".hermes", "cache", "model_catalog.json");
    expect(displayVendorPath(abs, {})).toBe("~/.hermes/cache/model_catalog.json");
    expect(displayVendorPath(abs, { HOME: "" })).toBe("~/.hermes/cache/model_catalog.json");
  });
});

describe("provider models cache cross-check", () => {
  it("parses provider_models_cache without leaking planted secrets or fingerprints into models", () => {
    const text = readFixture("provider_models_cache.well-formed.json");
    expect(text).toContain(HYGIENE_SENTINEL);
    const { byProvider, error } = parseHermesProviderModelsCache(text);
    expect(error).toBeNull();
    expect([...byProvider.keys()].sort()).toEqual(["nous", "openrouter"]);
    expect(byProvider.get("openrouter")?.has("openrouter/model-00")).toBe(true);
    // Map keys/values only — never re-serialize the raw file.
    const projected = JSON.stringify({
      providers: [...byProvider.keys()],
      sizes: [...byProvider.values()].map((s) => s.size),
    });
    expect(projected).not.toContain(HYGIENE_SENTINEL);
    expect(projected).not.toContain("deadbeef");
    expect(projected).not.toContain("api_key");
  });

  it("intersects per-provider when the cache is present", () => {
    const { rows } = parseHermesModelCatalog(readFixture("model_catalog.well-formed.json"));
    expect(rows).toHaveLength(73);
    const { byProvider } = parseHermesProviderModelsCache(
      readFixture("provider_models_cache.well-formed.json"),
    );
    const filtered = intersectHermesRowsWithProviderCache(rows, byProvider);
    // openrouter: 3 ids; nous: 2 ids → 5 rows before by-id collapse (all unique).
    expect(filtered).toHaveLength(5);
    const models = hermesRowsToModelEntries(filtered);
    expect(models).toHaveLength(5);
    expect(models.every((m) => m.efforts.length === 0 && m.default_effort === null)).toBe(true);
    expect(JSON.stringify(models)).not.toContain(HYGIENE_SENTINEL);
  });

  it("leaves the full catalog when the provider cache map is empty", () => {
    const { rows } = parseHermesModelCatalog(readFixture("model_catalog.well-formed.json"));
    expect(intersectHermesRowsWithProviderCache(rows, new Map())).toHaveLength(73);
  });

  it("keeps uncached providers fully when only one provider is in the cache", () => {
    const { rows } = parseHermesModelCatalog(readFixture("model_catalog.well-formed.json"));
    const byProvider = new Map<string, Set<string>>([
      ["openrouter", new Set(["openrouter/model-00"])],
    ]);
    const filtered = intersectHermesRowsWithProviderCache(rows, byProvider);
    // openrouter narrowed to 1; all 32 nous rows kept.
    expect(filtered.filter((r) => r.provider === "openrouter")).toHaveLength(1);
    expect(filtered.filter((r) => r.provider === "nous")).toHaveLength(32);
  });
});

describe("hermes adapter readModels", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("reads model_catalog.json from the operator home and tilde-collapses source", async () => {
    home = makeOperatorHome();
    const hermesDir = path.join(home, ".hermes");
    fs.mkdirSync(path.join(hermesDir, "cache"), { recursive: true });
    fs.writeFileSync(
      path.join(hermesDir, "cache", "model_catalog.json"),
      readFixture("model_catalog.well-formed.json"),
    );
    const adapter = createHermesAdapter({ HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toHaveLength(73);
    expect(result.models.every((m) => m.efforts.length === 0 && m.default_effort === null)).toBe(
      true,
    );
    expect(result.source).toBe(
      "~/.hermes/cache/model_catalog.json (version=1, updated_at=2026-07-15T12:00:00Z)",
    );
    expect(JSON.stringify(result)).not.toContain(HYGIENE_SENTINEL);
  });

  it("honours a genuine HERMES_HOME override outside the isolation markers", async () => {
    home = makeOperatorHome();
    writeCatalog(home, "model_catalog.well-formed.json");
    const adapter = createHermesAdapter({ HERMES_HOME: home, HOME: "/tmp/operator" });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toHaveLength(73);
    expect(result.source).toContain("model_catalog.json");
    expect(result.source).toContain("version=1");
  });

  it("intersects with provider_models_cache.json when present beside the home", async () => {
    home = makeOperatorHome();
    writeCatalog(home, "model_catalog.well-formed.json");
    fs.writeFileSync(
      path.join(home, HERMES_PROVIDER_MODELS_CACHE_FILE),
      readFixture("provider_models_cache.well-formed.json"),
    );
    const adapter = createHermesAdapter({ HERMES_HOME: home });
    const result = await adapter.readModels!(undefined);
    // 3 openrouter + 2 nous after per-provider intersection.
    expect(result.models).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain(HYGIENE_SENTINEL);
  });

  it("returns empty models when the catalog file is missing (fresh home)", async () => {
    home = makeOperatorHome();
    const adapter = createHermesAdapter({ HERMES_HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toEqual([]);
    expect(result.source).toContain(HERMES_MODEL_CATALOG_REL.replace(/\\/g, "/").split("/").pop());
  });

  it("rejects malformed catalog so refresh can warn", async () => {
    home = makeOperatorHome();
    writeCatalog(home, "model_catalog.malformed.json");
    const adapter = createHermesAdapter({ HERMES_HOME: home });
    await expect(adapter.readModels!(undefined)).rejects.toThrow(/malformed model_catalog/);
  });

  it("rejects without hanging when model_catalog.json is a FIFO (#288)", async () => {
    home = makeOperatorHome();
    const cacheDir = path.join(home, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const fifo = path.join(cacheDir, "model_catalog.json");
    execFileSync("mkfifo", [fifo]);
    const adapter = createHermesAdapter({ HERMES_HOME: home });
    const started = Date.now();
    await expect(adapter.readModels!(undefined)).rejects.toThrow(/not a regular file/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("refuses HERMES_HOME pointing at a per-task isolated home", async () => {
    home = makeOperatorHome();
    const taskCwd = path.join(home, "worktree");
    const isolated = path.join(taskCwd, HERMES_HOME_REL);
    fs.mkdirSync(path.join(isolated, "cache"), { recursive: true });
    fs.writeFileSync(
      path.join(isolated, "cache", "model_catalog.json"),
      JSON.stringify({
        version: 1,
        updated_at: "t",
        providers: {
          openrouter: { models: [{ id: "only-isolated" }] },
        },
      }),
    );
    const operatorHermes = path.join(home, ".hermes");
    fs.mkdirSync(operatorHermes, { recursive: true });

    const adapter = createHermesAdapter({
      HOME: home,
      HERMES_HOME: isolated,
    });
    const result = await adapter.readModels!(undefined);
    expect(result.models.map((m) => m.id)).not.toContain("only-isolated");
    expect(result.models).toEqual([]);
    expect(result.source).toContain(".hermes");
    expect(result.source).not.toContain(".parley");
  });
});

describe("refreshCatalog end-to-end: hermes disk → populated catalog", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("goes from empty shipped entry to a populated catalog via readModels alone", async () => {
    home = makeOperatorHome();
    writeCatalog(home, "model_catalog.well-formed.json");
    const adapter = createHermesAdapter({ HERMES_HOME: home });
    // Empty existing entry (mirrors the shipped hermes catalog models: []).
    const base = {
      hermes: {
        fetched_at: null as string | null,
        source: "docs/research/hermes-cli-automation.md",
        notes: "Interactive picker only.",
        models: [] as { id: string; efforts: string[]; default_effort: string | null }[],
      },
    };
    const { catalog, warnings } = await refreshCatalog(
      base,
      ["hermes"],
      new Map([["hermes", adapter]]),
      () => "2026-07-30T12:00:00.000Z",
    );
    expect(warnings).toEqual([]);
    expect(catalog.hermes!.models).toHaveLength(73);
    expect(catalog.hermes!.fetched_at).toBe("2026-07-30T12:00:00.000Z");
    expect(catalog.hermes!.source).toMatch(/model_catalog\.json/);
    expect(catalog.hermes!.source).toMatch(/version=1/);
    expect(catalog.hermes!.models.every((m) => m.efforts.length === 0)).toBe(true);
    expect(catalog.hermes!.models.every((m) => m.default_effort === null)).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain(HYGIENE_SENTINEL);
  });

  it("warns on malformed catalog and falls through to shipped/existing empty", async () => {
    home = makeOperatorHome();
    writeCatalog(home, "model_catalog.malformed.json");
    const adapter = createHermesAdapter({ HERMES_HOME: home });
    const { catalog, warnings } = await refreshCatalog(
      {},
      ["hermes"],
      new Map([["hermes", adapter]]),
    );
    // No probe, empty existing → shipped fallback warning wording path.
    expect(warnings.some((w) => /disk read failed.*malformed/i.test(w))).toBe(true);
    // Shipped hermes entry has empty models.
    expect(catalog.hermes?.models ?? []).toEqual([]);
  });

  it("stays quiet when the catalog file is absent (fresh home)", async () => {
    home = makeOperatorHome();
    const adapter = createHermesAdapter({ HERMES_HOME: home });
    const { warnings } = await refreshCatalog({}, ["hermes"], new Map([["hermes", adapter]]));
    // Empty disk is normal — warning is "returned no models" fallback, not a crash.
    expect(warnings.some((w) => /disk read failed/i.test(w))).toBe(false);
  });

  it("warns when model_catalog.json exceeds the size cap", async () => {
    home = makeOperatorHome();
    const cacheDir = path.join(home, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const catalogPath = path.join(cacheDir, "model_catalog.json");
    const fd = fs.openSync(catalogPath, "w");
    try {
      fs.ftruncateSync(fd, HERMES_MODEL_CATALOG_MAX_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    const adapter = createHermesAdapter({ HERMES_HOME: home });
    const { warnings } = await refreshCatalog({}, ["hermes"], new Map([["hermes", adapter]]));
    expect(warnings.some((w) => /disk read failed.*size cap/i.test(w))).toBe(true);
  });

  it("warns when model_catalog.json is a FIFO without hanging (#288)", async () => {
    home = makeOperatorHome();
    const cacheDir = path.join(home, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const fifo = path.join(cacheDir, "model_catalog.json");
    execFileSync("mkfifo", [fifo]);
    const adapter = createHermesAdapter({ HERMES_HOME: home });
    const started = Date.now();
    const { warnings } = await refreshCatalog({}, ["hermes"], new Map([["hermes", adapter]]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(warnings.some((w) => /disk read failed.*not a regular file/i.test(w))).toBe(true);
  });
});
