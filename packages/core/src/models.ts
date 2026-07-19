import fs from "node:fs";
import path from "node:path";
import {
  SHIPPED_CATALOG_RETRIEVED_AT,
  SHIPPED_CATALOG_VENDOR_IDS,
  SHIPPED_MODEL_CATALOG,
} from "./shipped-model-catalog.js";

export { SHIPPED_CATALOG_RETRIEVED_AT, SHIPPED_CATALOG_VENDOR_IDS, SHIPPED_MODEL_CATALOG };

/**
 * One model an adapter advertises. The catalog is advisory only: `delegate`
 * never consults it and keeps passing `--model`/`--effort` through opaquely.
 * `efforts` is the vendor's advertised reasoning-effort set (may be empty when
 * the vendor exposes none, e.g. grok's text listing).
 */
export interface ModelEntry {
  id: string;
  efforts: string[];
  /** The vendor's default effort for this model, or null when unknown. */
  default_effort: string | null;
  label?: string;
  notes?: string;
}

/** One vendor's slice of the catalog file (`~/.parley/models.json`). */
export interface VendorModels {
  /** ISO timestamp of the last successful `--refresh`; null when never probed. */
  fetched_at: string | null;
  /** Where the entry came from: a probe command (`codex debug models`) or `manual`. */
  source: string;
  models: ModelEntry[];
  effort_levels?: string[];
  notes?: string;
}

/** The whole catalog: vendor id → its models. The file is the source of truth. */
export type ModelCatalog = Record<string, VendorModels>;

/** What an adapter's `--refresh` probe yields; the catalog stamps `fetched_at`. */
export interface ProbedModels {
  /** The probe command, recorded as the entry's `source` (e.g. `codex debug models`). */
  source: string;
  models: ModelEntry[];
}

/**
 * The catalog-refresh capability `refreshCatalog` needs from a vendor adapter —
 * the structural slice of the daemon's `VendorAdapter`. Kept minimal so this
 * shared package stays a leaf (no dependency back into the daemon).
 */
export interface ModelProber {
  listModels?(existing: VendorModels | undefined): Promise<ProbedModels>;
}

/**
 * Local, user-patchable model/effort catalog (`parley models`, #29).
 *
 * The file at `~/.parley/models.json` is the source of truth: `parley models`
 * reads it directly so a user can hand-edit it to add models or efforts with no
 * code change. `--refresh` re-probes vendors via each adapter's optional
 * `listModels()` hook and rewrites their entry — but a failed or empty probe
 * keeps the existing entry (never clobber a manual patch with nothing). The
 * catalog is advisory only: `delegate` still passes `--model`/`--effort` through
 * opaquely and never consults it.
 */

/**
 * The seed written when no catalog file exists yet. Gives the user a concrete,
 * hand-editable starting point; refreshing overwrites these with live probes.
 */
export const DEFAULT_CATALOG: ModelCatalog = SHIPPED_MODEL_CATALOG;

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return [...value];
}

