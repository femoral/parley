/**
 * Effective project configuration for orchestrators (#163 / #142 / #169).
 *
 * `GET /info?project=<root>` builds one structured config from daemon home +
 * project files, then renders orchestrator-facing prose from that same object
 * so the two can never drift. Retention/gc, traceability, and internals are
 * intentionally omitted. Output is scoped to the effective configuration:
 * configured vendors only, models only via profiles (no full catalog dump),
 * and eval-related sections only when evaluation is on (#169).
 */
import fs from "node:fs";
import path from "node:path";
import {
  ENFORCEMENT_DIMENSIONS,
  FALLBACK_TASK_TYPE,
  formatDuration,
  formatEnforcementCell,
  isChildChannel,
  parseDuration,
  readConfig,
  resolveRubricIdForType,
  type AdapterEnforcement,
  type ChildChannel,
  type ClassificationConfig,
  type ConfigLayerSource,
  type Criterion,
  type HomePaths,
  type ParleyConfig,
  type ProfileConfig,
  type RunnerStatus,
  type TaskTypesMap,
} from "@useparley/core";
import type { VendorAdapter } from "./adapters/types.js";
import {
  readProjectClassification,
  resolveProjectSettings,
} from "./context.js";
import { LOCAL_EXECUTOR_ID } from "./executor.js";
import {
  detectHostVendorIds,
  isExecutableOnPath,
} from "./fingerprint.js";
import { composeOrchestratorInstructions } from "./prompt-layers.js";
import {
  CODE_REATTEMPT_WINDOW_EXPIRED,
  CODE_RETRY_LIMIT_EXCEEDED,
  DEFAULT_RETRY_MAX,
  DEFAULT_RETRY_WINDOW_MS,
} from "./retry.js";
import { loadRubric } from "./rubrics.js";

/** Project-relative directory for slim rubric markdown files (#176). */
export const RUBRICS_MD_DIR_REL = ".parley/rubrics-md";

/** Entry written under `.parley/.gitignore` so generated rubrics stay untracked. */
export const RUBRICS_MD_GITIGNORE_ENTRY = "rubrics-md/";

/** Project-relative path for one rubric's markdown file. */
export function rubricMarkdownRelPath(rubricId: string): string {
  return `${RUBRICS_MD_DIR_REL}/${rubricId}.md`;
}

/**
 * Slim criterion listing for generated rubric markdown: one line per criterion,
 * id + text only (no kind/weight/version/baseline).
 */
