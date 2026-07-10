import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  const gitDir = git(["-C", wt, "rev-parse", "--absolute-git-dir"]);
  const excludePath = path.join(gitDir, "parley-exclude");
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const gap = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludePath, `${gap}${entries.join("\n")}\n`);
  // `--worktree` config requires the extension; enabling it is git's own
  // documented prerequisite (git-worktree(1)) for per-worktree settings.
  git(["-C", wt, "config", "extensions.worktreeConfig", "true"]);
  git(["-C", wt, "config", "--worktree", "core.excludesFile", excludePath]);
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
 * Create an isolated worktree for a task: a fresh branch `parley/<id>-<name>`
 * off the base ref (HEAD by default), config translated and plumbing excluded.
 * Throws on git failure (e.g. a bad `--base-ref`) — the caller maps that to a
 * usage error.
 */
export function createWorktree(opts: CreateWorktreeOptions): WorktreeInfo {
  const branch = opts.name ? `parley/${opts.taskId}-${slug(opts.name)}` : `parley/${opts.taskId}`;
  const wtPath = path.join(opts.worktreesDir, path.basename(opts.repoRoot), opts.taskId);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  git(["-C", opts.repoRoot, "worktree", "add", "-b", branch, wtPath, opts.baseRef ?? "HEAD"]);
  try {
    const baseSha = git(["-C", wtPath, "rev-parse", "HEAD"]);
    const generated = translateConfig(opts.repoRoot, wtPath);
    appendExclude(wtPath, generated);
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
