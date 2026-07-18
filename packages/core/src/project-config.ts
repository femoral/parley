/**
 * Layered project settings (#178): shipped defaults < global (daemon home) <
 * project `.parley/config.json`, deep-merged per key.
 *
 * The daemon is the sole reader of host global config; CLI callers source the
 * global layer via `GET /config` and merge with a local project layer so local
 * and remote daemons share one code path.
 */
import {
  defaultTaskTypes,
  resolveTaskTypes,
  type TaskTypesMap,
} from "./classification.js";

/** Where an effective setting was decided. */
export type ConfigLayerSource = "default" | "global" | "project";

/**
 * Project-settings schema shared by `.parley/config.json` and the matching
 * keys in the daemon home config (`parley.json` / `GET /config`).
 */
export interface ProjectConfigLayer {
  eval?: {
    enabled?: boolean;
    /** @deprecated alias of enabled (#45 / #157) */
    expected?: boolean;
  };
  resume?: {
    enabled?: boolean;
  };
  retry?: {
    max?: number;
    window?: string | number;
  };
  /** Raw taskTypes section (string or `{ rubric }` entries); resolved later. */
  taskTypes?: unknown;
}

/** Provenance for each independent project-settings field. */
export interface ProjectConfigProvenance {
  eval: ConfigLayerSource;
  resume: ConfigLayerSource;
  retryMax: ConfigLayerSource;
  retryWindow: ConfigLayerSource;
  taskTypes: ConfigLayerSource;
}

/** Fully resolved project settings after defaults + deep merge. */
export interface EffectiveProjectSettings {
  evalEnabled: boolean;
  resumeEnabled: boolean;
  retryMax: number;
  /** Raw window value when set by global or project; undefined ⇒ caller default. */
  retryWindow: string | number | undefined;
  taskTypes: TaskTypesMap;
  /** Merged raw layer (pre-default resolution) for inspection/tests. */
  merged: ProjectConfigLayer;
  provenance: ProjectConfigProvenance;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge plain objects. Later layers win per key; `undefined` in a later
 * layer does not clear an earlier value. Arrays and non-objects replace wholly
 * (no element-wise merge).
 */
export function deepMerge(
  ...layers: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (const layer of layers) {
    if (layer === null || layer === undefined) continue;
    result = deepMergePair(result, layer);
  }
  return result;
}

function deepMergePair(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMergePair(prev, value);
    } else {
      out[key] =
        typeof value === "object" && value !== null
          ? (structuredClone(value) as unknown)
          : value;
    }
  }
  return out;
}

/**
 * Pull the project-settings subset from any config-shaped object (home
 * `parley.json`, project `config.json`, or a `GET /config` body).
 * Unknown / absent sections are omitted.
 */
export function extractProjectConfigLayer(raw: unknown): ProjectConfigLayer {
  if (!isPlainObject(raw)) return {};
  const layer: ProjectConfigLayer = {};
  if (raw.eval !== undefined && isPlainObject(raw.eval)) {
    const evalLayer: NonNullable<ProjectConfigLayer["eval"]> = {};
    if (typeof raw.eval.enabled === "boolean") evalLayer.enabled = raw.eval.enabled;
    if (typeof raw.eval.expected === "boolean") evalLayer.expected = raw.eval.expected;
    if (Object.keys(evalLayer).length > 0) layer.eval = evalLayer;
  }
  if (raw.resume !== undefined && isPlainObject(raw.resume)) {
    if (typeof raw.resume.enabled === "boolean") {
      layer.resume = { enabled: raw.resume.enabled };
    }
  }
  if (raw.retry !== undefined && isPlainObject(raw.retry)) {
    const retry: NonNullable<ProjectConfigLayer["retry"]> = {};
    if (
      typeof raw.retry.max === "number" &&
      Number.isInteger(raw.retry.max) &&
      raw.retry.max >= 0
    ) {
      retry.max = raw.retry.max;
    }
    if (typeof raw.retry.window === "string" && raw.retry.window !== "") {
      retry.window = raw.retry.window;
    } else if (
      typeof raw.retry.window === "number" &&
      Number.isFinite(raw.retry.window) &&
      raw.retry.window >= 0
    ) {
      retry.window = raw.retry.window;
    }
    if (Object.keys(retry).length > 0) layer.retry = retry;
  }
  if (raw.taskTypes !== undefined) {
    layer.taskTypes = raw.taskTypes;
  }
  return layer;
}

