import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexModels } from "@useparley/daemon/adapters/codex.js";
import { parseGrokModels } from "@useparley/daemon/adapters/grok.js";
import type {
  ProbedModels,
  VendorAdapter,
  VendorModels,
} from "@useparley/daemon/adapters/types.js";
import {
  DEFAULT_CATALOG,
  getShippedVendorModels,
  loadCatalog,
  refreshCatalog,
} from "@useparley/core";
import { cleanupHome, makeHome, runCli } from "./helpers.js";

const CODEX_FIXTURE = fileURLToPath(new URL("./fixtures/codex/debug-models.json", import.meta.url));
const GROK_FIXTURE = fileURLToPath(new URL("./fixtures/grok/models.txt", import.meta.url));

/** A minimal adapter exposing discovery hooks, cast for refresh tests. */
function fakeAdapter(
  id: string,
  listModels?: VendorAdapter["listModels"],
  readModels?: VendorAdapter["readModels"],
): VendorAdapter {
  return { id, listModels, readModels } as unknown as VendorAdapter;
}

describe("codex debug models parser (golden fixture)", () => {
  const json = fs.readFileSync(CODEX_FIXTURE, "utf8");

  it("normalizes slug/efforts/default and drops visibility:hide models", () => {
    expect(parseCodexModels(json)).toEqual([
      {
        id: "gpt-5.6-sol",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        default_effort: "medium",
      },
      {
        id: "gpt-5.4-mini",
        efforts: ["low", "medium", "high", "xhigh"],
        default_effort: "medium",
      },
      // codex-auto-review (visibility:"hide") is intentionally absent.
    ]);
  });

  it("throws on non-JSON or a missing models array (refresh keeps existing entry)", () => {
    expect(() => parseCodexModels("not json")).toThrow();
    expect(() => parseCodexModels('{"nope":1}')).toThrow(/models/);
  });
});

describe("grok models text parser (golden fixture)", () => {
  const text = fs.readFileSync(GROK_FIXTURE, "utf8");

  it("parses the bullet ids, skipping the header lines", () => {
    expect(parseGrokModels(text, undefined)).toEqual([
      { id: "grok-4.5", efforts: [], default_effort: null },
      { id: "grok-composer-2.5-fast", efforts: [], default_effort: null },
    ]);
  });

  it("carries efforts forward from the existing entry (hand-patch survives)", () => {
    const existing: VendorModels = {
      fetched_at: null,
      source: "manual",
      models: [{ id: "grok-4.5", efforts: ["low", "medium", "high"], default_effort: "high" }],
    };
    expect(parseGrokModels(text, existing)).toEqual([
      { id: "grok-4.5", efforts: ["low", "medium", "high"], default_effort: "high" },
      { id: "grok-composer-2.5-fast", efforts: [], default_effort: null },
    ]);
  });

  it("throws when no ids parse (refresh keeps existing entry)", () => {
    expect(() => parseGrokModels("No models here.\n", undefined)).toThrow(/no model ids/);
  });
});

describe("catalog read semantics", () => {
  it("returns the seed when the file is absent", () => {
    expect(loadCatalog("/nonexistent/parley/models.json")).toEqual(DEFAULT_CATALOG);
  });

  it("surfaces a corrupt file as an error rather than clobbering it", () => {
    const home = makeHome();
    try {
      const file = path.join(home, "models.json");
      fs.writeFileSync(file, "{ not valid json ");
      expect(() => loadCatalog(file)).toThrow(/not valid JSON/);
    } finally {
      cleanupHome(home);
    }
  });
});

