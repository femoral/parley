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

  it("normalizes slug/efforts/default and applies list+supported_in_api filters", () => {
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
      // hide / supported_in_api:false / missing supported_in_api are absent.
    ]);
    const ids = parseCodexModels(json).map((m) => m.id);
    expect(ids).not.toContain("codex-auto-review");
    expect(ids).not.toContain("internal-not-in-api");
    expect(ids).not.toContain("missing-api-flag");
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

describe("parley models command (daemon-owned allowlist + fleet refresh, #322)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    cleanupHome(home);
  });

  it("lists the daemon allowlist as JSON (seeded fake vendor)", async () => {
    const result = await runCli(["models", "--json"], home);
    expect(result.code).toBe(0);
    const allowlist = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(allowlist)).toContain("fake");
    expect((allowlist.fake as Record<string, unknown>)["fake-model"]).toBeDefined();
  });

  it("renders a human table of the allowlist", async () => {
    const result = await runCli(["models"], home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("fake");
    expect(result.stdout).toContain("fake-model");
    expect(result.stdout).toMatch(/efforts:/);
  });

  it("filters to one vendor with --vendor", async () => {
    const result = await runCli(["models", "--vendor", "fake", "--json"], home);
    expect(result.code).toBe(0);
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(["fake"]);
  });

  it("picks up hand-edits of parley.json on the daemon host without restart", async () => {
    // Start the daemon first so the subsequent edit is a true hot pick-up.
    expect((await runCli(["daemon", "start"], home)).code).toBe(0);
    const before = await runCli(["models", "--json"], home);
    expect(before.code).toBe(0);
    expect(JSON.parse(before.stdout).fake["hot-edit-model"]).toBeUndefined();

    const configPath = path.join(home, "parley.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      vendors: { fake: { models: Record<string, unknown> } };
    };
    // At most one default marker per vendor (#185) — do not add a second.
    cfg.vendors.fake.models["hot-edit-model"] = {
      efforts: ["low"],
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const after = await runCli(["models", "--json"], home);
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout).fake["hot-edit-model"]).toEqual({
      efforts: ["low"],
    });
  });

  it("set/unset round-trip an allowlist key over HTTP", async () => {
    const set = await runCli(
      [
        "models",
        "set",
        "vendors.fake.models.round-trip",
        '{"efforts":["low","high"]}',
      ],
      home,
    );
    expect(set.code).toBe(0);
    expect(set.stdout).toMatch(/set vendors\.fake\.models\.round-trip/);

    const listed = await runCli(["models", "--json"], home);
    expect(JSON.parse(listed.stdout).fake["round-trip"]).toEqual({
      efforts: ["low", "high"],
    });

    const unset = await runCli(
      ["models", "unset", "vendors.fake.models.round-trip"],
      home,
    );
    expect(unset.code).toBe(0);
    const after = await runCli(["models", "--json"], home);
    expect(JSON.parse(after.stdout).fake["round-trip"]).toBeUndefined();
  });

  it("rejects smuggling a non-models config key via models set", async () => {
    const res = await runCli(
      ["models", "set", "vendors.fake.bin", "evil-bin"],
      home,
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/limited to vendors\.<id>\.models/);
    // Original config untouched.
    const get = await runCli(["config", "get", "vendors.fake.bin"], home);
    expect(get.code).toBe(1);
  });

  it("refresh returns daemon catalog shape and does not require CLI-local models.json", async () => {
    // Ensure no local catalog file exists on the CLI home before refresh.
    const localCatalog = path.join(home, "models.json");
    if (fs.existsSync(localCatalog)) fs.unlinkSync(localCatalog);

    const result = await runCli(
      ["models", "refresh", "--vendor", "fake", "--json"],
      home,
    );
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout) as {
      daemon: { catalog: Record<string, unknown>; warnings: string[] };
      runners: unknown[];
    };
    expect(out.daemon).toBeDefined();
    expect(out.daemon.catalog).toBeDefined();
    expect(Array.isArray(out.runners)).toBe(true);
    // Daemon persists its catalog under the daemon home (same as this home when local).
    expect(fs.existsSync(localCatalog)).toBe(true);
  });

  it("accepts --refresh as an alias for the refresh subcommand", async () => {
    const result = await runCli(
      ["models", "--refresh", "--vendor", "fake", "--json"],
      home,
    );
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout) as { daemon: unknown; runners: unknown };
    expect(out.daemon).toBeDefined();
    expect(out.runners).toBeDefined();
  });
});

