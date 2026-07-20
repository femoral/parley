import fs from "node:fs";
import path from "node:path";
import {
  defaultClassification,
  extractProjectConfigLayer,
  homePathsFromEnv,
  mergeProjectConfigLayers,
  parseClassification,
  readConfig,
  resolveEffectiveProjectSettings,
  type ClassificationConfig,
  type EffectiveProjectSettings,
  type HomePaths,
  type ProjectConfigLayer,
  type TaskTypesMap,
} from "@useparley/core";

/** One `--context` file, read by the CLI and shipped to the daemon by value. */
export interface ContextFile {
  /** Filename it is written under in `.parley/context/` (basename only). */
  name: string;
  contents: string;
}

/** Directory name parley materializes task context under, inside the workspace. */
export const PARLEY_DIR = ".parley";

/**
 * Materialize a task's context on disk under `<dir>/.parley/` (spec §7): the
 * caller's brief as `TASK.md`, and each `--context` file under `context/`.
 *
 * This context rides the workspace, not the vendor prompt — it survives resume
 * (the child re-reads it) and the prompt only ever points at it. In a parley
 * worktree `/.parley/` is git-excluded at worktree creation; a `--cwd` task owns
 * its directory, so parley writes there without excluding (no repo-owner
 * guarantee to uphold outside parley's own worktrees, spec §6).
 */
export function materializeContext(
  dir: string,
  brief: string,
  contexts: ContextFile[],
): void {
  // Never create the workspace itself — only `.parley/` under an existing one.
  // A recursive mkdir here would silently revive a cleaned worktree path as an
  // empty non-git directory and let fix spawn into it (#180).
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(`workspace directory does not exist: ${dir}`);
  }

  const root = path.join(dir, PARLEY_DIR);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "TASK.md"), brief.endsWith("\n") ? brief : `${brief}\n`);
  // Idempotent: clear any prior context first so a reused directory (a `--cwd`
  // task run twice, or a re-delegation) never leaks stale files into the new
  // task's preamble via `contextPointers`.
  const contextDir = path.join(root, "context");
  fs.rmSync(contextDir, { recursive: true, force: true });
  if (contexts.length === 0) return;
  fs.mkdirSync(contextDir, { recursive: true });
  for (const file of contexts) {
    // Defense in depth: the CLI already basenames the path, but never let a
    // context name escape the context dir.
    const name = path.basename(file.name);
    if (name === "" || name === "." || name === "..") continue;
    fs.writeFileSync(path.join(contextDir, name), file.contents);
  }
}

/**
 * Materialize `.parley/child.json` so subprocesses that lose env can still find
 * the hub (ADR-0011). Shape: `{ "url": <daemon base>, "task_id": <id> }`.
 * Lives under `.parley/`, which worktrees already git-exclude.
 */
export function materializeChildHub(dir: string, url: string, taskId: string): void {
  const root = path.join(dir, PARLEY_DIR);
  fs.mkdirSync(root, { recursive: true });
  const body = JSON.stringify({ url, task_id: taskId });
  fs.writeFileSync(path.join(root, "child.json"), body.endsWith("\n") ? body : `${body}\n`);
}

/**
 * The relative pointers (for the prompt preamble) to the context files present
 * on disk under `<dir>/.parley/context/`, sorted. Empty when there are none.
 */
export function contextPointers(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, PARLEY_DIR, "context"))
      .sort()
      .map((name) => `${PARLEY_DIR}/context/${name}`);
  } catch {
    return [];
  }
}

/** Read optional JSON object file → project-settings layer (missing/corrupt ⇒ {}). */
function readOptionalConfigLayer(file: string): ProjectConfigLayer {
  let rawText: string;
  try {
    rawText = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    return extractProjectConfigLayer(JSON.parse(rawText));
  } catch {
    return {};
  }
}

/**
 * Global project-settings layer for the daemon host (#178).
 *
 * Sources, deep-merged (later wins per key):
 * 1. Home `parley.json` project-settings keys (same file as `GET /config`)
 * 2. Home `config.json` when present (same schema as project `.parley/config.json`)
 *
 * CLI processes must not call this for user-facing merge — they source the
 * global layer via `GET /config` instead (transport-agnostic).
 */
export function readGlobalConfigLayer(
  paths: HomePaths = homePathsFromEnv(),
): ProjectConfigLayer {
  let fromParley: ProjectConfigLayer = {};
  try {
    fromParley = extractProjectConfigLayer(readConfig(paths.config));
  } catch {
    fromParley = {};
  }
  const fromConfigJson = readOptionalConfigLayer(path.join(paths.home, "config.json"));
  return mergeProjectConfigLayers(fromParley, fromConfigJson);
}

