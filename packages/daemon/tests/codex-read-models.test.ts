import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  codexModelsCacheSource,
  createCodexAdapter,
  parseCodexModelsCache,
} from "../src/adapters/codex.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/codex/", import.meta.url));

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/** Isolated operator home for readModels; cleaned up after each test. */
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
    // hide / supported_in_api:false / missing flag must not appear
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
    // fetched_at wrong type → treated as absent
    expect(cacheFetchedAt).toBeNull();
  });
});

describe("codexModelsCacheSource", () => {
  it("surfaces the cache freshness stamp when present", () => {
    expect(codexModelsCacheSource("/tmp/x/models_cache.json", "2026-07-15T10:00:00.000Z")).toBe(
      "/tmp/x/models_cache.json (cache fetched_at=2026-07-15T10:00:00.000Z)",
    );
    expect(codexModelsCacheSource("/tmp/x/models_cache.json", null)).toBe(
      "/tmp/x/models_cache.json",
    );
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

  it("reads models_cache.json from the operator home (CODEX_HOME)", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      readFixture("models_cache.well-formed.json"),
    );
    const adapter = createCodexAdapter({ CODEX_HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.4-mini"]);
    expect(result.source).toContain(path.join(home, "models_cache.json"));
    expect(result.source).toContain("cache fetched_at=2026-07-15T10:00:00.000Z");
  });

  it("returns empty models when the cache file is missing (fresh home)", async () => {
    home = makeOperatorHome();
    const adapter = createCodexAdapter({ CODEX_HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toEqual([]);
    expect(result.source).toContain(path.join(home, "models_cache.json"));
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

  it("does not resolve a per-task isolated home", async () => {
    // Operator env has no CODEX_HOME; home is ~/.codex under HOME — never
    // something under a task cwd.
    home = makeOperatorHome();
    const taskCwd = path.join(home, "worktree");
    fs.mkdirSync(taskCwd);
    const adapter = createCodexAdapter({ HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.source).toContain(path.join(home, ".codex", "models_cache.json"));
    expect(result.source).not.toContain(taskCwd);
  });
});
