import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayVendorPath, mergeDiscoveredModels, refreshCatalog } from "@useparley/core";
import {
  createOpenclawAdapter,
  filterOpenclawModelsByAuthedProviders,
  OPENCLAW_CATALOG_MAX_BYTES,
  OPENCLAW_CONFIG_MAX_BYTES,
  openclawDiskModelsSource,
  parseOpenclawAuthProviders,
  parseOpenclawCatalog,
  parseOpenclawModels,
} from "../src/adapters/openclaw.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/openclaw/", import.meta.url));
const HYGIENE_SENTINEL = "PARLEY_FIXTURE_SENTINEL_MUST_NOT_LEAK";

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function makeOperatorHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parley-openclaw-home-"));
}

/** Layout plugin catalogs like a real openclaw home. */
function writePluginCatalog(home: string, plugin: string, fixtureName: string): void {
  const dir = path.join(home, "agents", "main", "agent", "plugins", plugin);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "catalog.json"), readFixture(fixtureName));
}

describe("parseOpenclawAuthProviders", () => {
  it("extracts unique provider ids from auth.profiles", () => {
    const text = readFixture("openclaw.well-formed.json");
    expect(text).toContain(HYGIENE_SENTINEL);
    const { providers, error } = parseOpenclawAuthProviders(text);
    expect(error).toBeNull();
    expect([...providers].sort()).toEqual(["opencode", "opencode-go"]);
    expect(JSON.stringify([...providers])).not.toContain(HYGIENE_SENTINEL);
  });

  it("returns empty providers when auth block is absent (not an error)", () => {
    const { providers, error } = parseOpenclawAuthProviders(readFixture("openclaw.no-auth.json"));
    expect(error).toBeNull();
    expect(providers.size).toBe(0);
  });

  it("flags malformed config as present-but-unusable without leaking secrets", () => {
    const result = parseOpenclawAuthProviders(readFixture("openclaw.malformed.json"));
    expect(result.providers.size).toBe(0);
    expect(result.error).toBe("malformed openclaw.json");
    expect(JSON.stringify(result)).not.toContain(HYGIENE_SENTINEL);
  });
});

describe("parseOpenclawCatalog", () => {
  it("maps provider/id keys and leaves efforts empty", () => {
    const { models, error } = parseOpenclawCatalog(readFixture("catalog.opencode-go.json"));
    expect(error).toBeNull();
    expect(models).toEqual([
      {
        id: "opencode-go/kimi-k2.6",
        efforts: [],
        default_effort: null,
        label: "Kimi K2.6",
      },
      {
        id: "opencode-go/deepseek-v4-pro",
        efforts: [],
        default_effort: null,
        label: "DeepSeek V4 Pro",
      },
    ]);
  });

  it("flags malformed / unexpected catalogs", () => {
    expect(parseOpenclawCatalog(readFixture("catalog.malformed.json")).error).toBe(
      "malformed catalog.json",
    );
    expect(parseOpenclawCatalog(readFixture("catalog.unexpected.json")).error).toBe(
      "unexpected catalog.json shape",
    );
  });
});

describe("filterOpenclawModelsByAuthedProviders", () => {
  it("intersects catalog models with authenticated providers only", () => {
    const go = parseOpenclawCatalog(readFixture("catalog.opencode-go.json")).models;
    const oc = parseOpenclawCatalog(readFixture("catalog.opencode.json")).models;
    const all = [...go, ...oc];
    const authed = parseOpenclawAuthProviders(readFixture("openclaw.well-formed.json")).providers;
    const filtered = filterOpenclawModelsByAuthedProviders(all, authed);
    const ids = filtered.map((m) => m.id);
    expect(ids).toContain("opencode-go/kimi-k2.6");
    expect(ids).toContain("opencode/claude-opus-4-6");
    expect(ids).not.toContain("unauthed-provider/should-be-filtered");
  });

  it("returns empty when no providers are authenticated", () => {
    const models = parseOpenclawCatalog(readFixture("catalog.opencode-go.json")).models;
    expect(filterOpenclawModelsByAuthedProviders(models, new Set())).toEqual([]);
  });
});

