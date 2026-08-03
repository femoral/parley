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

/**
 * True when `key` addresses the vendor model-allowlist subtree only.
 *
 * Allowed shapes:
 * - `vendors.<id>.models` — whole allowlist map for one vendor
 * - `vendors.<id>.models.<modelId>` — one model entry (model ids may contain
 *   dots? No — config keys split on `.`, so model ids with dots are not
 *   addressable as a single segment; set the whole map for those.)
 *
 * Rejects `vendors.<id>.bin`, `daemon.*`, `runners.*`, bare `vendors`, etc.
 */
export function isModelsAllowlistKey(key: string): boolean {
  if (typeof key !== "string" || key === "") return false;
  const parts = key.split(".");
  // vendors.<id>.models  OR  vendors.<id>.models.<modelId>
  if (parts.length < 3 || parts.length > 4) return false;
  if (parts[0] !== "vendors") return false;
  if (parts[1] === undefined || parts[1] === "") return false;
  if (parts[2] !== "models") return false;
  if (parts.length === 4 && (parts[3] === undefined || parts[3] === "")) return false;
  return true;
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
   * Milliseconds since `last_seen` (advertisement age). No runner round-trip —
   * the stored row is the source of truth (#314 / #322).
   */
  advertised_age_ms: number;
}

export interface ModelsRefreshResult {
  /** Daemon host: just re-probed via refreshCatalog (warnings preserved, #299). */
  daemon: {
    catalog: ModelCatalog;
    warnings: string[];
  };
  /** Each registered runner's last-advertised catalog + age. */
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
 * project every runner's last-advertised catalog with advertisement age.
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
      advertised_age_ms: age,
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
