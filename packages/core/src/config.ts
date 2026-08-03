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
 *
 * Remote auth (#323 / ADR-0030): the client also stores its name + token
 * beside the URL (`daemon.client`, `daemon.token`) and sends bearer auth.
 * `daemon.bind` is daemon-side only — listen address; default loopback.
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
  /**
   * Listen address for the daemon HTTP server (#323 / ADR-0030). Default
   * `127.0.0.1` (loopback-only). Set to e.g. `0.0.0.0` to accept non-local
   * connections; bearer auth is then mandatory for every non-loopback peer.
   * Cold — requires daemon restart.
   */
  bind?: string;
  /**
   * This client's registered name on the remote daemon (`clients.<name>`).
   * Stored beside `daemon.url` / `daemon.token` on the client host only.
   */
  client?: string;
  /**
   * Bearer token matching `clients.<name>.token` on the remote daemon.
   * Sent as `Authorization: Bearer <token>` on every remote request.
   */
  token?: string;
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
 * One model entry in a vendor's model+effort allowlist
 * (`vendors.<id>.models.<modelId>`; #185 / ADR-0014).
 *
 * Efforts are **explicit** — nothing is implied. Top-tier levels (max/ultra)
 * must be named to be usable. The optional `default` marker selects the combo
 * used when `parley delegate` omits `-m`/`-e`.
 */
export interface VendorModelAllowlistEntry {
  /**
   * Allowed reasoning efforts for this model. Empty means the model is
   * allowed only with no effort (effort-less vendors).
   */
  efforts: string[];
  /**
   * Default-combo marker for this model.
   *
   * - `true` — this model is the vendor default; `efforts` must list exactly
   *   one effort (or be empty for effort-less vendors). That pair is the
   *   combo used when delegate omits model and effort.
   * - a string — that effort (must appear in `efforts`) completes the default
   *   combo with this model, allowing multi-effort models to still be default.
   *
   * At most one model per vendor may set `default`.
   */
  default?: boolean | string;
  /** Free-text guidance for orchestrators (surfaced by `parley info`). */
  hint?: string;
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
  /**
   * Max concurrent live instances of this vendor across the whole daemon (#171).
   * Positive integer; when unset there is no vendor cap. Excess tasks sit
   * `queued` (FIFO) until a slot frees.
   */
  maxConcurrent?: number;
  /**
   * Model+effort allowlist (#185 / ADR-0014). Deny-by-default: a vendor with
   * no allowlist (missing or empty) cannot be delegated to. Map keyed by model
   * id; each entry lists explicit efforts, optional default marker, optional
   * orchestrator-facing hint. The model catalog is advisory only — this map
   * is the authority at every spawn path.
   */
  models?: Record<string, VendorModelAllowlistEntry>;
}

/**
 * Named agent profile under `profiles.<name>` (#113). Supplies defaults for
 * vendor/model/effort/posture plus optional args/env; explicit request fields
 * win over profile values.
 *
 * With {@link template} set (#195 / ADR-0015), the profile replaces adapter
 * argv composition entirely. Vendor/model/effort become *declared* (unverified)
 * provenance and the profile is exempt from the model allowlist.
 */
export interface ProfileConfig {
  /** Vendor id (built-in or plugin); required. Template profiles may use any id. */
  vendor: string;
  model?: string;
  effort?: string;
  sandbox?: SandboxMode;
  network?: boolean;
  /** Extra argv flags, appended after `vendors.<id>.args`. Unused when `template` is set. */
  args?: string[];
  /** Env vars merged last (after vendor env). */
  env?: Record<string, string>;
  /**
   * Max concurrent live instances of this profile across the whole daemon (#171).
   * Positive integer; when unset there is no profile cap. Combined with a
   * vendor cap, a task spawns only when both have a free slot.
   */
  maxConcurrent?: number;
  /**
   * Opt-in full argv that **replaces** adapter composition for this profile
   * (#195 / ADR-0015). Shape-validated only — a template that does not actually
   * run an agent fails at spawn, not config load. Elements expand shell-like
   * (`$VAR` / `${VAR}`) from the spawn env; `$PROMPT` is the task prompt.
   * Profiles without this field behave exactly as before (`args` splicing).
   */
  template?: string[];
  /**
   * Optional orchestrator-facing free-text hint (#195), same role as allowlist
   * model hints — guides when to use this profile.
   */
  hint?: string;
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
 * Named remote client under `clients.<name>` (#323 / ADR-0030). Mirrors
 * {@link RunnerConfig}: each device/UI holds its own revocable bearer token.
 * Tokens live in settings (not the db); deleting an entry revokes that client.
 */
export interface ClientConfig {
  /** Shared secret the client presents as `Authorization: Bearer <token>`. */
  token: string;
}

/** Eval on/off for a project or global defaults (#157 / #178). */
export interface EvalConfig {
  enabled?: boolean;
  /** @deprecated alias of enabled (#45) */
  expected?: boolean;
}

/** Whether `parley fix` resumes the parent vendor session (#152 / #178). */
export interface ResumeConfig {
  enabled?: boolean;
}

/** Retry budget and reattempt window (#158 / #178). */
export interface RetryConfig {
  /** Max *resumed* fixes per attempt chain. */
  max?: number;
  /** Duration string (`30m`) or bare milliseconds. */
  window?: string | number;
}

/**
 * Orchestrator fallbacks when `parley delegate` omits `-v` / `--profile` (#175).
 * When both are set, `profile` wins (a profile already names a vendor). Explicit
 * CLI flags always win over these defaults.
 */
export interface DefaultsConfig {
  /** Default vendor id when neither flag nor `defaults.profile` applies. */
  vendor?: string;
  /** Default profile name; wins over `defaults.vendor` when both are set. */
  profile?: string;
}

/**
 * The parley home config file (`~/.parley/parley.json`). Unknown top-level keys
 * (and unknown keys inside sections) are preserved by callers that round-trip
 * the file but ignored by readers.
 *
 * Project-settings keys (`eval`, `resume`, `retry`, `taskTypes`) are the global
 * layer for layered config (#178); project `.parley/config.json` overrides them
 * via deep merge. The same keys are exposed by `GET /config` for CLI merge.
 */
export interface ParleyConfig {
  ui?: UiConfig;
  daemon?: DaemonConfig;
  vendors?: Record<string, VendorConfig>;
  profiles?: Record<string, ProfileConfig>;
  /** Remote runner credentials (`runners.<name>.token`); see ADR-0012. */
  runners?: Record<string, RunnerConfig>;
  /**
   * Remote client credentials (`clients.<name>.token`); see ADR-0030.
   * Daemon-side map of named tokens; clients store their own name+token
   * under `daemon.client` / `daemon.token` beside `daemon.url`.
   */
  clients?: Record<string, ClientConfig>;
  /** Task data retention window for `parley gc` / daemon sweep (#153). */
  retention?: RetentionConfig;
  /** Fallback vendor/profile when delegate omits `-v` / `--profile` (#175). */
  defaults?: DefaultsConfig;
  /** Global default for evaluation (#178). */
  eval?: EvalConfig;
  /** Global default for fix resume (#178). */
  resume?: ResumeConfig;
  /** Global default for retry budget/window (#178). */
  retry?: RetryConfig;
  /**
   * Global default taskTypes map (#178). Same shape as project config
   * (string rubric or `{ rubric }`). Validated loosely here; full resolve is
   * in classification.ts.
   */
  taskTypes?: Record<string, string | { rubric: string }>;
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
  if (raw.bind !== undefined) {
    assertNonEmptyString(file, "daemon.bind", raw.bind);
  }
  if (raw.client !== undefined) {
    assertNonEmptyString(file, "daemon.client", raw.client);
  }
  if (raw.token !== undefined) {
    assertNonEmptyString(file, "daemon.token", raw.token);
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
  if (raw.maxConcurrent !== undefined) {
    const v = raw.maxConcurrent;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new Error(
        `invalid config at ${file}: vendors.${id}.maxConcurrent must be a positive integer`,
      );
    }
  }
  if (raw.models !== undefined) {
    validateVendorModels(file, id, raw.models);
  }
}

const KNOWN_VENDOR_MODEL_ENTRY = new Set(["efforts", "default", "hint"]);

function validateVendorModels(file: string, id: string, raw: unknown): void {
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: vendors.${id}.models must be an object`);
  }
  let defaultCount = 0;
  for (const [modelId, entry] of Object.entries(raw)) {
    if (modelId === "") {
      throw new Error(
        `invalid config at ${file}: vendors.${id}.models keys must be non-empty strings`,
      );
    }
    if (!isRecord(entry)) {
      throw new Error(
        `invalid config at ${file}: vendors.${id}.models.${modelId} must be an object`,
      );
    }
    for (const key of Object.keys(entry)) {
      if (!KNOWN_VENDOR_MODEL_ENTRY.has(key)) {
        throw new Error(
          `invalid config at ${file}: vendors.${id}.models.${modelId} has unknown key ${key}`,
        );
      }
    }
    if (entry.efforts === undefined) {
      throw new Error(
        `invalid config at ${file}: vendors.${id}.models.${modelId}.efforts is required`,
      );
    }
    if (!Array.isArray(entry.efforts) || entry.efforts.some((e) => typeof e !== "string")) {
      throw new Error(
        `invalid config at ${file}: vendors.${id}.models.${modelId}.efforts must be an array of strings`,
      );
    }
    if (entry.efforts.some((e) => e === "")) {
      throw new Error(
        `invalid config at ${file}: vendors.${id}.models.${modelId}.efforts entries must be non-empty strings`,
      );
    }
    const efforts = entry.efforts as string[];
    if (entry.hint !== undefined && typeof entry.hint !== "string") {
      throw new Error(
        `invalid config at ${file}: vendors.${id}.models.${modelId}.hint must be a string`,
      );
    }
    if (entry.default !== undefined) {
      if (typeof entry.default === "boolean") {
        if (entry.default === true) {
          defaultCount += 1;
          if (efforts.length > 1) {
            throw new Error(
              `invalid config at ${file}: vendors.${id}.models.${modelId}.default is true but efforts lists ${efforts.length} values — use default: "<effort>" to mark one, or list a single effort`,
            );
          }
        }
        // Explicit false is allowed but is not a default marker.
      } else if (typeof entry.default === "string") {
        defaultCount += 1;
        if (entry.default === "") {
          throw new Error(
            `invalid config at ${file}: vendors.${id}.models.${modelId}.default must be a non-empty effort id when a string`,
          );
        }
        if (!efforts.includes(entry.default)) {
          throw new Error(
            `invalid config at ${file}: vendors.${id}.models.${modelId}.default effort ${JSON.stringify(entry.default)} is not listed in efforts`,
          );
        }
      } else {
        throw new Error(
          `invalid config at ${file}: vendors.${id}.models.${modelId}.default must be a boolean or effort string`,
        );
      }
    }
  }
  if (defaultCount > 1) {
    throw new Error(
      `invalid config at ${file}: vendors.${id}.models has ${defaultCount} default markers; at most one model may be the default`,
    );
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
  if (raw.maxConcurrent !== undefined) {
    const v = raw.maxConcurrent;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new Error(
        `invalid config at ${file}: profiles.${name}.maxConcurrent must be a positive integer`,
      );
    }
  }
  // #195 / ADR-0015: shape-only — do not validate that the command runs an agent.
  if (raw.template !== undefined) {
    assertStringArray(file, `profiles.${name}.template`, raw.template);
  }
  if (raw.hint !== undefined) {
    if (typeof raw.hint !== "string") {
      throw new Error(
        `invalid config at ${file}: profiles.${name}.hint must be a string`,
      );
    }
  }
}

/** True when a profile opts into launch-template argv composition (#195). */
export function profileHasLaunchTemplate(
  cfg: ProfileConfig | undefined | null,
): boolean {
  return cfg !== undefined && cfg !== null && Array.isArray(cfg.template);
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

function validateClientEntry(file: string, name: string, raw: unknown): void {
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: clients.${name} must be an object`);
  }
  if (raw.token === undefined) {
    throw new Error(`invalid config at ${file}: clients.${name}.token is required`);
  }
  assertNonEmptyString(file, `clients.${name}.token`, raw.token);
}

function validateClients(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: clients must be an object`);
  }
  for (const [name, entry] of Object.entries(raw)) {
    if (name === "") {
      throw new Error(`invalid config at ${file}: clients keys must be non-empty strings`);
    }
    validateClientEntry(file, name, entry);
  }
}

function validateDefaults(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: defaults must be an object`);
  }
  if (raw.vendor !== undefined) {
    assertNonEmptyString(file, "defaults.vendor", raw.vendor);
  }
  if (raw.profile !== undefined) {
    assertNonEmptyString(file, "defaults.profile", raw.profile);
  }
}

