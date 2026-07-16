import fs from "node:fs";
import { isSandboxMode, type SandboxMode } from "./adapter.js";

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
 * Non-local daemon connection (`daemon.url`). When set, the CLI skips local
 * discovery/spawn and talks to that base URL (ADR-0010).
 */
export interface DaemonConfig {
  /** Base URL of a running daemon, e.g. `http://host:57123` (no trailing slash). */
  url?: string;
}

/**
 * Per-vendor settings under `vendors.<id>` (#112). `bin`/`args`/`env` customize
 * spawn; `plugin` loads a third-party adapter module (ADR-0009).
 */
export interface VendorConfig {
  /** Replace the adapter's default binary (argv[0]). */
  bin?: string;
  /** Extra argv flags, spliced into the flags region (before the prompt). */
  args?: string[];
  /** Env vars merged into the spawn plan (after plan.env, before profile.env). */
  env?: Record<string, string>;
  /**
   * Module specifier for a plugin adapter: absolute path, `file:` URL, or bare
   * package name resolved from the parley home dir. Loaded at daemon startup.
   */
  plugin?: string;
}

/**
 * Named agent profile under `profiles.<name>` (#113). Supplies defaults for
 * vendor/model/effort/posture plus optional args/env; explicit request fields
 * win over profile values.
 */
export interface ProfileConfig {
  /** Vendor id (built-in or plugin); required. */
  vendor: string;
  model?: string;
  effort?: string;
  sandbox?: SandboxMode;
  network?: boolean;
  /** Extra argv flags, appended after `vendors.<id>.args`. */
  args?: string[];
  /** Env vars merged last (after vendor env). */
  env?: Record<string, string>;
}

/**
 * The parley home config file (`~/.parley/parley.json`). Unknown top-level keys
 * (and unknown keys inside sections) are preserved by callers that round-trip
 * the file but ignored by readers.
 */
export interface ParleyConfig {
  ui?: UiConfig;
  daemon?: DaemonConfig;
  vendors?: Record<string, VendorConfig>;
  profiles?: Record<string, ProfileConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(file: string, path: string, value: unknown): void {
  if (typeof value !== "string" || value === "") {
    throw new Error(`invalid config at ${file}: ${path} must be a non-empty string`);
  }
}

function assertStringArray(file: string, path: string, value: unknown): void {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`invalid config at ${file}: ${path} must be an array of strings`);
  }
}

function assertStringRecord(file: string, path: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(`invalid config at ${file}: ${path} must be an object of string values`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`invalid config at ${file}: ${path}.${key} must be a string`);
    }
  }
}

function validateUi(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: ui must be an object`);
  }
  for (const key of ["path", "package"] as const) {
    if (raw[key] !== undefined) {
      assertNonEmptyString(file, `ui.${key}`, raw[key]);
    }
  }
}

function validateDaemon(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: daemon must be an object`);
  }
  if (raw.url !== undefined) {
    assertNonEmptyString(file, "daemon.url", raw.url);
  }
}

function validateVendorEntry(file: string, id: string, raw: unknown): void {
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: vendors.${id} must be an object`);
  }
  if (raw.bin !== undefined) assertNonEmptyString(file, `vendors.${id}.bin`, raw.bin);
  if (raw.args !== undefined) assertStringArray(file, `vendors.${id}.args`, raw.args);
  if (raw.env !== undefined) assertStringRecord(file, `vendors.${id}.env`, raw.env);
  if (raw.plugin !== undefined) {
    assertNonEmptyString(file, `vendors.${id}.plugin`, raw.plugin);
  }
}

function validateVendors(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: vendors must be an object`);
  }
  for (const [id, entry] of Object.entries(raw)) {
    if (id === "") {
      throw new Error(`invalid config at ${file}: vendors keys must be non-empty strings`);
    }
    validateVendorEntry(file, id, entry);
  }
}

function validateProfileEntry(file: string, name: string, raw: unknown): void {
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: profiles.${name} must be an object`);
  }
  if (raw.vendor === undefined) {
    throw new Error(`invalid config at ${file}: profiles.${name}.vendor is required`);
  }
  assertNonEmptyString(file, `profiles.${name}.vendor`, raw.vendor);
  if (raw.model !== undefined) {
    assertNonEmptyString(file, `profiles.${name}.model`, raw.model);
  }
  if (raw.effort !== undefined) {
    assertNonEmptyString(file, `profiles.${name}.effort`, raw.effort);
  }
  if (raw.sandbox !== undefined) {
    if (typeof raw.sandbox !== "string" || !isSandboxMode(raw.sandbox)) {
      throw new Error(
        `invalid config at ${file}: profiles.${name}.sandbox must be one of read-only|workspace|full`,
      );
    }
  }
  if (raw.network !== undefined) {
    if (typeof raw.network !== "boolean") {
      throw new Error(
        `invalid config at ${file}: profiles.${name}.network must be a boolean`,
      );
    }
  }
  if (raw.args !== undefined) assertStringArray(file, `profiles.${name}.args`, raw.args);
  if (raw.env !== undefined) assertStringRecord(file, `profiles.${name}.env`, raw.env);
}

function validateProfiles(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: profiles must be an object`);
  }
  for (const [name, entry] of Object.entries(raw)) {
    if (name === "") {
      throw new Error(`invalid config at ${file}: profiles keys must be non-empty strings`);
    }
    validateProfileEntry(file, name, entry);
  }
}

/**
 * Read the parley home config file, returning `{}` when it does not exist —
 * the file is optional; every consumer of `readConfig` must behave as if
 * nothing were configured in that case. A corrupt (unparseable) file is
 * surfaced as an error, never silently ignored — same posture as
 * `models.ts`'s `loadCatalog`, so a syntax slip is loud rather than silently
 * disabling whatever the file configures.
 *
 * Unknown keys (top-level and nested) are ignored by readers but preserved on
 * the returned object so round-trip editors keep them.
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
  // Validate known sections; unknown keys stay ignored-but-preserved.
  validateUi(file, config.ui);
  validateDaemon(file, config.daemon);
  validateVendors(file, config.vendors);
  validateProfiles(file, config.profiles);
  // Validate the fields consumers hand to path/module APIs — a non-string must
  // surface as a named config error here, not a TypeError deep in a consumer.
  // (ui.path / ui.package checked in validateUi above.)
  return config;
}
