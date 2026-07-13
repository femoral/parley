import fs from "node:fs";
import path from "node:path";

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
}

/** One vendor's slice of the catalog file (`~/.parley/models.json`). */
export interface VendorModels {
  /** ISO timestamp of the last successful `--refresh`; null when never probed. */
  fetched_at: string | null;
  /** Where the entry came from: a probe command (`codex debug models`) or `manual`. */
  source: string;
  models: ModelEntry[];
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
export const DEFAULT_CATALOG: ModelCatalog = {
  codex: {
    fetched_at: null,
    source: "codex debug models",
    models: [
      {
        id: "gpt-5.6-sol",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        default_effort: "medium",
      },
    ],
  },
  grok: {
    fetched_at: null,
    source: "manual",
    models: [{ id: "grok-4.5", efforts: ["low", "medium", "high"], default_effort: "high" }],
  },
};

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
  /** One per vendor whose entry was kept because the probe failed/was empty. */
  warnings: string[];
}

/**
 * Re-probe `vendorIds` and rewrite their catalog entries from the live vendor
 * CLIs, keeping the existing entry (with a warning) whenever a vendor has no
 * probe hook, its probe rejects, or it returns no models. Pure w.r.t. the input
 * catalog — returns a new object; the caller persists it. `now` is injected for
 * deterministic tests.
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
      warnings.push(`${id}: no refresh probe available; kept existing entry`);
      continue;
    }
    try {
      const probed = await adapter.listModels(next[id]);
      if (probed.models.length === 0) {
        warnings.push(`${id}: probe returned no models; kept existing entry`);
        continue;
      }
      next[id] = { fetched_at: now(), source: probed.source, models: probed.models };
    } catch (err) {
      warnings.push(
        `${id}: probe failed (${err instanceof Error ? err.message : String(err)}); ` +
          "kept existing entry",
      );
    }
  }
  return { catalog: next, warnings };
}
