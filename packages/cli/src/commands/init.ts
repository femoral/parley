import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import * as p from "@clack/prompts";
import {
  getShippedVendorModels,
  isSafeAllowlistToken,
  loadCatalog,
  readConfig,
  refreshCatalog,
  writeCatalog,
  writeConfig,
  type ModelCatalog,
  type ModelEntry,
  type ParleyConfig,
  type SelectedModel,
  type VendorAdapter,
  type VendorModelAllowlistEntry,
} from "@useparley/core";
import { createAdapterRegistry } from "@useparley/daemon/adapters/index.js";
import {
  BUILTIN_VENDOR_BINS,
  BUILTIN_VENDOR_IDS,
  detectHarnesses,
  isExecutableOnPath,
} from "@useparley/daemon/fingerprint.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import {
  defaultInitScope,
  installSkillsFromOptions,
  parseSkillInstallArgs,
} from "./skills/install.js";
import { formatInstallSummary, isGitRepo, repoRoot } from "./skills/copy.js";
import { PromptCancelled } from "./skills/prompts.js";

/** Workflow ids seeded by `parley init` (ADR-0016: no shipped resolution layer). */
export const EXAMPLE_WORKFLOW_IDS = ["coding-1", "coding-2", "research"] as const;

export type ExampleWorkflowId = (typeof EXAMPLE_WORKFLOW_IDS)[number];

export type WorkflowSeedStatus = "created" | "skipped";

export interface WorkflowSeedRecord {
  id: ExampleWorkflowId;
  dest: string;
  status: WorkflowSeedStatus;
}

/**
 * Absolute path to the bundled example workflow seeds. Resolves from this
 * module so it works from a git clone (tsx runs `src/`) and from a published
 * package alike. `PARLEY_WORKFLOW_SEEDS_SOURCE` overrides for tests.
 */
export function workflowSeedsSourceDir(): string {
  const override = process.env.PARLEY_WORKFLOW_SEEDS_SOURCE;
  if (override) return path.resolve(override);
  // workflows/ lives at the package root; this file is under src/commands/.
  return fileURLToPath(new URL("../../workflows", import.meta.url));
}

/**
 * Copy each example workflow into `destWorkflowsDir/<id>/` when missing.
 * Never overwrites an existing `.parley/workflows/<id>/` directory (or file).
 */
