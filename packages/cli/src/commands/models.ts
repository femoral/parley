import { parseArgs } from "../args.js";
import {
  DaemonRequestError,
  daemonGet,
  daemonPost,
  ensureDaemon,
} from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import type {
  ModelCatalog,
  ModelEntry,
  VendorModelAllowlistEntry,
  VendorModels,
} from "@useparley/core";

/** Parse a CLI value for `models set` (JSON when parseable; else raw string). */
function parseSetValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Map daemon validation / missing-key failures: 400/404 → exit 1 (not usage). */
function rethrowModelsError(err: unknown, prefix: string): never {
  if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
    throw new Error(`${prefix}: ${err.message}`);
  }
  throw err;
}

type AllowlistMap = Record<string, Record<string, VendorModelAllowlistEntry>>;

function renderAllowlistVendor(
  ctx: CliContext,
  vendor: string,
  models: Record<string, VendorModelAllowlistEntry>,
): void {
  ctx.stdout(`${vendor}\n`);
  const ids = Object.keys(models);
  if (ids.length === 0) {
    ctx.stdout("  (no models allowed)\n");
    return;
  }
  const idWidth = Math.max(...ids.map((id) => id.length));
  for (const id of ids) {
    const entry = models[id]!;
    const efforts = entry.efforts.length > 0 ? entry.efforts.join(", ") : "-";
    let def = "-";
    if (entry.default === true) {
      def = entry.efforts.length === 1 ? entry.efforts[0]! : "true";
    } else if (typeof entry.default === "string") {
      def = entry.default;
    }
    const hint =
      typeof entry.hint === "string" && entry.hint !== "" ? `  hint: ${entry.hint}` : "";
    ctx.stdout(`  ${id.padEnd(idWidth)}  efforts: ${efforts}  (default: ${def})${hint}\n`);
  }
}

function renderAllowlist(ctx: CliContext, allowlist: AllowlistMap): void {
  const vendors = Object.keys(allowlist);
  if (vendors.length === 0) {
    ctx.stdout("No model allowlist configured.\n");
    return;
  }
  vendors.forEach((vendor, i) => {
    if (i > 0) ctx.stdout("\n");
    renderAllowlistVendor(ctx, vendor, allowlist[vendor]!);
  });
}

function renderCatalogVendor(ctx: CliContext, vendor: string, entry: VendorModels): void {
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

function renderModelEntries(ctx: CliContext, models: ModelEntry[]): void {
  if (models.length === 0) {
    ctx.stdout("  (no models)\n");
    return;
  }
  const idWidth = Math.max(...models.map((m) => m.id.length));
  for (const m of models) {
    const efforts = m.efforts.length > 0 ? m.efforts.join(", ") : "-";
    const def = m.default_effort ?? "-";
    ctx.stdout(`  ${m.id.padEnd(idWidth)}  efforts: ${efforts}  (default: ${def})\n`);
  }
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

interface RefreshBody {
  daemon: { catalog: ModelCatalog; warnings: string[] };
  runners: Array<{
    name: string;
    capabilities: { vendors: Array<{ id: string; models: ModelEntry[] }> };
    last_seen: string;
    registered_at: string;
    /** Presence / last contact age — not capabilities advertisement age. */
    last_contact_age_ms: number;
  }>;
}

function renderRefresh(ctx: CliContext, body: RefreshBody): void {
  ctx.stdout("daemon (just refreshed)\n");
  const catalog = body.daemon.catalog;
  const vendors = Object.keys(catalog);
  if (vendors.length === 0) {
    ctx.stdout("  (no catalog entries)\n");
  } else {
    for (const vendor of vendors) {
      renderCatalogVendor(ctx, vendor, catalog[vendor]!);
    }
  }
  if (body.runners.length === 0) {
    ctx.stdout("\nrunners: (none registered)\n");
    return;
  }
  for (const runner of body.runners) {
    ctx.stdout(
      `\nrunner ${runner.name}  (last contact ${formatAge(runner.last_contact_age_ms)} ago)\n`,
    );
    if (runner.capabilities.vendors.length === 0) {
      ctx.stdout("  (no vendors advertised)\n");
      continue;
    }
    for (const v of runner.capabilities.vendors) {
      ctx.stdout(`${v.id}\n`);
      renderModelEntries(ctx, v.models);
    }
  }
}

async function modelsList(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--vendor": { aliases: ["-v"], value: true },
    "--json": {},
  });
  if (positionals.length > 0) {
    throw new UsageError(
      positionals.length === 1
        ? `models: unknown subcommand: ${positionals[0]}`
        : "usage: parley models [refresh|set|unset] …",
    );
  }
  const vendor = typeof flags["--vendor"] === "string" ? flags["--vendor"] : undefined;
  const json = flags["--json"] === true;
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const path =
    vendor !== undefined
      ? `/models?vendor=${encodeURIComponent(vendor)}`
      : "/models";
  const body = await daemonGet<{ allowlist: AllowlistMap }>(discovery, path);
  if (vendor !== undefined && body.allowlist[vendor] === undefined) {
    ctx.stderr(`warning: no allowlist entry for vendor '${vendor}'\n`);
  }
  if (json) printJson(ctx, body.allowlist);
  else renderAllowlist(ctx, body.allowlist);
  return 0;
}

