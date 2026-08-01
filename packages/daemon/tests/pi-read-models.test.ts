import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayVendorPath, mergeDiscoveredModels, refreshCatalog } from "@useparley/core";
import {
  applyPiSettingsDefaults,
  createPiAdapter,
  parsePiModels,
  parsePiModelsStore,
  parsePiSettings,
  PI_MODELS_STORE_MAX_BYTES,
  piModelsStoreSource,
} from "../src/adapters/pi.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/pi/", import.meta.url));
const HYGIENE_SENTINEL = "PARLEY_FIXTURE_SENTINEL_MUST_NOT_LEAK";

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function makeOperatorHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parley-pi-home-"));
}

describe("parsePiModelsStore", () => {
  it("maps provider/model ids and thinkingLevelMap keys as efforts", () => {
    const { models, error } = parsePiModelsStore(readFixture("models-store.well-formed.json"));
    expect(error).toBeNull();
    const byId = new Map(models.map((m) => [m.id, m]));
    expect(byId.get("openai-codex/gpt-5.5")).toMatchObject({
      id: "openai-codex/gpt-5.5",
      efforts: expect.arrayContaining(["xhigh", "minimal", "high"]),
      default_effort: null,
      label: "GPT-5.5",
    });
    expect(byId.get("anthropic/claude-sonnet-4-5")!.efforts).toEqual(["low", "high"]);
  });

  it("gives empty efforts when thinkingLevelMap is absent or empty (not the hardcoded constant)", () => {
    const { models } = parsePiModelsStore(readFixture("models-store.well-formed.json"));
    const noMap = models.find((m) => m.id === "openai-codex/gpt-5.4-mini")!;
    const emptyMap = models.find((m) => m.id === "openai-codex/gpt-no-map")!;
    expect(noMap.efforts).toEqual([]);
    expect(emptyMap.efforts).toEqual([]);
    // Probe applies the fixed thinking-level constant; disk must not.
    const probe = parsePiModels(
      "provider model context max-out thinking images\nopenai-codex gpt-5.4-mini 272K 128K yes yes\n",
    );
    expect(probe[0]!.efforts.length).toBeGreaterThan(0);
    expect(noMap.efforts).not.toEqual(probe[0]!.efforts);
  });

  it("returns empty models for an empty-but-valid store", () => {
    expect(parsePiModelsStore(readFixture("models-store.empty.json"))).toEqual({
      models: [],
      error: null,
    });
  });

  it("flags malformed / truncated JSON as present-but-unusable", () => {
    expect(parsePiModelsStore(readFixture("models-store.malformed.json"))).toEqual({
      models: [],
      error: "malformed models-store.json",
    });
  });

  it("flags unexpected shape as present-but-unusable", () => {
    expect(parsePiModelsStore(readFixture("models-store.unexpected.json"))).toEqual({
      models: [],
      error: "unexpected models-store.json shape",
    });
  });
});

describe("parsePiSettings / applyPiSettingsDefaults", () => {
  it("projects defaults only (no extension path leak)", () => {
    const text = readFixture("settings.well-formed.json");
    expect(text).toContain(HYGIENE_SENTINEL);
    const settings = parsePiSettings(text);
    expect(settings.error).toBeNull();
    expect(settings.defaultProvider).toBe("openai-codex");
    expect(settings.defaultModel).toBe("gpt-5.5");
    expect(settings.defaultThinkingLevel).toBe("high");
    expect(JSON.stringify(settings)).not.toContain(HYGIENE_SENTINEL);
    expect(JSON.stringify(settings)).not.toContain("extensions");
  });

  it("sets default_effort only on the default model when the level is in its efforts", () => {
    const { models } = parsePiModelsStore(readFixture("models-store.well-formed.json"));
    const settings = parsePiSettings(readFixture("settings.well-formed.json"));
    const applied = applyPiSettingsDefaults(models, settings);
    const def = applied.find((m) => m.id === "openai-codex/gpt-5.5")!;
    const other = applied.find((m) => m.id === "anthropic/claude-sonnet-4-5")!;
    expect(def.default_effort).toBe("high");
    expect(other.default_effort).toBeNull();
  });
});

describe("union(probe, disk) is a superset of probe (#282 hard contract)", () => {
  it("disk+probe merge never drops probe ids; empty disk efforts do not wipe probe efforts", () => {
    const disk = parsePiModelsStore(readFixture("models-store.well-formed.json")).models;
    const probeText = [
      "provider      model                         context  max-out  thinking  images",
      "openai-codex  gpt-5.5                       272K     128K     yes       yes",
      "openai-codex  gpt-5.4-mini                  272K     128K     yes       yes",
      "probe-only    only-in-probe                 128K     32K      no        no",
    ].join("\n");
    const probe = parsePiModels(probeText);
    const merged = mergeDiscoveredModels(
      { source: "disk", models: disk },
      { source: "pi --list-models", models: probe },
    );
    expect(merged).not.toBeNull();
    const byId = new Map(merged!.models.map((m) => [m.id, m]));
    for (const m of probe) {
      expect(byId.has(m.id)).toBe(true);
    }
    // Disk had empty efforts for mini; probe has the constant — richest-wins keeps probe.
    expect(byId.get("openai-codex/gpt-5.4-mini")!.efforts.length).toBeGreaterThan(0);
    // Disk had a real map for gpt-5.5 — non-empty disk efforts win over probe.
    expect(byId.get("openai-codex/gpt-5.5")!.efforts).toEqual(
      expect.arrayContaining(["xhigh", "minimal", "high"]),
    );
  });
});

