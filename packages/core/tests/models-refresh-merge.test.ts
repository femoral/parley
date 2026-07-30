import { describe, expect, it } from "vitest";
import type { ModelEntry, ModelProber, ProbedModels, VendorModels } from "../src/models.js";
import {
  mergeDiscoveredModels,
  pickRicherModelEntry,
  refreshCatalog,
} from "../src/models.js";
import { getShippedVendorModels } from "../src/models.js";

function entry(partial: Partial<ModelEntry> & { id: string }): ModelEntry {
  return {
    id: partial.id,
    efforts: partial.efforts ?? [],
    default_effort: partial.default_effort ?? null,
    ...(partial.label === undefined ? {} : { label: partial.label }),
    ...(partial.notes === undefined ? {} : { notes: partial.notes }),
  };
}

function prober(hooks: {
  readModels?: ModelProber["readModels"];
  listModels?: ModelProber["listModels"];
}): ModelProber {
  return hooks;
}

describe("pickRicherModelEntry (field-by-field)", () => {
  it("keeps non-empty efforts from primary when secondary only adds a label", () => {
    // Finding 5: whole-entry scoring discarded the richer effort list.
    const disk = entry({
      id: "m",
      efforts: ["low", "high", "xhigh"],
      default_effort: "high",
    });
    const probe = entry({
      id: "m",
      efforts: ["low"],
      default_effort: "low",
      label: "GPT",
    });
    expect(pickRicherModelEntry(disk, probe)).toEqual({
      id: "m",
      efforts: ["low", "high", "xhigh"],
      default_effort: "high",
      label: "GPT",
    });
  });

  it("preserves notes from disk when probe supplies efforts", () => {
    // Finding 5 second case — kimi-shaped notes must not vanish.
    const disk = entry({ id: "X", notes: "max_context_size=1048576" });
    const probe = entry({
      id: "X",
      efforts: ["low", "high"],
      default_effort: "high",
    });
    expect(pickRicherModelEntry(disk, probe)).toEqual({
      id: "X",
      efforts: ["low", "high"],
      default_effort: "high",
      notes: "max_context_size=1048576",
    });
  });

  it("takes secondary efforts when primary's are empty", () => {
    const disk = entry({ id: "m" });
    const probe = entry({ id: "m", efforts: ["high"] });
    expect(pickRicherModelEntry(disk, probe).efforts).toEqual(["high"]);
  });

  it("prefers primary default_effort / label / notes on ties", () => {
    const disk = entry({
      id: "m",
      efforts: ["low"],
      default_effort: "high",
      label: "from-disk",
      notes: "d",
    });
    const probe = entry({
      id: "m",
      efforts: ["high"],
      default_effort: "low",
      label: "from-probe",
      notes: "p",
    });
    expect(pickRicherModelEntry(disk, probe)).toEqual(disk);
  });
});

describe("mergeDiscoveredModels (union / richest-wins)", () => {
  it("returns null when both sides are empty", () => {
    expect(mergeDiscoveredModels(null, null)).toBeNull();
    expect(
      mergeDiscoveredModels({ source: "disk", models: [] }, { source: "probe", models: [] }),
    ).toBeNull();
  });

  it("is a superset of both id sets (disk must never shrink the probe set)", () => {
    const disk: ProbedModels = {
      source: "cache",
      models: [entry({ id: "only-disk", efforts: ["low"] }), entry({ id: "shared" })],
    };
    const probe: ProbedModels = {
      source: "cli",
      models: [entry({ id: "only-probe" }), entry({ id: "shared", efforts: ["high"] })],
    };
    const merged = mergeDiscoveredModels(disk, probe)!;
    const ids = merged.models.map((m) => m.id).sort();
    expect(ids).toEqual(["only-disk", "only-probe", "shared"]);
    // shared: disk empty efforts, probe has efforts → field merge takes probe efforts
    expect(merged.models.find((m) => m.id === "shared")).toEqual(
      entry({ id: "shared", efforts: ["high"] }),
    );
    expect(merged.source).toBe("cache + cli");
  });

  it("uses a single channel's source when the other is empty", () => {
    const disk: ProbedModels = {
      source: "cache",
      models: [entry({ id: "a" })],
    };
    expect(mergeDiscoveredModels(disk, null)).toEqual(disk);
    expect(mergeDiscoveredModels(null, disk)).toEqual(disk);
  });
});