describe("catalog refresh merge semantics", () => {
  const base = {
    grok: {
      fetched_at: null,
      source: "manual",
      models: [{ id: "grok-4.5", efforts: ["low", "medium", "high"], default_effort: "high" }],
    },
  };

  it("rewrites the entry on a successful probe, stamping fetched_at/source", async () => {
    const probed: ProbedModels = {
      source: "grok models",
      models: [{ id: "grok-4.5", efforts: ["low", "medium", "high"], default_effort: "high" }],
    };
    const adapters = new Map([["grok", fakeAdapter("grok", () => Promise.resolve(probed))]]);
    const { catalog, warnings } = await refreshCatalog(
      base,
      ["grok"],
      adapters,
      () => "2026-07-12T00:00:00.000Z",
    );
    expect(warnings).toEqual([]);
    expect(catalog.grok).toEqual({
      fetched_at: "2026-07-12T00:00:00.000Z",
      source: "grok models",
      models: [{ id: "grok-4.5", efforts: ["low", "medium", "high"], default_effort: "high" }],
    });
  });

  it("keeps the manual entry intact when the probe rejects, and warns", async () => {
    const adapters = new Map([
      ["grok", fakeAdapter("grok", () => Promise.reject(new Error("grok not installed")))],
    ]);
    const { catalog, warnings } = await refreshCatalog(base, ["grok"], adapters);
    expect(catalog).toEqual(base); // manual patch survives a failed refresh
    expect(warnings[0]).toMatch(/grok: probe failed/);
  });

  it("keeps the entry when the probe returns no models, and warns", async () => {
    const adapters = new Map([
      ["grok", fakeAdapter("grok", () => Promise.resolve({ source: "grok models", models: [] }))],
    ]);
    const { catalog, warnings } = await refreshCatalog(base, ["grok"], adapters);
    expect(catalog).toEqual(base);
    expect(warnings[0]).toMatch(/no models/);
  });

  it("warns and keeps the entry when the vendor has no probe hook", async () => {
    const adapters = new Map([["grok", fakeAdapter("grok", undefined)]]);
    const { catalog, warnings } = await refreshCatalog(base, ["grok"], adapters);
    expect(catalog).toEqual(base);
    expect(warnings[0]).toMatch(/no refresh probe/);
    expect(warnings[0]).toMatch(/kept existing entry/);
  });

  it("falls back to the shipped catalog when probe fails and the entry is empty", async () => {
    const empty = {
      codex: { fetched_at: null, source: "manual", models: [] as [] },
    };
    const adapters = new Map([
      ["codex", fakeAdapter("codex", () => Promise.reject(new Error("codex missing")))],
    ]);
    const { catalog, warnings } = await refreshCatalog(empty, ["codex"], adapters);
    const shipped = getShippedVendorModels("codex")!;
    expect(catalog.codex!.models).toEqual(shipped.models);
    expect(catalog.codex!.source).toMatch(/^shipped catalog \(point-in-time reference;/);
    expect(warnings[0]).toMatch(/probe failed/);
    expect(warnings[0]).toMatch(/shipped catalog as point-in-time reference/);
  });

  it("falls back to shipped when probe returns no models and the entry is empty", async () => {
    const empty = {
      codex: { fetched_at: null, source: "manual", models: [] as [] },
    };
    const adapters = new Map([
      ["codex", fakeAdapter("codex", () => Promise.resolve({ source: "codex debug models", models: [] }))],
    ]);
    const { catalog, warnings } = await refreshCatalog(empty, ["codex"], adapters);
    expect(catalog.codex!.models.length).toBeGreaterThan(0);
    expect(catalog.codex!.source).toMatch(/shipped catalog \(point-in-time reference/);
    expect(warnings[0]).toMatch(/no models/);
    expect(warnings[0]).toMatch(/shipped catalog/);
  });

  it("falls back to shipped when no probe hook and the entry is empty", async () => {
    const empty = {
      claude: { fetched_at: null, source: "manual", models: [] as [] },
    };
    const adapters = new Map([["claude", fakeAdapter("claude", undefined)]]);
    const { catalog, warnings } = await refreshCatalog(empty, ["claude"], adapters);
    expect(catalog.claude!.models.length).toBeGreaterThan(0);
    expect(catalog.claude!.source).toMatch(/shipped catalog \(point-in-time reference/);
    expect(warnings[0]).toMatch(/no refresh probe/);
    expect(warnings[0]).toMatch(/shipped catalog/);
  });

  it("passes the existing entry into listModels (so grok can carry efforts)", async () => {
    let seen: VendorModels | undefined = undefined;
    const adapters = new Map([
      [
        "grok",
        fakeAdapter("grok", (existing) => {
          seen = existing;
          return Promise.resolve({ source: "grok models", models: base.grok.models });
        }),
      ],
    ]);
    await refreshCatalog(base, ["grok"], adapters);
    expect(seen).toEqual(base.grok);
  });
});

describe("parley models command", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    cleanupHome(home);
  });

  it("seeds ~/.parley/models.json on first run and prints the catalog as JSON", async () => {
    const result = await runCli(["models", "--json"], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(DEFAULT_CATALOG);
    // The file is written so the user can hand-edit it.
    const file = path.join(home, "models.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(DEFAULT_CATALOG);
  });

  it("renders a human table listing both vendors and their models", async () => {
    const result = await runCli(["models"], home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("codex");
    expect(result.stdout).toContain("gpt-5.6-sol");
    expect(result.stdout).toContain("grok-4.5");
    expect(result.stdout).toContain("default: high");
  });

  it("filters to one vendor with --vendor", async () => {
    const result = await runCli(["models", "--vendor", "grok", "--json"], home);
    expect(result.code).toBe(0);
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(["grok"]);
  });

  it("reads a hand-edited catalog back verbatim (file is the source of truth)", async () => {
    const file = path.join(home, "models.json");
    const patched = {
      codex: {
        fetched_at: null,
        source: "manual",
        models: [{ id: "gpt-6-future", efforts: ["low", "max"], default_effort: "low" }],
      },
    };
    fs.writeFileSync(file, JSON.stringify(patched));
    const result = await runCli(["models", "--json"], home);
    expect(JSON.parse(result.stdout)).toEqual(patched);
  });

  it("accepts `refresh` as a subcommand alias for --refresh", async () => {
    // Empty entry + no working probe → shipped fallback still surfaces models.
    const file = path.join(home, "models.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        codex: { fetched_at: null, source: "manual", models: [] },
      }),
    );
    // codex may or may not be on PATH; either live data or shipped fallback is fine.
    const result = await runCli(["models", "refresh", "--vendor", "codex", "--json"], home);
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout) as { codex?: { models: unknown[]; source: string } };
    expect(out.codex).toBeDefined();
    // If live probe worked, models non-empty from probe; if not, shipped fallback.
    if (result.stderr.includes("shipped catalog")) {
      expect(out.codex!.source).toMatch(/shipped catalog \(point-in-time reference/);
      expect(out.codex!.models.length).toBeGreaterThan(0);
    } else {
      expect(out.codex!.models.length).toBeGreaterThan(0);
    }
  });
});