export function seedExampleWorkflows(
  destWorkflowsDir: string,
  sourceDir: string = workflowSeedsSourceDir(),
): WorkflowSeedRecord[] {
  const records: WorkflowSeedRecord[] = [];
  for (const id of EXAMPLE_WORKFLOW_IDS) {
    const src = path.join(sourceDir, id);
    const dest = path.join(destWorkflowsDir, id);
    if (!fs.existsSync(src)) {
      throw new UsageError(`init: bundled workflow seed not found: ${id} (looked in ${src})`);
    }
    if (fs.existsSync(dest)) {
      records.push({ id, dest, status: "skipped" });
      continue;
    }
    fs.mkdirSync(destWorkflowsDir, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    records.push({ id, dest, status: "created" });
  }
  return records;
}

/** Format seed results for human init output. */
export function formatWorkflowSeedSummary(records: readonly WorkflowSeedRecord[]): string {
  if (records.length === 0) return "  (none)\n";
  const lines: string[] = [];
  for (const r of records) {
    const note = r.status === "created" ? "created" : "exists, skipped";
    lines.push(`  ${r.id}: ${r.dest} (${note})`);
  }
  return `${lines.join("\n")}\n`;
}

// Shared with the runner fingerprint path (ADR-0029 / #314) — do not fork.
export {
  BUILTIN_VENDOR_BINS,
  BUILTIN_VENDOR_IDS,
  detectHarnesses,
  isExecutableOnPath,
};

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
 * True when effective config targets a remote daemon via `daemon.url` (#328).
 * Config key only — no network probe. Same signal the rest of the CLI uses.
 */
export function isRemoteDaemonConfig(config: ParleyConfig): boolean {
  return typeof config.daemon?.url === "string" && config.daemon.url.length > 0;
}

/**
 * Notice when init skips vendor-allowlist authoring against a remote daemon.
 * Names `parley models` so the operator's next step is unambiguous.
 */
export const REMOTE_MODELS_NOTICE =
  "Model allowlists are owned by the remote daemon (daemon.url is set). " +
  "Manage them with `parley models` (list, set, unset, --refresh); " +
  "local catalog probe and vendors.*.models writes were skipped.";

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
 * Merge a CLI-selected model into the advisory catalog list for setup (#284).
 *
 * - Selection already in the catalog → leave efforts unchanged (disk-only
 *   effort strings must not widen the authoritative allowlist).
 * - Catalog non-empty and selection unknown → no inject. The operator can
 *   type the id; we refuse to invent a brand-new allowlist key for a
 *   catalogued vendor from an untrusted vendor file.
 * - Catalog empty (goose, openhands) → inject one entry so pre-fill can make
 *   the vendor delegatable. **Posture change (ADR-0014):** empty-catalog
 *   vendors become spawnable from a readable vendor file alone.
 *
 * Injected model and effort ids must pass {@link isSafeAllowlistToken}
 * (charset + length). Adversarial disk strings (newlines, ANSI, multi-MiB)
 * are treated as "no selection known" — same as unreadable.
 */
export function modelsWithCliSelection(
  models: readonly ModelEntry[],
  cliSelected: SelectedModel | null | undefined,
): ModelEntry[] {
  if (cliSelected === null || cliSelected === undefined || cliSelected.model === "") {
    return [...models];
  }
  if (!isSafeAllowlistToken(cliSelected.model)) {
    return [...models];
  }
  const existing = models.find((m) => m.id === cliSelected.model);
  if (existing) {
    // Do not widen catalog efforts with disk-only values.
    return [...models];
  }
  // Pure inject only for empty catalogs (goose, openhands). Non-empty catalogs
  // that lack this model keep the list unchanged — never invent a key for a
  // catalogued vendor from disk.
  if (models.length > 0) {
    return [...models];
  }
  const effort =
    cliSelected.effort !== null &&
    cliSelected.effort !== "" &&
    isSafeAllowlistToken(cliSelected.effort)
      ? cliSelected.effort
      : undefined;
  return [
    {
      id: cliSelected.model,
      efforts: effort ? [effort] : [],
      default_effort: effort ?? null,
    },
  ];
}

/**
 * Default-effort marker for non-interactive seed from a CLI selection.
 * Validated against the **pre-injection** catalog so disk-only effort strings
 * never become the allowlist default of a catalog model (ADR-0014).
 *
 * When the model is a pure empty-catalog inject, the CLI effort is accepted
 * only when it is a safe allowlist token (charset + length). That value then
 * becomes both the sole allowed effort and the entry's `default` — deliberate:
 * for empty-catalog vendors there is no catalog `default_effort` to consult,
 * so the vendor file is the only source (documented in ADR-0014).
 */
export function cliSelectionDefaultEffort(
  catalogModels: readonly ModelEntry[],
  cliSelected: SelectedModel,
): true | string | undefined {
  if (cliSelected.effort === null || cliSelected.effort === "") {
    return undefined;
  }
  if (!isSafeAllowlistToken(cliSelected.effort)) {
    return undefined;
  }
  const catalogEntry = catalogModels.find((m) => m.id === cliSelected.model);
  if (catalogEntry) {
    return catalogEntry.efforts.includes(cliSelected.effort)
      ? cliSelected.effort
      : undefined;
  }
  // Empty-catalog inject path — effort is the sole known value for the entry.
  return cliSelected.effort;
}

function tryReadSelectedModel(
  adapters: Map<string, VendorAdapter> | undefined,
  vendor: string,
): SelectedModel | null {
  if (!adapters) return null;
  try {
    return adapters.get(vendor)?.readSelectedModel?.() ?? null;
  } catch {
    return null;
  }
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
 *
 * When `cliSelected` is readable, pre-fills the multiselect and default
 * prompts with the CLI's current selection (#284). The operator can always
 * override; an unreadable selection leaves initial values empty (today's
 * behavior).
 */
export async function promptVendorModels(
  vendor: string,
  models: readonly ModelEntry[],
  cliSelected?: SelectedModel | null,
): Promise<Record<string, VendorModelAllowlistEntry> | null> {
  ensureMultiselectShortcutHints();
  const prefillId =
    cliSelected && models.some((m) => m.id === cliSelected.model)
      ? cliSelected.model
      : undefined;
  // When a CLI selection is pre-filled, Enter accepts it (does not skip).
  // Call that out so "submit empty to skip" is not misleading.
  const modelMessage =
    prefillId !== undefined
      ? `${vendor}: models to allow (CLI selection pre-filled; deselect all and submit empty to skip)`
      : `${vendor}: models to allow (submit empty to skip)`;
  const selected = await p.multiselect({
    message: modelMessage,
    options: models.map((model) => ({
      value: model.id,
      label: model.id,
      hint:
        model.id === prefillId
          ? model.efforts.length > 0
            ? `CLI selection; efforts: ${model.efforts.join(", ")}`
            : "CLI selection; no effort flag"
          : model.efforts.length > 0
            ? `efforts: ${model.efforts.join(", ")}`
            : "no effort flag",
    })),
    initialValues: prefillId !== undefined ? [prefillId] : [],
    required: false,
  });
  if (p.isCancel(selected)) throw new PromptCancelled();
  if (selected.length === 0) return null;

  // Efforts are opt-in per model; single-effort models have nothing to narrow
  // and an empty submission keeps the full catalog set.
  const effortsById: Record<string, string[]> = {};
  for (const model of models) {
    if (!selected.includes(model.id) || model.efforts.length < 2) continue;
    const prefillEffort =
      cliSelected &&
      cliSelected.model === model.id &&
      cliSelected.effort !== null &&
      model.efforts.includes(cliSelected.effort)
        ? cliSelected.effort
        : undefined;
    const efforts = await p.multiselect({
      message: `${vendor}: efforts to allow for ${model.id} (submit empty to keep all)`,
      options: model.efforts.map((effort) => ({
        value: effort,
        label: effort,
        ...(effort === model.default_effort
          ? { hint: "catalog default" }
          : effort === prefillEffort
            ? { hint: "CLI selection" }
            : {}),
      })),
      initialValues: prefillEffort !== undefined ? [prefillEffort] : [],
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
    const defaultInitial =
      prefillId !== undefined && selected.includes(prefillId)
        ? prefillId
        : selected[0];
    const picked = await p.select({
      message: `${vendor}: default model`,
      options: selected.map((id) => ({ value: id, label: id })),
      initialValue: defaultInitial,
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
    // Prefer CLI selection when it is still among allowed efforts; else catalog.
    const cliEffort =
      cliSelected &&
      cliSelected.model === defaultId &&
      cliSelected.effort !== null &&
      allowedEfforts.includes(cliSelected.effort)
        ? cliSelected.effort
        : undefined;
    const initialEffort =
      cliEffort ??
      (typeof resolved === "string" ? resolved : allowedEfforts[0]!);
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
  /** Optional adapters for CLI selected-model pre-fill (#284). */
  adapters?: Map<string, VendorAdapter>;
}): Promise<{ config: ParleyConfig; changed: boolean; configuredVendors: string[] }> {
  const config = structuredClone(opts.config);
  const configuredVendors: string[] = [];
  let changed = false;
  const pending: {
    vendor: string;
    models: ModelEntry[];
    /** Pre-injection catalog (effort validation must use this, not `models`). */
    catalogModels: ModelEntry[];
    cliSelected: SelectedModel | null;
  }[] = [];
  for (const vendor of opts.harnesses) {
    const existing = config.vendors?.[vendor]?.models;
    if (existing && Object.keys(existing).length > 0) {
      configuredVendors.push(vendor);
      continue;
    }
    const cliSelected = tryReadSelectedModel(opts.adapters, vendor);
    // Keep the pre-injection catalog for effort validation (non-interactive).
    const catalogModels = modelEntries(opts.catalog, vendor);
    const models = modelsWithCliSelection(catalogModels, cliSelected);
    if (models.length === 0) continue;
    pending.push({ vendor, models, catalogModels, cliSelected });
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
  for (const { vendor, models, catalogModels, cliSelected } of chosen) {
    let allowlist: Record<string, VendorModelAllowlistEntry> | null;
    if (opts.interactive) {
      allowlist = await promptVendorModels(vendor, models, cliSelected);
    } else if (cliSelected && models.some((m) => m.id === cliSelected.model)) {
      // Non-interactive: seed all listed models; default effort is validated
      // against the pre-injection catalog (never a disk-only string).
      // Deliberate: empty-catalog vendors (goose/openhands) become delegatable
      // when a CLI selection is readable — that is the pre-fill feature.
      allowlist = seedVendorModels(
        models,
        models.map((m) => m.id),
        cliSelected.model,
        cliSelectionDefaultEffort(catalogModels, cliSelected),
      );
    } else {
      allowlist = seedVendorModels(models);
    }
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
 * `parley init` — one-shot setup: skills, config files, example workflows,
 * harness detection, model catalog refresh. Interactive on a TTY unless
 * `--yes` or `--json` is passed; non-interactive runs use sane defaults
 * (layout=agents, scope=project if git else global).
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

  // --- Example workflows (project scope only; user-owned after copy) ---
  // ADR-0016: no shipped-workflow resolution layer — seeds land under the
  // project's `.parley/workflows/<id>/` and are edited from that moment.
  let workflowSeeds: WorkflowSeedRecord[] = [];
  if (configScope === "project") {
    const root = repoRoot(cwd);
    const destDir = path.join(root, ".parley", "workflows");
    workflowSeeds = seedExampleWorkflows(destDir);
  }

  // Load home config for vendor.bin overrides (created empty above if missing).
  let config: ParleyConfig = {};
  try {
    config = readConfig(ctx.paths.config);
  } catch (err) {
    ctx.stderr(`warning: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Remote daemon (#328): allowlist/catalog probe reflect the daemon host's
  // vendor reality, not this CLI host. Skip local catalog probe + vendors.*.models
  // writes; point the operator at `parley models` instead.
  const remoteDaemon = isRemoteDaemonConfig(config);

  // --- Harnesses ---
  // Still detect local harnesses (CLI-local PATH info); only models authoring
  // is gated on remoteDaemon below.
  const harnesses = detectHarnesses(config, ctx.env);

  // --- Models ---
  const modelsFile = ctx.paths.models;
  let catalog = loadCatalog(modelsFile);
  const modelWarnings: string[] = [];
  const modelResults: HarnessModelResult[] = [];
  // Shared with allowlist pre-fill so selected-model reads (#284) use the same
  // operator-home env as the catalog refresh.
  let adapters: Map<string, VendorAdapter> | undefined;
  let populated: { config: ParleyConfig; changed: boolean; configuredVendors: string[] } = {
    config,
    changed: false,
    configuredVendors: [],
  };

  if (remoteDaemon) {
    // No createAdapterRegistry / refreshCatalog / writeCatalog / populateInitConfig.
    // Leave existing local vendors.*.models and models.json untouched.
  } else {
    if (harnesses.length > 0) {
      adapters = await createAdapterRegistry(ctx.env, {
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
    try {
      populated = await populateInitConfig({
        config,
        harnesses,
        catalog,
        interactive,
        adapters,
      });
    } catch (err) {
      if (err instanceof PromptCancelled) return 130;
      throw err;
    }
    if (populated.changed) writeConfig(ctx.paths.config, populated.config);
    config = populated.config;
  }

  // Provenance-plugin setup is deliberately not part of init while the
  // plugins are still being validated; see setupBundledPlugins.

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
      workflows: {
        seeds: workflowSeeds.map((r) => ({
          id: r.id,
          dest: r.dest,
          status: r.status,
        })),
      },
      harnesses,
      models: remoteDaemon
        ? {
            remote: true,
            skipped: true,
            notice: REMOTE_MODELS_NOTICE,
            file: modelsFile,
            vendors: [] as HarnessModelResult[],
            warnings: [] as string[],
          }
        : {
            file: modelsFile,
            vendors: modelResults,
            warnings: modelWarnings,
          },
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

  ctx.stdout("\n## Workflows\n");
  if (configScope !== "project") {
    ctx.stdout("  Skipped (scope=global; example workflows seed into the project layer).\n");
    ctx.stdout("  Re-run with `--scope project` inside a git repo to copy coding-1, coding-2, research.\n");
  } else {
    ctx.stdout(formatWorkflowSeedSummary(workflowSeeds));
    ctx.stdout(
      "  These are copies you own — edit freely under .parley/workflows/. Parley has no separate shipped-workflow layer.\n",
    );
  }

  ctx.stdout("\n## Harnesses\n");
  if (harnesses.length === 0) {
    ctx.stdout("  No built-in vendor CLIs detected on PATH.\n");
    ctx.stdout(
      `  Built-in vendor ids: ${BUILTIN_VENDOR_IDS.filter((id) => id !== "fake").join(", ")}.\n`,
    );
    if (remoteDaemon) {
      ctx.stdout(
        `  Install a harness CLI on the daemon host, then manage models with \`parley models --refresh\`.\n`,
      );
    } else {
      ctx.stdout(
        `  Install a harness CLI, set vendors.<id>.bin in ${ctx.paths.config}, then re-run \`parley init\` or \`parley models --refresh\`.\n`,
      );
      ctx.stdout(
        `  Model catalog: ${modelsFile}. For interactive setup, use the /parley-wizard skill.\n`,
      );
    }
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
  if (remoteDaemon) {
    ctx.stdout(`  ${REMOTE_MODELS_NOTICE}\n`);
  } else if (harnesses.length === 0) {
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

  return 0;
}