describe("parley models — two clients, one daemon (#322)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) cleanupHome(h);
  });

  it("two remote clients see the same allowlist and each other's edits", async () => {
    const daemonHome = makeHome();
    homes.push(daemonHome);
    // Register two client tokens on the daemon host.
    fs.writeFileSync(
      path.join(daemonHome, "parley.json"),
      JSON.stringify(
        {
          vendors: {
            fake: {
              models: {
                "shared-model": { efforts: ["low", "medium"], default: "medium" },
              },
            },
          },
          clients: {
            alice: { token: "token-alice" },
            bob: { token: "token-bob" },
          },
          // Keep loopback; clients still use daemon.url → same host port.
          daemon: { idleTimeoutMs: 0 },
        },
        null,
        2,
      ),
    );
    expect((await runCli(["daemon", "start"], daemonHome)).code).toBe(0);
    const discovery = JSON.parse(
      fs.readFileSync(path.join(daemonHome, "daemon.json"), "utf8"),
    ) as { port: number };
    const url = `http://127.0.0.1:${discovery.port}`;

    const alice = makeHome({ seedAllowlist: false });
    homes.push(alice);
    const bob = makeHome({ seedAllowlist: false });
    homes.push(bob);
    for (const [clientHome, name, token] of [
      [alice, "alice", "token-alice"],
      [bob, "bob", "token-bob"],
    ] as const) {
      fs.writeFileSync(
        path.join(clientHome, "parley.json"),
        JSON.stringify({
          daemon: { url, client: name, token },
        }),
      );
    }

    const aliceList = await runCli(["models", "--json"], alice);
    expect(aliceList.code).toBe(0);
    expect(JSON.parse(aliceList.stdout)).toEqual({
      fake: { "shared-model": { efforts: ["low", "medium"], default: "medium" } },
    });

    const bobList = await runCli(["models", "--json"], bob);
    expect(bobList.code).toBe(0);
    expect(JSON.parse(bobList.stdout)).toEqual(JSON.parse(aliceList.stdout));

    // Alice edits; Bob sees it. No second default marker (shared-model is default).
    const set = await runCli(
      [
        "models",
        "set",
        "vendors.fake.models.from-alice",
        '{"efforts":["high"]}',
      ],
      alice,
    );
    expect(set.code).toBe(0);

    const bobAfter = await runCli(["models", "--json"], bob);
    expect(bobAfter.code).toBe(0);
    const allow = JSON.parse(bobAfter.stdout) as {
      fake: Record<string, unknown>;
    };
    expect(allow.fake["from-alice"]).toEqual({
      efforts: ["high"],
    });
    expect(allow.fake["shared-model"]).toBeDefined();

    // Bob edits; Alice sees it.
    expect(
      (
        await runCli(
          [
            "models",
            "set",
            "vendors.fake.models.from-bob",
            '{"efforts":["low"]}',
          ],
          bob,
        )
      ).code,
    ).toBe(0);
    const aliceAfter = await runCli(["models", "--json"], alice);
    expect(JSON.parse(aliceAfter.stdout).fake["from-bob"]).toEqual({
      efforts: ["low"],
    });
  });

  it("refresh runs no probe on the CLI host (PATH without vendor bins)", async () => {
    const daemonHome = makeHome();
    homes.push(daemonHome);
    fs.writeFileSync(
      path.join(daemonHome, "parley.json"),
      JSON.stringify({
        vendors: { fake: { models: { "m": { efforts: ["low"], default: "low" } } } },
        clients: { remote: { token: "token-remote" } },
        daemon: { idleTimeoutMs: 0 },
      }),
    );
    expect((await runCli(["daemon", "start"], daemonHome)).code).toBe(0);
    const discovery = JSON.parse(
      fs.readFileSync(path.join(daemonHome, "daemon.json"), "utf8"),
    ) as { port: number };
    const url = `http://127.0.0.1:${discovery.port}`;

    const client = makeHome({ seedAllowlist: false });
    homes.push(client);
    fs.writeFileSync(
      path.join(client, "parley.json"),
      JSON.stringify({
        daemon: { url, client: "remote", token: "token-remote" },
      }),
    );
    // Empty PATH on the client: no vendor CLIs available to probe.
    const emptyBin = path.join(client, "empty-bin");
    fs.mkdirSync(emptyBin);
    const result = await runCli(["models", "refresh", "--vendor", "fake", "--json"], client, {
      extraEnv: {
        PATH: emptyBin,
        // Drop the fake-vendor bin so the client cannot probe even via env.
        PARLEY_FAKE_VENDOR_BIN: "",
      },
    });
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout) as {
      daemon: { catalog: Record<string, unknown> };
      runners: unknown[];
    };
    // Response came from the daemon (has catalog envelope) even though the
    // client host has nothing on PATH.
    expect(out.daemon.catalog).toBeDefined();
    expect(Array.isArray(out.runners)).toBe(true);
    // Client home must not grow a models.json from a local probe path.
    expect(fs.existsSync(path.join(client, "models.json"))).toBe(false);
  });
});