/**
 * Project `.parley/config.json` layer. Missing/corrupt ⇒ `{}` (defaults come
 * from global + shipped).
 */
export function readProjectConfigLayer(repo: string | null): ProjectConfigLayer {
  if (repo === null) return {};
  return readOptionalConfigLayer(path.join(repo, PARLEY_DIR, "config.json"));
}

/**
 * Single resolution path for layered project settings (#178):
 * shipped defaults < global (daemon home) < project.
 */
export function resolveProjectSettings(
  repo: string | null,
  paths: HomePaths = homePathsFromEnv(),
  options: { defaultRetryMax?: number } = {},
): EffectiveProjectSettings {
  return resolveEffectiveProjectSettings(
    readGlobalConfigLayer(paths),
    readProjectConfigLayer(repo),
    options,
  );
}

/**
 * Whether evaluations are expected/enabled (#45 / #157 / #178). Effective =
 * global < project; default OFF.
 */
export function readEvalExpected(
  repo: string | null,
  paths: HomePaths = homePathsFromEnv(),
): boolean {
  return resolveProjectSettings(repo, paths).evalEnabled;
}

/**
 * Whether structured evaluation is enabled (#157 / #178). Alias of
 * {@link readEvalExpected}.
 */
export function readEvalEnabled(
  repo: string | null,
  paths: HomePaths = homePathsFromEnv(),
): boolean {
  return readEvalExpected(repo, paths);
}

/**
 * Effective `taskTypes` map (#151 / #178). Missing everywhere ⇒ shipped defaults.
 * Malformed `taskTypes` when present throws (never coerce unknown shapes).
 */
export function readProjectTaskTypes(
  repo: string | null,
  paths: HomePaths = homePathsFromEnv(),
): TaskTypesMap {
  return resolveProjectSettings(repo, paths).taskTypes;
}

/**
 * Read a classification.json file. Returns null when missing; throws on
 * corrupt/invalid content.
 */
function readClassificationFile(file: string): ClassificationConfig | null {
  let rawText: string;
  try {
    rawText = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid classification.json: ${msg}`);
  }
  return parseClassification(parsed);
}

/**
 * Effective classification (#161 / #178): shipped defaults < home
 * `classification.json` < project `.parley/classification.json`. Whole-file
 * replace at each layer (arrays are not element-merged).
 */
export function readProjectClassification(
  repo: string | null,
  paths: HomePaths = homePathsFromEnv(),
): ClassificationConfig {
  const globalDoc = readClassificationFile(path.join(paths.home, "classification.json"));
  if (repo === null) return globalDoc ?? defaultClassification();
  const projectDoc = readClassificationFile(
    path.join(repo, PARLEY_DIR, "classification.json"),
  );
  return projectDoc ?? globalDoc ?? defaultClassification();
}

/**
 * Whether `parley fix` should resume the parent's vendor session (#152 / #178).
 * Defaults **on** when unset at every layer.
 */
export function readResumeEnabled(
  repo: string | null,
  paths: HomePaths = homePathsFromEnv(),
): boolean {
  return resolveProjectSettings(repo, paths).resumeEnabled;
}

/**
 * Effective retry budget (`retry.max`, #158 / #178). Caps *resumed* fixes per
 * chain. Default 1 when unset at every layer.
 */
export function readRetryMax(
  repo: string | null,
  defaultMax = 1,
  paths: HomePaths = homePathsFromEnv(),
): number {
  return resolveProjectSettings(repo, paths, { defaultRetryMax: defaultMax }).retryMax;
}

/**
 * Effective reattempt window (`retry.window`, #158 / #178) as milliseconds.
 * Default when unset/unparseable is supplied by the caller (shipped 30m).
 */
export function readRetryWindowMs(
  repo: string | null,
  parseDurationFn: (text: string) => number | null,
  defaultMs: number,
  paths: HomePaths = homePathsFromEnv(),
): number {
  const settings = resolveProjectSettings(repo, paths);
  const window = settings.retryWindow;
  if (typeof window === "string") {
    const ms = parseDurationFn(window);
    if (ms !== null && ms >= 0) return ms;
  } else if (typeof window === "number" && Number.isFinite(window) && window >= 0) {
    return Math.round(window);
  }
  return defaultMs;
}
