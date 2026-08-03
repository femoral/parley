import type { ParleyConfig, VendorAdapter } from "@useparley/core";
import { createFakeAdapter } from "./fake.js";
import { createCodexAdapter } from "./codex.js";
import { createGrokAdapter } from "./grok.js";
import { createClaudeAdapter } from "./claude.js";
import { createCursorAdapter } from "./cursor.js";
import { createAntigravityAdapter } from "./antigravity.js";
import { createKiloAdapter } from "./kilo.js";
import { createGooseAdapter } from "./goose.js";
import { createOpenclawAdapter } from "./openclaw.js";
import { createClineAdapter } from "./cline.js";
import { createOpenhandsAdapter } from "./openhands.js";
import { createOpencodeAdapter } from "./opencode.js";
import { createHermesAdapter } from "./hermes.js";
import { createPiAdapter } from "./pi.js";
import { createKimiAdapter } from "./kimi.js";
import { loadPluginAdapter } from "./plugins.js";

/**
 * Built-in vendor adapters. New first-party vendors are additive: one module
 * here (ADR-0004). Third-party vendors load via `vendors.<id>.plugin` (ADR-0009).
 */
export function createBuiltinAdapters(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, VendorAdapter> {
  const adapters = [
    createFakeAdapter(env),
    createCodexAdapter(env),
    createGrokAdapter(env),
    createClaudeAdapter(env),
    createCursorAdapter(env),
    createAntigravityAdapter(env),
    createKiloAdapter(env),
    createGooseAdapter(env),
    createOpenclawAdapter(env),
    createClineAdapter(env),
    createOpenhandsAdapter(env),
    createOpencodeAdapter(env),
    createHermesAdapter(env),
    createPiAdapter(env),
    createKimiAdapter(env),
  ];
  return new Map(adapters.map((adapter) => [adapter.id, adapter]));
}

/**
 * Vendor adapter registry: built-ins first, then plugins from config.
 * A plugin may shadow a built-in (logs a warning). A plugin that fails to load
 * is logged and skipped — the daemon stays up; delegating to that vendor then
 * fails with the existing unknown-vendor error.
 *
 * Plugins load only at daemon startup — changing a plugin module requires a
 * restart. Vendor args/env/profiles are re-read per task (hot).
 */
export async function createAdapterRegistry(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    config?: ParleyConfig;
    parleyHome?: string;
    /** Where to write load warnings/errors (default stderr). */
    log?: (line: string) => void;
  } = {},
): Promise<Map<string, VendorAdapter>> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const registry = createBuiltinAdapters(env);
  const vendors = options.config?.vendors;
  if (!vendors || options.parleyHome === undefined) return registry;

  for (const [id, spec] of Object.entries(vendors)) {
    if (spec.plugin === undefined) continue;
    try {
      const adapter = await loadPluginAdapter(id, spec, env, options.parleyHome);
      if (registry.has(id)) {
        log(`parley daemon: plugin adapter "${id}" shadows built-in vendor`);
      }
      registry.set(id, adapter);
    } catch (err) {
      log(
        `parley daemon: failed to load plugin adapter "${id}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return registry;
}

/** Synchronous built-ins-only registry (tests that don't need plugins). */
export function createAdapterRegistrySync(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, VendorAdapter> {
  return createBuiltinAdapters(env);
}

export type { VendorAdapter } from "./types.js";
