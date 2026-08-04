/**
 * Daemon /models surface (#322): allowlist CRUD (CLIENT-class, subtree-scoped)
 * and fleet refresh (daemon re-fingerprint + runner advertisement ages).
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths, type ParleyConfig } from "@useparley/core";
import { openDatabase, upsertRunner, type DatabaseHandle } from "../src/db.js";
import {
  extractAllowlist,
  isModelsAllowlistKey,
  parseModelsAllowlistKey,
  refreshFleetCatalog,
  setModelsAllowlistPath,
} from "../src/models-http.js";
import {
  classifyAuthRoute,
  isModelsAllowlistKey as exportedKeyGuard,
  startServer,
  type DaemonServer,
} from "../src/server.js";
import { withFakeAllowlist } from "./helpers.js";
import type { ModelProber } from "@useparley/core";

const homes: string[] = [];
let server: DaemonServer | null = null;
const dbs: DatabaseHandle[] = [];

function makeHome(config: Record<string, unknown> = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-models-http-"));
  homes.push(home);
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(
      withFakeAllowlist({
        clients: { laptop: { token: "fake-client-token" } },
        ...config,
      }),
    ),
  );
  return home;
}

async function boot(home: string, opts: { bind?: string } = {}): Promise<string> {
  server = await startServer(homePaths(home), { bind: opts.bind });
  return `http://127.0.0.1:${server.port}`;
}

async function json(
  base: string,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed };
}

afterEach(async () => {
  if (server !== null) {
    await server.close();
    server = null;
  }
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("isModelsAllowlistKey (subtree scope)", () => {
  it("accepts vendors.<id>.models and model ids that contain dots (F1)", () => {
    expect(isModelsAllowlistKey("vendors.fake.models")).toBe(true);
    expect(isModelsAllowlistKey("vendors.codex.models.gpt-5")).toBe(true);
    expect(isModelsAllowlistKey("vendors.codex.models.gpt-5.6-sol")).toBe(true);
    expect(isModelsAllowlistKey("vendors.opencode.models.opencode/gpt-5.2")).toBe(true);
    // Two-dot id: remainder after models/ is one model id.
    expect(isModelsAllowlistKey("vendors.opencode.models.foo.bar.baz")).toBe(true);
    expect(exportedKeyGuard("vendors.x.models.y")).toBe(true);
    const dotted = parseModelsAllowlistKey("vendors.codex.models.gpt-5.6-sol");
    expect(dotted).toEqual({
      ok: true,
      vendorId: "codex",
      modelId: "gpt-5.6-sol",
    });
  });

  it("rejects config-admin keys that must not be writable remotely", () => {
    expect(isModelsAllowlistKey("vendors.fake.bin")).toBe(false);
    expect(isModelsAllowlistKey("vendors.fake.args")).toBe(false);
    expect(isModelsAllowlistKey("daemon.bind")).toBe(false);
    expect(isModelsAllowlistKey("daemon.url")).toBe(false);
    expect(isModelsAllowlistKey("clients.evil.token")).toBe(false);
    expect(isModelsAllowlistKey("runners.gpu.token")).toBe(false);
    expect(isModelsAllowlistKey("vendors")).toBe(false);
    expect(isModelsAllowlistKey("vendors.fake")).toBe(false);
    expect(isModelsAllowlistKey("")).toBe(false);
  });

  it("rejects reserved dunder ids and wildcard vendor * (F1)", () => {
    expect(parseModelsAllowlistKey("vendors.__proto__.models").ok).toBe(false);
    expect(parseModelsAllowlistKey("vendors.fake.models.__proto__").ok).toBe(false);
    expect(parseModelsAllowlistKey("vendors.fake.models.constructor").ok).toBe(false);
    expect(parseModelsAllowlistKey("vendors.fake.models.prototype").ok).toBe(false);
    expect(parseModelsAllowlistKey("vendors.*.models").ok).toBe(false);
    expect(parseModelsAllowlistKey("vendors.*.models.x")!.ok).toBe(false);
    const star = parseModelsAllowlistKey("vendors.*.models");
    expect(star.ok).toBe(false);
    if (!star.ok) expect(star.error).toMatch(/wildcard|'\*'/);
    const proto = parseModelsAllowlistKey("vendors.fake.models.__proto__");
    expect(proto.ok).toBe(false);
    if (!proto.ok) expect(proto.error).toMatch(/reserved id/);
  });

  it("setModelsAllowlistPath keeps dotted model ids as a single leaf key", () => {
    const next = setModelsAllowlistPath(
      { vendors: { codex: { models: {} } } },
      "vendors.codex.models.gpt-5.6-sol",
      { efforts: ["low"] },
    );
    const models = (next as { vendors: { codex: { models: Record<string, unknown> } } })
      .vendors.codex.models;
    expect(models["gpt-5.6-sol"]).toEqual({ efforts: ["low"] });
    // Must not nest as gpt-5 → 6 → sol.
    expect(models["gpt-5"]).toBeUndefined();
  });
});

describe("classifyAuthRoute — /models is CLIENT-class", () => {
  it("classifies read and edit models routes as client (not config-admin)", () => {
    expect(classifyAuthRoute("GET", "/models")).toBe("client");
    expect(classifyAuthRoute("POST", "/models/set")).toBe("client");
    expect(classifyAuthRoute("POST", "/models/unset")).toBe("client");
    expect(classifyAuthRoute("POST", "/models/refresh")).toBe("client");
    // Contrast: raw config writes remain config-admin.
    expect(classifyAuthRoute("POST", "/config/set")).toBe("config-admin");
  });
});

describe("extractAllowlist", () => {
  it("projects vendors.*.models and filters by vendor", () => {
    const config: ParleyConfig = {
      vendors: {
        fake: { models: { m: { efforts: ["low"] } }, bin: "fake" },
        codex: { models: { "gpt-x": { efforts: ["high"], default: "high" } } },
      },
    };
    expect(extractAllowlist(config)).toEqual({
      fake: { m: { efforts: ["low"] } },
      codex: { "gpt-x": { efforts: ["high"], default: "high" } },
    });
    expect(extractAllowlist(config, "fake")).toEqual({
      fake: { m: { efforts: ["low"] } },
    });
  });
});

describe("HTTP /models routes", () => {
  it("GET returns the allowlist; hand-edit is hot", async () => {
    const home = makeHome();
    const base = await boot(home);
    const first = await json(base, "GET", "/models");
    expect(first.status).toBe(200);
    const body = first.body as { allowlist: { fake: Record<string, unknown> } };
    expect(body.allowlist.fake).toBeDefined();

    const cfgPath = path.join(home, "parley.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      vendors: { fake: { models: Record<string, unknown> } };
    };
    // No second default marker — allowlist may have at most one (#185).
    cfg.vendors.fake.models["hand"] = { efforts: ["low"] };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    const second = await json(base, "GET", "/models");
    expect(second.status).toBe(200);
    expect(
      (second.body as { allowlist: { fake: Record<string, unknown> } }).allowlist.fake
        .hand,
    ).toEqual({ efforts: ["low"] });
  });

  it("POST set/unset round-trips a models key", async () => {
    const home = makeHome();
    const base = await boot(home);
    const set = await json(base, "POST", "/models/set", {
      key: "vendors.fake.models.extra",
      // No default — TEST_FAKE_MODELS already marks one default model.
      value: { efforts: ["medium"] },
    });
    expect(set.status).toBe(200);
    const setBody = set.body as { allowlist: { fake: Record<string, unknown> } };
    expect(setBody.allowlist.fake.extra).toEqual({
      efforts: ["medium"],
    });

    const unset = await json(base, "POST", "/models/unset", {
      key: "vendors.fake.models.extra",
    });
    expect(unset.status).toBe(200);
    expect(
      (unset.body as { allowlist: { fake: Record<string, unknown> } }).allowlist.fake
        .extra,
    ).toBeUndefined();
  });

  it("rejects smuggling a non-models key (subtree scope proof)", async () => {
    const home = makeHome();
    const base = await boot(home);
    for (const key of [
      "vendors.fake.bin",
      "daemon.bind",
      "clients.evil.token",
      "runners.gpu.token",
      "profiles.fast.vendor",
    ]) {
      const res = await json(base, "POST", "/models/set", { key, value: "x" });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(
        /limited to vendors|refused key/,
      );
    }
    // Config file must not have grown those keys.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, "parley.json"), "utf8"),
    ) as ParleyConfig;
    expect(onDisk.daemon).toBeUndefined();
    expect(onDisk.clients?.evil).toBeUndefined();
  });

  it("POST set/unset keeps dotted model ids as a single leaf (gpt-5.6-sol)", async () => {
    const home = makeHome({
      vendors: {
        fake: {
          models: { "fake-model": { efforts: ["low"], default: "low" } },
        },
        codex: { models: {} },
      },
    });
    const base = await boot(home);
    const set = await json(base, "POST", "/models/set", {
      key: "vendors.codex.models.gpt-5.6-sol",
      value: { efforts: ["medium"], default: "medium" },
    });
    expect(set.status).toBe(200);
    const setBody = set.body as {
      allowlist: { codex: Record<string, unknown> };
    };
    expect(setBody.allowlist.codex["gpt-5.6-sol"]).toEqual({
      efforts: ["medium"],
      default: "medium",
    });
    // Nested gpt-5.6 must not appear.
    expect(setBody.allowlist.codex["gpt-5"]).toBeUndefined();

    const unset = await json(base, "POST", "/models/unset", {
      key: "vendors.codex.models.gpt-5.6-sol",
    });
    expect(unset.status).toBe(200);
    expect(
      (unset.body as { allowlist: { codex?: Record<string, unknown> } }).allowlist
        .codex?.["gpt-5.6-sol"],
    ).toBeUndefined();
  });

  it("POST set rejects __proto__ and * with honest 400 (not a silent drop)", async () => {
    const home = makeHome();
    const base = await boot(home);
    const proto = await json(base, "POST", "/models/set", {
      key: "vendors.fake.models.__proto__",
      value: { efforts: ["low"] },
    });
    expect(proto.status).toBe(400);
    expect((proto.body as { error: string }).error).toMatch(/reserved id/);

    const star = await json(base, "POST", "/models/set", {
      key: "vendors.*.models",
      value: {},
    });
    expect(star.status).toBe(400);
    expect((star.body as { error: string }).error).toMatch(/wildcard|'\*'/);

    // On-disk config must not have gained a "*" vendor or poisoned models.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, "parley.json"), "utf8"),
    ) as ParleyConfig;
    expect(onDisk.vendors?.["*"]).toBeUndefined();
    // Bracket __proto__ hits the prototype getter — assert own-key absence.
    const fakeModels = onDisk.vendors?.fake?.models as
      | Record<string, unknown>
      | undefined;
    expect(fakeModels !== undefined && Object.hasOwn(fakeModels, "__proto__")).toBe(
      false,
    );
  });

  it("off-loopback: models set works with client token; config set stays 403", async () => {
    const home = makeHome();
    const { port } = await (async () => {
      server = await startServer(homePaths(home), { bind: "0.0.0.0" });
      return { port: server.port };
    })();
    // Find a non-loopback interface if any; otherwise skip live dial and still
    // assert classification + the loopback path for models set.
    const nets = os.networkInterfaces();
    let remote: string | null = null;
    for (const entries of Object.values(nets)) {
      if (!entries) continue;
      for (const e of entries) {
        if (e.family === "IPv4" && !e.internal) {
          remote = e.address;
          break;
        }
      }
      if (remote) break;
    }
    if (remote === null) {
      // No non-loopback IP (rare CI) — pure classification already covered.
      return;
    }
    const base = `http://${remote}:${port}`;
    const auth = { authorization: "Bearer fake-client-token" };
    const modelsSet = await json(
      base,
      "POST",
      "/models/set",
      {
        key: "vendors.fake.models.remote-ok",
        value: { efforts: ["low"] },
      },
      auth,
    );
    expect(modelsSet.status).toBe(200);

    const configSet = await json(
      base,
      "POST",
      "/config/set",
      { key: "vendors.fake.bin", value: "nope" },
      auth,
    );
    expect(configSet.status).toBe(403);
  });

  it("POST /models/refresh returns daemon catalog + runner ages", async () => {
    const home = makeHome();
    const paths = homePaths(home);
    // Seed a runner row directly (no runner process) so refresh can attach ages.
    const db = openDatabase(paths);
    dbs.push(db);
    const past = new Date(Date.now() - 12_000).toISOString();
    upsertRunner(db, {
      name: "gpu",
      capabilities: JSON.stringify({
        vendors: [
          {
            id: "fake",
            models: [{ id: "runner-m", efforts: ["low"], default_effort: "low" }],
          },
        ],
      }),
      protocol_version: 1,
      build_version: "test",
    });
    // Force last_seen into the past for a non-zero age.
    db.prepare(`UPDATE runners SET last_seen = ?, registered_at = ? WHERE name = ?`).run(
      past,
      past,
      "gpu",
    );
    db.close();
    dbs.pop();

    const base = await boot(home);
    const res = await json(base, "POST", "/models/refresh", { vendor: "fake" });
    expect(res.status).toBe(200);
    const body = res.body as {
      daemon: { catalog: Record<string, unknown>; warnings: string[] };
      runners: Array<{
        name: string;
        last_contact_age_ms: number;
        last_seen: string;
        capabilities: { vendors: Array<{ id: string }> };
      }>;
    };
    expect(body.daemon.catalog).toBeDefined();
    expect(Array.isArray(body.daemon.warnings)).toBe(true);
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0]!.name).toBe("gpu");
    // last_seen was backdated ~12s — field is last contact, not advertisement age.
    expect(body.runners[0]!.last_contact_age_ms).toBeGreaterThanOrEqual(10_000);
    expect(body.runners[0]!.capabilities.vendors.some((v) => v.id === "fake")).toBe(
      true,
    );
  });
});

describe("refreshFleetCatalog (unit)", () => {
  it("writes models.json and attaches last_contact_age_ms from last_seen", async () => {
    const home = makeHome();
    const paths = homePaths(home);
    const db = openDatabase(paths);
    dbs.push(db);
    const past = new Date(Date.now() - 5_000).toISOString();
    upsertRunner(db, {
      name: "cpu",
      capabilities: JSON.stringify({
        vendors: [{ id: "codex", models: [] }],
      }),
      protocol_version: 1,
      build_version: "t",
    });
    db.prepare(`UPDATE runners SET last_seen = ? WHERE name = ?`).run(past, "cpu");
    const rows = db
      .prepare(
        `SELECT name, capabilities, protocol_version, build_version, registered_at, last_seen, last_completed_at FROM runners`,
      )
      .all() as Array<{
      name: string;
      capabilities: string;
      protocol_version: number;
      build_version: string;
      registered_at: string;
      last_seen: string;
      last_completed_at: string | null;
    }>;
    db.close();
    dbs.pop();

    const result = await refreshFleetCatalog({
      paths,
      adapters: new Map(),
      runners: rows,
      vendor: "codex",
      now: () => "2026-08-03T00:00:00.000Z",
      nowMs: () => Date.parse(past) + 5_000,
    });
    expect(result.daemon.catalog).toBeDefined();
    expect(fs.existsSync(paths.models)).toBe(true);
    expect(result.runners).toHaveLength(1);
    expect(result.runners[0]!.last_contact_age_ms).toBe(5_000);
  });

  it("propagates non-empty discovery warnings from a failing probe (#299 / F3)", async () => {
    const home = makeHome();
    const paths = homePaths(home);
    // Empty entry so fallback path still runs after both channels fail.
    fs.writeFileSync(
      paths.models,
      JSON.stringify({
        "probe-vendor": { fetched_at: null, source: "manual", models: [] },
      }),
    );
    const failing: ModelProber = {
      listModels: () => Promise.reject(new Error("probe exploded for warning test")),
      readModels: () =>
        Promise.resolve({
          source: "disk",
          models: [],
          warnings: ["config.toml empty-channel note"],
        }),
    };
    const result = await refreshFleetCatalog({
      paths,
      adapters: new Map([["probe-vendor", failing]]),
      runners: [],
      vendor: "probe-vendor",
    });
    // Neuter-proof: hardcoding warnings: [] here would fail this assertion.
    expect(result.daemon.warnings.length).toBeGreaterThan(0);
    const joined = result.daemon.warnings.join("\n");
    expect(joined).toMatch(/probe exploded for warning test|empty-channel note|probe-vendor/);
  });
});
