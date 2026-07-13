import fs from "node:fs";

/**
 * UI bundle discovery settings (`docs/spec/ui-interface-contract.md` §"Serving
 * convention"). Both keys are optional and are consulted in order — `path`
 * before `package` — by the daemon's discovery routine.
 */
export interface UiConfig {
  /** Explicit bundle directory, served directly (highest-priority hit). */
  path?: string;
  /** A package name to resolve instead of the `@useparley/ui` default. */
  package?: string;
}

/**
 * The parley home config file (`~/.parley/parley.json`). Currently only the
 * `ui` section is defined; unknown top-level keys are preserved by callers
 * that round-trip the file but ignored by readers.
 */
export interface ParleyConfig {
  ui?: UiConfig;
}

/**
 * Read the parley home config file, returning `{}` when it does not exist —
 * the file is optional; every consumer of `readConfig` must behave as if
 * nothing were configured in that case. A corrupt (unparseable) file is
 * surfaced as an error, never silently ignored — same posture as
 * `models.ts`'s `loadCatalog`, so a syntax slip is loud rather than silently
 * disabling whatever the file configures.
 */
export function readConfig(file: string): ParleyConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Name the file: a bare SyntaxError ("Unexpected token …") gives the user
    // of a hand-edited config nothing to act on.
    throw new Error(`invalid config at ${file}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid config at ${file}: must be a JSON object`);
  }
  const config = parsed as ParleyConfig;
  // Validate the fields consumers hand to path/module APIs — a non-string must
  // surface as a named config error here, not a TypeError deep in a consumer.
  for (const key of ["path", "package"] as const) {
    const value = (config.ui as Record<string, unknown> | undefined)?.[key];
    if (value !== undefined && (typeof value !== "string" || value === "")) {
      throw new Error(`invalid config at ${file}: ui.${key} must be a non-empty string`);
    }
  }
  return config;
}
