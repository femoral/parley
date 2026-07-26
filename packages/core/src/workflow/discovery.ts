/**
 * Two-layer workflow discovery (ADR-0016 / #231).
 *
 * Layers (nearest wins by id):
 * 1. Global — `{home}/workflows/` where home is `resolveHome()` (`~/.parley`
 *    or `PARLEY_HOME`)
 * 2. Local  — `{base}/.parley/workflows/` where base is
 *    `repoRoot(cwd) ?? cwd`
 *
 * When the local base resolves to the same directory as the global parent
 * home (cwd *is* home / no separate repo), the two layers are deduped so one
 * directory is not read twice.
 *
 * This is intentionally a **different base** from `readProjectConfigLayer`
 * (daemon), which takes a repo root and returns `{}` without one. Workflows
 * must resolve outside a repo (scratch mode), so they cannot reuse that helper.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHome } from "../home.js";
import {
  loadWorkflowDefinition,
  type ParseWorkflowResult,
  type WorkflowDefinition,
} from "./definition.js";

/** Relative path under a local base (repo root or cwd). */
export const WORKFLOWS_DIR_REL = ".parley/workflows";

/** Relative path under parley home for the global layer. */
export const GLOBAL_WORKFLOWS_DIR_REL = "workflows";

export interface DiscoverWorkflowsOptions {
  /** Working directory used to locate the local layer. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Parley home for the global layer. Defaults to {@link resolveHome} (honours
   * `PARLEY_HOME`). Pass an absolute path in tests.
   */
  home?: string;
  /**
   * Override repo-root detection. Defaults to {@link findRepoRoot}.
   * Injected in tests; production callers rarely need this.
   */
  repoRoot?: (cwd: string) => string | null;
}

export interface WorkflowRef {
  /** Workflow id (directory name). */
  id: string;
  /** Absolute path of the workflow directory. */
  dir: string;
  /** Which layer supplied this id. */
  layer: "global" | "local";
}

export interface DiscoverWorkflowsResult {
  /** All discovered workflows, local overwriting global on id collision. */
  byId: Map<string, WorkflowRef>;
  /** Absolute path of the global workflows directory (even if missing). */
  globalDir: string;
  /** Absolute path of the local workflows directory (even if missing). */
  localDir: string;
  /** True when global and local resolved to the same directory (deduped). */
  deduped: boolean;
}

/**
 * Walk upward from `cwd` looking for a `.git` entry (file or directory).
 * Returns the directory containing it, or null when none is found.
 *
 * Pure filesystem — no `git` binary — so unit tests do not need a real repo
 * and linked worktrees (`.git` file) still resolve.
 */
export function findRepoRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    } catch {
      // ignore permission errors and keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Local layer base: `repoRoot(cwd) ?? cwd`. Workflows deliberately fall back
 * to cwd when outside a repo (scratch definitions, non-git projects).
 */
export function localWorkflowBase(
  cwd: string,
  repoRootFn: (cwd: string) => string | null = findRepoRoot,
): string {
  return repoRootFn(cwd) ?? path.resolve(cwd);
}

/**
 * Discover workflow directories in both layers. Nearest (local) wins by id.
 * Does not parse `workflow.json` — see {@link resolveWorkflow} / {@link listWorkflows}.
 */
export function discoverWorkflows(
  options: DiscoverWorkflowsOptions = {},
): DiscoverWorkflowsResult {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const home = path.resolve(options.home ?? resolveHome());
  const repoRootFn = options.repoRoot ?? findRepoRoot;

  const globalDir = path.join(home, GLOBAL_WORKFLOWS_DIR_REL);
  const localBase = localWorkflowBase(cwd, repoRootFn);
  const localDir = path.join(localBase, WORKFLOWS_DIR_REL);

  const deduped = path.resolve(globalDir) === path.resolve(localDir);

  const byId = new Map<string, WorkflowRef>();

  // Global first, then local overwrites — nearest wins.
  for (const id of listWorkflowIds(globalDir)) {
    byId.set(id, {
      id,
      dir: path.join(globalDir, id),
      layer: "global",
    });
  }
  if (!deduped) {
    for (const id of listWorkflowIds(localDir)) {
      byId.set(id, {
        id,
        dir: path.join(localDir, id),
        layer: "local",
      });
    }
  }

  return { byId, globalDir, localDir, deduped };
}

/**
 * Resolve one workflow by id (nearest wins) and parse it.
 * Returns null when the id is not found in either layer.
 */
export function resolveWorkflow(
  id: string,
  options: DiscoverWorkflowsOptions = {},
): ParseWorkflowResult | null {
  const { byId } = discoverWorkflows(options);
  const ref = byId.get(id);
  if (ref === undefined) return null;
  return loadWorkflowDefinition(ref.dir);
}

/**
 * Load every discovered workflow, skipping parse failures when `soft` is true.
 */
export function listWorkflows(
  options: DiscoverWorkflowsOptions & { soft?: boolean } = {},
): WorkflowDefinition[] {
  const { byId } = discoverWorkflows(options);
  const out: WorkflowDefinition[] = [];
  for (const ref of byId.values()) {
    try {
      out.push(loadWorkflowDefinition(ref.dir).definition);
    } catch (err) {
      if (options.soft) continue;
      throw err;
    }
  }
  return out;
}

/**
 * Convenience for tests and callers that want the user home without going
 * through `PARLEY_HOME` (discovery still prefers `resolveHome` by default).
 */
export function userHomeDir(): string {
  return os.homedir();
}

function listWorkflowIds(workflowsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    // Require workflow.json so empty/prompt-only dirs are ignored.
    const wf = path.join(workflowsDir, ent.name, "workflow.json");
    if (fs.existsSync(wf)) ids.push(ent.name);
  }
  return ids.sort();
}
