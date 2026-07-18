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
  FALLBACK_TASK_TYPE,
  formatDuration,
  isChildChannel,
  parseDuration,
  readConfig,
  resolveRubricIdForType,
  scoreRubric,
  type ChildChannel,
  type ClassificationConfig,
  type ConfigLayerSource,
  type Criterion,
  type HomePaths,
  type ParleyConfig,
  type ProfileConfig,
  type TaskTypesMap,
} from "@useparley/core";
import type { VendorAdapter } from "./adapters/types.js";
import {
  readProjectClassification,
  resolveProjectSettings,
} from "./context.js";
import { composeOrchestratorInstructions } from "./prompt-layers.js";
import {
  CODE_REATTEMPT_WINDOW_EXPIRED,
  CODE_RETRY_LIMIT_EXCEEDED,
  DEFAULT_RETRY_MAX,
  DEFAULT_RETRY_WINDOW_MS,
} from "./retry.js";
import { loadRubric } from "./rubrics.js";

/** One configured vendor as shown by `parley info` (#169). */
export interface InfoVendor {
  id: string;
  childChannel: ChildChannel;
  /** Per-vendor `retry.window` override (ms), or null when using project/default. */
  retryWindowMs: number | null;
  /** Human form of {@link retryWindowMs}, or null. */
  retryWindow: string | null;
}

/** One named profile from the daemon's `parley.json`. */
export interface InfoProfile {
  name: string;
  vendor: string;
  model: string | null;
  effort: string | null;
  sandbox: string | null;
  network: boolean | null;
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

/** Compact criterion line for rubric summaries. */
export interface InfoCriterion {
  id: string;
  kind: Criterion["kind"];
  weight: number;
  text: string;
}

/** Rubric resolved for one task type (eval-on only). */
export interface InfoRubricSummary {
  type: string;
  rubricId: string;
  version: number;
  /** 0–10 baseline derived from the rubric formula. */
  baseline: number;
  criteria: InfoCriterion[];
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
  };
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

function rubricSummary(
  projectDir: string,
  typeId: string,
  taskTypes: TaskTypesMap,
): InfoRubricSummary {
  const rubricId = resolveRubricIdForType(typeId, taskTypes);
  const rubric = loadRubric(projectDir, rubricId);
  // All-false answers: baseline is independent of answers; score is unused.
  const answers: Record<string, boolean> = {};
  for (const c of rubric.criteria) answers[c.id] = false;
  const { baseline } = scoreRubric(rubric, answers);
  return {
    type: typeId,
    rubricId: rubric.id,
    version: rubric.version,
    baseline,
    criteria: rubric.criteria.map((c) => ({
      id: c.id,
      kind: c.kind,
      weight: c.weight,
      text: c.text,
    })),
  };
}

/**
 * Build the structured effective config for a project (hot-read, no I/O beyond
 * config files already used at spawn/eval/fix time).
 */
export function buildInfoConfig(options: BuildInfoOptions): InfoConfig {
  const { projectDir, paths, adapters } = options;

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
    return {
      id,
      childChannel: effectiveChildChannel(adapter, vendorCfg),
      retryWindowMs: windowMs,
      retryWindow: windowMs !== null ? formatDuration(windowMs) : null,
    };
  });

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
      rubrics: typeIds.map((id) => rubricSummary(projectDir, id, taskTypesMap)),
      howTo: {
        command:
          'parley eval <task> --answers \'<json>\' --feedback "<text>"',
        notes: [
          "Map every rubric criterion id to a boolean (true = criterion holds).",
          "The daemon computes score and baseline; do not assert a free score.",
          "When eval is on, register an orchestrator session first (`parley session -v <harness> -m <model> -e <effort>`).",
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

  const config: InfoConfig = {
    project: projectDir,
    instructions,
    vendors,
    profiles,
    defaults,
    evaluation,
    fix,
    provenance,
  };
  if (taskTypes !== undefined) config.taskTypes = taskTypes;
  if (classification !== undefined) config.classification = classification;
  return config;
}

/** Render orchestrator-facing prose from a structured {@link InfoConfig}. */
export function renderInfoProse(config: InfoConfig): string {
  const lines: string[] = [];

  lines.push("# Parley project info", "");

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
  } else {
    for (const v of config.vendors) {
      const extras: string[] = [`child channel: ${v.childChannel}`];
      if (v.retryWindow !== null) {
        extras.push(`retry window: ${v.retryWindow}`);
      }
      lines.push(`- \`${v.id}\` (${extras.join("; ")})`);
    }
  }
  lines.push("");
  lines.push("### Profiles");
  if (config.profiles.length === 0) {
    lines.push("(none configured in daemon parley.json)");
  } else {
    for (const p of config.profiles) {
      const bits = [`vendor=${p.vendor}`];
      if (p.model !== null) bits.push(`model=${p.model}`);
      if (p.effort !== null) bits.push(`effort=${p.effort}`);
      if (p.sandbox !== null) bits.push(`sandbox=${p.sandbox}`);
      if (p.network !== null) bits.push(`network=${p.network}`);
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
      lines.push(
        `#### \`${r.type}\` (rubric \`${r.rubricId}\` v${r.version}, baseline ${r.baseline}/10)`,
      );
      for (const c of r.criteria) {
        const sign = c.kind === "positive" ? "+" : "−";
        lines.push(`- ${sign}${c.weight} \`${c.id}\`: ${c.text}`);
      }
      lines.push("");
    }
  }

  // --- Fix & retries ---
  lines.push("## Fix & retries", "");
  lines.push(
    `\`${config.fix.commands.fix}\` — linked reattempt; resumes the parent vendor session when resume is enabled.`,
  );
  lines.push(
    `\`${config.fix.commands.fresh}\` — blank session, uncapped by retry limits, stays in the attempt chain.`,
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
