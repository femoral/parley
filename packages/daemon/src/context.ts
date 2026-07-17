import fs from "node:fs";
import path from "node:path";
import {
  defaultTaskTypes,
  resolveTaskTypes,
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

/**
 * Whether a project declares (via `.parley/config.json`, sibling to
 * `.parley/context/`) that delegations into it are expected to be eval'd
 * (#45). Absent file, absent `eval` key, or malformed JSON all default to
 * `false` — eval is opt-in per project.
 *
 * Also accepts `eval.enabled` as the v3 on/off switch (#157): either
 * `enabled: true` or `expected: true` turns evaluation on. Default OFF.
 */
export function readEvalExpected(repo: string | null): boolean {
  if (repo === null) return false;
  try {
    const raw = fs.readFileSync(path.join(repo, PARLEY_DIR, "config.json"), "utf8");
    const config = JSON.parse(raw) as {
      eval?: { expected?: unknown; enabled?: unknown };
    };
    return config.eval?.enabled === true || config.eval?.expected === true;
  } catch {
    return false;
  }
}

/**
 * Whether structured evaluation is enabled for the project (#157). Default
 * OFF — absent file/key/malformed JSON all yield false. Alias of
 * {@link readEvalExpected} (both keys accepted).
 */
export function readEvalEnabled(repo: string | null): boolean {
  return readEvalExpected(repo);
}

/**
 * Hot-read the project's effective `taskTypes` map from `.parley/config.json`
 * (#151). Missing file or missing `taskTypes` section ⇒ shipped defaults.
 * Malformed `taskTypes` throws so delegate can surface a named error (never
 * coerce unknown shapes into defaults).
 */
export function readProjectTaskTypes(repo: string | null): TaskTypesMap {
  if (repo === null) return defaultTaskTypes();
  let rawText: string;
  try {
    rawText = fs.readFileSync(path.join(repo, PARLEY_DIR, "config.json"), "utf8");
  } catch {
    return defaultTaskTypes();
  }
  let config: { taskTypes?: unknown };
  try {
    config = JSON.parse(rawText) as { taskTypes?: unknown };
  } catch {
    // Corrupt project config: same posture as eval_expected — degrade to
    // defaults rather than blocking every delegate on a JSON typo elsewhere.
    // An *invalid taskTypes shape* (when present) is still a hard error.
    return defaultTaskTypes();
  }
  if (config.taskTypes === undefined) return defaultTaskTypes();
  return resolveTaskTypes(config.taskTypes);
}

/**
 * Whether `parley fix` should resume the parent's vendor session (#152).
 * Read from the project's `.parley/config.json` (`resume.enabled`). Defaults
 * **on** when the file, key, or project is absent — resume is the common path;
 * opt out explicitly with `"resume": { "enabled": false }`.
 */
export function readResumeEnabled(repo: string | null): boolean {
  if (repo === null) return true;
  try {
    const raw = fs.readFileSync(path.join(repo, PARLEY_DIR, "config.json"), "utf8");
    const config = JSON.parse(raw) as { resume?: { enabled?: unknown } };
    if (config.resume?.enabled === false) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Project retry budget (`retry.max`, #158). Caps *resumed* fixes per chain.
 * Default 1 when the file, section, or key is absent. Hot-read at fix time.
 * Non-integer / negative values degrade to the default (never block fix).
 */
export function readRetryMax(repo: string | null, defaultMax = 1): number {
  if (repo === null) return defaultMax;
  try {
    const raw = fs.readFileSync(path.join(repo, PARLEY_DIR, "config.json"), "utf8");
    const config = JSON.parse(raw) as { retry?: { max?: unknown } };
    const max = config.retry?.max;
    if (typeof max === "number" && Number.isInteger(max) && max >= 0) return max;
    return defaultMax;
  } catch {
    return defaultMax;
  }
}

/**
 * Project reattempt window (`retry.window`, #158) as milliseconds. Default
 * when unset/unparseable is supplied by the caller (shipped 30m). Accepts the
 * same duration strings as `--answer-timeout` (`30m`, `90s`, `250ms`).
 */
export function readRetryWindowMs(
  repo: string | null,
  parseDuration: (text: string) => number | null,
  defaultMs: number,
): number {
  if (repo === null) return defaultMs;
  try {
    const raw = fs.readFileSync(path.join(repo, PARLEY_DIR, "config.json"), "utf8");
    const config = JSON.parse(raw) as { retry?: { window?: unknown } };
    const window = config.retry?.window;
    if (typeof window === "string") {
      const ms = parseDuration(window);
      if (ms !== null && ms >= 0) return ms;
    } else if (typeof window === "number" && Number.isFinite(window) && window >= 0) {
      // Bare number: milliseconds (matches parseDuration bare-number semantics).
      return Math.round(window);
    }
    return defaultMs;
  } catch {
    return defaultMs;
  }
}
