import fs from "node:fs";
import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { createAdapterRegistry } from "@useparley/daemon/adapters/index.js";
import type { ModelCatalog, VendorModels } from "@useparley/daemon/adapters/types.js";
import { loadCatalog, refreshCatalog, writeCatalog } from "@useparley/core";

/** Restrict a catalog to a single vendor, or return it whole when unfiltered. */
function filterCatalog(catalog: ModelCatalog, vendor: string | undefined): ModelCatalog {
  if (vendor === undefined) return catalog;
  const entry = catalog[vendor];
  return entry ? { [vendor]: entry } : {};
}

/** Render one vendor's entry as an aligned human-readable block. */
function renderVendor(ctx: CliContext, vendor: string, entry: VendorModels): void {
  const when =
    entry.fetched_at === null ? "never refreshed" : `fetched ${entry.fetched_at}`;
  ctx.stdout(`${vendor}  (source: ${entry.source}, ${when})\n`);
  if (entry.models.length === 0) {
    ctx.stdout("  (no models)\n");
    return;
  }
  const idWidth = Math.max(...entry.models.map((m) => m.id.length));
  for (const m of entry.models) {
    const efforts = m.efforts.length > 0 ? m.efforts.join(", ") : "-";
    const def = m.default_effort ?? "-";
    ctx.stdout(`  ${m.id.padEnd(idWidth)}  efforts: ${efforts}  (default: ${def})\n`);
  }
}

function renderCatalog(ctx: CliContext, catalog: ModelCatalog): void {
  const vendors = Object.keys(catalog);
  if (vendors.length === 0) {
    ctx.stdout("No models.\n");
    return;
  }
  vendors.forEach((vendor, i) => {
    if (i > 0) ctx.stdout("\n");
    renderVendor(ctx, vendor, catalog[vendor]!);
  });
}

/**
 * `parley models [--vendor <id>] [--json] [--refresh]`. Reads the local,
 * hand-editable catalog at `~/.parley/models.json` (seeding it on first run so
 * there is something to edit), optionally re-probing vendors with `--refresh`.
 * The catalog is advisory: this command never talks to the daemon and never
 * gates `delegate`.
 */
export async function runModels(ctx: CliContext, args: string[]): Promise<number> {
  const { flags } = parseArgs(args, {
    "--vendor": { aliases: ["-v"], value: true },
    "--json": {},
    "--refresh": {},
  });
  const vendor = typeof flags["--vendor"] === "string" ? flags["--vendor"] : undefined;
  const json = flags["--json"] === true;
  const refresh = flags["--refresh"] === true;
  const file = ctx.paths.models;

  // Seed the file on first run so `~/.parley/models.json` always exists for the
  // user to hand-edit (loadCatalog returns the seed in memory when it is absent).
  let catalog = loadCatalog(file);
  if (!fs.existsSync(file)) writeCatalog(file, catalog);

  if (refresh) {
    const adapters = createAdapterRegistry(ctx.env);
    const targets = vendor !== undefined ? [vendor] : Object.keys(catalog);
    const result = await refreshCatalog(catalog, targets, adapters);
    catalog = result.catalog;
    writeCatalog(file, catalog);
    for (const warning of result.warnings) ctx.stderr(`warning: ${warning}\n`);
  }

  const view = filterCatalog(catalog, vendor);
  if (vendor !== undefined && catalog[vendor] === undefined) {
    ctx.stderr(`warning: no catalog entry for vendor '${vendor}'\n`);
  }

  if (json) printJson(ctx, view);
  else renderCatalog(ctx, view);
  return 0;
}