describe("union(probe, disk) is a superset of probe (#282 hard contract)", () => {
  it("disk+probe merge never drops probe ids", () => {
    const go = parseOpenclawCatalog(readFixture("catalog.opencode-go.json")).models;
    const oc = parseOpenclawCatalog(readFixture("catalog.opencode.json")).models;
    const authed = parseOpenclawAuthProviders(readFixture("openclaw.well-formed.json")).providers;
    const disk = filterOpenclawModelsByAuthedProviders([...go, ...oc], authed);
    const probeJson = JSON.stringify({
      count: 2,
      models: [
        { key: "opencode-go/kimi-k2.6", name: "Kimi K2.6" },
        { key: "openai/gpt-5.5", name: "gpt-5.5" },
      ],
    });
    const probe = parseOpenclawModels(probeJson, undefined);
    const merged = mergeDiscoveredModels(
      { source: "disk", models: disk },
      { source: "openclaw models list --all --json", models: probe },
    );
    expect(merged).not.toBeNull();
    const ids = new Set(merged!.models.map((m) => m.id));
    for (const m of probe) {
      expect(ids.has(m.id)).toBe(true);
    }
    // Disk-only authed models still present.
    expect(ids.has("opencode/claude-opus-4-6")).toBe(true);
    // Unauthed catalog provider never admitted.
    expect(ids.has("unauthed-provider/should-be-filtered")).toBe(false);
  });
});

describe("openclawDiskModelsSource / displayVendorPath", () => {
  it("names catalog contribution without embedding secrets", () => {
    expect(openclawDiskModelsSource("~/.openclaw/openclaw.json", 2)).toBe(
      "~/.openclaw/openclaw.json + 2 catalog.json",
    );
  });

  it("tilde-collapses openclaw.json under HOME", () => {
    expect(
      displayVendorPath("/tmp/operator/.openclaw/openclaw.json", { HOME: "/tmp/operator" }),
    ).toBe("~/.openclaw/openclaw.json");
  });
});

