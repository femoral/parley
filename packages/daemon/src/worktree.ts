import { execFileSync, spawnSync } from "node:child_process";
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

// ---------------------------------------------------------------------------
// Child-authored ignored artifacts (#401)
// ---------------------------------------------------------------------------

/**
 * The run's cross-step handoff subtree (`.parley/tmp/<address>/{in,out}`). It
 * sits under parley's own `.parley/`, which parley excludes wholesale — but
 * the `out/` leg is the *child's* output surface (ADR-0018), so it is carved
 * out of the plumbing rule below: a run whose handoff channel still holds
 * output is worth inspecting, and `parley clean <run>` is the explicit exit.
 */
const HANDOFF_ROOT = `${PARLEY_DIR}/tmp`;

/**
 * The child's leg of the handoff: `.parley/tmp/<address>/out/…`. The step
 * brief and `in/` under the same address are written by the daemon
 * (`materializeStepContext` / `materializeInputs`), so they stay plumbing.
 */
const HANDOFF_OUT = new RegExp(`^${HANDOFF_ROOT.replace(/\./g, "\\.")}/[^/]+/out/`);

/** Upper bound on artifact paths collected by a directory walk. */
const MAX_ARTIFACTS = 50;

/** One `git status --porcelain` record: the two status chars plus its path. */
interface StatusEntry {
  /** Porcelain code, e.g. `??` (untracked), `!!` (ignored), ` M`, `R `. */
  code: string;
  /** Worktree-relative path; directories keep git's trailing slash. */
  path: string;
}

/** Where parley registers this worktree's excluded plumbing (see appendExclude). */
function parleyExcludePath(wt: string): string {
  return path.join(gitDir(wt), "parley-exclude");
}

/**
 * The paths parley itself excluded in this worktree, read back from the
 * worktree-scoped exclude file — the single source of truth for "plumbing"
 * (translated config, `.parley/`, adapter-materialized files). Normalized to
 * worktree-relative with no leading or trailing slash; an absent file means
 * nothing was registered.
 */