describe("piModelsStoreSource / displayVendorPath", () => {
  it("surfaces default_model when present", () => {
    expect(piModelsStoreSource("~/.pi/agent/models-store.json", "openai-codex/gpt-5.5")).toBe(
      "~/.pi/agent/models-store.json (default_model=openai-codex/gpt-5.5)",
    );
  });

  it("tilde-collapses against os.homedir() when HOME is unset or empty", () => {
    const realHome = os.homedir();
    const abs = path.join(realHome, ".pi", "agent", "models-store.json");
    expect(displayVendorPath(abs, {})).toBe("~/.pi/agent/models-store.json");
  });
});

describe("pi adapter readModels", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("reads models-store.json + settings.json from the operator agent home", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(path.join(home, "models-store.json"), readFixture("models-store.well-formed.json"));
    fs.writeFileSync(path.join(home, "settings.json"), readFixture("settings.well-formed.json"));
    const adapter = createPiAdapter({
      PI_CODING_AGENT_DIR: home,
      HOME: "/tmp/operator",
    });
    const result = await adapter.readModels!(undefined);
    expect(result.models.map((m) => m.id)).toEqual(
      expect.arrayContaining([
        "openai-codex/gpt-5.5",
        "openai-codex/gpt-5.4-mini",
        "anthropic/claude-sonnet-4-5",
      ]),
    );
    expect(result.models.find((m) => m.id === "openai-codex/gpt-5.5")!.default_effort).toBe(
      "high",
    );
    expect(result.models.find((m) => m.id === "openai-codex/gpt-5.4-mini")!.efforts).toEqual([]);
    expect(result.source).toContain("models-store.json");
    expect(result.source).toContain("default_model=openai-codex/gpt-5.5");
    expect(JSON.stringify(result)).not.toContain(HYGIENE_SENTINEL);
  });

  it("returns empty models when models-store.json is missing", async () => {
    home = makeOperatorHome();
    const adapter = createPiAdapter({ PI_CODING_AGENT_DIR: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toEqual([]);
  });

  it("rejects malformed store so refresh can warn", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(path.join(home, "models-store.json"), readFixture("models-store.malformed.json"));
    const adapter = createPiAdapter({ PI_CODING_AGENT_DIR: home });
    await expect(adapter.readModels!(undefined)).rejects.toThrow(/malformed models-store/);
  });

  it("rejects without hanging when models-store.json is a FIFO (#288)", async () => {
    home = makeOperatorHome();
    const fifo = path.join(home, "models-store.json");
    execFileSync("mkfifo", [fifo]);
    const adapter = createPiAdapter({ PI_CODING_AGENT_DIR: home });
    const started = Date.now();
    await expect(adapter.readModels!(undefined)).rejects.toThrow(/not a regular file/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("resolves default HOME/.pi/agent layout", async () => {
    home = makeOperatorHome();
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "models-store.json"),
      readFixture("models-store.well-formed.json"),
    );
    const adapter = createPiAdapter({ HOME: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.source).toContain(".pi/agent/models-store.json");
  });
});

describe("refreshCatalog end-to-end: degraded pi disk reads warn", () => {
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
        source: "pi --list-models",
        models: [{ id: "from-probe", efforts: [] as string[], default_effort: null }],
      }),
  };

  it("warns on malformed store even when the probe succeeds", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(path.join(home, "models-store.json"), readFixture("models-store.malformed.json"));
    const adapter = { ...createPiAdapter({ PI_CODING_AGENT_DIR: home }), ...probeOk };
    const { catalog, warnings } = await refreshCatalog({}, ["pi"], new Map([["pi", adapter]]));
    expect(catalog.pi!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*malformed/i.test(w))).toBe(true);
  });

  it("stays quiet when models-store.json is absent", async () => {
    home = makeOperatorHome();
    const adapter = { ...createPiAdapter({ PI_CODING_AGENT_DIR: home }), ...probeOk };
    const { warnings } = await refreshCatalog({}, ["pi"], new Map([["pi", adapter]]));
    expect(warnings).toEqual([]);
  });

  it("warns when models-store.json exceeds the size cap", async () => {
    home = makeOperatorHome();
    const storePath = path.join(home, "models-store.json");
    const fd = fs.openSync(storePath, "w");
    try {
      fs.ftruncateSync(fd, PI_MODELS_STORE_MAX_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    const adapter = { ...createPiAdapter({ PI_CODING_AGENT_DIR: home }), ...probeOk };
    const { catalog, warnings } = await refreshCatalog({}, ["pi"], new Map([["pi", adapter]]));
    expect(catalog.pi!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*size cap/i.test(w))).toBe(true);
  });

  it("warns when models-store.json is a FIFO without hanging (#288)", async () => {
    home = makeOperatorHome();
    const fifo = path.join(home, "models-store.json");
    execFileSync("mkfifo", [fifo]);
    const adapter = { ...createPiAdapter({ PI_CODING_AGENT_DIR: home }), ...probeOk };
    const started = Date.now();
    const { catalog, warnings } = await refreshCatalog({}, ["pi"], new Map([["pi", adapter]]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(catalog.pi!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*not a regular file/i.test(w))).toBe(true);
  });
});