export function formatRubricMarkdown(
  criteria: ReadonlyArray<Pick<Criterion, "id" | "text">>,
): string {
  const lines = criteria.map((c) => `- \`${c.id}\`: ${c.text}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Ensure `.parley/.gitignore` ignores generated `rubrics-md/` (#176).
 * Creates `.parley/` and the gitignore when missing; appends the entry when absent.
 */
export function ensureParleyRubricsGitignore(projectDir: string): void {
  const parleyDir = path.join(projectDir, ".parley");
  fs.mkdirSync(parleyDir, { recursive: true });
  const gitignorePath = path.join(parleyDir, ".gitignore");
  let content = "";
  try {
    content = fs.readFileSync(gitignorePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const hasEntry = content.split(/\r?\n/).some((line) => {
    const t = line.trim();
    return (
      t === "rubrics-md/" ||
      t === "rubrics-md" ||
      t === "/rubrics-md/" ||
      t === "/rubrics-md"
    );
  });
  if (hasEntry) return;
  const base =
    content === "" || content.endsWith("\n") ? content : `${content}\n`;
  fs.writeFileSync(
    gitignorePath,
    `${base}${RUBRICS_MD_GITIGNORE_ENTRY}\n`,
    "utf8",
  );
}

/**
 * Write slim markdown for each unique rubric referenced by `taskTypes`, delete
 * orphan `.md` files not in the current set, ensure gitignore, and return path
 * refs (one per task type). Does not run when eval is off — callers use
 * {@link materializeInfoRubrics}.
 */
export function writeRubricMarkdownFiles(
  projectDir: string,
  taskTypes: InfoTaskType[],
): InfoRubricSummary[] {
  const dir = path.join(projectDir, RUBRICS_MD_DIR_REL);
  fs.mkdirSync(dir, { recursive: true });

  const uniqueIds = new Set<string>();
  for (const t of taskTypes) {
    uniqueIds.add(t.rubric);
  }

  for (const rubricId of uniqueIds) {
    const rubric = loadRubric(projectDir, rubricId);
    const body = formatRubricMarkdown(rubric.criteria);
    fs.writeFileSync(path.join(dir, `${rubricId}.md`), body, "utf8");
  }

  // Delete orphans so stale rubrics do not linger after type/mapping changes.
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -".md".length);
    if (!uniqueIds.has(id)) {
      fs.unlinkSync(path.join(dir, entry));
    }
  }

  ensureParleyRubricsGitignore(projectDir);

  return taskTypes.map((t) => ({
    type: t.id,
    rubricId: t.rubric,
    path: rubricMarkdownRelPath(t.rubric),
  }));
}

/**
 * CLI-side materialization of rubric markdown after layered merge (#176).
 * When eval is off, returns `config` unchanged and writes nothing. When on,
 * regenerates files from final `taskTypes` and sets `evaluation.rubrics`.
 * Not called from {@link buildInfo} / {@link buildInfoConfig} so remote
 * daemons need no project write access.
 */
export function materializeInfoRubrics(
  projectDir: string,
  config: InfoConfig,
): InfoConfig {
  if (!config.evaluation.enabled) {
    return config;
  }
  const taskTypes = config.taskTypes ?? [];
  const rubrics = writeRubricMarkdownFiles(projectDir, taskTypes);
  return {
    ...config,
    evaluation: {
      ...config.evaluation,
      rubrics,
    },
  };
}

/** One allowed model+effort combo on a vendor (#185 / ADR-0014). */
export interface InfoVendorModel {
  id: string;
  efforts: string[];
  /** True when this model is the vendor's default combo (see {@link defaultEffort}). */
  isDefault: boolean;
  /**
   * Effort for the default combo when {@link isDefault} is true; null when the
   * default is effort-less; absent/null when not the default model.
   */
  defaultEffort: string | null;
  /** Orchestrator-facing free-text hint, or null. */
  hint: string | null;
}

/** One configured vendor as shown by `parley info` (#169 / #185). */
export interface InfoVendor {
  id: string;
  childChannel: ChildChannel;
  /** Per-vendor `retry.window` override (ms), or null when using project/default. */
  retryWindowMs: number | null;
  /** Human form of {@link retryWindowMs}, or null. */
  retryWindow: string | null;
  /**
   * Model+effort allowlist (#185). Empty when the vendor has no models
   * configured (deny-by-default — cannot delegate until set).
   */
  models: InfoVendorModel[];
  /**
   * Declared posture enforcement for this configured vendor (#279), when the
   * adapter is loaded. Absent when the vendor key has no registered adapter.
   */
  enforcement?: AdapterEnforcement;
}

/**
 * One executor in the fleet view (#321 / #307): the daemon host (`local`) plus
 * each registered remote runner. Summary only — models and host detail live in
 * `parley runners show`.
 */
export interface InfoExecutor {
  /** `local` for the daemon host, or a registered runner name. */
  name: string;
  status: RunnerStatus;
  /** Advertised vendor ids (host fingerprint or last registration). */
  vendors: string[];
}

/**
 * One row of the sandbox/network enforcement matrix (#279) — every registered
 * adapter (not only configured vendors), sourced from
 * {@link VendorAdapter.enforcement}.
 */
export interface InfoEnforcementRow {
  id: string;
  enforcement: AdapterEnforcement;
}

/** One named profile from the daemon's `parley.json`. */
export interface InfoProfile {
  name: string;
  vendor: string;
  model: string | null;
  effort: string | null;
  sandbox: string | null;
  network: boolean | null;
  /**
   * True when the profile has a launch template (#195 / ADR-0015). Vendor/
   * model/effort on a template profile are *declared* (unverified) provenance.
   */
  template: boolean;
  /** Orchestrator-facing free-text hint, or null (#195). */
  hint: string | null;
}

/**
 * Configured delegate fallbacks (`defaults.vendor` / `defaults.profile`, #175).
 * When both are set, profile wins at resolve time.
 */
export interface InfoDefaults {
  vendor: string | null;
  profile: string | null;
}

/** One work-domain type (configured or automatic `other`). */
export interface InfoTaskType {
  id: string;
  rubric: string;
  /** True for the automatic `other` fallback (not listed in project taskTypes). */
  automatic: boolean;
}

/**
 * Path ref for one task type's rubric (eval-on only). Criterion text lives in
 * the markdown file at `path` rather than being inlined (#176).
 */
export interface InfoRubricSummary {
  type: string;
  rubricId: string;
  /** Project-relative path, e.g. `.parley/rubrics-md/coding.md`. */
  path: string;
}

/** Evaluation section of the structured config. */
export interface InfoEvaluation {
  enabled: boolean;
  /**
   * Rubric summary per task type when enabled (including automatic `other`).
   * Absent when evaluation is off.
   */
  rubrics?: InfoRubricSummary[];
  /**
   * How to submit an eval when enabled. Absent when off.
   */
  howTo?: {
    command: string;
    notes: string[];
  };
}

/** Fix / retry section. */
export interface InfoFix {
  resumeEnabled: boolean;
  retryMax: number;
  retryWindowMs: number;
  retryWindow: string;
  commands: {
    fix: string;
    fresh: string;
  };
  errorCodes: Array<{
    code: string;
    exitCode: number;
    meaning: string;
    remedy: string;
  }>;
}

/** Provenance for layered project settings shown by `parley info` (#178). */
export interface InfoProvenance {
  evaluation: ConfigLayerSource;
  resume: ConfigLayerSource;
  retryMax: ConfigLayerSource;
  retryWindow: ConfigLayerSource;
  taskTypes: ConfigLayerSource;
  /** Classification is whole-file layered (default / global / project). */
  classification: ConfigLayerSource;
}

/**
 * Structured effective configuration. `parley info --json` prints this object;
 * prose is always rendered from it (never from a parallel read).
 *
 * When evaluation is off, `taskTypes` and `classification` are omitted so the
 * JSON twin stays as slim as the prose (#169).
 */
export interface InfoConfig {
  project: string;
  /** Compounded orchestrator PROMPT.md (home → project), or null when empty. */
  instructions: string | null;
  /** Vendors present in daemon config and/or referenced by profiles (#169). */
  vendors: InfoVendor[];
  /**
   * Executor fleet (#321): daemon host first (`local`), then registered runners.
   * Vendor availability is host-fingerprinted / last-advertised — never the CLI
   * host's PATH. One summary line each in prose; depth deferred to runners show.
   */
  executors: InfoExecutor[];
  /**
   * Host/capability advisories (not gates). Built on the **daemon** host
   * (e.g. missing bubblewrap for grok, #247 / #321). Empty when nothing to
   * warn about; omitted from JSON only when undefined.
   */
  warnings?: string[];
  /**
   * Per-adapter posture enforcement matrix (#279). Built from every registered
   * adapter's declaration (including unconfigured built-ins; excludes nothing
   * the registry knows about). `approximate` / `none` cells mean the flag is
   * accepted but not OS-enforced.
   */
  enforcement_matrix: InfoEnforcementRow[];
  profiles: InfoProfile[];
  /** Fallback when delegate omits -v/--profile (#175). */
  defaults: InfoDefaults;
  /** Work-domain types; present only when evaluation is enabled (#169). */
  taskTypes?: InfoTaskType[];
  /** Size/difficulty guidance; present only when evaluation is enabled (#169). */
  classification?: ClassificationConfig;
  evaluation: InfoEvaluation;
  fix: InfoFix;
  /** Where each layered setting was decided (#178). */
  provenance: InfoProvenance;
}

/**
 * Advisory warning when sandboxed grok postures cannot run on the **daemon**
 * host (#247 / #321). Pure: inject platform / PATH presence so tests never
 * depend on the machine. Runner-host sandbox posture is capability detail
 * (see `parley runners show`), not listed here.
 *
 * "Grok present" means configured in effective config **or** advertised by the
 * local (`local`) executor fingerprint.
 */
export function grokSandboxHostWarnings(opts: {
  platform: NodeJS.Platform;
  hasBubblewrap: boolean;
  grokPresent: boolean;
}): string[] {
  if (opts.platform !== "linux") return [];
  if (!opts.grokPresent) return [];
  if (opts.hasBubblewrap) return [];
  return [
    "Sandboxed grok postures (workspace, read-only) will fail on the daemon host: " +
      "bubblewrap (`bwrap`) is not on PATH. Install bubblewrap for your " +
      'distribution, or use a profile with sandbox: "full".',
  ];
}

/** Daemon response body for `GET /info`. */
export interface InfoResponse {
  prose: string;
  config: InfoConfig;
}

export interface BuildInfoOptions {
  /** Absolute workspace root the CLI sends as `?project=`. */
  projectDir: string;
  paths: HomePaths;
  adapters: Map<string, VendorAdapter>;
  /**
   * Env used for the daemon host fingerprint and sandbox probe (defaults to
   * `process.env`). Tests inject a controlled PATH.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Registered remote runners (status already derived; vendor ids from last
   * advertisement). Daemon host is always prepended as `local` / online.
   */
  runners?: ReadonlyArray<{
    name: string;
    status: RunnerStatus;
    vendors: readonly string[];
  }>;
  /**
   * Platform for the daemon-host sandbox advisory (defaults to
   * `process.platform`). Injected in tests.
   */
  platform?: NodeJS.Platform;
}

function effectiveChildChannel(
  adapter: VendorAdapter | undefined,
  vendorCfg: { childChannel?: ChildChannel } | undefined,
): ChildChannel {
  const override = vendorCfg?.childChannel;
  if (typeof override === "string" && isChildChannel(override)) return override;
  return adapter?.childChannel ?? "mcp";
}

function vendorRetryWindowMs(
  vendorCfg: { retryWindow?: string | number } | undefined,
): number | null {
  if (vendorCfg?.retryWindow === undefined) return null;
  const raw = vendorCfg.retryWindow;
  if (typeof raw === "string") {
    const ms = parseDuration(raw);
    return ms !== null && ms >= 0 ? ms : null;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.round(raw);
  }
  return null;
}

function profileEntry(name: string, cfg: ProfileConfig): InfoProfile {
  return {
    name,
    vendor: cfg.vendor,
    model: cfg.model ?? null,
    effort: cfg.effort ?? null,
    sandbox: cfg.sandbox ?? null,
    network: cfg.network ?? null,
    template: Array.isArray(cfg.template),
    hint: typeof cfg.hint === "string" ? cfg.hint : null,
  };
}

/** Expand `vendors.<id>.models` for `parley info` (#185). */
function infoVendorModels(
  vendorCfg: { models?: Record<string, { efforts?: string[]; default?: boolean | string; hint?: string }> } | undefined,
): InfoVendorModel[] {
  const models = vendorCfg?.models;
  if (models === undefined || typeof models !== "object" || models === null) {
    return [];
  }
  return Object.entries(models)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entry]) => {
      const efforts = Array.isArray(entry.efforts)
        ? entry.efforts.filter((e): e is string => typeof e === "string")
        : [];
      const d = entry.default;
      let isDefault = false;
      let defaultEffort: string | null = null;
      if (d === true) {
        isDefault = true;
        defaultEffort = efforts.length === 1 ? efforts[0]! : null;
      } else if (typeof d === "string" && d !== "") {
        isDefault = true;
        defaultEffort = d;
      }
      return {
        id,
        efforts,
        isDefault,
        defaultEffort: isDefault ? defaultEffort : null,
        hint: typeof entry.hint === "string" ? entry.hint : null,
      };
    });
}

/**
 * Vendor ids that appear in effective daemon configuration: explicit
 * `vendors.<id>` entries and vendors named by profiles. Never the full
 * built-in adapter catalog (#169).
 */
function configuredVendorIds(daemonConfig: ParleyConfig): string[] {
  const ids = new Set<string>();
  for (const id of Object.keys(daemonConfig.vendors ?? {})) {
    ids.add(id);
  }
  for (const profile of Object.values(daemonConfig.profiles ?? {})) {
    if (typeof profile.vendor === "string" && profile.vendor !== "") {
      ids.add(profile.vendor);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve a path-only rubric ref for one task type (no I/O, no criterion load).
 * Markdown materialization is CLI-side via {@link materializeInfoRubrics}.
 */
function rubricRef(typeId: string, taskTypes: TaskTypesMap): InfoRubricSummary {
  const rubricId = resolveRubricIdForType(typeId, taskTypes);
  return {
    type: typeId,
    rubricId,
    path: rubricMarkdownRelPath(rubricId),
  };
}

/**
 * Build the structured effective config for a project (hot-read, no I/O beyond
 * config files already used at spawn/eval/fix time).
 */
export function buildInfoConfig(options: BuildInfoOptions): InfoConfig {
  const { projectDir, paths, adapters } = options;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  let daemonConfig: ParleyConfig;
  try {
    daemonConfig = readConfig(paths.config);
  } catch {
    daemonConfig = {};
  }

  const instructions = composeOrchestratorInstructions({
    homeDir: paths.home,
    projectDir,
  });

  // #169: only vendors that are configured (vendors.* and/or profile refs).
  const vendors: InfoVendor[] = configuredVendorIds(daemonConfig).map((id) => {
    const adapter = adapters.get(id);
    const vendorCfg = daemonConfig.vendors?.[id];
    const windowMs = vendorRetryWindowMs(vendorCfg);
    const entry: InfoVendor = {
      id,
      childChannel: effectiveChildChannel(adapter, vendorCfg),
      retryWindowMs: windowMs,
      retryWindow: windowMs !== null ? formatDuration(windowMs) : null,
      models: infoVendorModels(vendorCfg),
    };
    if (adapter?.enforcement !== undefined) {
      entry.enforcement = adapter.enforcement;
    }
    return entry;
  });

  // #321: executor fleet — daemon host first, then registered runners.
  // Vendor ids are host-fingerprinted (daemon PATH / plugin registry), never
  // the CLI caller's PATH. Model catalogs stay on runners show / registration.
  const localVendors = detectHostVendorIds({
    adapters,
    config: daemonConfig,
    env,
  });
  const executors: InfoExecutor[] = [
    {
      name: LOCAL_EXECUTOR_ID,
      status: "online",
      vendors: localVendors,
    },
    ...(options.runners ?? []).map((r) => ({
      name: r.name,
      status: r.status,
      vendors: [...r.vendors],
    })),
  ];

  // #279: full registry matrix (all loaded adapters), stable id order.
  const enforcement_matrix: InfoEnforcementRow[] = [...adapters.entries()]
    .filter(([, adapter]) => adapter.enforcement !== undefined)
    .map(([id, adapter]) => ({ id, enforcement: adapter.enforcement }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Profiles already carry only configured models (no full models.json dump).
  const profiles: InfoProfile[] = Object.entries(daemonConfig.profiles ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, cfg]) => profileEntry(name, cfg));

  const defaults: InfoDefaults = {
    vendor:
      typeof daemonConfig.defaults?.vendor === "string"
        ? daemonConfig.defaults.vendor
        : null,
    profile:
      typeof daemonConfig.defaults?.profile === "string"
        ? daemonConfig.defaults.profile
        : null,
  };

  // Layered project settings: defaults < global (home) < project (#178).
  const settings = resolveProjectSettings(projectDir, paths, {
    defaultRetryMax: DEFAULT_RETRY_MAX,
  });
  const classificationSource: ConfigLayerSource = fs.existsSync(
    path.join(projectDir, ".parley", "classification.json"),
  )
    ? "project"
    : fs.existsSync(path.join(paths.home, "classification.json"))
      ? "global"
      : "default";

  const evalEnabled = settings.evalEnabled;

  // #169: task types, classification, rubrics, and how-to only when eval is on.
  let taskTypes: InfoTaskType[] | undefined;
  let classification: ClassificationConfig | undefined;
  let evaluation: InfoEvaluation;

  if (!evalEnabled) {
    evaluation = { enabled: false };
  } else {
    const taskTypesMap = settings.taskTypes;
    taskTypes = Object.entries(taskTypesMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, entry]) => ({
        id,
        rubric: entry.rubric,
        automatic: false,
      }));
    if (!Object.prototype.hasOwnProperty.call(taskTypesMap, FALLBACK_TASK_TYPE)) {
      taskTypes.push({
        id: FALLBACK_TASK_TYPE,
        rubric: resolveRubricIdForType(FALLBACK_TASK_TYPE, taskTypesMap),
        automatic: true,
      });
    }
    classification = readProjectClassification(projectDir, paths);
    const typeIds = taskTypes.map((t) => t.id);
    evaluation = {
      enabled: true,
      // Path refs only; CLI materializes markdown after layered merge (#176).
      rubrics: typeIds.map((id) => rubricRef(id, taskTypesMap)),
      howTo: {
        command:
          'parley eval <task> --answers \'<json>\' --feedback "<text>"',
        notes: [
          "Map every rubric criterion id to a boolean (true = criterion holds).",
          "The daemon computes score and baseline; do not assert a free score.",
          "When eval is on, register an orchestrator session first (`parley session`; provenance from PARLEY_HARNESS/MODEL/EFFORT via a harness plugin, or unknown when unset).",
          "A later eval call overwrites the previous result for that task.",
        ],
      },
    };
  }

  const retryMax = settings.retryMax;
  let retryWindowMs = DEFAULT_RETRY_WINDOW_MS;
  if (settings.retryWindow !== undefined) {
    const window = settings.retryWindow;
    if (typeof window === "string") {
      const ms = parseDuration(window);
      if (ms !== null && ms >= 0) retryWindowMs = ms;
    } else if (typeof window === "number" && Number.isFinite(window) && window >= 0) {
      retryWindowMs = Math.round(window);
    }
  }
  const resumeEnabled = settings.resumeEnabled;

  const fix: InfoFix = {
    resumeEnabled,
    retryMax,
    retryWindowMs,
    retryWindow: formatDuration(retryWindowMs),
    commands: {
      fix: 'parley fix <task> "<brief>"',
      fresh: 'parley fix --fresh <task> "<brief>"',
    },
    errorCodes: [
      {
        code: CODE_RETRY_LIMIT_EXCEEDED,
        exitCode: 7,
        meaning: `Resumed fix would exceed retry.max (${retryMax}) for this chain.`,
        remedy: "Use `parley fix --fresh` or start a new delegate.",
      },
      {
        code: CODE_REATTEMPT_WINDOW_EXPIRED,
        exitCode: 8,
        meaning: `Parent has been terminal longer than the reattempt window (${formatDuration(retryWindowMs)}).`,
        remedy: "Use `parley fix --fresh` or start a new delegate.",
      },
    ],
  };

  const provenance: InfoProvenance = {
    evaluation: settings.provenance.eval,
    resume: settings.provenance.resume,
    retryMax: settings.provenance.retryMax,
    retryWindow: settings.provenance.retryWindow,
    taskTypes: settings.provenance.taskTypes,
    classification: classificationSource,
  };

  // Daemon-host sandbox advisory (#247 / #321): describes this process's host,
  // not the CLI caller's. Grok "present" = configured allowlist or local fingerprint.
  const configuredVendorIdsSet = new Set(vendors.map((v) => v.id));
  const grokPresent =
    configuredVendorIdsSet.has("grok") || localVendors.includes("grok");
  const hostWarnings = grokSandboxHostWarnings({
    platform,
    hasBubblewrap: isExecutableOnPath("bwrap", env),
    grokPresent,
  });

  const config: InfoConfig = {
    project: projectDir,
    instructions,
    vendors,
    executors,
    enforcement_matrix,
    profiles,
    defaults,
    evaluation,
    fix,
    provenance,
  };
  if (hostWarnings.length > 0) config.warnings = hostWarnings;
  if (taskTypes !== undefined) config.taskTypes = taskTypes;
  if (classification !== undefined) config.classification = classification;
  return config;
}

/** Render orchestrator-facing prose from a structured {@link InfoConfig}. */
export function renderInfoProse(config: InfoConfig): string {
  const lines: string[] = [];

  lines.push("# Parley project info", "");

  // --- Host warnings (advisory only; never fail the command) ---
  const warnings = config.warnings ?? [];
  if (warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  // --- Instructions ---
  lines.push("## Instructions", "");
  if (config.instructions === null || config.instructions.trim() === "") {
    lines.push("(no orchestrator PROMPT.md layers)");
  } else {
    lines.push(config.instructions.trimEnd());
  }
  lines.push("");

  // --- Vendors & profiles ---
  lines.push("## Vendors & profiles", "");
  lines.push("### Vendors");
  if (config.vendors.length === 0) {
    lines.push("(none configured)");
    lines.push("Run /parley-wizard to configure a vendor and model allowlist.");
  } else {
    for (const v of config.vendors) {
      const extras: string[] = [`child channel: ${v.childChannel}`];
      if (v.retryWindow !== null) {
        extras.push(`retry window: ${v.retryWindow}`);
      }
      lines.push(`- \`${v.id}\` (${extras.join("; ")})`);
      if (v.models.length === 0) {
        lines.push(
          "  - models: (none configured — deny-by-default; run /parley-wizard or set vendors.<id>.models)",
        );
      } else {
        for (const m of v.models) {
          const bits: string[] = [];
          if (m.efforts.length === 0) {
            bits.push("efforts: (none — effort-less)");
          } else {
            bits.push(`efforts: ${m.efforts.join(", ")}`);
          }
          if (m.isDefault) {
            const de =
              m.defaultEffort === null
                ? "default"
                : `default@${m.defaultEffort}`;
            bits.push(de);
          }
          if (m.hint !== null && m.hint !== "") {
            bits.push(`hint: ${m.hint}`);
          }
          lines.push(`  - \`${m.id}\` (${bits.join("; ")})`);
        }
      }
    }
  }
  lines.push("");
  lines.push("### Executors");
  lines.push(
    "Vendor availability per executor host (daemon first, then registered runners). Detail: `parley runners show <name>`.",
  );
  // Tolerate older daemon bodies that predate the executors field (#321).
  const executors = config.executors ?? [];
  if (executors.length === 0) {
    lines.push("(no executors)");
  } else {
    for (const ex of executors) {
      const vendorList =
        ex.vendors.length > 0 ? ex.vendors.join(", ") : "(none)";
      lines.push(`- \`${ex.name}\` (${ex.status}): ${vendorList}`);
    }
  }
  lines.push("");
  lines.push("### Profiles");
  if (config.profiles.length === 0) {
    lines.push("(none configured in daemon parley.json)");
  } else {
    for (const p of config.profiles) {
      const bits = [`vendor=${p.vendor}`];
      if (p.model !== null) {
        bits.push(
          p.template ? `model=${p.model} (declared)` : `model=${p.model}`,
        );
      }
      if (p.effort !== null) {
        bits.push(
          p.template ? `effort=${p.effort} (declared)` : `effort=${p.effort}`,
        );
      }
      if (p.sandbox !== null) bits.push(`sandbox=${p.sandbox}`);
      if (p.network !== null) bits.push(`network=${p.network}`);
      if (p.template) bits.push("template");
      if (p.hint !== null && p.hint !== "") bits.push(`hint: ${p.hint}`);
      lines.push(`- \`${p.name}\`: ${bits.join(" ")}`);
    }
  }
  lines.push("");
  lines.push("### Defaults");
  lines.push(
    "When `parley delegate` omits `-v` / `--profile`, the daemon uses these fallbacks (profile wins if both are set):",
  );
  if (config.defaults.profile === null && config.defaults.vendor === null) {
    lines.push(
      "(none — set `defaults.profile` or `defaults.vendor` in daemon parley.json)",
    );
  } else {
    if (config.defaults.profile !== null) {
      lines.push(`- profile: \`${config.defaults.profile}\``);
    }
    if (config.defaults.vendor !== null) {
      lines.push(`- vendor: \`${config.defaults.vendor}\``);
    }
  }
  lines.push("");

  // --- Sandbox enforcement matrix (#279) ---
  lines.push("## Sandbox enforcement", "");
  lines.push(
    "Every adapter accepts the same posture flags (`--sandbox read-only|workspace|full`, `--no-network`), but **enforcement is not portable**. Cells below are adapter self-declarations:",
  );
  lines.push("");
  lines.push(
    "- `enforced` — vendor delivers what the posture asks (real OS/CLI isolation, or unrestricted `full`)",
  );
  lines.push("- `approximate` — soft lever only (see note in parentheses)");
  lines.push("- `none` — flag accepted; nothing real happens");
  lines.push(
    "- `refused` — prepare fails rather than under-isolate (e.g. network-off gaps)",
  );
  lines.push("");
  lines.push(
    "`approximate` / `none` mean the flag is accepted but **not** OS-enforced. A prepare-time `PARLEY-DIAG` line is written to the task's `diag.log` when a weak `read-only` / `workspace` or `network:false` posture is requested. `full` is trivially enforced (no isolation requested) and never produces a sandbox diagnostic.",
  );
  lines.push("");
  if (config.enforcement_matrix.length === 0) {
    lines.push("(no adapters registered)");
  } else {
    const headers = ["Vendor", ...ENFORCEMENT_DIMENSIONS];
    lines.push(`| ${headers.join(" | ")} |`);
    lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const row of config.enforcement_matrix) {
      // Hide the contract-test double from the orchestrator-facing matrix.
      if (row.id === "fake") continue;
      const cells = ENFORCEMENT_DIMENSIONS.map((dim) =>
        formatEnforcementCell(row.enforcement[dim]),
      );
      lines.push(`| \`${row.id}\` | ${cells.join(" | ")} |`);
    }
  }
  lines.push("");

  // --- Task types / Classification / Evaluation details: eval-on only (#169) ---
  if (config.evaluation.enabled) {
    const taskTypes = config.taskTypes ?? [];
    lines.push("## Task types", "");
    lines.push(
      `Task type set (source: ${config.provenance.taskTypes}). Pass \`--type <id>\` on delegate (optional; omitted ⇒ \`other\`). Valid ids:`,
    );
    for (const t of taskTypes) {
      const auto = t.automatic ? " — automatic fallback when `--type` is omitted" : "";
      lines.push(`- \`${t.id}\` → rubric \`${t.rubric}\`${auto}`);
    }
    lines.push("");

    const classification = config.classification;
    if (classification !== undefined) {
      lines.push("## Classification", "");
      lines.push(
        `Size/difficulty guidance (source: ${config.provenance.classification}). Optional at delegate time: \`--size <id>\` and \`--difficulty <id>\` (for metrics).`,
      );
      lines.push("");
      lines.push("### Sizes");
      for (const s of classification.sizes) {
        lines.push(`- \`${s.id}\`: ${s.guidance}`);
      }
      lines.push("");
      lines.push("### Difficulties");
      for (const d of classification.difficulties) {
        lines.push(`- \`${d.id}\`: ${d.guidance}`);
      }
      lines.push("");
    }

    lines.push("## Evaluation", "");
    lines.push(
      `Evaluation is **on** for this project. (source: ${config.provenance.evaluation})`,
    );
    lines.push("");
    if (config.evaluation.howTo !== undefined) {
      lines.push("### How to eval");
      lines.push("");
      lines.push("```");
      lines.push(config.evaluation.howTo.command);
      lines.push("```");
      for (const note of config.evaluation.howTo.notes) {
        lines.push(`- ${note}`);
      }
      lines.push("");
    }
    lines.push("### Rubrics by type");
    lines.push("");
    for (const r of config.evaluation.rubrics ?? []) {
      lines.push(`- \`${r.type}\` → rubric \`${r.path}\``);
    }
    lines.push("");
  }

  // --- Fix & retries ---
  lines.push("## Fix & retries", "");
  lines.push(
    `\`${config.fix.commands.fix}\` — linked reattempt; resumes the parent vendor session when resume is enabled.`,
  );
  lines.push(
    `\`${config.fix.commands.fresh}\` — blank session, uncapped by retry limits, stays in the attempt chain.`,
  );
  lines.push(
    "Launch-template profiles never resume: `parley fix` on a template-profile task always behaves as `--fresh` (fresh template argv; no vendor-session resume).",
  );
  lines.push("");
  lines.push(
    `- resume.enabled: **${config.fix.resumeEnabled ? "on" : "off"}** (source: ${config.provenance.resume}; off ⇒ linked attempt with a fresh session)`,
  );
  lines.push(
    `- retry.max: **${config.fix.retryMax}** (source: ${config.provenance.retryMax}; caps *resumed* fixes per chain)`,
  );
  lines.push(
    `- retry.window: **${config.fix.retryWindow}** (source: ${config.provenance.retryWindow}; parent must not have been terminal longer than this to resume)`,
  );
  const vendorOverrides = config.vendors.filter((v) => v.retryWindow !== null);
  if (vendorOverrides.length > 0) {
    lines.push("- per-vendor retry window overrides:");
    for (const v of vendorOverrides) {
      lines.push(`  - \`${v.id}\`: ${v.retryWindow}`);
    }
  }
  lines.push("");
  lines.push("Error codes (CLI exit codes):");
  for (const e of config.fix.errorCodes) {
    lines.push(
      `- \`${e.code}\` (exit ${e.exitCode}): ${e.meaning} ${e.remedy}`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Compute effective config and prose in one shot. Prose is always
 * `renderInfoProse(config)` of the same object returned in the response.
 */
export function buildInfo(options: BuildInfoOptions): InfoResponse {
  const config = buildInfoConfig(options);
  return { prose: renderInfoProse(config), config };
}
