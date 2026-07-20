import fs from "node:fs";
import path from "node:path";
import {
  getShippedVendorModels,
  loadCatalog,
  readConfig,
  refreshCatalog,
  writeCatalog,
  writeConfig,
  type ModelCatalog,
  type ParleyConfig,
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

  return 0;
}
