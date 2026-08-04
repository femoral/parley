/**
 * Daemon-owned model catalog + allowlist surface (#322).
 *
 * Routes under `/models` are CLIENT-class (token-authenticated off-loopback)
 * for both read and edit — dedicated remote allowlist edits, distinct from
 * raw config-admin which stays loopback-only (#323 / ADR-0030).
 *
 * Edit routes are intentionally scoped to the `vendors.<id>.models` subtree
 * only. Accepting arbitrary dotted keys here would reopen the config-admin
 * hole (mint runners, change bind, rewrite bin/args/env, …).
 *
 * Model ids commonly contain dots (`gpt-5.6-sol`, opencode/pi ids). Paths are
 * parsed as `vendors` / `<vendorId>` / `models` / `<modelId…>` where the model
 * id is the remainder re-joined with dots — not a hard 4-segment cap.
 */
import {
  loadCatalog,
  readConfig,
  refreshCatalog,
  writeCatalog,
  type HomePaths,
  type ModelCatalog,
  type ModelProber,
  type ParleyConfig,
  type RunnerCapabilities,
  type VendorConfig,
  type VendorModelAllowlistEntry,
} from "@useparley/core";
import type { RunnerRow } from "./db.js";

/** Object-prototype poison keys — never allow as vendor or model ids. */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ModelsAllowlistKeyOk = {
  ok: true;
  vendorId: string;
  /** Null when the key addresses the whole `models` map for the vendor. */
  modelId: string | null;
};

export type ModelsAllowlistKeyErr = {
  ok: false;
  /** Honest rejection message for 400 responses. */
  error: string;
};

/**
 * Parse a models-edit key into vendor + optional model id.
 *
 * Allowed shapes:
 * - `vendors.<id>.models` — whole allowlist map for one vendor
 * - `vendors.<id>.models.<modelId>` — one model entry; modelId may contain
 *   dots (`gpt-5.6-sol`) because everything after segment 3 is re-joined
 *
 * Rejects empty vendor/model ids, `*` vendor (no wildcard semantics),
 * reserved dunder ids (`__proto__`, `constructor`, `prototype`) in either
 * position, and any key outside the models subtree.
 */
export function parseModelsAllowlistKey(key: string): ModelsAllowlistKeyOk | ModelsAllowlistKeyErr {
  if (typeof key !== "string" || key === "") {
    return { ok: false, error: "key is required" };
  }
  const parts = key.split(".");
  if (parts.length < 3) {
    return {
      ok: false,
      error:
        `models edit is limited to vendors.<id>.models[.<modelId>]; refused key: ${key}`,
    };
  }
  if (parts[0] !== "vendors") {
    return {
      ok: false,
      error:
        `models edit is limited to vendors.<id>.models[.<modelId>]; refused key: ${key}`,
    };
  }
  if (parts[2] !== "models") {
    return {
      ok: false,
      error:
        `models edit is limited to vendors.<id>.models[.<modelId>]; refused key: ${key}`,
    };
  }
  // Reject empty segments in the fixed prefix (vendors..models / vendors.x.models.).
  if (parts.slice(0, 3).some((p) => p === "")) {
    return {
      ok: false,
      error: `invalid models key (empty path segment): ${key}`,
    };
  }

  const vendorId = parts[1]!;
  if (vendorId === "*") {
    return {
      ok: false,
      error: `vendor id '*' is not allowed (no wildcard semantics)`,
    };
  }
  if (RESERVED_IDS.has(vendorId)) {
    return {
      ok: false,
      error: `refused reserved id in vendor position: ${vendorId}`,
    };
  }

  if (parts.length === 3) {
    return { ok: true, vendorId, modelId: null };
  }

  // Model id = remainder of the path re-joined with dots (F1).
  const modelId = parts.slice(3).join(".");
  if (modelId === "" || parts.slice(3).some((p) => p === "")) {
    return {
      ok: false,
      error: `invalid models key (empty model id segment): ${key}`,
    };
  }
  if (RESERVED_IDS.has(modelId) || parts.slice(3).some((p) => RESERVED_IDS.has(p))) {
    return {
      ok: false,
      error: `refused reserved id in model position: ${modelId}`,
    };
  }
  return { ok: true, vendorId, modelId };
}

/**
 * True when `key` addresses the vendor model-allowlist subtree only.
 * Prefer {@link parseModelsAllowlistKey} when an error message is needed.
 */
export function isModelsAllowlistKey(key: string): boolean {
  return parseModelsAllowlistKey(key).ok;
}

/**
 * Set a models-allowlist path without splitting the model id on dots.
 * (Generic `setConfigPath` would nest `gpt-5.6-sol` as gpt-5 → 6 → sol.)
 */
export function setModelsAllowlistPath(
  root: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const parsed = parseModelsAllowlistKey(key);
  if (!parsed.ok) throw new Error(parsed.error);

  const result = structuredClone(root) as Record<string, unknown>;
  if (!isRecord(result.vendors)) {
    result.vendors = {};
  }
  const vendors = result.vendors as Record<string, unknown>;
  const existing = vendors[parsed.vendorId];
  if (existing !== undefined && !isRecord(existing)) {
    throw new Error(
      `invalid config key ${key}: vendors.${parsed.vendorId} is not an object`,
    );
  }
  const vendor: Record<string, unknown> = isRecord(existing)
    ? { ...existing }
    : {};
  vendors[parsed.vendorId] = vendor;

  if (parsed.modelId === null) {
    vendor.models = value;
    return result;
  }

  const modelsRaw = vendor.models;
  if (modelsRaw !== undefined && !isRecord(modelsRaw)) {
    throw new Error(
      `invalid config key ${key}: vendors.${parsed.vendorId}.models is not an object`,
    );
  }
  const models: Record<string, unknown> = isRecord(modelsRaw) ? { ...modelsRaw } : {};
  models[parsed.modelId] = value;
  vendor.models = models;
  return result;
}