export function parleyExcludedPaths(wtPath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(parleyExcludePath(wtPath), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter((line) => line !== "");
}

/** `git status --porcelain -z` records (ignored entries included). */
function statusEntries(wtPath: string): StatusEntry[] {
  const raw = execFileSync(
    "git",
    ["-C", wtPath, "status", "--porcelain", "-z", "--ignored"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const records = raw.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined || record === "") continue;
    const code = record.slice(0, 2);
    // A rename/copy record carries its original path in the next NUL field.
    if (code.startsWith("R") || code.startsWith("C")) i += 1;
    entries.push({ code, path: record.slice(3) });
  }
  return entries;
}

/** Worktree-relative files under `rel` (a file yields itself), capped. */
function filesUnder(wtPath: string, rel: string): string[] {
  const found: string[] = [];
  const walk = (relDir: string): void => {
    if (found.length >= MAX_ARTIFACTS) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(path.join(wtPath, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (found.length >= MAX_ARTIFACTS) return;
      const child = `${relDir}/${dirent.name}`;
      if (dirent.isDirectory()) walk(child);
      else found.push(child);
    }
  };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path.join(wtPath, rel));
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [rel];
  walk(rel);
  return found;
}

/**
 * Child output the ignored entry `rel` hides inside the run handoff subtree —
 * empty unless the entry covers (or sits inside) `.parley/tmp`, and limited to
 * the `out/` leg the child writes.
 */
function handoffArtifacts(wtPath: string, rel: string): string[] {
  const inside = rel === HANDOFF_ROOT || rel.startsWith(`${HANDOFF_ROOT}/`);
  if (!inside && !HANDOFF_ROOT.startsWith(`${rel}/`)) return [];
  const start = rel.startsWith(`${HANDOFF_ROOT}/`) ? rel : HANDOFF_ROOT;
  return filesUnder(wtPath, start).filter((file) => HANDOFF_OUT.test(file));
}

/**
 * Leg 1 of the plumbing rule — how much of `rel` parley itself registered:
 *
 * - `owned`: `rel` *is* a registered path, or sits under one — all plumbing.
 * - `partial`: registered paths sit *under* `rel`. `git status --ignored`
 *   collapses to directory granularity (`!! .grok/`), so such an entry holds
 *   parley's config *and* whatever the child wrote beside it; the caller must
 *   look inside rather than write the whole directory off.
 * - `unknown`: leg 1 has nothing to say; exclude-source attribution decides.
 */
function parleyOwnership(rel: string, owned: readonly string[]): "owned" | "partial" | "unknown" {
  let partial = false;
  for (const registered of owned) {
    if (registered === rel || rel.startsWith(`${registered}/`)) return "owned";
    if (registered.startsWith(`${rel}/`)) partial = true;
  }
  return partial ? "partial" : "unknown";
}

/**
 * Leg 2 of the plumbing rule: the exclude file that made each path ignored,
 * per `git check-ignore -v`. Paths matched by nothing are absent from the map.
 * Throws when git itself fails (exit 1 just means "no path matched").
 */
function excludeSources(wtPath: string, rels: readonly string[]): Map<string, string> {
  const result = spawnSync(
    "git",
    ["-C", wtPath, "check-ignore", "-v", "-z", "--stdin"],
    { input: `${rels.join("\0")}\0`, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed: ${result.stderr?.trim() ?? result.status}`);
  }
  const fields = result.stdout.split("\0");
  const sources = new Map<string, string>();
  // Records are `<source>\0<linenum>\0<pattern>\0<pathname>`.
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const source = fields[i];
    const pathname = fields[i + 3];
    if (source === undefined || pathname === undefined || pathname === "") continue;
    sources.set(pathname, source);
  }
  return sources;
}

/**
 * Gitignored paths in `wtPath` that the *child* authored — the artifacts a
 * report-only task's own report points at (#401). `git status --porcelain`
 * never lists ignored files, so a worktree whose entire product is a
 * gitignored draft used to read as untouched and got reclaimed under the
 * report that referenced it.
 *
 * Plumbing is subtracted on two legs, both required:
 *
 * 1. Paths parley registered in the worktree-scoped exclude file
 *    ({@link parleyExcludedPaths}).
 * 2. For whatever survives, the exclude file git attributes the match to:
 *    parley's own exclude file means plumbing, the repo's `.gitignore` means
 *    the child's.
 *
 * Leg 1 is not redundant: when a path is ignored by both the repo `.gitignore`
 * and parley's `core.excludesFile`, git attributes it to `.gitignore` — so in
 * any repo whose `.gitignore` covers a vendor dir (`.grok/`, `.claude/`,
 * `.codex/` are common), attribution alone would read parley's own
 * materialized config as the child's work and retain every worktree forever.
 *
 * Returns worktree-relative paths as git reports them (directories keep their
 * trailing slash). Throws on git failure; callers err toward retention.
 */
export function childAuthoredIgnoredPaths(wtPath: string): string[] {
  return childAuthoredFrom(wtPath, statusEntries(wtPath));
}

/** {@link childAuthoredIgnoredPaths} over already-collected status entries. */
function childAuthoredFrom(wtPath: string, entries: readonly StatusEntry[]): string[] {
  const ignored = entries.filter((entry) => entry.code === "!!").map((entry) => entry.path);
  if (ignored.length === 0) return [];

  const owned = parleyExcludedPaths(wtPath);
  const found: string[] = [];
  const unattributed: string[] = [];
  for (const entry of ignored) {
    const rel = entry.replace(/\/+$/, "");
    found.push(...handoffArtifacts(wtPath, rel));
    const ownership = parleyOwnership(rel, owned);
    if (ownership === "owned") continue;
    if (ownership === "partial") {
      // A collapsed directory holding parley's own config: whatever else the
      // child dropped in there is still the child's, so name those files
      // instead of writing the whole directory off as plumbing.
      found.push(
        ...filesUnder(wtPath, rel).filter(
          (file) => parleyOwnership(file, owned) === "unknown" && !HANDOFF_OUT.test(file),
        ),
      );
      continue;
    }
    unattributed.push(entry);
  }
  if (unattributed.length > 0) {
    const excludeFile = path.resolve(parleyExcludePath(wtPath));
    const sources = excludeSources(wtPath, unattributed);
    for (const entry of unattributed) {
      const source = sources.get(entry);
      if (source !== undefined && path.resolve(wtPath, source) === excludeFile) continue;
      found.push(entry);
    }
  }
  return found;
}

/** Why a worktree counts as dirt — the reason `parley clean` refuses. */
export interface WorktreeDirt {
  dirty: boolean;
  /** Null when clean; `error` when git itself failed (treated as dirty). */
  reason: "uncommitted" | "ignored-artifacts" | "error" | null;
  /** Child-authored ignored artifacts found, when that is the reason. */
  ignoredPaths: string[];
}

/**
 * Whether the worktree holds uncommitted/untracked files or child-authored
 * ignored artifacts, and which of the two — so `parley clean` can name the
 * reason it refused (#336, #401). Parley plumbing never counts (see
 * {@link childAuthoredIgnoredPaths}); commits on the task branch are kept and
 * are not loss risk, so they are not dirt. One `git status` answers both
 * questions. On any git error we report dirty, erring toward refusing clean.
 */
export function worktreeDirt(wtPath: string): WorktreeDirt {
  try {
    const entries = statusEntries(wtPath);
    if (entries.some((entry) => entry.code !== "!!")) {
      return { dirty: true, reason: "uncommitted", ignoredPaths: [] };
    }
    const ignoredPaths = childAuthoredFrom(wtPath, entries);
    if (ignoredPaths.length > 0) {
      return { dirty: true, reason: "ignored-artifacts", ignoredPaths };
    }
    return { dirty: false, reason: null, ignoredPaths: [] };
  } catch {
    return { dirty: true, reason: "error", ignoredPaths: [] };
  }
}

/**
 * Whether the worktree has diverged from its baseline — any new commit, any
 * dirty/untracked file, or any child-authored ignored artifact (parley
 * plumbing is excluded, so it never counts). Modified worktrees are retained;
 * untouched ones are auto-removed. On any git error we report modified,
 * erring toward keeping the child's work.
 */
export function isWorktreeModified(wtPath: string, baseSha: string): boolean {
  return worktreeModification(wtPath, baseSha).modified;
}

/** Why a worktree is retained rather than auto-removed. */
export interface WorktreeModification {
  modified: boolean;
  /** Null when untouched; `error` when git itself failed (treated as modified). */
  reason: "uncommitted" | "ignored-artifacts" | "commits" | "error" | null;
  /** Child-authored ignored artifacts found, when that is the reason. */
  ignoredPaths: string[];
}

/**
 * {@link isWorktreeModified} with the reason attached, so the retain branch
 * can say what it kept and why instead of being silent (#401).
 */
export function worktreeModification(wtPath: string, baseSha: string): WorktreeModification {
  const dirt = worktreeDirt(wtPath);
  if (dirt.dirty) {
    return { modified: true, reason: dirt.reason, ignoredPaths: dirt.ignoredPaths };
  }
  try {
    if (git(["-C", wtPath, "rev-parse", "HEAD"]) !== baseSha) {
      return { modified: true, reason: "commits", ignoredPaths: [] };
    }
  } catch {
    return { modified: true, reason: "error", ignoredPaths: [] };
  }
  return { modified: false, reason: null, ignoredPaths: [] };
}

/**
 * Remove a worktree, keeping its branch (parley never merges — the orchestrator
 * owns the branch's fate). `force` (default true) maps to `git worktree remove
 * --force` so callers that already gate on a clean tree (or intentionally
 * discard dirt) can strip plumbing without git refusing. Pass `force: false`
 * when the caller has verified the tree is clean and wants a non-forced
 * remove. A worktree whose directory already vanished out-of-band is pruned
 * rather than failed, so `parley clean` can always converge on "gone".
 */
export function removeWorktree(
  root: string,
  wtPath: string,
  opts: { force?: boolean } = {},
): void {
  if (!fs.existsSync(wtPath)) {
    git(["-C", root, "worktree", "prune"]);
    return;
  }
  const force = opts.force !== false;
  const args = ["-C", root, "worktree", "remove"];
  if (force) args.push("--force");
  args.push(wtPath);
  git(args);
}
