import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKimiAdapter,
  kimiModelsConfigSource,
  parseKimiModelsConfig,
} from "../src/adapters/kimi.js";
import { parseToml } from "../src/adapters/toml.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/kimi/", import.meta.url));
const HYGIENE_SENTINEL = "PARLEY_FIXTURE_SENTINEL_MUST_NOT_LEAK";

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function makeOperatorHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parley-kimi-home-"));
}

describe("parseKimiModelsConfig", () => {
  it("extracts [models.*] tables and default_model from a well-formed config", () => {
    const text = readFixture("config.well-formed.toml");
    const { models, defaultModel } = parseKimiModelsConfig(text);
    expect(defaultModel).toBe("kimi-code/kimi-for-coding");
    expect(models).toEqual([
      {
        id: "kimi-code/k3",
        efforts: ["low", "high", "max"],
        default_effort: "high",
        notes: "max_context_size=1048576",
      },
      {
        id: "kimi-code/kimi-for-coding",
        efforts: ["low", "high"],
        default_effort: "low",
      },
      {
        id: "kimi-code/extra",
        efforts: [],
        default_effort: null,
      },
    ]);
  });

  it("never surfaces co-located credential values (secret hygiene)", () => {
    const text = readFixture("config.well-formed.toml");
    expect(text).toContain(HYGIENE_SENTINEL); // fixture still has the sentinel
    const { models, defaultModel } = parseKimiModelsConfig(text);
    const serialized = JSON.stringify({ models, defaultModel });
    expect(serialized).not.toContain(HYGIENE_SENTINEL);
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("providers");
  });

  it("returns empty models for an empty-but-valid config (fresh home)", () => {
    expect(parseKimiModelsConfig(readFixture("config.empty.toml"))).toEqual({
      models: [],
      defaultModel: null,
    });
  });

  it("fails soft on malformed / truncated TOML", () => {
    const result = parseKimiModelsConfig(readFixture("config.malformed.toml"));
    // May recover partial keys, but must not throw; never includes sentinel.
    expect(Array.isArray(result.models)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(HYGIENE_SENTINEL);
  });

  it("returns empty models for valid TOML with unexpected shape", () => {
    const { models, defaultModel } = parseKimiModelsConfig(
      readFixture("config.unexpected.toml"),
    );
    expect(models).toEqual([]);
    expect(defaultModel).toBeNull();
  });
});

describe("kimiModelsConfigSource", () => {
  it("surfaces default_model when present (model id, not a secret)", () => {
    expect(kimiModelsConfigSource("/tmp/x/config.toml", "kimi-code/k3")).toBe(
      "/tmp/x/config.toml (default_model=kimi-code/k3)",
    );
    expect(kimiModelsConfigSource("/tmp/x/config.toml", null)).toBe("/tmp/x/config.toml");
  });
});

describe("parseToml table headers with quoted model ids", () => {
  it("nests models.\"id\" under models[id]", () => {
    const root = parseToml(`[models."kimi-code/k3"]\nsupport_efforts = [ "low" ]\n`);
    expect(root.models).toBeDefined();
    const models = root.models as Record<string, unknown>;
    expect(models["kimi-code/k3"]).toMatchObject({ support_efforts: ["low"] });
  });
});

describe("kimi adapter readModels", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("reads config.toml from the operator home (KIMI_CODE_HOME)", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(path.join(home, "config.toml"), readFixture("config.well-formed.toml"));
    const adapter = createKimiAdapter({ KIMI_CODE_HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models.map((m) => m.id)).toEqual([
      "kimi-code/k3",
      "kimi-code/kimi-for-coding",
      "kimi-code/extra",
    ]);
    expect(result.source).toContain(path.join(home, "config.toml"));
    expect(result.source).toContain("default_model=kimi-code/kimi-for-coding");
    // Hygiene: result must not carry the credential sentinel.
    expect(JSON.stringify(result)).not.toContain(HYGIENE_SENTINEL);
  });

  it("returns empty models when config.toml is missing", async () => {
    home = makeOperatorHome();
    const adapter = createKimiAdapter({ KIMI_CODE_HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toEqual([]);
  });

  it("returns empty models on malformed config without throwing", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(path.join(home, "config.toml"), readFixture("config.malformed.toml"));
    const adapter = createKimiAdapter({ KIMI_CODE_HOME: home });
    await expect(adapter.readModels!(undefined)).resolves.toMatchObject({
      models: expect.any(Array),
    });
  });

  it("does not resolve the isolated per-task KIMI_CODE_HOME under task cwd", async () => {
    home = makeOperatorHome();
    const taskCwd = path.join(home, "worktree");
    const isolated = path.join(taskCwd, ".parley-kimi");
    fs.mkdirSync(isolated, { recursive: true });
    fs.writeFileSync(
      path.join(isolated, "config.toml"),
      'default_model = "from-isolated"\n[models."only-isolated"]\nsupport_efforts = [ "low" ]\n',
    );
    // Operator home is HOME/.kimi-code (empty) — not the isolated tree.
    const adapter = createKimiAdapter({ HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models.map((m) => m.id)).not.toContain("only-isolated");
    expect(result.source).toContain(path.join(home, ".kimi-code", "config.toml"));
    expect(result.source).not.toContain(".parley-kimi");
  });
});