/**
 * Unset a models-allowlist path, treating dotted model ids as a single leaf key.
 */
export function unsetModelsAllowlistPath(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const parsed = parseModelsAllowlistKey(key);
  if (!parsed.ok) throw new Error(parsed.error);

  const result = structuredClone(root) as Record<string, unknown>;
  if (!isRecord(result.vendors)) {
    throw new Error(`no such config key: ${key}`);
  }
  const vendors = result.vendors as Record<string, unknown>;
  const vendor = vendors[parsed.vendorId];
  if (!isRecord(vendor)) {
    throw new Error(`no such config key: ${key}`);
  }

  if (parsed.modelId === null) {
    if (!("models" in vendor)) {
      throw new Error(`no such config key: ${key}`);
    }
    const nextVendor = { ...vendor };
    delete nextVendor.models;
    vendors[parsed.vendorId] = nextVendor;
    return result;
  }

  if (!isRecord(vendor.models) || !(parsed.modelId in vendor.models)) {
    throw new Error(`no such config key: ${key}`);
  }
  const models = { ...(vendor.models as Record<string, unknown>) };
  delete models[parsed.modelId];
  vendors[parsed.vendorId] = { ...vendor, models };
  return result;
}

/** Collect `vendors.*.models` maps from a hot-loaded config. */
export function extractAllowlist(
  config: ParleyConfig,
  vendorFilter?: string,
): Record<string, Record<string, VendorModelAllowlistEntry>> {
  const out: Record<string, Record<string, VendorModelAllowlistEntry>> = {};
  const vendors = config.vendors ?? {};
  for (const [id, entry] of Object.entries(vendors)) {
    if (vendorFilter !== undefined && id !== vendorFilter) continue;
    const models = entry?.models;
    if (models === undefined) continue;
    out[id] = models;
  }
  return out;
}

export interface RunnerCatalogEntry {
  name: string;
  /** Last-advertised capabilities (model catalogs) at registration / re-fingerprint. */
  capabilities: RunnerCapabilities;
  last_seen: string;
  registered_at: string;
  /**
   * Milliseconds since `last_seen` (presence / last contact — lease polls and
   * task traffic refresh this, so it is **not** capabilities advertisement age).
   *
   * True capabilities age needs a `capabilities_updated_at` column on the
   * runners table (follow-up issue); do not invent that here without a migration.
   */
  last_contact_age_ms: number;
}

export interface ModelsRefreshResult {
  /** Daemon host: just re-probed via refreshCatalog (warnings preserved, #299). */
  daemon: {
    catalog: ModelCatalog;
    warnings: string[];
  };
  /** Each registered runner's last-advertised catalog + last-contact age. */
  runners: RunnerCatalogEntry[];
}

function parseCapabilitiesJson(raw: string): RunnerCapabilities {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { vendors?: unknown }).vendors)
    ) {
      return parsed as RunnerCapabilities;
    }
  } catch {
    /* fall through */
  }
  return { vendors: [] };
}

/**
 * Re-fingerprint the daemon host (refreshCatalog + write models.json) and
 * project every runner's last-advertised catalog with last-contact age.
 * Probes never leave this host — runners are not contacted.
 */
export async function refreshFleetCatalog(options: {
  paths: HomePaths;
  adapters: Map<string, ModelProber & { id?: string }>;
  runners: RunnerRow[];
  vendor?: string;
  now?: () => string;
  nowMs?: () => number;
}): Promise<ModelsRefreshResult> {
  const nowIso = options.now ?? (() => new Date().toISOString());
  const nowMs = options.nowMs ?? (() => Date.now());
  const file = options.paths.models;
  let catalog = loadCatalog(file);
  const targets =
    options.vendor !== undefined
      ? [options.vendor]
      : Object.keys(catalog).length > 0
        ? Object.keys(catalog)
        : [...options.adapters.keys()];
  const result = await refreshCatalog(catalog, targets, options.adapters, nowIso);
  catalog = result.catalog;
  writeCatalog(file, catalog);

  const view =
    options.vendor !== undefined
      ? catalog[options.vendor] !== undefined
        ? { [options.vendor]: catalog[options.vendor]! }
        : {}
      : catalog;

  const runners: RunnerCatalogEntry[] = options.runners.map((row) => {
    const caps = parseCapabilitiesJson(row.capabilities);
    let filtered = caps;
    if (options.vendor !== undefined) {
      filtered = {
        vendors: caps.vendors.filter((v) => v.id === options.vendor),
      };
    }
    const lastMs = Date.parse(row.last_seen);
    const age = Number.isFinite(lastMs) ? Math.max(0, nowMs() - lastMs) : 0;
    return {
      name: row.name,
      capabilities: filtered,
      last_seen: row.last_seen,
      registered_at: row.registered_at,
      last_contact_age_ms: age,
    };
  });

  return {
    daemon: { catalog: view, warnings: result.warnings },
    runners,
  };
}

/** Load daemon admin config (missing → {}). */
export function loadDaemonConfig(paths: HomePaths): ParleyConfig {
  return readConfig(paths.config);
}

/** Type guard for a vendor config map entry used when projecting allowlists. */
export function vendorModelsOf(
  vendors: ParleyConfig["vendors"],
  id: string,
): VendorConfig["models"] | undefined {
  return vendors?.[id]?.models;
}