describe("openclaw adapter readModels", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("reads catalogs and intersects with auth.profiles providers", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(path.join(home, "openclaw.json"), readFixture("openclaw.well-formed.json"));
    writePluginCatalog(home, "opencode-go", "catalog.opencode-go.json");
    writePluginCatalog(home, "opencode", "catalog.opencode.json");
    const adapter = createOpenclawAdapter({ OPENCLAW_STATE_DIR: home });
    const result = await adapter.readModels!(undefined);
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("opencode-go/kimi-k2.6");
    expect(ids).toContain("opencode-go/deepseek-v4-pro");
    expect(ids).toContain("opencode/claude-opus-4-6");
    expect(ids).not.toContain("unauthed-provider/should-be-filtered");
    expect(result.models.every((m) => m.efforts.length === 0)).toBe(true);
    expect(result.source).toContain("openclaw.json");
    expect(JSON.stringify(result)).not.toContain(HYGIENE_SENTINEL);
  });

  it("returns empty when openclaw.json is missing (fresh home)", async () => {
    home = makeOperatorHome();
    writePluginCatalog(home, "opencode-go", "catalog.opencode-go.json");
    const adapter = createOpenclawAdapter({ OPENCLAW_STATE_DIR: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toEqual([]);
  });

  it("returns empty when no auth profiles (large catalog alone is not enough)", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(path.join(home, "openclaw.json"), readFixture("openclaw.no-auth.json"));
    writePluginCatalog(home, "opencode-go", "catalog.opencode-go.json");
    const adapter = createOpenclawAdapter({ OPENCLAW_STATE_DIR: home });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(HYGIENE_SENTINEL);
  });

  it("rejects malformed openclaw.json so refresh can warn", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(path.join(home, "openclaw.json"), readFixture("openclaw.malformed.json"));
    const adapter = createOpenclawAdapter({ OPENCLAW_STATE_DIR: home });
    await expect(adapter.readModels!(undefined)).rejects.toThrow(/malformed openclaw\.json/);
  });

  it("rejects without hanging when openclaw.json is a FIFO (#288)", async () => {
    home = makeOperatorHome();
    const fifo = path.join(home, "openclaw.json");
    execFileSync("mkfifo", [fifo]);
    const adapter = createOpenclawAdapter({ OPENCLAW_STATE_DIR: home });
    const started = Date.now();
    await expect(adapter.readModels!(undefined)).rejects.toThrow(/not a regular file/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("refuses OPENCLAW_STATE_DIR pointing at a per-task isolated home", async () => {
    home = makeOperatorHome();
    const taskCwd = path.join(home, "worktree");
    const isolated = path.join(taskCwd, ".openclaw-state");
    fs.mkdirSync(isolated, { recursive: true });
    fs.writeFileSync(path.join(isolated, "openclaw.json"), readFixture("openclaw.well-formed.json"));
    writePluginCatalog(isolated, "opencode-go", "catalog.opencode-go.json");
    // Operator home empty.
    const operatorOpenclaw = path.join(home, ".openclaw");
    fs.mkdirSync(operatorOpenclaw, { recursive: true });

    const adapter = createOpenclawAdapter({
      HOME: home,
      OPENCLAW_STATE_DIR: isolated,
    });
    const result = await adapter.readModels!(undefined);
    expect(result.models).toEqual([]);
    expect(result.source).toContain(".openclaw");
    expect(result.source).not.toContain(".openclaw-state");
  });
});

describe("refreshCatalog end-to-end: degraded openclaw disk reads warn", () => {
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
        source: "openclaw models list --all --json",
        models: [{ id: "from-probe", efforts: [] as string[], default_effort: null }],
      }),
  };

  it("warns on malformed config even when the probe succeeds", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(path.join(home, "openclaw.json"), readFixture("openclaw.malformed.json"));
    const adapter = { ...createOpenclawAdapter({ OPENCLAW_STATE_DIR: home }), ...probeOk };
    const { catalog, warnings } = await refreshCatalog(
      {},
      ["openclaw"],
      new Map([["openclaw", adapter]]),
    );
    expect(catalog.openclaw!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*malformed/i.test(w))).toBe(true);
    expect(JSON.stringify(warnings)).not.toContain(HYGIENE_SENTINEL);
  });

  it("stays quiet when openclaw.json is absent", async () => {
    home = makeOperatorHome();
    const adapter = { ...createOpenclawAdapter({ OPENCLAW_STATE_DIR: home }), ...probeOk };
    const { warnings } = await refreshCatalog({}, ["openclaw"], new Map([["openclaw", adapter]]));
    expect(warnings).toEqual([]);
  });

  it("warns when openclaw.json exceeds the size cap", async () => {
    home = makeOperatorHome();
    const configPath = path.join(home, "openclaw.json");
    const fd = fs.openSync(configPath, "w");
    try {
      fs.ftruncateSync(fd, OPENCLAW_CONFIG_MAX_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    const adapter = { ...createOpenclawAdapter({ OPENCLAW_STATE_DIR: home }), ...probeOk };
    const { catalog, warnings } = await refreshCatalog(
      {},
      ["openclaw"],
      new Map([["openclaw", adapter]]),
    );
    expect(catalog.openclaw!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*size cap/i.test(w))).toBe(true);
  });

  it("warns when openclaw.json is a FIFO without hanging (#288)", async () => {
    home = makeOperatorHome();
    const fifo = path.join(home, "openclaw.json");
    execFileSync("mkfifo", [fifo]);
    const adapter = { ...createOpenclawAdapter({ OPENCLAW_STATE_DIR: home }), ...probeOk };
    const started = Date.now();
    const { catalog, warnings } = await refreshCatalog(
      {},
      ["openclaw"],
      new Map([["openclaw", adapter]]),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(catalog.openclaw!.models.map((m) => m.id)).toEqual(["from-probe"]);
    expect(warnings.some((w) => /disk read failed.*not a regular file/i.test(w))).toBe(true);
  });

  it("warns when a catalog.json exceeds the size cap", async () => {
    home = makeOperatorHome();
    fs.writeFileSync(path.join(home, "openclaw.json"), readFixture("openclaw.well-formed.json"));
    const dir = path.join(home, "agents", "main", "agent", "plugins", "huge");
    fs.mkdirSync(dir, { recursive: true });
    const catalogPath = path.join(dir, "catalog.json");
    const fd = fs.openSync(catalogPath, "w");
    try {
      fs.ftruncateSync(fd, OPENCLAW_CATALOG_MAX_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    const adapter = { ...createOpenclawAdapter({ OPENCLAW_STATE_DIR: home }), ...probeOk };
    const { warnings } = await refreshCatalog({}, ["openclaw"], new Map([["openclaw", adapter]]));
    expect(warnings.some((w) => /disk read failed.*size cap/i.test(w))).toBe(true);
  });
});