async function modelsRefresh(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--vendor": { aliases: ["-v"], value: true },
    "--json": {},
    "--refresh": {},
  });
  if (positionals.length > 0) {
    throw new UsageError(
      `models refresh: unexpected argument: ${positionals[0]}`,
    );
  }
  const vendor = typeof flags["--vendor"] === "string" ? flags["--vendor"] : undefined;
  const json = flags["--json"] === true;
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  // Probes run on the daemon host only — never on this CLI process (#322).
  const body = await daemonPost<RefreshBody>(
    discovery,
    "/models/refresh",
    vendor !== undefined ? { vendor } : {},
  );
  for (const warning of body.daemon.warnings) {
    ctx.stderr(`warning: ${warning}\n`);
  }
  if (json) printJson(ctx, body);
  else renderRefresh(ctx, body);
  return 0;
}

async function modelsSet(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  const key = positionals[0];
  const rawValue = positionals[1];
  if (key === undefined) {
    throw new UsageError("models set: a dotted key is required (vendors.<id>.models…)");
  }
  if (rawValue === undefined) {
    throw new UsageError("models set: a value is required");
  }
  if (positionals.length > 2) {
    throw new UsageError(`models set: unexpected argument: ${positionals[2]}`);
  }
  const value = parseSetValue(rawValue);
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let body: { key: string; value: unknown; allowlist: AllowlistMap };
  try {
    body = await daemonPost(discovery, "/models/set", { key, value });
  } catch (err) {
    rethrowModelsError(err, "models set");
  }
  if (flags["--json"] === true) {
    printJson(ctx, { key: body.key, value: body.value, allowlist: body.allowlist });
  } else {
    ctx.stdout(`set ${key}\n`);
  }
  return 0;
}

async function modelsUnset(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  const key = positionals[0];
  if (key === undefined) {
    throw new UsageError("models unset: a dotted key is required (vendors.<id>.models…)");
  }
  if (positionals.length > 1) {
    throw new UsageError(`models unset: unexpected argument: ${positionals[1]}`);
  }
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let body: { key: string; allowlist: AllowlistMap };
  try {
    body = await daemonPost(discovery, "/models/unset", { key });
  } catch (err) {
    rethrowModelsError(err, "models unset");
  }
  if (flags["--json"] === true) {
    printJson(ctx, { key: body.key, allowlist: body.allowlist });
  } else {
    ctx.stdout(`unset ${key}\n`);
  }
  return 0;
}

/**
 * `parley models [refresh|set|unset] …` — daemon-owned model allowlist and
 * fleet catalog (#322 / #307).
 *
 * - bare / list: the daemon-wide allowlist (`vendors.*.models`) over HTTP
 * - `set` / `unset`: edit that subtree only (CLIENT-class; not raw config-admin)
 * - `refresh` / `--refresh`: daemon re-fingerprints its own host and returns
 *   the aggregate (daemon catalog + each runner's last-advertised catalog with
 *   advertisement age). Probes never run on the CLI host.
 *
 * Hand-edits of `parley.json` on the daemon host are picked up hot (config is
 * re-read per call). Delegate-time allowlist enforcement is unchanged.
 */
export async function runModels(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "set") return modelsSet(ctx, args.slice(1));
  if (sub === "unset") return modelsUnset(ctx, args.slice(1));
  if (sub === "refresh") return modelsRefresh(ctx, args.slice(1));

  // Support legacy `--refresh` flag as an alias for the refresh subcommand.
  const { flags } = parseArgs(args, {
    "--vendor": { aliases: ["-v"], value: true },
    "--json": {},
    "--refresh": {},
  });
  if (flags["--refresh"] === true) {
    return modelsRefresh(ctx, args);
  }
  return modelsList(ctx, args);
}
