import fs from "node:fs";
import path from "node:path";
import {
  isChildChannel,
  isSandboxMode,
  type ChildChannel,
  type SandboxMode,
} from "./adapter.js";

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
  /**
   * Idle auto-shutdown window in milliseconds (#130). The daemon exits after
   * this long with no live tasks, no open connections, and no RPC. `0`
   * disables. Default: 5 minutes.
   */
  idleTimeoutMs?: number;
}

/**
 * Task-scoped data retention (`retention.days`, #153 / #136). Daemon-home
 * config only — no per-project override. Missing section ⇒ default 30 days.
 */
export interface RetentionConfig {
  /**
   * Days after a task reaches a terminal state before gc may purge it.
   * Non-negative integer; `0` expires every terminal task immediately.
   * Default when unset: 30.
   */
  days?: number;
}

/** Default retention window when `retention.days` is unset (#153). */
export const DEFAULT_RETENTION_DAYS = 30;

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
  /**
   * Override the adapter's declared child channel for preamble teaching
   * (`mcp` | `cli` | `http`; #155). Other transports stay functional but untaught.
   */
  childChannel?: ChildChannel;
  /**
   * Per-vendor reattempt window override for `parley fix` resumes (#158).
   * Duration string (`30m`, `90s`, `250ms`) or bare milliseconds. When set,
   * replaces the project/global `retry.window` for this vendor only. Hot-read.
   */
  retryWindow?: string | number;
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
 * Named remote runner under `runners.<name>` (#111 / ADR-0012). The daemon
 * authenticates lease/heartbeat/event requests with the bearer token; the
 * runner process is started with the same name + token out-of-band.
 */
export interface RunnerConfig {
  /** Shared secret the runner presents as `Authorization: Bearer <token>`. */
  token: string;
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
  /** Remote runner credentials (`runners.<name>.token`); see ADR-0012. */
  runners?: Record<string, RunnerConfig>;
  /** Task data retention window for `parley gc` / daemon sweep (#153). */
  retention?: RetentionConfig;
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
  if (raw.idleTimeoutMs !== undefined) {
    const v = raw.idleTimeoutMs;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(
        `invalid config at ${file}: daemon.idleTimeoutMs must be a non-negative integer`,
      );
    }
  }
}

function validateRetention(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: retention must be an object`);
  }
  if (raw.days !== undefined) {
    const v = raw.days;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(
        `invalid config at ${file}: retention.days must be a non-negative integer`,
      );
    }
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
  if (raw.childChannel !== undefined) {
    if (typeof raw.childChannel !== "string" || !isChildChannel(raw.childChannel)) {
      throw new Error(
        `invalid config at ${file}: vendors.${id}.childChannel must be one of mcp|cli|http`,
      );
    }
  }
  if (raw.retryWindow !== undefined) {
    if (typeof raw.retryWindow === "string") {
      if (raw.retryWindow === "") {
        throw new Error(
          `invalid config at ${file}: vendors.${id}.retryWindow must be a non-empty duration string or non-negative number`,
        );
      }
    } else if (typeof raw.retryWindow === "number") {
      if (!Number.isFinite(raw.retryWindow) || raw.retryWindow < 0) {
        throw new Error(
          `invalid config at ${file}: vendors.${id}.retryWindow must be a non-empty duration string or non-negative number`,
        );
      }
    } else {
      throw new Error(
        `invalid config at ${file}: vendors.${id}.retryWindow must be a non-empty duration string or non-negative number`,
      );
    }
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

function validateRunnerEntry(file: string, name: string, raw: unknown): void {
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: runners.${name} must be an object`);
  }
  if (raw.token === undefined) {
    throw new Error(`invalid config at ${file}: runners.${name}.token is required`);
  }
  assertNonEmptyString(file, `runners.${name}.token`, raw.token);
}

