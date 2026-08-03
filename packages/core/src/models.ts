import fs from "node:fs";
import path from "node:path";
import {
  SHIPPED_CATALOG_RETRIEVED_AT,
  SHIPPED_CATALOG_VENDOR_IDS,
  SHIPPED_MODEL_CATALOG,
} from "./shipped-model-catalog.js";
import { collapseOperatorHomeInText } from "./vendor-home.js";

export { SHIPPED_CATALOG_RETRIEVED_AT, SHIPPED_CATALOG_VENDOR_IDS, SHIPPED_MODEL_CATALOG };

/**
 * One model an adapter advertises. The catalog is advisory only: discovery
 * (wizard choices, nearest-combo suggestions). The per-vendor allowlist
 * (`vendors.<id>.models`, #185 / ADR-0014) is the authority that gates spawn.
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

/** What an adapter's discovery channel yields; the catalog stamps `fetched_at`. */
export interface ProbedModels {
  /**
   * Provenance string recorded as the entry's `source` (e.g. `codex debug models`,
   * or `~/.codex/models_cache.json (cache fetched_at=…)` for a disk read).
   */
  source: string;
  models: ModelEntry[];
}

/**
 * The catalog-refresh capability `refreshCatalog` needs from a vendor adapter —
 * the structural slice of the daemon's `VendorAdapter`. Kept minimal so this
 * shared package stays a leaf (no dependency back into the daemon).
 *
 * Two optional discovery channels (#281):
 *  - `readModels` — on-disk vendor config/state (no subprocess)
 *  - `listModels` — CLI probe
 * Precedence: disk → probe → shipped fallback; merge is union / richest-wins.
 */
export interface ModelProber {
  /**
   * Optional on-disk discovery: read the vendor's own config/state files from
   * the *operator* home (never a per-task isolated home). Must fail soft —
   * absent/malformed files return empty models or reject; the refresh path
   * never lets a bad file crash the catalog.
   */
  readModels?(existing: VendorModels | undefined): Promise<ProbedModels>;
  listModels?(existing: VendorModels | undefined): Promise<ProbedModels>;
}

/**
 * Local, user-patchable model/effort catalog (`parley models`, #29).
 *
 * The file at `~/.parley/models.json` is the source of truth: `parley models`
 * reads it directly so a user can hand-edit it to add models or efforts with no
 * code change. `--refresh` re-probes vendors via each adapter's optional
 * `listModels()` / `readModels()` hooks and rewrites their entry — but a failed
 * or empty discovery keeps the existing entry (never clobber a manual patch
 * with nothing). The catalog is advisory only for discovery; spawn is gated by
 * the vendor allowlist (`vendors.<id>.models`, #185 / ADR-0014).
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
 * Per-field richest-wins merge for the same model id (#281 / fix round).
 *
 * Whole-entry scoring discarded a richer efforts list when the other channel
 * only carried a label. Field rules (primary = higher-precedence channel,
 * usually disk; secondary = probe):
 *  - `efforts`: non-empty beats empty; both non-empty → keep primary
 *  - `default_effort`: non-null beats null; both set → keep primary
 *  - `label` / `notes`: present beats absent; both set → keep primary
 *
 * Never fabricates fields: only copies values that already exist on one side.
 */