/**
 * Deep-merge global then project layers (project wins per key). Does not apply
 * shipped defaults — see {@link resolveEffectiveProjectSettings}.
 */
export function mergeProjectConfigLayers(
  global: ProjectConfigLayer,
  project: ProjectConfigLayer,
): ProjectConfigLayer {
  return deepMerge(
    global as Record<string, unknown>,
    project as Record<string, unknown>,
  ) as ProjectConfigLayer;
}

function evalEnabledFromLayer(layer: ProjectConfigLayer | undefined): boolean | undefined {
  if (layer?.eval === undefined) return undefined;
  if (layer.eval.enabled === true || layer.eval.expected === true) return true;
  if (layer.eval.enabled === false) return false;
  if (layer.eval.expected === false && layer.eval.enabled === undefined) return false;
  return undefined;
}

function sourceFor(projectHas: boolean, globalHas: boolean): ConfigLayerSource {
  if (projectHas) return "project";
  if (globalHas) return "global";
  return "default";
}

/**
 * Resolve effective project settings: deep-merge global + project, then apply
 * shipped defaults for any still-unset fields.
 */
export function resolveEffectiveProjectSettings(
  global: ProjectConfigLayer,
  project: ProjectConfigLayer,
  options: { defaultRetryMax?: number } = {},
): EffectiveProjectSettings {
  const defaultRetryMax = options.defaultRetryMax ?? 1;
  const merged = mergeProjectConfigLayers(global, project);

  const projectEval = evalEnabledFromLayer(project);
  const globalEval = evalEnabledFromLayer(global);
  const evalEnabled = projectEval ?? globalEval ?? false;

  const projectResume = project.resume?.enabled;
  const globalResume = global.resume?.enabled;
  const resumeEnabled =
    projectResume !== undefined
      ? projectResume !== false
      : globalResume !== undefined
        ? globalResume !== false
        : true;

  const projectMax = project.retry?.max;
  const globalMax = global.retry?.max;
  const retryMax =
    typeof projectMax === "number"
      ? projectMax
      : typeof globalMax === "number"
        ? globalMax
        : defaultRetryMax;

  const projectWindow = project.retry?.window;
  const globalWindow = global.retry?.window;
  const retryWindow =
    projectWindow !== undefined
      ? projectWindow
      : globalWindow !== undefined
        ? globalWindow
        : undefined;

  const projectHasTaskTypes = project.taskTypes !== undefined;
  const globalHasTaskTypes = global.taskTypes !== undefined;
  let taskTypes: TaskTypesMap;
  if (projectHasTaskTypes) {
    taskTypes = resolveTaskTypes(project.taskTypes);
  } else if (globalHasTaskTypes) {
    taskTypes = resolveTaskTypes(global.taskTypes);
  } else {
    taskTypes = defaultTaskTypes();
  }

  const provenance: ProjectConfigProvenance = {
    eval: sourceFor(projectEval !== undefined, globalEval !== undefined),
    resume: sourceFor(projectResume !== undefined, globalResume !== undefined),
    retryMax: sourceFor(projectMax !== undefined, globalMax !== undefined),
    retryWindow: sourceFor(projectWindow !== undefined, globalWindow !== undefined),
    taskTypes: sourceFor(projectHasTaskTypes, globalHasTaskTypes),
  };

  return {
    evalEnabled,
    resumeEnabled,
    retryMax,
    retryWindow,
    taskTypes,
    merged,
    provenance,
  };
}
