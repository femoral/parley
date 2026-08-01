import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayVendorPath, mergeDiscoveredModels, refreshCatalog } from "@useparley/core";
import {
  createGrokAdapter,
  GROK_CONFIG_MAX_BYTES,
  GROK_MODELS_CACHE_MAX_BYTES,
  grokModelsCacheSource,
  mergeGrokDiskModels,
  parseGrokModels,
  parseGrokModelsCache,
  parseGrokModelsConfig,
} from "../src/adapters/grok.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/grok/", import.meta.url));
const HYGIENE_SENTINEL = "PARLEY_FIXTURE_SENTINEL_MUST_NOT_LEAK";

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function makeOperatorHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parley-grok-home-"));
}

describe("parseGrokModelsCache", () => {
  it("maps well-formed cache entries and applies hidden/supported_in_api filters", () => {
    const { models, cacheFetchedAt, error } = parseGrokModelsCache(
      readFixture("models_cache.well-formed.json"),
    );
    expect(error).toBeNull();
    expect(cacheFetchedAt).toBe("2026-07-15T10:00:00.000Z");
    expect(models).toEqual([
      {
        id: "grok-4.5",
        efforts: ["high", "medium", "low"],
        default_effort: "high",
        label: "Grok 4.5",
      },
    ]);
    const ids = models.map((m) => m.id);
    expect(ids).not.toContain("hidden-model");
    expect(ids).not.toContain("internal-not-in-api");
    expect(ids).not.toContain("missing-api-flag");
  });

  it("never surfaces co-located api_key values (secret hygiene)", () => {
    const text = readFixture("models_cache.well-formed.json");
    expect(text).toContain(HYGIENE_SENTINEL);
    const { models } = parseGrokModelsCache(text);
    const serialized = JSON.stringify(models);
    expect(serialized).not.toContain(HYGIENE_SENTINEL);
    expect(serialized).not.toContain("api_key");
  });

  it("returns empty models for an empty-but-valid cache (fresh home)", () => {
    const { models, cacheFetchedAt, error } = parseGrokModelsCache(
      readFixture("models_cache.empty.json"),
    );
    expect(error).toBeNull();
    expect(models).toEqual([]);
    expect(cacheFetchedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("flags malformed / truncated JSON as present-but-unusable", () => {
    expect(parseGrokModelsCache(readFixture("models_cache.malformed.json"))).toEqual({
      models: [],
      cacheFetchedAt: null,
      error: "malformed models_cache.json",
    });
    expect(parseGrokModelsCache("not json at all")).toEqual({
      models: [],
      cacheFetchedAt: null,
      error: "malformed models_cache.json",
    });
  });

  it("flags valid JSON with unexpected shape as present-but-unusable", () => {
    const { models, cacheFetchedAt, error } = parseGrokModelsCache(
      readFixture("models_cache.unexpected.json"),
    );
    expect(models).toEqual([]);
    expect(cacheFetchedAt).toBe("2026-07-15T10:00:00.000Z");
    expect(error).toBe("unexpected models_cache.json shape");
  });
});

describe("parseGrokModelsConfig", () => {
  it("extracts [model.*] tables including quoted dotted ids", () => {
    const text = readFixture("config.well-formed.toml");
    const { models, defaultModel, error } = parseGrokModelsConfig(text);
    expect(error).toBeNull();
    expect(defaultModel).toBe("grok-4.5");
    expect(models.map((m) => m.id).sort()).toEqual(
      ["byok-custom", "grok-4.5-build", "grok-build"].sort(),
    );
    for (const m of models) {
      expect(m.efforts).toEqual([]);
      expect(m.default_effort).toBeNull();
    }
  });

  it("never surfaces co-located env_key / api_key values (secret hygiene)", () => {
    const text = readFixture("config.well-formed.toml");
    expect(text).toContain(HYGIENE_SENTINEL);
    const { models, defaultModel, error } = parseGrokModelsConfig(text);
    const serialized = JSON.stringify({ models, defaultModel, error });
    expect(serialized).not.toContain(HYGIENE_SENTINEL);
    expect(serialized).not.toContain("env_key");
    expect(serialized).not.toContain("api_key");
  });

  it("returns empty models when config has no [model.*] tables", () => {
    expect(parseGrokModelsConfig(readFixture("config.empty.toml"))).toEqual({
      models: [],
      defaultModel: "grok-4.5",
      error: null,
    });
  });

  it("flags malformed / truncated TOML as present-but-unusable", () => {
    const result = parseGrokModelsConfig(readFixture("config.malformed.toml"));
    expect(result.models).toEqual([]);
    expect(result.error).toMatch(/malformed config\.toml/);
    expect(JSON.stringify(result)).not.toContain(HYGIENE_SENTINEL);
  });
});

describe("mergeGrokDiskModels (cache + config union)", () => {
  it("unions cache and config ids; cache wins same-id", () => {
    const cache = parseGrokModelsCache(readFixture("models_cache.well-formed.json")).models;
    const config = parseGrokModelsConfig(readFixture("config.well-formed.toml")).models;
    const merged = mergeGrokDiskModels(cache, config);
    const ids = merged.map((m) => m.id);
    expect(ids).toContain("grok-4.5");
    expect(ids).toContain("grok-build");
    expect(ids).toContain("grok-4.5-build");
    expect(ids).toContain("byok-custom");
    const main = merged.find((m) => m.id === "grok-4.5")!;
    expect(main.efforts).toEqual(["high", "medium", "low"]);
    expect(main.default_effort).toBe("high");
  });
});

describe("union(probe, disk) is a superset of probe (#282 hard contract)", () => {
  it("disk+probe merge never drops probe ids", () => {
    const disk = mergeGrokDiskModels(
      parseGrokModelsCache(readFixture("models_cache.well-formed.json")).models,
      parseGrokModelsConfig(readFixture("config.well-formed.toml")).models,
    );
    // Probe-shaped listing: includes cache model plus an id only the text probe would see.
    const probeText = [
      "Available models:",
      "  * grok-4.5 (default)",
      "  - grok-probe-only",
    ].join("\n");
    const probe = parseGrokModels(probeText, undefined);
    const merged = mergeDiscoveredModels(
      { source: "disk", models: disk },
      { source: "grok models", models: probe },
    );
    expect(merged).not.toBeNull();
    const ids = new Set(merged!.models.map((m) => m.id));
    for (const m of probe) {
      expect(ids.has(m.id)).toBe(true);
    }
    // Disk-only variants still present.
    expect(ids.has("grok-build")).toBe(true);
    // Filtered cache ids still excluded.
    expect(ids.has("hidden-model")).toBe(false);
    expect(ids.has("internal-not-in-api")).toBe(false);
  });
});

describe("grokModelsCacheSource / displayVendorPath", () => {
  it("surfaces the cache freshness stamp when present", () => {
    expect(grokModelsCacheSource("~/.grok/models_cache.json", "2026-07-15T10:00:00.000Z")).toBe(
      "~/.grok/models_cache.json (cache fetched_at=2026-07-15T10:00:00.000Z)",
    );
  });

  it("tilde-collapses against os.homedir() when HOME is unset or empty", () => {
    const realHome = os.homedir();
    const abs = path.join(realHome, ".grok", "models_cache.json");
    expect(displayVendorPath(abs, {})).toBe("~/.grok/models_cache.json");
    expect(displayVendorPath(abs, { HOME: "" })).toBe("~/.grok/models_cache.json");
  });
});

describe("grok adapter readModels", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("merges models_cache.json and config.toml from the operator home", async () => {
    home = makeOperatorHome();
    const grokDir = path.join(home, ".grok");
    fs.mkdirSync(grokDir, { recursive: true });
    fs.writeFileSync(
      path.join(grokDir, "models_cache.json"),
      readFixture("models_cache.well-formed.json"),
    );
    fs.writeFileSync(path.join(grokDir, "config.toml"), readFixture("config.well-formed.toml"));
    const adapter = createGrokAdapter({ HOME: home });
    const result = await adapter.readModels!(undefined);
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("grok-4.5");
    expect(ids).toContain("grok-build");
    expect(ids).toContain("grok-4.5-build");
    expect(ids).not.toContain("hidden-model");
    expect(result.source).toContain("models_cache.json");
    expect(result.source).toContain("config.toml");
    expect(JSON.stringify(result)).not.toContain(HYGIENE_SENTINEL);
  });

  it("honours a genuine GROK_HOME override", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      readFixture("models_cache.well-formed.json"),
    );
    const adapter = createGrokAdapter({ GROK_HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models.map((m) => m.id)).toContain("grok-4.5");
    expect(result.source).toContain("models_cache.json");
  });

  it("returns empty models when both files are missing (fresh home)", async () => {
    home = makeOperatorHome();
    const adapter = createGrokAdapter({ GROK_HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toEqual([]);
  });

  it("rejects malformed cache so refresh can warn", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      readFixture("models_cache.malformed.json"),
    );
    const adapter = createGrokAdapter({ GROK_HOME: home });
    await expect(adapter.readModels!(undefined)).rejects.toThrow(/malformed models_cache/);
  });

  it("rejects without hanging when models_cache.json is a FIFO (#288)", async () => {
    home = makeOperatorHome();
    const fifo = path.join(home, "models_cache.json");
    execFileSync("mkfifo", [fifo]);
    const adapter = createGrokAdapter({ GROK_HOME: home });
    const started = Date.now();
    await expect(adapter.readModels!(undefined)).rejects.toThrow(/not a regular file/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("refreshCatalog end-to-end: degraded grok disk reads warn", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  const probeOk = {
    listModels: () =>
      Promise.resolve({
        source: "grok models",
        models: [{ id: "from-probe", efforts: [] as string[], default_effort: null }],
      }),
  };

  it("warns on malformed cache even when the probe succeeds", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      readFixture("models_cache.malformed.json"),
    );
    const adapter = { ...createGrokAdapter({ GROK_HOME: home }), ...probeOk };
    const { catalog, warnings } = await refreshCatalog({}, ["grok"], new Map([["grok", adapter]]));
    expect(catalog.grok!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*malformed/i.test(w))).toBe(true);
    expect(JSON.stringify(warnings)).not.toContain(HYGIENE_SENTINEL);
  });

  it("stays quiet when both files are absent (fresh home)", async () => {
    home = makeOperatorHome();
    const adapter = { ...createGrokAdapter({ GROK_HOME: home }), ...probeOk };
    const { catalog, warnings } = await refreshCatalog({}, ["grok"], new Map([["grok", adapter]]));
    expect(catalog.grok!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings).toEqual([]);
  });

  it("warns when models_cache.json exceeds the size cap", async () => {
    home = makeOperatorHome();
    const cachePath = path.join(home, "models_cache.json");
    const fd = fs.openSync(cachePath, "w");
    try {
      fs.ftruncateSync(fd, GROK_MODELS_CACHE_MAX_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    const adapter = { ...createGrokAdapter({ GROK_HOME: home }), ...probeOk };
    const { catalog, warnings } = await refreshCatalog({}, ["grok"], new Map([["grok", adapter]]));
    expect(catalog.grok!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*size cap/i.test(w))).toBe(true);
  });

  it("warns when models_cache.json is a FIFO without hanging (#288)", async () => {
    home = makeOperatorHome();
    const fifo = path.join(home, "models_cache.json");
    execFileSync("mkfifo", [fifo]);
    const adapter = { ...createGrokAdapter({ GROK_HOME: home }), ...probeOk };
    const started = Date.now();
    const { catalog, warnings } = await refreshCatalog({}, ["grok"], new Map([["grok", adapter]]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(catalog.grok!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*not a regular file/i.test(w))).toBe(true);
  });

  it("warns when config.toml exceeds the size cap", async () => {
    home = makeOperatorHome();
    // Valid empty cache so the path fails on config, not cache.
    fs.writeFileSync(path.join(home, "models_cache.json"), readFixture("models_cache.empty.json"));
    const configPath = path.join(home, "config.toml");
    const fd = fs.openSync(configPath, "w");
    try {
      fs.ftruncateSync(fd, GROK_CONFIG_MAX_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    const adapter = { ...createGrokAdapter({ GROK_HOME: home }), ...probeOk };
    const { warnings } = await refreshCatalog({}, ["grok"], new Map([["grok", adapter]]));
    expect(warnings.some((w) => /disk read failed.*size cap/i.test(w))).toBe(true);
  });
});
