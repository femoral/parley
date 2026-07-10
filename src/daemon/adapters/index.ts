import type { VendorAdapter } from "./types.js";
import { createFakeAdapter } from "./fake.js";
import { createGrokAdapter } from "./grok.js";

/**
 * Vendor adapter registry. New vendors (codex, grok — #22) are additive: one
 * module here, no core changes (ADR-0004).
 */
export function createAdapterRegistry(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, VendorAdapter> {
  const adapters = [createFakeAdapter(env), createGrokAdapter(env)];
  return new Map(adapters.map((adapter) => [adapter.id, adapter]));
}

export type { VendorAdapter } from "./types.js";
