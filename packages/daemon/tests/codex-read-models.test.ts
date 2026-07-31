import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayVendorPath, refreshCatalog } from "@useparley/core";
import {
  CODEX_MODELS_CACHE_MAX_BYTES,
  codexModelsCacheSource,
  createCodexAdapter,
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
    const { models, cacheFetchedAt, error } = parseCodexModelsCache(
      readFixture("models_cache.well-formed.json"),
    );
    expect(error).toBeNull();
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
    const { models, cacheFetchedAt, error } = parseCodexModelsCache(
      readFixture("models_cache.empty.json"),
    );
    expect(error).toBeNull();
    expect(models).toEqual([]);
    expect(cacheFetchedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("flags malformed / truncated JSON as present-but-unusable", () => {
    expect(parseCodexModelsCache(readFixture("models_cache.malformed.json"))).toEqual({
      models: [],
      cacheFetchedAt: null,
      error: "malformed models_cache.json",
    });
    expect(parseCodexModelsCache("not json at all")).toEqual({
      models: [],
      cacheFetchedAt: null,
      error: "malformed models_cache.json",
    });
  });

  it("flags valid JSON with unexpected shape as present-but-unusable", () => {
    const { models, cacheFetchedAt, error } = parseCodexModelsCache(
      readFixture("models_cache.unexpected.json"),
    );
    expect(models).toEqual([]);
    expect(cacheFetchedAt).toBeNull();
    expect(error).toBe("unexpected models_cache.json shape");
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

  it("tilde-collapses against os.homedir() when HOME is unset or empty", () => {
    // Must not write /home/<user>/… into models.json when HOME is scrubbed.
    const realHome = os.homedir();
    const abs = path.join(realHome, ".codex", "models_cache.json");
    expect(displayVendorPath(abs, {})).toBe("~/.codex/models_cache.json");
    expect(displayVendorPath(abs, { HOME: "" })).toBe("~/.codex/models_cache.json");
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

  it("rejects malformed cache so refresh can warn", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      readFixture("models_cache.malformed.json"),
    );
    const adapter = createCodexAdapter({ CODEX_HOME: home });
    await expect(adapter.readModels!(undefined)).rejects.toThrow(/malformed models_cache/);
  });

  it("refuses CODEX_HOME pointing at a per-task isolated home (isolation guard)", async () => {
    // Shared resolver refuses isolation-marker paths on every override env,
    // including research-only CODEX_HOME. Decy cache under the marker must
    // not be read; fall back to operator HOME/.codex (empty here).
    home = makeOperatorHome();
    const taskCwd = path.join(home, "worktree");
    const isolated = path.join(taskCwd, ".parley-kimi");
    fs.mkdirSync(isolated, { recursive: true });
    fs.writeFileSync(
      path.join(isolated, "models_cache.json"),
      JSON.stringify({
        fetched_at: "2026-07-01T00:00:00.000Z",
        models: [
          {
            slug: "only-isolated",
            visibility: "list",
            supported_in_api: true,
            supported_reasoning_levels: [{ effort: "low" }],
            default_reasoning_level: "low",
          },
        ],
      }),
    );
    const operatorCodex = path.join(home, ".codex");
    fs.mkdirSync(operatorCodex, { recursive: true });

    const adapter = createCodexAdapter({
      HOME: home,
      CODEX_HOME: isolated,
    });
    const result = await adapter.readModels!(undefined);
    expect(result.models.map((m) => m.id)).not.toContain("only-isolated");
    expect(result.models).toEqual([]);
    expect(result.source).toContain(".codex");
    expect(result.source).not.toContain(".parley-kimi");
  });
});

describe("refreshCatalog end-to-end: degraded disk reads warn (finding 4 / round 2)", () => {
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
        source: "codex debug models",
        models: [{ id: "from-probe", efforts: [] as string[], default_effort: null }],
      }),
  };

  it("warns on malformed cache even when the probe succeeds", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      readFixture("models_cache.malformed.json"),
    );
    const adapter = { ...createCodexAdapter({ CODEX_HOME: home }), ...probeOk };
    const { catalog, warnings } = await refreshCatalog({}, ["codex"], new Map([["codex", adapter]]));
    expect(catalog.codex!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*malformed/i.test(w))).toBe(true);
  });

  it("warns on unexpected shape even when the probe succeeds", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      readFixture("models_cache.unexpected.json"),
    );
    const adapter = { ...createCodexAdapter({ CODEX_HOME: home }), ...probeOk };
    const { warnings } = await refreshCatalog({}, ["codex"], new Map([["codex", adapter]]));
    expect(warnings.some((w) => /disk read failed.*unexpected/i.test(w))).toBe(true);
  });

  it("stays quiet when the cache file is absent (fresh home)", async () => {
    home = makeOperatorHome();
    const adapter = { ...createCodexAdapter({ CODEX_HOME: home }), ...probeOk };
    const { catalog, warnings } = await refreshCatalog({}, ["codex"], new Map([["codex", adapter]]));
    expect(catalog.codex!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings).toEqual([]);
  });

  it("warns when models_cache.json exceeds the size cap", async () => {
    home = makeOperatorHome();
    // Sparse file: size reported as over the cap without writing gigabytes.
    const cachePath = path.join(home, "models_cache.json");
    const fd = fs.openSync(cachePath, "w");
    try {
      fs.ftruncateSync(fd, CODEX_MODELS_CACHE_MAX_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    const adapter = { ...createCodexAdapter({ CODEX_HOME: home }), ...probeOk };
    const { catalog, warnings } = await refreshCatalog({}, ["codex"], new Map([["codex", adapter]]));
    expect(catalog.codex!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*size cap/i.test(w))).toBe(true);
  });
});
