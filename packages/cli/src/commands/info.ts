import fs from "node:fs";
import path from "node:path";
import {
  extractProjectConfigLayer,
  formatDuration,
  parseDuration,
  resolveEffectiveProjectSettings,
  type ProjectConfigLayer,
  type ParleyConfig,
} from "@useparley/core";
import {
  materializeInfoRubrics,
  renderInfoProse,
  type InfoConfig,
  type InfoProvenance,
} from "@useparley/daemon/info.js";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonGet, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import { detectHarnesses } from "./init.js";

interface InfoBody {
  prose: string;
  config: InfoConfig;
}

interface ConfigBody {
  config: unknown;
}

/** Read local project `.parley/config.json` (missing/corrupt ⇒ {}). */
function readLocalProjectLayer(projectRoot: string): ProjectConfigLayer {
  const file = path.join(projectRoot, ".parley", "config.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    return extractProjectConfigLayer(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Apply CLI-side layered merge (daemon globals via GET /config + local project)
 * onto the daemon-built InfoConfig so remote and local share one code path (#178).
 */
function applyLayeredSettings(
  config: InfoConfig,
  globalLayer: ProjectConfigLayer,
  projectLayer: ProjectConfigLayer,
): InfoConfig {
  const settings = resolveEffectiveProjectSettings(globalLayer, projectLayer);
  const next: InfoConfig = { ...config };

  // Evaluation enabled flag + collapse rubrics when off.
  if (settings.evalEnabled) {
    next.evaluation = {
      ...config.evaluation,
      enabled: true,
      // Keep daemon rubrics/howTo when present; fill howTo if missing.
      howTo: config.evaluation.howTo ?? {
        command: 'parley eval <task> --answers \'<json>\' --feedback "<text>"',
        notes: [
          "Map every rubric criterion id to a boolean (true = criterion holds).",
          "The daemon computes score and baseline; do not assert a free score.",
          "When eval is on, register an orchestrator session first (`parley session`; provenance from PARLEY_HARNESS/MODEL/EFFORT via a harness plugin, or unknown when unset).",
          "A later eval call overwrites the previous result for that task.",
        ],
      },
      rubrics: config.evaluation.rubrics,
    };
  } else {
    next.evaluation = { enabled: false };
  }

  // Fix / retry from effective merge.
  let retryWindowMs = config.fix.retryWindowMs;
  if (settings.retryWindow !== undefined) {
    const window = settings.retryWindow;
    if (typeof window === "string") {
      const ms = parseDuration(window);
      if (ms !== null && ms >= 0) retryWindowMs = ms;
    } else if (typeof window === "number" && Number.isFinite(window) && window >= 0) {
      retryWindowMs = Math.round(window);
    }
  } else if (settings.provenance.retryWindow === "default") {
    // Keep daemon default window when neither layer set a window.
    retryWindowMs = config.fix.retryWindowMs;
  }

  // Format duration without pulling formatDuration if already on config — recompute
  // via the daemon-rendered form when ms unchanged; simple formatter for changes.
  const retryWindow =
    retryWindowMs === config.fix.retryWindowMs
      ? config.fix.retryWindow
      : formatDuration(retryWindowMs);

  next.fix = {
    ...config.fix,
    resumeEnabled: settings.resumeEnabled,
    retryMax: settings.retryMax,
    retryWindowMs,
    retryWindow,
    errorCodes: config.fix.errorCodes.map((e) => {
      if (e.code === "retry_limit_exceeded") {
        return {
          ...e,
          meaning: `Resumed fix would exceed retry.max (${settings.retryMax}) for this chain.`,
        };
      }
      if (e.code === "reattempt_window_expired") {
        return {
          ...e,
          meaning: `Parent has been terminal longer than the reattempt window (${retryWindow}).`,
        };
      }
      return e;
    }),
  };

  // Task types (#169: eval-on only): rebuild list from the effective map when a
  // non-default layer declares types, or when the daemon omitted them.
  if (!settings.evalEnabled) {
    delete next.taskTypes;
    delete next.classification;
  } else if (
    settings.provenance.taskTypes !== "default" ||
    (config.taskTypes ?? []).length === 0
  ) {
    const entries: InfoConfig["taskTypes"] = Object.entries(settings.taskTypes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, entry]) => ({
        id,
        rubric: entry.rubric,
        automatic: false,
      }));
    if (!Object.prototype.hasOwnProperty.call(settings.taskTypes, "other")) {
      entries.push({ id: "other", rubric: "generic", automatic: true });
    }
    next.taskTypes = entries;
  }

  const provenance: InfoProvenance = {
    evaluation: settings.provenance.eval,
    resume: settings.provenance.resume,
    retryMax: settings.provenance.retryMax,
    retryWindow: settings.provenance.retryWindow,
    taskTypes: settings.provenance.taskTypes,
    classification: config.provenance.classification,
  };
  next.provenance = provenance;

  return next;
}


/**
 * `parley info [--json]` — print the project's effective configuration as
 * orchestrator-facing prose, or the structured config the prose was rendered
 * from (#163 / #178). Global settings come from the daemon (`GET /config`);
 * project overrides are read locally and deep-merged.
 */
export async function runInfo(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });

  if (positionals.length > 0) {
    throw new UsageError(`info: unexpected argument: ${positionals[0]}`);
  }

  const project = path.resolve(process.cwd());
  const params = new URLSearchParams();
  params.set("project", project);

  const discovery = await ensureDaemon(ctx.paths, ctx.env);

  // Global layer exclusively via daemon API (never read home from CLI).
  let globalLayer: ProjectConfigLayer = {};
  let globalConfig: ParleyConfig = {};
  try {
    const configBody = await daemonGet<ConfigBody>(discovery, "/config");
    globalLayer = extractProjectConfigLayer(configBody.config);
    if (typeof configBody.config === "object" && configBody.config !== null) {
      globalConfig = configBody.config as ParleyConfig;
    }
  } catch (err) {
    // Unreachable daemon fails hard below on /info; soft-fail here only if
    // /config is missing on an older daemon — treat as empty global.
    if (!(err instanceof DaemonRequestError && err.status === 404)) {
      // Still try /info; empty global keeps project-only behavior.
      globalLayer = {};
    }
  }

  const projectLayer = readLocalProjectLayer(project);

  let body: InfoBody;
  try {
    body = await daemonGet<InfoBody>(discovery, `/info?${params.toString()}`);
  } catch (err) {
    if (err instanceof DaemonRequestError && err.status === 400) {
      throw new Error(`info: ${err.message}`);
    }
    throw err;
  }

  // One merge implementation: daemon-reported globals + local project overrides.
  // Materialize rubric markdown after layered merge so final taskTypes win (#176).
  const layered = applyLayeredSettings(body.config, globalLayer, projectLayer);
  const configuredVendorIds = new Set(layered.vendors.map((vendor) => vendor.id));
  layered.detected_vendors = detectHarnesses(globalConfig, ctx.env)
    .filter((id) => !configuredVendorIds.has(id))
    .sort((a, b) => a.localeCompare(b));
  const config = materializeInfoRubrics(project, layered);
  const prose = renderInfoProse(config);

  if (flags["--json"] === true) {
    printJson(ctx, config);
  } else {
    const text = prose.endsWith("\n") || prose === "" ? prose : `${prose}\n`;
    ctx.stdout(text);
  }
  return 0;
}
