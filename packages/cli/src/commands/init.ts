import fs from "node:fs";
import path from "node:path";
import { styleText } from "node:util";
import * as p from "@clack/prompts";
import {
  getShippedVendorModels,
  loadCatalog,
  readConfig,
  refreshCatalog,
  writeCatalog,
  writeConfig,
  type ModelCatalog,
  type ModelEntry,
  type ParleyConfig,
  type VendorModelAllowlistEntry,
} from "@useparley/core";
import { createAdapterRegistry } from "@useparley/daemon/adapters/index.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import {
  defaultInitScope,
  installSkillsFromOptions,
  parseSkillInstallArgs,
} from "./skills/install.js";
import { formatInstallSummary, isGitRepo, repoRoot } from "./skills/copy.js";
import { PromptCancelled } from "./skills/prompts.js";
import { setupBundledPlugins } from "./plugins/setup.js";

/**
 * Built-in vendor ids and default CLI binary names (adapter DEFAULT_*_BIN).
 * Detection walks PATH (or absolute override) for these names.
 */
export const BUILTIN_VENDOR_BINS: Readonly<Record<string, string>> = {
  claude: "claude",
  cline: "cline",
  codex: "codex",
  fake: "fake",
  gemini: "gemini",
  goose: "goose",
  grok: "grok",
  hermes: "hermes",
  kilo: "kilo",
  kimi: "kimi",
  openclaw: "openclaw",
  opencode: "opencode",
  openhands: "openhands",
  pi: "pi",
};

export const BUILTIN_VENDOR_IDS = Object.keys(BUILTIN_VENDOR_BINS);