/**
 * Validate a parsed config value with the same named field errors as load time.
 * `source` is included in every error message (a filesystem path for file loads,
 * or a synthetic label for in-memory pushes) so callers can point at the input.
 * Unknown keys (top-level and nested) are ignored-but-preserved on the returned
 * object.
 */

function validateEval(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: eval must be an object`);
  }
  for (const key of ["enabled", "expected"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      throw new Error(`invalid config at ${file}: eval.${key} must be a boolean`);
    }
  }
}

function validateResume(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: resume must be an object`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error(`invalid config at ${file}: resume.enabled must be a boolean`);
  }
}

function validateRetry(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: retry must be an object`);
  }
  if (raw.max !== undefined) {
    const v = raw.max;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(
        `invalid config at ${file}: retry.max must be a non-negative integer`,
      );
    }
  }
  if (raw.window !== undefined) {
    const w = raw.window;
    if (typeof w === "string") {
      if (w === "") {
        throw new Error(
          `invalid config at ${file}: retry.window must be a non-empty duration string or non-negative number`,
        );
      }
    } else if (typeof w === "number") {
      if (!Number.isFinite(w) || w < 0) {
        throw new Error(
          `invalid config at ${file}: retry.window must be a non-empty duration string or non-negative number`,
        );
      }
    } else {
      throw new Error(
        `invalid config at ${file}: retry.window must be a non-empty duration string or non-negative number`,
      );
    }
  }
}

function validateTaskTypes(file: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    throw new Error(`invalid config at ${file}: taskTypes must be an object`);
  }
  for (const [id, entry] of Object.entries(raw)) {
    if (id === "") {
      throw new Error(`invalid config at ${file}: taskTypes keys must be non-empty strings`);
    }
    if (typeof entry === "string") {
      if (entry === "") {
        throw new Error(
          `invalid config at ${file}: taskTypes.${id} must be a non-empty rubric name`,
        );
      }
      continue;
    }
    if (!isRecord(entry)) {
      throw new Error(
        `invalid config at ${file}: taskTypes.${id} must be a rubric name string or { rubric: string }`,
      );
    }
    if (typeof entry.rubric !== "string" || entry.rubric === "") {
      throw new Error(
        `invalid config at ${file}: taskTypes.${id}.rubric must be a non-empty string`,
      );
    }
  }
}

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
  validateClients(source, config.clients);
  validateRetention(source, config.retention);
  validateDefaults(source, config.defaults);
  validateEval(source, config.eval);
  validateResume(source, config.resume);
  validateRetry(source, config.retry);
  validateTaskTypes(source, config.taskTypes);
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
  "clients",
  "retention",
  "defaults",
  "eval",
  "resume",
  "retry",
  "taskTypes",
]);
const KNOWN_EVAL = new Set(["enabled", "expected"]);
const KNOWN_RESUME = new Set(["enabled"]);
const KNOWN_RETRY = new Set(["max", "window"]);
const KNOWN_UI = new Set(["path", "package"]);
const KNOWN_DAEMON = new Set(["url", "idleTimeoutMs", "bind", "client", "token"]);
const KNOWN_VENDOR = new Set([
  "bin",
  "args",
  "env",
  "plugin",
  "childChannel",
  "retryWindow",
  "maxConcurrent",
  "models",
]);
const KNOWN_PROFILE = new Set([
  "vendor",
  "model",
  "effort",
  "sandbox",
  "network",
  "args",
  "env",
  "maxConcurrent",
]);
const KNOWN_RUNNER = new Set(["token"]);
const KNOWN_CLIENT = new Set(["token"]);
const KNOWN_RETENTION = new Set(["days"]);
const KNOWN_DEFAULTS = new Set(["vendor", "profile"]);

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
      const models = entry.models;
      if (isRecord(models)) {
        for (const [modelId, modelEntry] of Object.entries(models)) {
          if (!isRecord(modelEntry)) continue;
          for (const key of Object.keys(modelEntry)) {
            if (!KNOWN_VENDOR_MODEL_ENTRY.has(key)) {
              unknown.push(`vendors.${id}.models.${modelId}.${key}`);
            }
          }
        }
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
  const clients = config.clients;
  if (isRecord(clients)) {
    for (const [name, entry] of Object.entries(clients)) {
      if (!isRecord(entry)) continue;
      for (const key of Object.keys(entry)) {
        if (!KNOWN_CLIENT.has(key)) unknown.push(`clients.${name}.${key}`);
      }
    }
  }
  const retention = config.retention;
  if (isRecord(retention)) {
    for (const key of Object.keys(retention)) {
      if (!KNOWN_RETENTION.has(key)) unknown.push(`retention.${key}`);
    }
  }
  const defaults = config.defaults;
  if (isRecord(defaults)) {
    for (const key of Object.keys(defaults)) {
      if (!KNOWN_DEFAULTS.has(key)) unknown.push(`defaults.${key}`);
    }
  }
  const evalSection = config.eval;
  if (isRecord(evalSection)) {
    for (const key of Object.keys(evalSection)) {
      if (!KNOWN_EVAL.has(key)) unknown.push(`eval.${key}`);
    }
  }
  const resume = config.resume;
  if (isRecord(resume)) {
    for (const key of Object.keys(resume)) {
      if (!KNOWN_RESUME.has(key)) unknown.push(`resume.${key}`);
    }
  }
  const retry = config.retry;
  if (isRecord(retry)) {
    for (const key of Object.keys(retry)) {
      if (!KNOWN_RETRY.has(key)) unknown.push(`retry.${key}`);
    }
  }
  // taskTypes values are free-form entries (string or { rubric }); no nested
  // unknown-key scan beyond the section itself being known.
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