export function pickRicherModelEntry(primary: ModelEntry, secondary: ModelEntry): ModelEntry {
  const efforts =
    primary.efforts.length > 0
      ? primary.efforts
      : secondary.efforts.length > 0
        ? secondary.efforts
        : primary.efforts;
  const default_effort =
    primary.default_effort !== null
      ? primary.default_effort
      : secondary.default_effort !== null
        ? secondary.default_effort
        : null;
  const label =
    primary.label !== undefined && primary.label !== ""
      ? primary.label
      : secondary.label !== undefined && secondary.label !== ""
        ? secondary.label
        : primary.label ?? secondary.label;
  const notes =
    primary.notes !== undefined && primary.notes !== ""
      ? primary.notes
      : secondary.notes !== undefined && secondary.notes !== ""
        ? secondary.notes
        : primary.notes ?? secondary.notes;
  return {
    id: primary.id,
    efforts: [...efforts],
    default_effort,
    ...(label === undefined ? {} : { label }),
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * Union / richest-wins merge of two discovery results (#281).
 *
 * The result is always a **superset** of both id sets — a disk read must never
 * shrink what the probe alone produced (grok's cache can miss agent variants
 * that live only in config). Same-id collisions merge field-by-field
 * ({@link pickRicherModelEntry}); primary (disk) wins per-field ties.
 *
 * Returns `null` when both sides are empty so the caller can fall through to
 * shipped. Source strings are joined with ` + ` when both contributed models.
 */
export function mergeDiscoveredModels(
  primary: ProbedModels | null,
  secondary: ProbedModels | null,
): ProbedModels | null {
  const primaryModels = primary?.models ?? [];
  const secondaryModels = secondary?.models ?? [];
  if (primaryModels.length === 0 && secondaryModels.length === 0) return null;

  const byId = new Map<string, ModelEntry>();
  // Seed with secondary, fold primary on top so primary wins per-field ties.
  for (const entry of secondaryModels) {
    byId.set(entry.id, entry);
  }
  for (const entry of primaryModels) {
    const existing = byId.get(entry.id);
    byId.set(entry.id, existing === undefined ? entry : pickRicherModelEntry(entry, existing));
  }

  const sources: string[] = [];
  if (primary !== null && primaryModels.length > 0) sources.push(primary.source);
  if (secondary !== null && secondaryModels.length > 0) sources.push(secondary.source);

  return {
    source: sources.join(" + "),
    models: [...byId.values()],
  };
}

/**
 * Invoke an optional discovery channel, swallowing throws so a bad file or
 * missing binary never takes down refresh / `parley init`. Empty results and
 * missing hooks both yield `null` (no contribution to the merge).
 */
async function safeDiscover(
  hook: ((existing: VendorModels | undefined) => Promise<ProbedModels>) | undefined,
  existing: VendorModels | undefined,
): Promise<{ result: ProbedModels | null; error: string | null }> {
  if (!hook) return { result: null, error: null };
  try {
    const probed = await hook(existing);
    if (probed.models.length === 0) return { result: null, error: null };
    return { result: probed, error: null };
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Re-discover models for `vendorIds` and rewrite their catalog entries.
 *
 * Per vendor, channels run in precedence order (#281):
 *  1. `readModels` — operator-home config/state files
 *  2. `listModels` — CLI probe
 *  3. shipped fallback via {@link applyRefreshFallback}
 *
 * Disk and probe results are merged with union / richest-wins so the catalog
 * is a superset of either channel alone. A successful discovery with models
 * always wins over an empty existing entry. When both channels fail or return
 * nothing: keep any non-empty existing entry; if the entry would be empty,
 * fall back to the shipped reference catalog. Pure w.r.t. the input catalog —
 * returns a new object; the caller persists it. `now` is injected for
 * deterministic tests.
 *
 * Fail-soft means "don't crash", not "don't tell anyone": a disk/probe failure
 * still emits a warning even when the other channel succeeded and filled the
 * catalog.
 *
 * Discovery remains advisory (ADR-0014): nothing here gates, widens, or
 * bypasses the deny-by-default allowlist.
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
    if (!adapter?.listModels && !adapter?.readModels) {
      applyRefreshFallback(next, id, "no refresh probe available", warnings);
      continue;
    }

    const existing = next[id];
    const disk = await safeDiscover(adapter.readModels?.bind(adapter), existing);
    const probe = await safeDiscover(adapter.listModels?.bind(adapter), existing);
    const merged = mergeDiscoveredModels(disk.result, probe.result);
    // Collapse operator-home prefixes in caught error text once here so every
    // reader/probe (codex, kimi, hermes, …) benefits without each adapter
    // having to remember (#291). Paths may be embedded mid-string (fs open
    // paths, execFile binary under home, stderr naming config under home).
    const diskError =
      disk.error !== null ? collapseOperatorHomeInText(disk.error) : null;
    const probeError =
      probe.error !== null ? collapseOperatorHomeInText(probe.error) : null;

    if (merged !== null && merged.models.length > 0) {
      // Fail-soft ≠ silent: surface a channel failure even when the other
      // channel filled the catalog (finding 4). Empty disk/probe (fresh home)
      // stays quiet — that is a normal non-error state.
      if (adapter.readModels && diskError) {
        warnings.push(`${id}: disk read failed (${diskError})`);
      }
      if (adapter.listModels && probeError) {
        warnings.push(`${id}: probe failed (${probeError})`);
      }
      // Vendor-level effort_levels / notes are catalog metadata (usually from
      // the shipped seed). Discovery only refreshes fetched_at/source/models;
      // always carry those vendor fields through unchanged when present (#293).
      next[id] = {
        fetched_at: now(),
        source: merged.source,
        models: merged.models,
        ...(existing?.effort_levels !== undefined
          ? { effort_levels: existing.effort_levels }
          : {}),
        ...(existing?.notes !== undefined ? { notes: existing.notes } : {}),
      };
      continue;
    }

    // Both channels empty/failed — explain why, then fall back.
    const reasons: string[] = [];
    if (adapter.readModels) {
      if (diskError) reasons.push(`disk read failed (${diskError})`);
      else reasons.push("disk read returned no models");
    }
    if (adapter.listModels) {
      if (probeError) reasons.push(`probe failed (${probeError})`);
      else reasons.push("probe returned no models");
    }
    if (!adapter.readModels && !adapter.listModels) {
      reasons.push("no refresh probe available");
    }
    applyRefreshFallback(next, id, reasons.join("; "), warnings);
  }
  return { catalog: next, warnings };
}
