import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refreshCatalog } from "@useparley/core";
import {
  codexModelsCacheSource,
  createCodexAdapter,
  displayVendorPath,
  parseCodexModels,
  parseCodexModelsCache,
} from "../src/adapters/codex.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/codex/", import.meta.url));
const CLI_CODEX_FIXTURE = fileURLToPath(
  new URL("../../cli/tests/fixtures/codex/debug-models.json", import.meta.url),
);

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function makeOperatorHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parley-codex-home-"));
}

describe("parseCodexModelsCache", () => {
  it("maps well-formed cache entries and applies visibility/supported_in_api filters", () => {
    const { models, cacheFetchedAt } = parseCodexModelsCache(
      readFixture("models_cache.well-formed.json"),
    );
    expect(cacheFetchedAt).toBe("2026-07-15T10:00:00.000Z");
    expect(models).toEqual([
      {
        id: "gpt-5.6-sol",
        efforts: ["low", "medium", "high", "xhigh"],
        default_effort: "medium",
      },
      {
        id: "gpt-5.4-mini",
        efforts: ["low", "medium"],
        default_effort: "low",
      },
    ]);
    expect(models.map((m) => m.id)).not.toContain("codex-auto-review");
    expect(models.map((m) => m.id)).not.toContain("internal-not-in-api");
    expect(models.map((m) => m.id)).not.toContain("missing-api-flag");
  });

  it("returns empty models for an empty-but-valid cache (fresh home)", () => {
    const { models, cacheFetchedAt } = parseCodexModelsCache(
      readFixture("models_cache.empty.json"),
    );
    expect(models).toEqual([]);
    expect(cacheFetchedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("fails soft on malformed / truncated JSON", () => {
    expect(parseCodexModelsCache(readFixture("models_cache.malformed.json"))).toEqual({
      models: [],
      cacheFetchedAt: null,
    });
    expect(parseCodexModelsCache("not json at all")).toEqual({
      models: [],
      cacheFetchedAt: null,
    });
  });

  it("fails soft on valid JSON with unexpected shape", () => {
    const { models, cacheFetchedAt } = parseCodexModelsCache(
      readFixture("models_cache.unexpected.json"),
    );
    expect(models).toEqual([]);
    expect(cacheFetchedAt).toBeNull();
  });
});

describe("parseCodexModels (probe) shares the disk filter (finding 3)", () => {
  it("drops hide, supported_in_api:false, and missing supported_in_api", () => {
    const models = parseCodexModels(fs.readFileSync(CLI_CODEX_FIXTURE, "utf8"));
    expect(models.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.4-mini"]);
    expect(models.map((m) => m.id)).not.toContain("codex-auto-review");
    expect(models.map((m) => m.id)).not.toContain("internal-not-in-api");
    expect(models.map((m) => m.id)).not.toContain("missing-api-flag");
  });
});

describe("refreshCatalog merge does not re-admit filtered codex ids (finding 3)", () => {
  it("union of disk cache + probe stays free of excluded ids", async () => {
    const cacheJson = readFixture("models_cache.well-formed.json");
    const probeJson = fs.readFileSync(CLI_CODEX_FIXTURE, "utf8");
    const disk = parseCodexModelsCache(cacheJson).models;
    const probe = parseCodexModels(probeJson);
    // Sanity: both parsers agree on the allowed set.
    expect(disk.map((m) => m.id).sort()).toEqual(probe.map((m) => m.id).sort());

    const adapters = new Map([
      [
        "codex",
        {
          readModels: () =>
            Promise.resolve({ source: "~/.codex/models_cache.json", models: disk }),
          listModels: () =>
            Promise.resolve({ source: "codex debug models", models: probe }),
        },
      ],
    ]);
    const { catalog } = await refreshCatalog({}, ["codex"], adapters, () => "t");
    const ids = catalog.codex!.models.map((m) => m.id);
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("gpt-5.4-mini");
    expect(ids).not.toContain("internal-not-in-api");
    expect(ids).not.toContain("missing-api-flag");
    expect(ids).not.toContain("codex-auto-review");
  });
});

describe("codexModelsCacheSource / displayVendorPath", () => {
  it("surfaces the cache freshness stamp when present", () => {
    expect(codexModelsCacheSource("~/.codex/models_cache.json", "2026-07-15T10:00:00.000Z")).toBe(
      "~/.codex/models_cache.json (cache fetched_at=2026-07-15T10:00:00.000Z)",
    );
  });

  it("collapses absolute paths under HOME to tilde form (finding 11)", () => {
    expect(
      displayVendorPath("/tmp/operator/.codex/models_cache.json", { HOME: "/tmp/operator" }),
    ).toBe("~/.codex/models_cache.json");
  });
});

describe("codex adapter readModels", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("reads models_cache.json from the operator home and tilde-collapses source", async () => {
    home = makeOperatorHome();
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "models_cache.json"),
      readFixture("models_cache.well-formed.json"),
    );
    // Default path under HOME (no CODEX_HOME) so source collapses to ~/.codex/…
    const adapter = createCodexAdapter({ HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.4-mini"]);
    expect(result.source).toBe(
      "~/.codex/models_cache.json (cache fetched_at=2026-07-15T10:00:00.000Z)",
    );
  });

  it("honours a genuine CODEX_HOME override outside the isolation markers", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      readFixture("models_cache.well-formed.json"),
    );
    const adapter = createCodexAdapter({ CODEX_HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.4-mini"]);
    expect(result.source).toContain("models_cache.json");
  });

  it("returns empty models when the cache file is missing (fresh home)", async () => {
    home = makeOperatorHome();
    const adapter = createCodexAdapter({ CODEX_HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toEqual([]);
  });

  it("returns empty models on malformed cache without throwing", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      readFixture("models_cache.malformed.json"),
    );
    const adapter = createCodexAdapter({ CODEX_HOME: home });
    await expect(adapter.readModels!(undefined)).resolves.toMatchObject({ models: [] });
  });
});