/** True when `bin` is executable on PATH or as an absolute path. */
export function isExecutableOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (bin.includes(path.sep) || path.isAbsolute(bin)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

/**
 * Detect which built-in vendor CLIs are available.
 * Respects `vendors.<id>.bin` overrides. `fake` only when
 * `PARLEY_FAKE_VENDOR_BIN` or `vendors.fake.bin` is set (and executable).
 */
export function detectHarnesses(
  config: ParleyConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const found: string[] = [];
  for (const id of BUILTIN_VENDOR_IDS) {
    const override = config.vendors?.[id]?.bin;
    if (id === "fake") {
      // Test double: only when explicitly configured. Accept an existing path
      // (script may not be +x; spawn uses node on the script) or a PATH hit.
      const fakeBin = override ?? env.PARLEY_FAKE_VENDOR_BIN;
      if (fakeBin === undefined || fakeBin === "") continue;
      if (path.isAbsolute(fakeBin) || fakeBin.includes(path.sep)) {
        if (fs.existsSync(fakeBin)) found.push(id);
      } else if (isExecutableOnPath(fakeBin, env)) {
        found.push(id);
      }
      continue;
    }
    const bin = override ?? BUILTIN_VENDOR_BINS[id]!;
    if (isExecutableOnPath(bin, env)) found.push(id);
  }
  return found;
}

/** Ensure a JSON object file exists; create `{}` when missing. Never overwrite. */
function ensureEmptyJsonFile(file: string): { path: string; created: boolean } {
  if (fs.existsSync(file)) {
    return { path: file, created: false };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeConfig(file, {});
  return { path: file, created: true };
}

export interface InitConfigResult {
  homeConfig: { path: string; created: boolean };
  projectConfig?: { path: string; created: boolean };
  scope: "global" | "project";
}

/** Whether init may use clack prompts for this invocation. */
export function isInteractiveInit(opts: {
  stdinIsTTY: boolean | undefined;
  json: boolean;
  yes: boolean;
}): boolean {
  return Boolean(opts.stdinIsTTY) && !opts.json && !opts.yes;
}

/**
 * Ensure layered config files exist for the resolved scope.
 * Always creates home `parley.json` when missing; project scope also ensures
 * `<repo>/.parley/config.json`.
 */
export function ensureInitConfig(opts: {
  homeConfigPath: string;
  cwd: string;
  scope: "global" | "project";
}): InitConfigResult {
  const homeConfig = ensureEmptyJsonFile(opts.homeConfigPath);
  if (opts.scope === "project" && !isGitRepo(opts.cwd)) {
    throw new UsageError("init: --scope project must run inside a git repository");
  }
  if (opts.scope === "project") {
    const root = repoRoot(opts.cwd);
    const projectPath = path.join(root, ".parley", "config.json");
    const projectConfig = ensureEmptyJsonFile(projectPath);
    return { homeConfig, projectConfig, scope: opts.scope };
  }
  return { homeConfig, scope: opts.scope };
}

/** Resolve init config scope from flags. */
export function resolveInitConfigScope(
  scopeFlag: string | undefined,
  cwd: string,
): "global" | "project" {
  if (scopeFlag === undefined) return defaultInitScope(cwd);
  if (scopeFlag !== "global" && scopeFlag !== "project") {
    throw new UsageError(`init: --scope must be 'global' or 'project', got '${scopeFlag}'`);
  }
  return scopeFlag;
}

export interface HarnessModelResult {
  vendor: string;
  modelCount: number;
  source: string;
  /** True when live probe did not yield models (shipped fallback or empty). */
  needsFallbackGuidance: boolean;
  modelIds: string[];
}

function modelEntries(catalog: ModelCatalog, vendor: string): ModelEntry[] {
  const live = catalog[vendor]?.models;
  if (live && live.length > 0) return live;
  return getShippedVendorModels(vendor)?.models ?? [];
}

function defaultMarker(model: ModelEntry): true | string {
  return model.default_effort && model.efforts.includes(model.default_effort)
    ? model.default_effort
    : model.efforts.length === 1
      ? true
      : model.efforts[0] ?? true;
}

/**
 * Build a valid authoritative allowlist from advisory catalog entries.
 *
 * `effortsById` narrows a model's allowed efforts (interactive opt-in);
 * omitted models keep every catalog effort. When `defaultEffort` is provided
 * it is used as the default-combo marker for the default model; otherwise the
 * marker is derived via `defaultMarker` over the *allowed* efforts (catalog
 * `default_effort` when still allowed, else first allowed effort / `true`).
 */
export function seedVendorModels(
  models: readonly ModelEntry[],
  selectedIds: readonly string[] = models.map((model) => model.id),
  defaultId: string | undefined = selectedIds[0],
  defaultEffort?: true | string,
  effortsById?: Readonly<Record<string, readonly string[]>>,
): Record<string, VendorModelAllowlistEntry> {
  const selected = new Set(selectedIds);
  const allowlist: Record<string, VendorModelAllowlistEntry> = {};
  for (const model of models) {
    if (!selected.has(model.id)) continue;
    const efforts = [...(effortsById?.[model.id] ?? model.efforts)];
    allowlist[model.id] = {
      efforts,
      ...(model.id === defaultId
        ? { default: defaultEffort ?? defaultMarker({ ...model, efforts }) }
        : {}),
    };
  }
  return allowlist;
}

/**
 * Surface clack's native `a` (toggle all) / `i` (invert) multiselect shortcuts
 * in the instructions footer rendered below the option list, next to the
 * Space/Enter hints. The exported instructions array is module state, so this
 * runs once per process; the guard also tolerates test mocks of the module
 * that don't export the array.
 */
let multiselectShortcutHintsInstalled = false;
function ensureMultiselectShortcutHints(): void {
  if (multiselectShortcutHintsInstalled) return;
  multiselectShortcutHintsInstalled = true;
  const instructions = (p as { MULTISELECT_INSTRUCTIONS?: string[] }).MULTISELECT_INSTRUCTIONS;
  if (Array.isArray(instructions)) {
    instructions.push(
      `${styleText("dim", "a:")} toggle all`,
      `${styleText("dim", "i:")} invert`,
    );
  }
}

/**
 * Interactive model/effort allowlist for one vendor. Exported for unit tests.
 * Returns `null` when the user submits an empty model selection — the vendor
 * is skipped and no allowlist is written.
 */
export async function promptVendorModels(
  vendor: string,
  models: readonly ModelEntry[],
): Promise<Record<string, VendorModelAllowlistEntry> | null> {
  ensureMultiselectShortcutHints();
  const selected = await p.multiselect({
    message: `${vendor}: models to allow (submit empty to skip)`,
    options: models.map((model) => ({
      value: model.id,
      label: model.id,
      hint: model.efforts.length > 0 ? `efforts: ${model.efforts.join(", ")}` : "no effort flag",
    })),
    initialValues: [],
    required: false,
  });
  if (p.isCancel(selected)) throw new PromptCancelled();
  if (selected.length === 0) return null;

  // Efforts are opt-in per model; single-effort models have nothing to narrow
  // and an empty submission keeps the full catalog set.
  const effortsById: Record<string, string[]> = {};
  for (const model of models) {
    if (!selected.includes(model.id) || model.efforts.length < 2) continue;
    const efforts = await p.multiselect({
      message: `${vendor}: efforts to allow for ${model.id} (submit empty to keep all)`,
      options: model.efforts.map((effort) => ({
        value: effort,
        label: effort,
        ...(effort === model.default_effort ? { hint: "catalog default" } : {}),
      })),
      initialValues: [],
      required: false,
    });
    if (p.isCancel(efforts)) throw new PromptCancelled();
    if (efforts.length > 0) effortsById[model.id] = efforts;
  }

  // A single selected model is the default by construction.
  let defaultId: string;
  if (selected.length === 1) {
    defaultId = selected[0]!;
  } else {
    const picked = await p.select({
      message: `${vendor}: default model`,
      options: selected.map((id) => ({ value: id, label: id })),
      initialValue: selected[0],
    });
    if (p.isCancel(picked)) throw new PromptCancelled();
    defaultId = picked;
  }

  const defaultModel = models.find((model) => model.id === defaultId);
  const allowedEfforts = defaultModel
    ? effortsById[defaultModel.id] ?? defaultModel.efforts
    : [];
  let defaultEffort: true | string | undefined;
  if (defaultModel && allowedEfforts.length >= 2) {
    const resolved = defaultMarker({ ...defaultModel, efforts: [...allowedEfforts] });
    // defaultMarker returns a string when efforts.length >= 2 (catalog default
    // or first effort); never `true` in that branch.
    const initialEffort = typeof resolved === "string" ? resolved : allowedEfforts[0]!;
    const effort = await p.select({
      message: `${vendor}: default effort for ${defaultId}`,
      options: allowedEfforts.map((e) => ({ value: e, label: e })),
      initialValue: initialEffort,
    });
    if (p.isCancel(effort)) throw new PromptCancelled();
    defaultEffort = effort;
  }

  return seedVendorModels(models, selected, defaultId, defaultEffort, effortsById);
}

/** Populate only missing daemon-owned delegation defaults; never replace values. */
export async function populateInitConfig(opts: {
  config: ParleyConfig;
  harnesses: readonly string[];
  catalog: ModelCatalog;
  interactive: boolean;
}): Promise<{ config: ParleyConfig; changed: boolean; configuredVendors: string[] }> {
  const config = structuredClone(opts.config);
  const configuredVendors: string[] = [];
  let changed = false;
  const pending: { vendor: string; models: ModelEntry[] }[] = [];
  for (const vendor of opts.harnesses) {
    const existing = config.vendors?.[vendor]?.models;
    if (existing && Object.keys(existing).length > 0) {
      configuredVendors.push(vendor);
      continue;
    }
    const models = modelEntries(opts.catalog, vendor);
    if (models.length === 0) continue;
    pending.push({ vendor, models });
  }
  // Interactive runs pick which vendors to walk through up front; submitting
  // nothing shortcuts vendor configuration entirely.
  let chosen = pending;
  if (opts.interactive && pending.length > 0) {
    ensureMultiselectShortcutHints();
    const picked = await p.multiselect({
      message: "vendors to configure (submit empty to skip)",
      options: pending.map(({ vendor, models }) => ({
        value: vendor,
        label: vendor,
        hint: `${models.length} model${models.length === 1 ? "" : "s"}`,
      })),
      initialValues: [],
      required: false,
    });
    if (p.isCancel(picked)) throw new PromptCancelled();
    const pickedSet = new Set(picked);
    chosen = pending.filter(({ vendor }) => pickedSet.has(vendor));
  }
  for (const { vendor, models } of chosen) {
    const allowlist = opts.interactive
      ? await promptVendorModels(vendor, models)
      : seedVendorModels(models);
    if (allowlist === null) continue;
    config.vendors ??= {};
    config.vendors[vendor] = { ...config.vendors[vendor], models: allowlist };
    configuredVendors.push(vendor);
    changed = true;
  }
  config.defaults ??= {};
  if (!config.defaults.vendor && configuredVendors.length > 0) {
    config.defaults.vendor = configuredVendors[0];
    changed = true;
  }
  if (!config.defaults.profile && config.profiles && Object.keys(config.profiles).length > 0) {
    config.defaults.profile = Object.keys(config.profiles).sort()[0];
    changed = true;
  }
  return { config, changed, configuredVendors };
}

function catalogEntrySummary(catalog: ModelCatalog, vendor: string): HarnessModelResult {
  const entry = catalog[vendor];
  if (entry === undefined || entry.models.length === 0) {
    const shipped = getShippedVendorModels(vendor);
    return {
      vendor,
      modelCount: 0,
      source: entry?.source ?? "none",
      needsFallbackGuidance: true,
      modelIds: shipped?.models.map((m) => m.id) ?? [],
    };
  }
  const fromShipped = entry.source.startsWith("shipped catalog") || entry.source === "stub";
  return {
    vendor,
    modelCount: entry.models.length,
    source: entry.source,
    needsFallbackGuidance: fromShipped,
    modelIds: entry.models.map((m) => m.id),
  };
}

function printModelFallbackGuidance(
  ctx: CliContext,
  m: HarnessModelResult,
  configPath: string,
  modelsPath: string,
): void {
  const shipped = getShippedVendorModels(m.vendor);
  const ids =
    m.modelIds.length > 0 ? m.modelIds : (shipped?.models.map((x) => x.id) ?? []);
  if (ids.length > 0) {
    ctx.stdout(`    Shipped reference models: ${ids.join(", ")}\n`);
  } else {
    ctx.stdout("    No shipped reference models for this vendor.\n");
  }
  ctx.stdout(
    `    Set models in ${modelsPath} or vendor defaults in ${configPath}, or use the /parley-wizard skill for interactive setup.\n`,
  );
}

/**
 * `parley init` — one-shot setup: skills, config files, harness detection,
 * model catalog refresh. Interactive on a TTY unless `--yes` or `--json` is
 * passed; non-interactive runs use sane defaults (layout=agents, scope=project
 * if git else global).
 */
export async function runInit(ctx: CliContext, args: string[]): Promise<number> {
  const parsed = parseSkillInstallArgs(args, "init");
  const json = parsed.json;
  const cwd = parsed.cwd;
  const interactive = isInteractiveInit({
    stdinIsTTY: process.stdin.isTTY,
    json,
    yes: parsed.yes,
  });

  // --- Skills ---
  const skillsResult = await installSkillsFromOptions({
    ...parsed,
    interactive,
    mode: "init",
  });
  if ("cancelled" in skillsResult) {
    return 130;
  }

  // --- Configuration ---
  const configScope = resolveInitConfigScope(parsed.scope, cwd);
  const configResult = ensureInitConfig({
    homeConfigPath: ctx.paths.config,
    cwd,
    scope: configScope,
  });

  // Load home config for vendor.bin overrides (created empty above if missing).
  let config: ParleyConfig = {};
  try {
    config = readConfig(ctx.paths.config);
  } catch (err) {
    ctx.stderr(`warning: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // --- Harnesses ---
  const harnesses = detectHarnesses(config, ctx.env);

  // --- Models ---
  const modelsFile = ctx.paths.models;
  let catalog = loadCatalog(modelsFile);
  const modelWarnings: string[] = [];
  const modelResults: HarnessModelResult[] = [];

  if (harnesses.length > 0) {
    const adapters = await createAdapterRegistry(ctx.env, {
      config,
      parleyHome: ctx.paths.home,
      log: (line) => {
        if (!json) ctx.stderr(`${line}\n`);
      },
    });
    const result = await refreshCatalog(catalog, harnesses, adapters);
    catalog = result.catalog;
    modelWarnings.push(...result.warnings);
    writeCatalog(modelsFile, catalog);
    for (const id of harnesses) {
      modelResults.push(catalogEntrySummary(catalog, id));
    }
  } else if (!fs.existsSync(modelsFile)) {
    // Seed so the path we point users at always exists.
    writeCatalog(modelsFile, catalog);
  }

  // Authoritative delegation settings are daemon-owned and always live in the
  // home config, regardless of the project-settings/skill install scope.
  let populated;
  try {
    populated = await populateInitConfig({ config, harnesses, catalog, interactive });
  } catch (err) {
    if (err instanceof PromptCancelled) return 130;
    throw err;
  }
  if (populated.changed) writeConfig(ctx.paths.config, populated.config);
  config = populated.config;

  let pluginSetup;
  try {
    pluginSetup = await setupBundledPlugins({
      ctx,
      cwd,
      harnesses,
      interactive,
      yes: parsed.yes,
      json,
    });
  } catch (err) {
    if (err instanceof PromptCancelled) return 130;
    throw err;
  }

  if (json) {
    printJson(ctx, {
      skills: {
        installs: skillsResult.records.map((r) => ({
          skill: r.skill,
          dest: r.dest,
          layout: r.layout,
          scope: r.scope ?? null,
          changes: r.changes,
        })),
      },
      configuration: {
        scope: configResult.scope,
        home: configResult.homeConfig,
        project: configResult.projectConfig ?? null,
      },
      harnesses,
      models: {
        file: modelsFile,
        vendors: modelResults,
        warnings: modelWarnings,
      },
      plugins: pluginSetup,
    });
    return 0;
  }

  // --- Human output ---
  if (!skillsResult.interactivePrinted) {
    ctx.stdout("## Skills\n");
    ctx.stdout(`${formatInstallSummary(skillsResult.records)}\n`);
  }

  ctx.stdout("\n## Configuration\n");
  const homeNote = configResult.homeConfig.created ? "created" : "exists";
  ctx.stdout(`  home: ${configResult.homeConfig.path} (${homeNote})\n`);
  if (configResult.projectConfig) {
    const projNote = configResult.projectConfig.created ? "created" : "exists";
    ctx.stdout(`  project: ${configResult.projectConfig.path} (${projNote})\n`);
  } else {
    ctx.stdout("  project: (scope=global; no project config written)\n");
  }
  ctx.stdout(`  scope: ${configResult.scope}\n`);
  if (populated.configuredVendors.length > 0) {
    ctx.stdout(`  delegation defaults: ${populated.configuredVendors.join(", ")}\n`);
  }

  ctx.stdout("\n## Harnesses\n");
  if (harnesses.length === 0) {
    ctx.stdout("  No built-in vendor CLIs detected on PATH.\n");
    ctx.stdout(
      `  Built-in vendor ids: ${BUILTIN_VENDOR_IDS.filter((id) => id !== "fake").join(", ")}.\n`,
    );
    ctx.stdout(
      `  Install a harness CLI, set vendors.<id>.bin in ${ctx.paths.config}, then re-run \`parley init\` or \`parley models --refresh\`.\n`,
    );
    ctx.stdout(
      `  Model catalog: ${modelsFile}. For interactive setup, use the /parley-wizard skill.\n`,
    );
  } else {
    for (const id of harnesses) {
      const bin =
        id === "fake"
          ? (config.vendors?.fake?.bin ?? ctx.env.PARLEY_FAKE_VENDOR_BIN ?? "fake")
          : (config.vendors?.[id]?.bin ?? BUILTIN_VENDOR_BINS[id] ?? id);
      ctx.stdout(`  ${id}  (bin: ${bin})\n`);
    }
  }

  ctx.stdout("\n## Models\n");
  if (harnesses.length === 0) {
    ctx.stdout(`  Skipped refresh (no harnesses). Catalog: ${modelsFile}\n`);
    ctx.stdout("  Use /parley-wizard or edit the catalog / config to set models.\n");
  } else {
    ctx.stdout(`  Catalog: ${modelsFile}\n`);
    for (const w of modelWarnings) {
      ctx.stderr(`warning: ${w}\n`);
    }
    for (const m of modelResults) {
      if (m.modelCount > 0 && !m.needsFallbackGuidance) {
        ctx.stdout(`  ${m.vendor}: ${m.modelCount} model(s) (source: ${m.source})\n`);
      } else if (m.modelCount > 0 && m.needsFallbackGuidance) {
        ctx.stdout(
          `  ${m.vendor}: no live models; using shipped reference catalog (${m.modelCount} model(s)).\n`,
        );
        printModelFallbackGuidance(ctx, m, ctx.paths.config, modelsFile);
      } else {
        ctx.stdout(`  ${m.vendor}: no models available.\n`);
        printModelFallbackGuidance(ctx, m, ctx.paths.config, modelsFile);
      }
    }
  }

  ctx.stdout("\n## Provenance plugins\n");
  if (pluginSetup.available.length === 0) {
    ctx.stdout("  No first-party provenance plugin matches a detected harness.\n");
  } else if (pluginSetup.installed.length > 0) {
    ctx.stdout(`  Set up: ${pluginSetup.installed.join(", ")}\n`);
  } else {
    ctx.stdout(`  Available: ${pluginSetup.available.join(", ")}\n`);
  }
  for (const warning of pluginSetup.warnings) ctx.stderr(`warning: ${warning}\n`);

  return 0;
}
