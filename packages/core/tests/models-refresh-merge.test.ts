import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelEntry, ModelProber, ProbedModels, VendorModels } from "../src/models.js";
import {
  mergeDiscoveredModels,
  pickRicherModelEntry,
  refreshCatalog,
} from "../src/models.js";
import { getShippedVendorModels } from "../src/models.js";
import { operatorHomeDir } from "../src/vendor-home.js";

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

  it("collapses operator home paths in disk-read failure warnings (#291)", async () => {
    // Simulate a real Node fs error: absolute path under the operator home is
    // embedded mid-message. Collapse must happen at the shared refreshCatalog
    // warning site so every reader benefits.
    const home = operatorHomeDir();
    const absPath = path.join(home, ".hermes", "cache", "model_catalog.json");
    const fsMsg = `EACCES: permission denied, open '${absPath}'`;
    const adapters = new Map([
      [
        "hermes",
        prober({
          readModels: () => Promise.reject(new Error(fsMsg)),
          listModels: () =>
            Promise.resolve({
              source: "hermes models",
              models: [entry({ id: "from-probe" })],
            }),
        }),
      ],
    ]);
    const { warnings } = await refreshCatalog({}, ["hermes"], adapters, () => NOW);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/hermes: disk read failed/);
    expect(warnings[0]).toContain("~/.hermes/cache/model_catalog.json");
    expect(warnings[0]).not.toContain(home);
  });

  it("collapses operator home paths when disk fails and both channels empty (#291)", async () => {
    const home = operatorHomeDir();
    const absPath = path.join(home, ".codex", "models_cache.json");
    const fsMsg = `ENOENT: no such file or directory, open '${absPath}'`;
    const adapters = new Map([
      [
        "codex",
        prober({
          readModels: () => Promise.reject(new Error(fsMsg)),
          listModels: () => Promise.reject(new Error("not installed")),
        }),
      ],
    ]);
    const base: Record<string, VendorModels> = {
      codex: {
        fetched_at: null,
        source: "manual",
        models: [entry({ id: "kept" })],
      },
    };
    const { warnings } = await refreshCatalog(base, ["codex"], adapters, () => NOW);
    expect(warnings[0]).toMatch(/disk read failed/);
    expect(warnings[0]).toContain("~/.codex/models_cache.json");
    expect(warnings[0]).not.toContain(home);
  });

  it("collapses operator home paths in probe failure warnings (#291)", async () => {
    // Probe errors can embed absolute paths (execFile binary under home via
    // PARLEY_*_BIN, or vendor stderr naming config under home).
    const home = operatorHomeDir();
    const binPath = path.join(home, ".local", "bin", "hermes");
    const probeMsg = `spawn ${binPath} EACCES`;
    const adapters = new Map([
      [
        "hermes",
        prober({
          readModels: () =>
            Promise.resolve({
              source: "~/.hermes/cache/model_catalog.json",
              models: [entry({ id: "from-disk" })],
            }),
          listModels: () => Promise.reject(new Error(probeMsg)),
        }),
      ],
    ]);
    const { warnings } = await refreshCatalog({}, ["hermes"], adapters, () => NOW);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/hermes: probe failed/);
    expect(warnings[0]).toContain("~/.local/bin/hermes");
    expect(warnings[0]).not.toContain(home);
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

  it("preserves vendor effort_levels and notes on successful refresh (#293)", async () => {
    // Hermes-shaped: shipped vocabulary + discovery models with empty efforts.
    // Refresh must not drop the only on-disk record of the effort vocabulary.
    const shippedEffortLevels = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
    const shippedNotes = "Interactive picker only.";
    const base: Record<string, VendorModels> = {
      hermes: {
        fetched_at: null,
        source: "docs/research/hermes-cli-automation.md",
        notes: shippedNotes,
        effort_levels: [...shippedEffortLevels],
        models: [],
      },
    };
    const adapters = new Map([
      [
        "hermes",
        prober({
          readModels: () =>
            Promise.resolve({
              source: "~/.hermes/cache/model_catalog.json",
              models: [
                entry({ id: "openrouter/anthropic/claude-sonnet-4" }),
                entry({ id: "openrouter/openai/gpt-5" }),
              ],
            }),
        }),
      ],
    ]);
    const { catalog, warnings } = await refreshCatalog(base, ["hermes"], adapters, () => NOW);
    expect(warnings).toEqual([]);
    const refreshed = catalog.hermes!;
    expect(refreshed.fetched_at).toBe(NOW);
    expect(refreshed.source).toBe("~/.hermes/cache/model_catalog.json");
    expect(refreshed.models).toEqual([
      entry({ id: "openrouter/anthropic/claude-sonnet-4" }),
      entry({ id: "openrouter/openai/gpt-5" }),
    ]);
    // Byte-for-byte: same vocabulary and notes as the prior entry.
    expect(refreshed.effort_levels).toEqual([...shippedEffortLevels]);
    expect(refreshed.notes).toBe(shippedNotes);
  });

  it("does not invent effort_levels or notes when prior entry lacks them (#293)", async () => {
    const base: Record<string, VendorModels> = {
      grok: {
        fetched_at: null,
        source: "manual",
        models: [entry({ id: "old" })],
      },
    };
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
    const { catalog } = await refreshCatalog(base, ["grok"], adapters, () => NOW);
    expect(catalog.grok).toEqual({
      fetched_at: NOW,
      source: "grok models",
      models: [entry({ id: "grok-4.5" })],
    });
    expect(catalog.grok).not.toHaveProperty("effort_levels");
    expect(catalog.grok).not.toHaveProperty("notes");
  });

  it("preserves effort_levels alone or notes alone (#293)", async () => {
    const adapters = new Map([
      [
        "kimi",
        prober({
          listModels: () =>
            Promise.resolve({
              source: "kimi probe",
              models: [entry({ id: "kimi-code/k3" })],
            }),
        }),
      ],
    ]);
    const onlyEfforts: Record<string, VendorModels> = {
      kimi: {
        fetched_at: null,
        source: "manual",
        effort_levels: ["low", "high"],
        models: [],
      },
    };
    const withEfforts = await refreshCatalog(onlyEfforts, ["kimi"], adapters, () => NOW);
    expect(withEfforts.catalog.kimi!.effort_levels).toEqual(["low", "high"]);
    expect(withEfforts.catalog.kimi).not.toHaveProperty("notes");
    expect(withEfforts.catalog.kimi!.models).toEqual([entry({ id: "kimi-code/k3" })]);

    const onlyNotes: Record<string, VendorModels> = {
      kimi: {
        fetched_at: null,
        source: "manual",
        notes: "from shipped",
        models: [],
      },
    };
    const withNotes = await refreshCatalog(onlyNotes, ["kimi"], adapters, () => NOW);
    expect(withNotes.catalog.kimi!.notes).toBe("from shipped");
    expect(withNotes.catalog.kimi).not.toHaveProperty("effort_levels");
  });

  it("excludes codex non-API models from the merged catalog (finding 3)", async () => {
    // Divergent channel inputs (not a shared array reference): disk and probe
    // each return a different *allowed* subset after the shared filter. Union
    // must keep both good ids and must not invent excluded ones. A leaky
    // channel that still emitted internal-not-in-api / missing-api-flag /
    // codex-auto-review would re-admit them via union — those ids must only
    // appear if a channel wrongly returns them (caught by not.toContain).
    const diskModels = [
      entry({ id: "gpt-5.6-sol", efforts: ["low"], default_effort: "medium" }),
      // disk-only allowed id — probe does not list it
      entry({ id: "gpt-5.4-mini", efforts: ["low"], default_effort: "low" }),
    ];
    const probeModels = [
      entry({ id: "gpt-5.6-sol", efforts: ["low", "medium"], default_effort: "medium" }),
      // probe-only allowed id — not present on disk
      entry({ id: "gpt-5.4-codex", efforts: ["low"], default_effort: "low" }),
    ];
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
    const ids = catalog.codex!.models.map((m) => m.id).sort();
    expect(ids).toEqual(["gpt-5.4-codex", "gpt-5.4-mini", "gpt-5.6-sol"]);
    // Union of allowed subsets — never the filtered-out classes.
    expect(ids).not.toContain("internal-not-in-api");
    expect(ids).not.toContain("missing-api-flag");
    expect(ids).not.toContain("codex-auto-review");
    // Shared id: both non-empty efforts → primary (disk) wins per field rules.
    expect(catalog.codex!.models.find((m) => m.id === "gpt-5.6-sol")!.efforts).toEqual(["low"]);
  });
});