describe("refreshCatalog with readModels + listModels", () => {
  const NOW = "2026-07-30T12:00:00.000Z";

  it("prefers disk when only readModels returns models", async () => {
    const adapters = new Map([
      [
        "kimi",
        prober({
          readModels: () =>
            Promise.resolve({
              source: "kimi config.toml",
              models: [entry({ id: "kimi-code/k3", efforts: ["low", "high"], default_effort: "high" })],
            }),
        }),
      ],
    ]);
    const { catalog, warnings } = await refreshCatalog({}, ["kimi"], adapters, () => NOW);
    expect(warnings).toEqual([]);
    expect(catalog.kimi).toEqual({
      fetched_at: NOW,
      source: "kimi config.toml",
      models: [entry({ id: "kimi-code/k3", efforts: ["low", "high"], default_effort: "high" })],
    });
  });

  it("merges disk + probe as a superset (union case)", async () => {
    const adapters = new Map([
      [
        "grok",
        prober({
          readModels: () =>
            Promise.resolve({
              source: "models_cache.json",
              models: [
                entry({ id: "cache-only", efforts: ["high"], default_effort: "high" }),
                entry({ id: "shared", efforts: ["low"] }),
              ],
            }),
          listModels: () =>
            Promise.resolve({
              source: "grok models",
              models: [
                entry({ id: "probe-only" }),
                entry({ id: "shared" }), // thinner — disk keeps efforts
              ],
            }),
        }),
      ],
    ]);
    const { catalog } = await refreshCatalog({}, ["grok"], adapters, () => NOW);
    const ids = catalog.grok!.models.map((m) => m.id).sort();
    expect(ids).toEqual(["cache-only", "probe-only", "shared"]);
    expect(catalog.grok!.models.find((m) => m.id === "shared")!.efforts).toEqual(["low"]);
    expect(catalog.grok!.source).toBe("models_cache.json + grok models");
  });

  it("warns when disk fails even if probe succeeds (finding 4)", async () => {
    const adapters = new Map([
      [
        "codex",
        prober({
          readModels: () => Promise.reject(new Error("EACCES")),
          listModels: () =>
            Promise.resolve({
              source: "codex debug models",
              models: [entry({ id: "gpt-5.6-sol", efforts: ["low"] })],
            }),
        }),
      ],
    ]);
    const { catalog, warnings } = await refreshCatalog({}, ["codex"], adapters, () => NOW);
    expect(catalog.codex!.models).toEqual([entry({ id: "gpt-5.6-sol", efforts: ["low"] })]);
    expect(catalog.codex!.source).toBe("codex debug models");
    expect(warnings).toEqual(["codex: disk read failed (EACCES)"]);
  });

  it("falls through to probe when disk returns empty (fresh home)", async () => {
    const adapters = new Map([
      [
        "codex",
        prober({
          readModels: () => Promise.resolve({ source: "cache", models: [] }),
          listModels: () =>
            Promise.resolve({
              source: "codex debug models",
              models: [entry({ id: "from-probe" })],
            }),
        }),
      ],
    ]);
    const { catalog, warnings } = await refreshCatalog({}, ["codex"], adapters, () => NOW);
    expect(catalog.codex!.models).toEqual([entry({ id: "from-probe" })]);
    // Empty disk is a normal non-error state — no warning.
    expect(warnings).toEqual([]);
  });

  it("falls back to shipped when both channels empty and entry is empty", async () => {
    const empty = {
      codex: { fetched_at: null, source: "manual", models: [] as ModelEntry[] },
    };
    const adapters = new Map([
      [
        "codex",
        prober({
          readModels: () => Promise.resolve({ source: "cache", models: [] }),
          listModels: () => Promise.resolve({ source: "probe", models: [] }),
        }),
      ],
    ]);
    const { catalog, warnings } = await refreshCatalog(empty, ["codex"], adapters);
    const shipped = getShippedVendorModels("codex")!;
    expect(catalog.codex!.models).toEqual(shipped.models);
    expect(catalog.codex!.source).toMatch(/^shipped catalog \(point-in-time reference;/);
    expect(warnings[0]).toMatch(/disk read returned no models/);
    expect(warnings[0]).toMatch(/probe returned no models/);
  });

  it("keeps existing entry when both channels fail and entry is non-empty", async () => {
    const base: Record<string, VendorModels> = {
      codex: {
        fetched_at: null,
        source: "manual",
        models: [entry({ id: "hand-patched" })],
      },
    };
    const adapters = new Map([
      [
        "codex",
        prober({
          readModels: () => Promise.reject(new Error("bad cache")),
          listModels: () => Promise.reject(new Error("not installed")),
        }),
      ],
    ]);
    const { catalog, warnings } = await refreshCatalog(base, ["codex"], adapters);
    expect(catalog).toEqual(base);
    expect(warnings[0]).toMatch(/disk read failed/);
    expect(warnings[0]).toMatch(/probe failed/);
    expect(warnings[0]).toMatch(/kept existing entry/);
  });

  it("still works with listModels-only adapters (no readModels)", async () => {
    const adapters = new Map([
      [
        "grok",
        prober({
          listModels: () =>
            Promise.resolve({
              source: "grok models",
              models: [entry({ id: "grok-4.5" })],
            }),
        }),
      ],
    ]);
    const { catalog } = await refreshCatalog({}, ["grok"], adapters, () => NOW);
    expect(catalog.grok!.source).toBe("grok models");
    expect(catalog.grok!.models).toEqual([entry({ id: "grok-4.5" })]);
  });

  it("excludes codex non-API models from the merged catalog (finding 3)", async () => {
    // Simulates disk (strict filter) + probe that previously only dropped hide:
    // both channels now share the filter, so union must not re-admit
    // internal-not-in-api / missing-api-flag.
    const diskModels = [
      entry({ id: "gpt-5.6-sol", efforts: ["low"], default_effort: "medium" }),
      entry({ id: "gpt-5.4-mini", efforts: ["low"], default_effort: "low" }),
    ];
    // Probe path after the shared filter — same id set as disk.
    const probeModels = [...diskModels];
    const adapters = new Map([
      [
        "codex",
        prober({
          readModels: () =>
            Promise.resolve({ source: "~/.codex/models_cache.json", models: diskModels }),
          listModels: () =>
            Promise.resolve({ source: "codex debug models", models: probeModels }),
        }),
      ],
    ]);
    const { catalog } = await refreshCatalog({}, ["codex"], adapters, () => NOW);
    const ids = catalog.codex!.models.map((m) => m.id);
    expect(ids).toEqual(["gpt-5.6-sol", "gpt-5.4-mini"]);
    expect(ids).not.toContain("internal-not-in-api");
    expect(ids).not.toContain("missing-api-flag");
    expect(ids).not.toContain("codex-auto-review");
  });
});
