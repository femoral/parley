import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonGet, daemonPost, daemonPut, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { HelpRequested, UsageError } from "../errors.js";
import type { ParleyConfig } from "@useparley/core";

interface ConfigBody {
  config: ParleyConfig;
  warnings?: string[];
}

interface ConfigKeyBody {
  key: string;
  value?: unknown;
  config?: ParleyConfig;
}

/**
 * Parse a CLI value for `config set`. JSON when the string is valid JSON
 * (numbers, booleans, objects, arrays, quoted strings); otherwise the raw
 * string so `parley config set profiles.fast.vendor fake` stays ergonomic.
 */
function parseSetValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function printWarnings(ctx: CliContext, warnings: string[] | undefined): void {
  if (warnings === undefined) return;
  for (const w of warnings) ctx.stderr(`warning: ${w}\n`);
}

/** Map daemon validation / missing-key failures: 400/404 → exit 1 (not usage). */
function rethrowConfigError(err: unknown, prefix: string): never {
  if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
    throw new Error(`${prefix}: ${err.message}`);
  }
  throw err;
}

async function configShow(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  if (positionals.length > 0) {
    throw new UsageError(`config show: unexpected argument: ${positionals[0]}`);
  }
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const body = await daemonGet<ConfigBody>(discovery, "/config");
  if (flags["--json"] === true) printJson(ctx, body.config);
  else ctx.stdout(`${JSON.stringify(body.config, null, 2)}\n`);
  return 0;
}

async function configGet(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  const key = positionals[0];
  if (key === undefined) {
    throw new UsageError("config get: a dotted key is required");
  }
  if (positionals.length > 1) {
    throw new UsageError(`config get: unexpected argument: ${positionals[1]}`);
  }
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let body: ConfigKeyBody;
  try {
    body = await daemonGet<ConfigKeyBody>(
      discovery,
      `/config?key=${encodeURIComponent(key)}`,
    );
  } catch (err) {
    rethrowConfigError(err, "config get");
  }
  if (flags["--json"] === true) printJson(ctx, { key: body.key, value: body.value });
  else if (typeof body.value === "string") ctx.stdout(`${body.value}\n`);
  else ctx.stdout(`${JSON.stringify(body.value, null, 2)}\n`);
  return 0;
}

async function configSet(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  const key = positionals[0];
  const rawValue = positionals[1];
  if (key === undefined) {
    throw new UsageError("config set: a dotted key is required");
  }
  if (rawValue === undefined) {
    throw new UsageError("config set: a value is required");
  }
  if (positionals.length > 2) {
    throw new UsageError(`config set: unexpected argument: ${positionals[2]}`);
  }
  const value = parseSetValue(rawValue);
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let body: ConfigKeyBody & ConfigBody;
  try {
    body = await daemonPost<ConfigKeyBody & ConfigBody>(discovery, "/config/set", {
      key,
      value,
    });
  } catch (err) {
    rethrowConfigError(err, "config set");
  }
  if (flags["--json"] === true) printJson(ctx, { key: body.key, value: body.value, config: body.config });
  else ctx.stdout(`set ${key}\n`);
  return 0;
}

async function configUnset(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  const key = positionals[0];
  if (key === undefined) {
    throw new UsageError("config unset: a dotted key is required");
  }
  if (positionals.length > 1) {
    throw new UsageError(`config unset: unexpected argument: ${positionals[1]}`);
  }
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let body: ConfigKeyBody & ConfigBody;
  try {
    body = await daemonPost<ConfigKeyBody & ConfigBody>(discovery, "/config/unset", { key });
  } catch (err) {
    rethrowConfigError(err, "config unset");
  }
  if (flags["--json"] === true) printJson(ctx, { key: body.key, config: body.config });
  else ctx.stdout(`unset ${key}\n`);
  return 0;
}

async function configPush(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  const file = positionals[0];
  if (file === undefined) {
    throw new UsageError("config push: a file path is required");
  }
  if (positionals.length > 1) {
    throw new UsageError(`config push: unexpected argument: ${positionals[1]}`);
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `config push: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `config push: invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let body: ConfigBody;
  try {
    body = await daemonPut<ConfigBody>(discovery, "/config", parsed);
  } catch (err) {
    rethrowConfigError(err, "config push");
  }
  printWarnings(ctx, body.warnings);
  if (flags["--json"] === true) printJson(ctx, { config: body.config, warnings: body.warnings ?? [] });
  else ctx.stdout(`pushed config from ${file}\n`);
  return 0;
}

async function configPull(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  if (positionals.length > 1) {
    throw new UsageError(`config pull: unexpected argument: ${positionals[1]}`);
  }
  const outFile = positionals[0];
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const body = await daemonGet<ConfigBody>(discovery, "/config");
  const pretty = `${JSON.stringify(body.config, null, 2)}\n`;
  if (outFile !== undefined) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, pretty, "utf8");
    if (flags["--json"] === true) printJson(ctx, { file: outFile, config: body.config });
    else ctx.stdout(`wrote config to ${outFile}\n`);
  } else if (flags["--json"] === true) {
    printJson(ctx, body.config);
  } else {
    ctx.stdout(pretty);
  }
  return 0;
}

/**
 * `parley config show|get|set|unset|push|pull` — administer the daemon's own
 * `parley.json` via HTTP endpoints (#156). The CLI never opens the daemon's
 * config file; local and remote daemons share this surface.
 */
export async function runConfig(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "show":
      return configShow(ctx, args.slice(1));
    case "get":
      return configGet(ctx, args.slice(1));
    case "set":
      return configSet(ctx, args.slice(1));
    case "unset":
      return configUnset(ctx, args.slice(1));
    case "push":
      return configPush(ctx, args.slice(1));
    case "pull":
      return configPull(ctx, args.slice(1));
    case "-h":
    case "--help":
      throw new HelpRequested(sub);
    default:
      throw new UsageError(
        sub === undefined
          ? "usage: parley config show|get|set|unset|push|pull"
          : `config: unknown subcommand: ${sub}`,
      );
  }
}
