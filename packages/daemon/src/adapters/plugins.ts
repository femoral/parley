import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { VendorAdapter, VendorConfig } from "@useparley/core";

/**
 * Plugin adapter loader (ADR-0009 / #108).
 *
 * Module contract — the loaded module must export:
 *
 *   createAdapter(env: NodeJS.ProcessEnv): VendorAdapter
 *
 * Named export preferred; default export accepted (either the factory function
 * itself, or an object with a `createAdapter` property). The returned adapter's
 * `id` must equal the config key (`vendors.<id>`); `prepare`, `resume`,
 * `parseEvent`, and `sessionId` must be functions.
 *
 * Specifiers:
 * - absolute filesystem path
 * - `file:` URL
 * - bare package specifier, resolved with `createRequire` from the parley home
 *   directory so users can `npm install` plugins into `~/.parley`
 *
 * Plugins are loaded at daemon startup only — adding or changing a plugin
 * module requires a daemon restart. Vendor args/env/profiles hot-reload per
 * task; plugin *code* does not (complexity not worth it).
 */

/** Validate a candidate adapter object; throws a descriptive Error on failure. */
export function assertVendorAdapter(id: string, value: unknown): asserts value is VendorAdapter {
  if (typeof value !== "object" || value === null) {
    throw new Error(`plugin adapter "${id}": createAdapter must return an object`);
  }
  const adapter = value as Record<string, unknown>;
  if (adapter.id !== id) {
    throw new Error(
      `plugin adapter "${id}": returned id ${JSON.stringify(adapter.id)} does not match config key`,
    );
  }
  for (const method of ["prepare", "resume", "parseEvent", "sessionId"] as const) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`plugin adapter "${id}": ${method} must be a function`);
    }
  }
}

/**
 * Resolve a plugin specifier to a URL string suitable for dynamic `import()`.
 * Bare package names resolve from `parleyHome` (typically `~/.parley`).
 */
export function resolvePluginSpecifier(spec: string, parleyHome: string): string {
  if (spec.startsWith("file:")) return spec;
  if (path.isAbsolute(spec)) return pathToFileURL(spec).href;
  // Bare package / relative path: resolve as Node would from the parley home
  // (users `npm install` plugins into ~/.parley/node_modules).
  const require = createRequire(path.join(parleyHome, "package.json"));
  try {
    return pathToFileURL(require.resolve(spec)).href;
  } catch (err) {
    throw new Error(
      `plugin adapter: cannot resolve ${JSON.stringify(spec)} from ${parleyHome}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function extractFactory(mod: Record<string, unknown>): (env: NodeJS.ProcessEnv) => unknown {
  if (typeof mod.createAdapter === "function") {
    return mod.createAdapter as (env: NodeJS.ProcessEnv) => unknown;
  }
  const def = mod.default;
  if (typeof def === "function") {
    return def as (env: NodeJS.ProcessEnv) => unknown;
  }
  if (typeof def === "object" && def !== null) {
    const nested = (def as Record<string, unknown>).createAdapter;
    if (typeof nested === "function") {
      return nested as (env: NodeJS.ProcessEnv) => unknown;
    }
  }
  throw new Error(
    "plugin module must export createAdapter(env) (named export preferred; default export accepted)",
  );
}

/**
 * Dynamically import and validate a plugin adapter for config key `id`.
 * Throws on resolution, load, factory, or shape failures — callers log and
 * continue so a bad plugin never takes down the daemon.
 */
export async function loadPluginAdapter(
  id: string,
  spec: VendorConfig,
  env: NodeJS.ProcessEnv,
  parleyHome: string,
): Promise<VendorAdapter> {
  if (spec.plugin === undefined || spec.plugin === "") {
    throw new Error(`plugin adapter "${id}": vendors.${id}.plugin is required`);
  }
  const url = resolvePluginSpecifier(spec.plugin, parleyHome);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `plugin adapter "${id}": failed to import ${spec.plugin}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let factory: (env: NodeJS.ProcessEnv) => unknown;
  try {
    factory = extractFactory(mod);
  } catch (err) {
    throw new Error(
      `plugin adapter "${id}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let created: unknown;
  try {
    created = factory(env);
  } catch (err) {
    throw new Error(
      `plugin adapter "${id}": createAdapter threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // Await if the factory returns a Promise (not required, but tolerant).
  if (
    typeof created === "object" &&
    created !== null &&
    typeof (created as Promise<unknown>).then === "function"
  ) {
    created = await (created as Promise<unknown>);
  }
  assertVendorAdapter(id, created);
  return created;
}
