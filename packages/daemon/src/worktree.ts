import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MaterializedFile } from "@useparley/core";
import { PARLEY_DIR } from "./context.js";

/**
 * Worktree manager (spec §6, ADR-0005). Parley owns an isolated git worktree
 * per task under the parley home dir, translates the repo's Claude config into
 * the canonical AGENTS.md surface both vendors read, and keeps every generated
 * path out of git so the child can never commit parley plumbing.
 *
 * Everything here shells out to the real `git` CLI — worktrees, branches and
 * exclude files are git's own artifacts, and reusing git keeps behaviour honest
 * against real repos (the only fixtures the suite uses).
 */

/** What parley records about a task's worktree once created. */
export interface WorktreeInfo {
  /** Absolute path to the worktree (the child's working directory). */
  path: string;
  /** The branch parley created and checked out: `parley/<id>-<name>`. */
  branch: string;
  /** The commit the branch started at — the baseline for "untouched". */
  baseSha: string;
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Resolve the top-level directory of the git repository containing `dir`, or
 * `null` when `dir` is not inside a working tree (delegating outside a repo
 * without `--cwd` is a usage error the caller surfaces as exit 2).
 */
export function repoRoot(dir: string): string | null {
  try {
    return git(["-C", dir, "rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

/** Whether the repo has any tracked file under `pathspec` (skips translation). */
function tracks(root: string, pathspec: string): boolean {
  try {
    return git(["-C", root, "ls-files", "--", pathspec]) !== "";
  } catch {
    return false;
  }
}

/** Filesystem-safe branch slug from a `--name` label. */
function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned === "" ? "task" : cleaned;
}

/**
 * Symlink the canonical AGENTS.md surface at the Claude config it mirrors:
 * `AGENTS.md → CLAUDE.md` and `.agents/skills → .claude/skills`. Each is
 * skipped when the repo already tracks the vendor-convention name (the repo
 * owns that surface) or when there is nothing to point at. Returns the relative
 * paths generated, for the exclude file.
 */
function translateConfig(root: string, wt: string): string[] {
  const generated: string[] = [];

  if (fs.existsSync(path.join(wt, "CLAUDE.md")) && !tracks(root, "AGENTS.md")) {
    fs.symlinkSync("CLAUDE.md", path.join(wt, "AGENTS.md"));
    generated.push("/AGENTS.md");
  }

  if (fs.existsSync(path.join(wt, ".claude", "skills")) && !tracks(root, ".agents")) {
    fs.mkdirSync(path.join(wt, ".agents"), { recursive: true });
    fs.symlinkSync(path.join("..", ".claude", "skills"), path.join(wt, ".agents", "skills"));
    generated.push("/.agents/");
  }

  return generated;
}

/**
 * The worktree's private git directory (`HEAD`, `index.lock`, per-worktree
 * config, …). Always lives under the *source repo's* common git dir, not under
 * `wt` itself — git's own layout, unrelated to where parley places worktrees.
 */
export function gitDir(wt: string): string {
  return git(["-C", wt, "rev-parse", "--absolute-git-dir"]);
}

/**
 * The repo's *common* git directory — where `objects/` and `refs/` actually
 * live, shared by the source repo and every worktree. For a worktree this
 * differs from `gitDir()` (which returns the worktree's private gitdir);
 * `git add`/`git commit` inside a worktree need to write here too, not just
 * to the private gitdir. `--path-format=absolute` makes the result absolute
 * regardless of cwd (git's default is relative for `--git-common-dir`, unlike
 * `--absolute-git-dir` which has no common-dir equivalent flag).
 */
export function commonGitDir(wt: string): string {
  return git(["-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

/**
 * Register parley-generated paths in an exclude file scoped to this worktree
 * only, so `git status` inside stays clean of plumbing and the child can never
 * stage it. `info/exclude` won't do: git resolves it through the COMMON git
 * dir shared by the source repo and every worktree, so appending there would
 * silently git-ignore e.g. a future AGENTS.md in the user's real checkout.
 * Instead the entries live in a parley-owned file inside the worktree's
 * private gitdir (`.git/worktrees/<name>/`, deleted with the worktree), wired
 * up via worktree-scoped `core.excludesFile`.
 */
function appendExclude(wt: string, entries: string[]): void {
  if (entries.length === 0) return;
  const excludePath = path.join(gitDir(wt), "parley-exclude");
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const gap = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludePath, `${gap}${entries.join("\n")}\n`);
  // `--worktree` config requires the extension; enabling it is git's own
  // documented prerequisite (git-worktree(1)) for per-worktree settings.
  git(["-C", wt, "config", "extensions.worktreeConfig", "true"]);
  // Bare mirrors (managed clones, #316/#318) inherit `core.bare=true` from the
  // common config. Once worktreeConfig is on, that leaks into the worktree and
  // git reports `is-inside-work-tree: false` — checkout/status break, and
  // post-task detach for mirror reuse fails. Linked worktrees are never bare.
  git(["-C", wt, "config", "--worktree", "core.bare", "false"]);
  git(["-C", wt, "config", "--worktree", "core.excludesFile", excludePath]);
}

/**
 * Git-exclude vendor-materialized files (e.g. grok's `.grok/config.toml`) from a
 * worktree, so parley plumbing never shows in the child's `git status`, never
 * counts as "modified" (which would block auto-remove), and can never be staged
 * by the child. Each file is excluded by its exact rooted path — never a whole
 * directory, which could hide unrelated child-authored files sharing that dir
 * (and let real work be auto-removed as "untouched"). Called by the engine
 * before spawning a worktree task, on fresh runs and resumes alike: entries
 * already present in the exclude file are skipped, so respawns don't grow it.
 * Additive to the same worktree-scoped exclude file `translateConfig`'s entries
 * live in; a `--cwd` task has no parley worktree to manage.
 */
export function excludeMaterializedFiles(wtPath: string, relPaths: string[]): void {
  const entries = [
    ...new Set(
      relPaths
        .map((rel) => rel.replace(/^\/+/, ""))
        .filter((rel) => rel !== "")
        .map((rel) => `/${rel}`),
    ),
  ];
  const excludePath = path.join(gitDir(wtPath), "parley-exclude");
  let existing: Set<string> = new Set();
  try {
    existing = new Set(fs.readFileSync(excludePath, "utf8").split("\n"));
  } catch {
    /* no exclude file yet */
  }
  appendExclude(wtPath, entries.filter((entry) => !existing.has(entry)));
}

/**
 * Git-exclude vendor-materialized files for a `--cwd` task (no parley worktree).
 *
 * When `cwd` sits inside a git working tree, appends exact paths (relative to
 * the repo root) to that repo's local `.git/info/exclude` — never committed,
 * so the operator's global ignore stays clean. Entries already present are
 * skipped (dedupe on repeat spawn/resume). When `cwd` is not in a git repo,
 * returns silently (nothing to exclude against).
 *
 * Distinct from {@link excludeMaterializedFiles}, which uses a *worktree-private*
 * exclude file so source-repo checkouts are never affected. A `--cwd` task
 * *is* the operator's real tree, so local `info/exclude` is the right lever
 * for files materialised with a restrictive `mode` (e.g. credentials, should
 * an adapter ever need one again — none does since #298).
 */
export function excludeMaterializedFilesInCwdRepo(
  cwd: string,
  relPaths: string[],
): void {
  const root = repoRoot(cwd);
  if (root === null) return;
  if (relPaths.length === 0) return;

  const entries = [
    ...new Set(
      relPaths
        .map((rel) => rel.replace(/^\/+/, ""))
        .filter((rel) => rel !== "")
        .map((rel) => {
          // Materialized paths are relative to task cwd; exclude patterns are
          // relative to the repo root. When cwd is a subdir, join then relativize.
          const abs = path.resolve(cwd, rel);
          const fromRoot = path.relative(root, abs);
          // Refuse to write exclude entries that escape the repo.
          if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) return null;
          return `/${fromRoot.split(path.sep).join("/")}`;
        })
        .filter((entry): entry is string => entry !== null),
    ),
  ];
  if (entries.length === 0) return;

  // info/exclude lives under the *common* git dir. For a linked worktree,
  // gitDir() is <repo>/.git/worktrees/<name>/ — entries there are ignored by
  // git; only <repo>/.git/info/exclude is read (same pitfall as appendExclude).
  let gd: string;
  try {
    gd = commonGitDir(cwd);
  } catch {
    return;
  }
  const excludePath = path.join(gd, "info", "exclude");
  let existingText = "";
  try {
    existingText = fs.readFileSync(excludePath, "utf8");
  } catch {
    /* create below */
  }
  const existing = new Set(existingText.split("\n"));
  const toAdd = entries.filter((entry) => !existing.has(entry));
  if (toAdd.length === 0) return;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const gap = existingText.length > 0 && !existingText.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludePath, `${gap}${toAdd.join("\n")}\n`);
}

/**
 * Write adapter {@link MaterializedFile}s into `cwd` before spawn (engine +
 * runner). Honours optional `mode` (e.g. `0o600` for OAuth tokens): passed to
 * writeFileSync so a credential never lands at the umask default even between
 * syscalls, then chmod after to cover an already-existing file.
 */
export function writeMaterializedFiles(
  cwd: string,
  files: readonly MaterializedFile[],
): void {
  for (const file of files) {
    const target = path.join(cwd, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (file.mode !== undefined) {
      fs.writeFileSync(target, file.contents, { mode: file.mode });
      fs.chmodSync(target, file.mode);
    } else {
      fs.writeFileSync(target, file.contents);
    }
  }
}

export interface CreateWorktreeOptions {
  /** Top-level of the source repository (from `repoRoot`). */
  repoRoot: string;
  /** `~/.parley/worktrees` — the parent for all parley worktrees. */
  worktreesDir: string;
  taskId: string;
  name: string | null;
  /** Ref to branch from; `null` means the repo's current HEAD. */
  baseRef: string | null;
}

/**
 * Whether `dir` is a usable git working tree (has a checkout git can resolve).
 * Empty plain directories (including a stale path recreated by mkdir) are not.
 */
export function isValidGitCheckout(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return repoRoot(dir) !== null;
}

/**
 * Path parley uses for a task worktree under `worktreesDir` (same layout as
 * `createWorktree` / `attachWorktree`).
 */
export function worktreePathFor(
  worktreesDir: string,
  repoRootPath: string,
  taskId: string,
): string {
  return path.join(worktreesDir, path.basename(repoRootPath), taskId);
}

/**
 * After `git worktree add`: translate config, exclude parley plumbing, return
 * HEAD. Shared by create (new branch) and attach (existing branch) so fix
 * recreation does not duplicate git plumbing (#180). Also used by run
 * checkouts (ADR-0018 / #234).
 *
 * Exclusion is a worktree-private `parley-exclude` via `core.excludesFile
 * --worktree` — never `.git/info/exclude` (ADR-0005 correction / ADR-0018).
 */
export function finalizeWorktree(repoRootPath: string, wtPath: string): string {
  const baseSha = git(["-C", wtPath, "rev-parse", "HEAD"]);
  const generated = translateConfig(repoRootPath, wtPath);
  // Parley always materializes task context under `.parley/` here (spec §7);
  // exclude it unconditionally so the child can never commit or see it as a
  // change, whether or not `--context` files were passed.
  generated.push(`/${PARLEY_DIR}/`);
  appendExclude(wtPath, generated);
  return baseSha;
}

/**
 * Create an isolated worktree for a task: a fresh branch `parley/<id>-<name>`
 * off the base ref (HEAD by default), config translated and plumbing excluded.
 * Throws on git failure (e.g. a bad `--base-ref`) — the caller maps that to a
 * usage error.
 */
export function createWorktree(opts: CreateWorktreeOptions): WorktreeInfo {
  const branch = opts.name ? `parley/${opts.taskId}-${slug(opts.name)}` : `parley/${opts.taskId}`;
  const wtPath = worktreePathFor(opts.worktreesDir, opts.repoRoot, opts.taskId);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  git(["-C", opts.repoRoot, "worktree", "add", "-b", branch, wtPath, opts.baseRef ?? "HEAD"]);
  try {
    const baseSha = finalizeWorktree(opts.repoRoot, wtPath);
    return { path: wtPath, branch, baseSha };
  } catch (err) {
    // No task row exists yet, so a half-built worktree would leak untracked:
    // roll back the worktree and its branch before surfacing the failure.
    try {
      git(["-C", opts.repoRoot, "worktree", "remove", "--force", wtPath]);
      git(["-C", opts.repoRoot, "branch", "-D", branch]);
    } catch {
      /* best-effort rollback; the original error is the one that matters */
    }
    throw err;
  }
}

export interface AttachWorktreeOptions {
  /** Top-level of the source repository (from `repoRoot`). */
  repoRoot: string;
  /** `~/.parley/worktrees` — the parent for all parley worktrees. */
  worktreesDir: string;
  /** Task id that owns this worktree path (usually the new fix attempt). */
  taskId: string;
  /** Existing branch to check out (kept by `parley clean`; never deleted). */
  branch: string;
}

/**
 * Re-attach a worktree checkout for an *existing* branch — used when fix needs
 * a workspace after the parent's parley-managed worktree was cleaned or
 * otherwise vanished (#180). Does not create a branch (unlike `createWorktree`).
 *
 * If a leftover non-git directory already sits at the target path (e.g. a
 * stale empty dir from a previous mkdir), it is removed first so git can add
 * a real worktree there.
 */
export function attachWorktree(opts: AttachWorktreeOptions): WorktreeInfo {
  const wtPath = worktreePathFor(opts.worktreesDir, opts.repoRoot, opts.taskId);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  if (fs.existsSync(wtPath)) {
    if (isValidGitCheckout(wtPath)) {
      // Already a usable checkout at this path (e.g. prior partial run).
      const headBranch = git(["-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"]);
      if (headBranch === opts.branch) {
        const baseSha = git(["-C", wtPath, "rev-parse", "HEAD"]);
        return { path: wtPath, branch: opts.branch, baseSha };
      }
    }
    // Empty residue or wrong tree: clear so `worktree add` can proceed.
    fs.rmSync(wtPath, { recursive: true, force: true });
    try {
      git(["-C", opts.repoRoot, "worktree", "prune"]);
    } catch {
      /* prune is best-effort */
    }
  }

  git(["-C", opts.repoRoot, "worktree", "add", wtPath, opts.branch]);
  try {
    const baseSha = finalizeWorktree(opts.repoRoot, wtPath);
    return { path: wtPath, branch: opts.branch, baseSha };
  } catch (err) {
    try {
      git(["-C", opts.repoRoot, "worktree", "remove", "--force", wtPath]);
    } catch {
      /* best-effort rollback; the original error is the one that matters */
    }
    throw err;
  }
}

/**
 * Whether the worktree has diverged from its baseline — any new commit or any
 * dirty/untracked file (parley plumbing is excluded, so it never counts).
 * Modified worktrees are retained; untouched ones are auto-removed. On any git
 * error we report modified, erring toward keeping the child's work.
 */
export function isWorktreeModified(wtPath: string, baseSha: string): boolean {
  try {
    if (git(["-C", wtPath, "status", "--porcelain"]) !== "") return true;
    return git(["-C", wtPath, "rev-parse", "HEAD"]) !== baseSha;
  } catch {
    return true;
  }
}

/**
 * Remove a worktree, keeping its branch (parley never merges — the orchestrator
 * owns the branch's fate). Forced so parley plumbing and any base checkout are
 * removed without git refusing. A worktree whose directory already vanished
 * out-of-band is pruned rather than failed, so `parley clean` can always
 * converge on "gone".
 */
export function removeWorktree(root: string, wtPath: string): void {
  if (!fs.existsSync(wtPath)) {
    git(["-C", root, "worktree", "prune"]);
    return;
  }
  git(["-C", root, "worktree", "remove", "--force", wtPath]);
}