function validateRunners(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: runners must be an object`);
  }
  for (const [name, entry] of Object.entries(raw)) {
    if (name === "") {
      throw new Error(`invalid config at ${file}: runners keys must be non-empty strings`);
    }
    validateRunnerEntry(file, name, entry);
  }
}

/**
 * Validate a parsed config value with the same named field errors as load time.
 * `source` is included in every error message (a filesystem path for file loads,
 * or a synthetic label for in-memory pushes) so callers can point at the input.
 * Unknown keys (top-level and nested) are ignored-but-preserved on the returned
 * object.
 */
export function validateConfig(source: string, raw: unknown): ParleyConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`invalid config at ${source}: must be a JSON object`);
  }
  const config = raw as ParleyConfig;
  // Validate known sections; unknown keys stay ignored-but-preserved.
  validateUi(source, config.ui);
  validateDaemon(source, config.daemon);
  validateVendors(source, config.vendors);
  validateProfiles(source, config.profiles);
  validateRunners(source, config.runners);
  validateRetention(source, config.retention);
  // Validate the fields consumers hand to path/module APIs — a non-string must
  // surface as a named config error here, not a TypeError deep in a consumer.
  // (ui.path / ui.package checked in validateUi above.)
  return config;
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
  return validateConfig(file, parsed);
}

/**
 * Persist a config object to disk (pretty-printed JSON). Write is atomic via
 * temp file + rename so a crash mid-write cannot leave a half-applied file.
 * Callers must validate first (`validateConfig`); this only serializes.
 */
export function writeConfig(file: string, config: ParleyConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, file);
}

/** Known top-level and nested keys — anything else is ignored-but-preserved. */
const KNOWN_TOP_LEVEL = new Set([
  "ui",
  "daemon",
  "vendors",
  "profiles",
  "runners",
  "retention",
]);
const KNOWN_UI = new Set(["path", "package"]);
const KNOWN_DAEMON = new Set(["url", "idleTimeoutMs"]);
const KNOWN_VENDOR = new Set(["bin", "args", "env", "plugin", "childChannel", "retryWindow"]);
const KNOWN_PROFILE = new Set([
  "vendor",
  "model",
  "effort",
  "sandbox",
  "network",
  "args",
  "env",
]);
const KNOWN_RUNNER = new Set(["token"]);
const KNOWN_RETENTION = new Set(["days"]);

/**
 * List dotted paths of unknown keys in a config object (top-level and nested
 * under known sections). Used to warn on wholesale push (#156) while still
 * preserving those keys for round-trips.
 */
export function collectUnknownConfigKeys(config: Record<string, unknown>): string[] {
  const unknown: string[] = [];
  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_LEVEL.has(key)) unknown.push(key);
  }
  const ui = config.ui;
  if (isRecord(ui)) {
    for (const key of Object.keys(ui)) {
      if (!KNOWN_UI.has(key)) unknown.push(`ui.${key}`);
    }
  }
  const daemon = config.daemon;
  if (isRecord(daemon)) {
    for (const key of Object.keys(daemon)) {
      if (!KNOWN_DAEMON.has(key)) unknown.push(`daemon.${key}`);
    }
  }
  const vendors = config.vendors;
  if (isRecord(vendors)) {
    for (const [id, entry] of Object.entries(vendors)) {
      if (!isRecord(entry)) continue;
      for (const key of Object.keys(entry)) {
        if (!KNOWN_VENDOR.has(key)) unknown.push(`vendors.${id}.${key}`);
      }
    }
  }
  const profiles = config.profiles;
  if (isRecord(profiles)) {
    for (const [name, entry] of Object.entries(profiles)) {
      if (!isRecord(entry)) continue;
      for (const key of Object.keys(entry)) {
        if (!KNOWN_PROFILE.has(key)) unknown.push(`profiles.${name}.${key}`);
      }
    }
  }
  const runners = config.runners;
  if (isRecord(runners)) {
    for (const [name, entry] of Object.entries(runners)) {
      if (!isRecord(entry)) continue;
      for (const key of Object.keys(entry)) {
        if (!KNOWN_RUNNER.has(key)) unknown.push(`runners.${name}.${key}`);
      }
    }
  }
  const retention = config.retention;
  if (isRecord(retention)) {
    for (const key of Object.keys(retention)) {
      if (!KNOWN_RETENTION.has(key)) unknown.push(`retention.${key}`);
    }
  }
  return unknown;
}

/** Split and validate a dotted config key (`daemon.url`, `profiles.fast.vendor`). */
export function parseConfigKey(key: string): string[] {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("config key must be a non-empty dotted path");
  }
  const parts = key.split(".");
  if (parts.some((p) => p === "")) {
    throw new Error(`invalid config key: ${key}`);
  }
  return parts;
}

/**
 * Read a dotted path from a config object. Returns `{ found: false }` when any
 * segment is missing; does not throw for absent keys.
 */
export function getConfigPath(
  root: unknown,
  key: string,
): { found: true; value: unknown } | { found: false } {
  const parts = parseConfigKey(key);
  let cur: unknown = root;
  for (const part of parts) {
    if (!isRecord(cur) || !(part in cur)) return { found: false };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

/**
 * Return a deep-cloned config with `key` set to `value`, creating intermediate
 * objects as needed. Throws when an intermediate segment exists but is not an
 * object (would otherwise silently clobber scalar structure).
 */
export function setConfigPath(
  root: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const parts = parseConfigKey(key);
  const result = structuredClone(root) as Record<string, unknown>;
  let cur: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      cur[part] = created;
      cur = created;
      continue;
    }
    if (!isRecord(next)) {
      throw new Error(
        `invalid config key ${key}: ${parts.slice(0, i + 1).join(".")} is not an object`,
      );
    }
    cur = next;
  }
  cur[parts[parts.length - 1]!] = value;
  return result;
}

/**
 * Return a deep-cloned config with `key` removed. Throws when the path is
 * absent so callers can report a clear "no such key" error.
 */
export function unsetConfigPath(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const parts = parseConfigKey(key);
  const result = structuredClone(root) as Record<string, unknown>;
  let cur: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    if (!isRecord(next)) {
      throw new Error(`no such config key: ${key}`);
    }
    cur = next;
  }
  const last = parts[parts.length - 1]!;
  if (!(last in cur)) {
    throw new Error(`no such config key: ${key}`);
  }
  delete cur[last];
  return result;
}

/**
 * Resolve the retention window in days from config, applying the shipped
 * default when the section or key is absent.
 */
export function retentionDays(config: ParleyConfig): number {
  return config.retention?.days ?? DEFAULT_RETENTION_DAYS;
}