export function parseModelEntry(value: unknown): ModelEntry {
  const input = object(value, "model entry");
  if (typeof input.id !== "string") throw new TypeError("model entry id must be a string");
  if (input.default_effort !== null && typeof input.default_effort !== "string") {
    throw new TypeError("model entry default_effort must be a string or null");
  }
  if (input.label !== undefined && typeof input.label !== "string") throw new TypeError("model entry label must be a string");
  if (input.notes !== undefined && typeof input.notes !== "string") throw new TypeError("model entry notes must be a string");
  return {
    id: input.id,
    efforts: strings(input.efforts, "model entry efforts"),
    default_effort: input.default_effort,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}

export function parseVendorModels(value: unknown): VendorModels {
  const input = object(value, "vendor models");
  if (input.fetched_at !== null && typeof input.fetched_at !== "string") throw new TypeError("vendor models fetched_at must be a string or null");
  if (typeof input.source !== "string") throw new TypeError("vendor models source must be a string");
  if (!Array.isArray(input.models)) throw new TypeError("vendor models models must be an array");
  if (input.notes !== undefined && typeof input.notes !== "string") throw new TypeError("vendor models notes must be a string");
  return {
    fetched_at: input.fetched_at,
    source: input.source,
    models: input.models.map(parseModelEntry),
    ...(input.effort_levels === undefined ? {} : { effort_levels: strings(input.effort_levels, "vendor models effort_levels") }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}

export function parseModelCatalog(value: unknown): ModelCatalog {
  const input = object(value, "model catalog");
  return Object.fromEntries(Object.entries(input).map(([id, vendor]) => [id, parseVendorModels(vendor)]));
}

export function getShippedModelCatalog(): ModelCatalog {
  return structuredClone(SHIPPED_MODEL_CATALOG);
}

export function getShippedVendorModels(id: string): VendorModels | undefined {
  const vendor = SHIPPED_MODEL_CATALOG[id];
  return vendor === undefined ? undefined : structuredClone(vendor);
}

/** A deep copy of the seed (so callers never mutate the shared constant). */
function seedCatalog(): ModelCatalog {
  return structuredClone(DEFAULT_CATALOG);
}

/**
 * Read the catalog from `file`, returning the seed when it does not exist. A
 * corrupt (unparseable) file is surfaced as an error, never silently replaced —
 * the file is a hand-editable artifact and a syntax slip must not lose the
 * user's patches.
 */
export function loadCatalog(file: string): ModelCatalog {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return seedCatalog();
    throw err;
  }
  try {
    return JSON.parse(text) as ModelCatalog;
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); ` +
        "fix or delete it to regenerate the default catalog",
    );
  }
}

/** Write the catalog to `file` as pretty JSON, creating parent dirs as needed. */
export function writeCatalog(file: string, catalog: ModelCatalog): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);
}

/** The outcome of a `--refresh`: the (possibly) updated catalog plus warnings. */
export interface RefreshResult {
  catalog: ModelCatalog;
  /** One per vendor whose entry was kept or filled from the shipped catalog. */
  warnings: string[];
}

/**
 * When a live probe is unavailable/empty/failed and the catalog entry would
 * leave the user with no models, fill from the shipped reference catalog
 * (`getShippedVendorModels`) and label the source clearly. Never clobbers an
 * existing non-empty entry (manual patches and prior live data survive).
 */
function applyRefreshFallback(
  next: ModelCatalog,
  id: string,
  reason: string,
  warnings: string[],
): void {
  const existing = next[id];
  if (existing !== undefined && existing.models.length > 0) {
    warnings.push(`${id}: ${reason}; kept existing entry`);
    return;
  }
  const shipped = getShippedVendorModels(id);
  if (shipped !== undefined && shipped.models.length > 0) {
    next[id] = {
      ...shipped,
      source: `shipped catalog (point-in-time reference; ${shipped.source})`,
    };
    const when = shipped.fetched_at ?? "unknown date";
    warnings.push(
      `${id}: ${reason}; using shipped catalog as point-in-time reference ` +
        `(retrieved ${when})`,
    );
    return;
  }
  warnings.push(`${id}: ${reason}; kept existing entry`);
}

/**
 * Re-probe `vendorIds` and rewrite their catalog entries from the live vendor
 * CLIs. A successful probe with models always wins. When a vendor has no probe
 * hook, its probe rejects, or it returns no models: keep any non-empty existing
 * entry (never clobber a manual patch); if the entry would be empty, fall back
 * to the shipped reference catalog when it has models, labeled as point-in-time
 * reference data. Pure w.r.t. the input catalog — returns a new object; the
 * caller persists it. `now` is injected for deterministic tests.
 */
export async function refreshCatalog<A extends ModelProber>(
  catalog: ModelCatalog,
  vendorIds: string[],
  adapters: Map<string, A>,
  now: () => string = () => new Date().toISOString(),
): Promise<RefreshResult> {
  const next = structuredClone(catalog);
  const warnings: string[] = [];
  for (const id of vendorIds) {
    const adapter = adapters.get(id);
    if (!adapter?.listModels) {
      applyRefreshFallback(next, id, "no refresh probe available", warnings);
      continue;
    }
    try {
      const probed = await adapter.listModels(next[id]);
      if (probed.models.length === 0) {
        applyRefreshFallback(next, id, "probe returned no models", warnings);
        continue;
      }
      next[id] = { fetched_at: now(), source: probed.source, models: probed.models };
    } catch (err) {
      applyRefreshFallback(
        next,
        id,
        `probe failed (${err instanceof Error ? err.message : String(err)})`,
        warnings,
      );
    }
  }
  return { catalog: next, warnings };
}
