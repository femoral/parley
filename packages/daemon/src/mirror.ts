/**
 * Parley-managed bare mirrors + claim-time repo sync (ADR-0031 / #316 / #318).
 *
 * Shared by the remote runner and the daemon in-process executor. On claim the
 * executor ensures a bare mirror under the parley home's `clones/` dir (or uses
 * an optional operator-managed clone override), fetches with prune, verifies
 * `base_sha` (direct sha fetch as fallback), and preflight-pushes the base sha
 * to the task branch name — all before the vendor child is spawned. Credentials
 * are ambient host git credentials only; nothing is stored in parley config or
 * on the wire.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeRepoKey,
  stripFetchUrlCredentials,
  type GitAuthFailureCode,
  type RunnerLeaseSpec,
} from "@useparley/core";

/** Bound git I/O so a hung remote cannot stall the runner forever. */
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Stale mkdir-lock age before another process may steal it. */
const MIRROR_LOCK_STALE_MS = 10 * 60 * 1000;
/** How long to wait for a peer holding the mirror lock. */
const MIRROR_LOCK_WAIT_MS = 120_000;

/**
 * Temp clone directories live under clones/ with this prefix. Real mirror
 * encodings never use it (see {@link isMirrorTempName}).
 */
export const MIRROR_TEMP_PREFIX = ".parley-clone-tmp-";

/**
 * Diagnosis class for claim-time git failures. The `code` is a stable token
 * for operators / tests; `message` is the human-readable fail string.
 * Codes match {@link GitAuthFailureCode} on the fail wire (#317).
 */
export type ClaimGitFailureCode = GitAuthFailureCode;

export class ClaimGitError extends Error {
  readonly code: ClaimGitFailureCode;

  constructor(code: ClaimGitFailureCode, message: string) {
    super(message);
    this.name = "ClaimGitError";
    this.code = code;
  }
}

/** Redact userinfo before embedding a fetch URL in a diagnosis string. */
function safeUrl(fetchUrl: string): string {
  return stripFetchUrlCredentials(fetchUrl);
}

/**
 * Encode a repo key (`host/path`) into a single filesystem path segment.
 *
 * Readable slug (`/` → `--`, other path-hostile chars → `_`) plus a fixed
 * `-<sha256(rawKey)[:8]>` suffix so the mapping is injective: keys that
 * collapse under the slug alone (e.g. `a/b--c` vs `a--b/c`) still get
 * distinct directories.
 *
 * @example
 * encodeRepoKeyForFs("github.com/femoral/parley")
 * // → "github.com--femoral--parley-<8 hex chars>"
 */
export function encodeRepoKeyForFs(repoKey: string): string {
  const raw = repoKey.trim();
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  const cleaned = raw
    .toLowerCase()
    .replace(/\//g, "--")
    .replace(/[^a-z0-9._+-]+/g, "_")
    // No leading dots: temp clone dirs use a `.parley-clone-tmp-` prefix and
    // must never collide with a real encoding (F4).
    .replace(/^[._]+|[._]+$/g, "");
  let slug = cleaned;
  if (slug === "" || slug === "." || slug === "..") {
    slug = "key";
  } else if (slug.length > 140) {
    slug = slug.slice(0, 140);
  }
  return `${slug}-${hash}`;
}

/**
 * Directory name for a mirror when the lease has no `repo_key` (e.g. bare
 * path / `file://` origin that does not normalize). Stable hash of the fetch
 * URL so warm reuse still works.
 */
export function encodeFetchUrlForFs(fetchUrl: string): string {
  return `url-${shortHash(fetchUrl.trim())}`;
}

/** True when a clones/ entry name is a temp clone dir, never a real mirror. */
export function isMirrorTempName(name: string): boolean {
  return name.startsWith(MIRROR_TEMP_PREFIX);
}

/** Absolute path of the managed bare mirror for this identity. */
export function mirrorPathFor(
  clonesDir: string,
  repoKey: string | null,
  fetchUrl: string,
): string {
  const name =
    repoKey !== null && repoKey !== ""
      ? encodeRepoKeyForFs(repoKey)
      : encodeFetchUrlForFs(fetchUrl);
  return path.join(clonesDir, name);
}

/** Filesystem-safe branch slug — mirrors `packages/daemon/src/worktree.ts`. */
function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned === "" ? "task" : cleaned;
}

/** Task branch name: `parley/<id>` or `parley/<id>-<slug>` (same as worktree). */
export function taskBranchName(taskId: string, name: string | null): string {
  return name ? `parley/${taskId}-${slug(name)}` : `parley/${taskId}`;
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function git(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): string {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  }).trim();
}

function gitErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr: unknown }).stderr).trim();
    if (stderr !== "") return stderr;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function isBareGitDir(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    const bare = git(["-C", dir, "rev-parse", "--is-bare-repository"]);
    return bare === "true";
  } catch {
    return false;
  }
}

function sleepMs(ms: number): void {
  // Synchronous sleep: claim-time git is already sync; keep the lock path simple.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * mkdir-based lock for a mirror path. Lock lives at `<mirrorPath>.lock` (a
 * directory). Stale locks older than {@link MIRROR_LOCK_STALE_MS} are stolen.
 */
export function withMirrorLock(mirrorPath: string, fn: () => void): void {
  const acquired = tryWithMirrorLock(mirrorPath, fn, MIRROR_LOCK_WAIT_MS);
  if (!acquired) {
    throw new ClaimGitError(
      "mirror_clone_failed",
      `timed out waiting for mirror lock at ${mirrorPath}.lock`,
    );
  }
}

/**
 * Try to take the mirror lock (stealing only when stale). Returns false when
 * another process holds a non-stale lock and `waitMs` elapses without
 * acquisition. Used by prune so a mid-task mirror is skipped, not waited on
 * for the full claim timeout (#318 review HIGH-4).
 */
export function tryWithMirrorLock(
  mirrorPath: string,
  fn: () => void,
  waitMs = 0,
): boolean {
  const lockDir = `${mirrorPath}.lock`;
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(
          path.join(lockDir, "owner"),
          `${process.pid}\n${Date.now()}\n`,
          { flag: "wx" },
        );
      } catch {
        /* owner stamp is best-effort */
      }
      try {
        fn();
      } finally {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* leave for stale reaper */
        }
      }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (isStaleLock(lockDir, MIRROR_LOCK_STALE_MS)) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* peer may be reclaiming */
        }
        continue;
      }
      if (Date.now() >= deadline) return false;
      sleepMs(50);
    }
  }
}

function isStaleLock(lockDir: string, staleMs: number): boolean {
  try {
    const ownerPath = path.join(lockDir, "owner");
    if (fs.existsSync(ownerPath)) {
      const text = fs.readFileSync(ownerPath, "utf8");
      const lines = text.split("\n");
      const ts = Number(lines[1]);
      if (Number.isFinite(ts) && Date.now() - ts > staleMs) return true;
    }
    const st = fs.statSync(lockDir);
    return Date.now() - st.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

/**
 * Create the bare mirror if missing, otherwise fetch all refs with prune.
 * Uses the host's ambient git credentials.
 *
 * Concurrency: a mkdir-lock serializes ensure for the same mirror path. Cold
 * clones go into a sibling temp dir then `rename` into place so a peer never
 * observes a half-cloned destination (and we never `rmSync` a peer's in-flight
 * clone at the final path).
 *
 * Implementation note: we clone with `--mirror` for a full ref fetch, then
 * clear `remote.origin.mirror` so later `git push origin <refspec>` (claim-time
 * preflight and post-task branch handoff) can target a single branch. A pure
 * mirror remote rejects refspecs (`--mirror can't be combined with refspecs`).
 */
export function ensureMirror(mirrorPath: string, fetchUrl: string): void {
  const display = safeUrl(fetchUrl);
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });

  withMirrorLock(mirrorPath, () => {
    if (isBareGitDir(mirrorPath)) {
      try {
        configureMirrorRemote(mirrorPath, fetchUrl);
        // Free any task branch still checked out in a surviving daemon worktree
        // so +refs/*:refs/* can update those refs (#318 BLOCKER-1).
        detachLinkedWorktreeBranches(mirrorPath);
        git(["-C", mirrorPath, "fetch", "--prune", "origin", "+refs/*:refs/*"]);
      } catch (err) {
        if (err instanceof ClaimGitError) throw err;
        throw new ClaimGitError(
          "mirror_fetch_failed",
          `mirror fetch failed for ${display}: ${gitErrorMessage(err)}`,
        );
      }
      return;
    }

    // Residue at the final path (half-clone, non-bare junk). Safe under the
    // lock: no peer is mid-clone into this path (clones use a temp sibling).
    if (fs.existsSync(mirrorPath)) {
      fs.rmSync(mirrorPath, { recursive: true, force: true });
    }

    const parent = path.dirname(mirrorPath);
    const base = path.basename(mirrorPath);
    const tmp = path.join(
      parent,
      `${MIRROR_TEMP_PREFIX}${base}-${process.pid}-${Date.now().toString(36)}`,
    );
    try {
      if (fs.existsSync(tmp)) {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      git(["clone", "--mirror", fetchUrl, tmp]);
      configureMirrorRemote(tmp, fetchUrl);
      // Re-check: peer may have finished while we cloned (shouldn't under lock,
      // but rename must not clobber a good bare).
      if (isBareGitDir(mirrorPath)) {
        fs.rmSync(tmp, { recursive: true, force: true });
        configureMirrorRemote(mirrorPath, fetchUrl);
        git(["-C", mirrorPath, "fetch", "--prune", "origin", "+refs/*:refs/*"]);
        return;
      }
      if (fs.existsSync(mirrorPath)) {
        fs.rmSync(mirrorPath, { recursive: true, force: true });
      }
      fs.renameSync(tmp, mirrorPath);
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      if (err instanceof ClaimGitError) throw err;
      throw new ClaimGitError(
        "mirror_clone_failed",
        `mirror clone failed for ${display}: ${gitErrorMessage(err)}`,
      );
    }
  });
}

/**
 * Keep full-ref fetch while allowing single-branch push (see ensureMirror).
 */
function configureMirrorRemote(mirrorPath: string, fetchUrl: string): void {
  const display = safeUrl(fetchUrl);
  try {
    git(["-C", mirrorPath, "remote", "set-url", "origin", fetchUrl]);
  } catch {
    try {
      git(["-C", mirrorPath, "remote", "add", "origin", fetchUrl]);
    } catch (err) {
      throw new ClaimGitError(
        "mirror_fetch_failed",
        `could not set origin to ${display}: ${gitErrorMessage(err)}`,
      );
    }
  }
  try {
    git(["-C", mirrorPath, "config", "remote.origin.mirror", "false"]);
  } catch {
    /* optional on non-mirror bares */
  }
  try {
    git(["-C", mirrorPath, "config", "remote.origin.fetch", "+refs/*:refs/*"]);
  } catch {
    /* best-effort */
  }
}

/**
 * Ensure `sha` is a resolvable commit in `repoPath`. Tries local first, then
 * a direct fetch of that object from origin. Throws `base_sha_unresolvable`.
 */
export function ensureBaseSha(repoPath: string, sha: string): void {
  const target = sha.trim();
  if (target === "") {
    throw new ClaimGitError(
      "base_sha_unresolvable",
      "base_sha not resolvable from origin: empty base_sha",
    );
  }
  if (hasCommit(repoPath, target)) return;

  try {
    git(["-C", repoPath, "fetch", "origin", target]);
  } catch {
    // Fall through to final check / diagnosis.
  }
  if (hasCommit(repoPath, target)) return;

  throw new ClaimGitError(
    "base_sha_unresolvable",
    `base_sha not resolvable from origin: ${target}`,
  );
}

function hasCommit(repoPath: string, sha: string): boolean {
  try {
    git(["-C", repoPath, "rev-parse", "--verify", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Whether a git push error should be classed as permission / denial. */
export function isPushDeniedDetail(detail: string): boolean {
  return /denied|forbidden|not allowed|pre-receive hook declined|hook declined|authentication failed|permission|read.?only|PROHIBITED|unauthorized|unable to create temporary object directory|operation not permitted|cannot create|disk quota|Read-only file system/i.test(
    detail,
  );
}

/**
 * Pre-flight: push `baseSha` to `refs/heads/<branch>` on origin before the
 * vendor spawns. Surfaces permission / hook denials at claim time.
 *
 * Uses a **real** push (not `--dry-run`): git's dry-run path does not invoke
 * remote `pre-receive` / `update` hooks, so denials would only appear after
 * the vendor ran. The branch tip starts at base_sha; the post-task push
 * advances it with any child commits.
 */
export function preflightPushBranch(
  repoPath: string,
  baseSha: string,
  branch: string,
): void {
  try {
    git([
      "-C",
      repoPath,
      "push",
      "origin",
      `${baseSha}:refs/heads/${branch}`,
    ]);
  } catch (err) {
    const detail = gitErrorMessage(err);
    const denied = isPushDeniedDetail(detail);
    throw new ClaimGitError(
      denied ? "push_denied" : "push_preflight_failed",
      denied
        ? `push denied at claim time (branch ${branch}): ${detail}`
        : `push preflight failed (branch ${branch}): ${detail}`,
    );
  }

  // Bare mirrors with fetch `+refs/*:refs/*` can grow a local `refs/heads/<branch>`
  // as a side effect of the push above. Drop it so `git worktree add -b` can
  // create a fresh task branch at base_sha (createWorktree always uses -b).
  try {
    git(["-C", repoPath, "update-ref", "-d", `refs/heads/${branch}`]);
  } catch {
    /* non-bare clones only have remotes/origin/<branch> — nothing to delete */
  }
}

/**
 * Best-effort delete of a preflight branch left on origin after a task fails.
 * Errors are swallowed — a residual remote branch is preferable to blocking fail.
 */
export function deleteRemoteBranchBestEffort(
  repoPath: string,
  branch: string,
): void {
  try {
    git(["-C", repoPath, "push", "origin", `:refs/heads/${branch}`]);
  } catch {
    /* residual orphan documented in ADR-0031 */
  }
}

/** @deprecated alias — prefer {@link preflightPushBranch}. */
export const dryRunPushBranch = preflightPushBranch;

/**
 * Best-effort fetch into an operator-managed (non-mirror) clone so base_sha
 * can resolve. Failures are non-fatal here — ensureBaseSha owns the diagnosis.
 */
export function fetchOperatorClone(repoPath: string): void {
  try {
    git(["-C", repoPath, "fetch", "--prune", "origin"]);
  } catch {
    /* ensureBaseSha will fail precisely if the object is still missing */
  }
}

/** Result of claim-time repo resolution / sync. */
export interface PreparedRepo {
  /** Repo root used for worktree create/remove (bare mirror or override clone). */
  repoLocal: string;
  /** Verified base commit (or ref) passed to `createWorktree`. */
  baseRef: string;
  /** Precomputed task branch name (matches createWorktree). */
  branch: string;
  /** Whether to push the task branch to origin after the child exits. */
  pushToOrigin: boolean;
  /**
   * True when claim-time preflight successfully pushed `branch` to origin.
   * On later task failure the runner best-effort deletes that remote ref.
   */
  preflightPushed: boolean;
  /** How the repo was obtained (for logs / tests). */
  source: "mirror" | "override" | "local";
}

export interface PrepareClaimRepoOptions {
  /** Optional operator override map (repo key → local path). */
  repos: Record<string, string>;
  /** `homePaths(...).clones` — parent for managed bare mirrors. */
  clonesDir: string;
}

/**
 * Exact key match only (repo key or full path id). Basename heuristics are
 * intentionally absent (ADR-0031 / #316 review F1).
 */
export function resolveReposOverride(
  repos: Record<string, string>,
  repoId: string,
): string | null {
  if (repoId === "") return null;
  const hit = repos[repoId];
  return hit !== undefined ? hit : null;
}

/**
 * Claim-time repo sync: resolve source, update, verify base_sha, preflight push.
 * Throws {@link ClaimGitError} on any failure (caller maps to transport.fail).
 */
export function prepareClaimRepo(
  lease: RunnerLeaseSpec,
  opts: PrepareClaimRepoOptions,
): PreparedRepo {
  const branch = taskBranchName(lease.task_id, lease.name);
  const baseSha = lease.base_sha?.trim() || null;
  const baseRef = baseSha ?? lease.base_ref ?? "HEAD";

  // 1) Optional operator-managed clone — exact match on repo_key, else exact
  // path id (no basename heuristics; F1).
  const override =
    (lease.repo_key !== null && lease.repo_key !== ""
      ? resolveReposOverride(opts.repos, lease.repo_key)
      : null) ?? resolveReposOverride(opts.repos, lease.repo);
  if (override !== null) {
    if (!fs.existsSync(override)) {
      throw new ClaimGitError(
        "override_missing",
        `repos override path does not exist: ${override}`,
      );
    }
    fetchOperatorClone(override);
    if (baseSha !== null) {
      ensureBaseSha(override, baseSha);
    } else {
      try {
        git(["-C", override, "rev-parse", "--verify", `${baseRef}^{commit}`]);
      } catch (err) {
        throw new ClaimGitError(
          "base_sha_unresolvable",
          `base_sha not resolvable from origin: ${baseRef} (${gitErrorMessage(err)})`,
        );
      }
    }
    const resolved =
      baseSha ??
      git(["-C", override, "rev-parse", "--verify", `${baseRef}^{commit}`]);
    preflightPushBranch(override, resolved, branch);
    return {
      repoLocal: override,
      baseRef: resolved,
      branch,
      pushToOrigin: true,
      preflightPushed: true,
      source: "override",
    };
  }

  // 2) Managed bare mirror when we have a fetch URL.
  if (lease.repo_fetch_url !== null && lease.repo_fetch_url !== "") {
    const mirrorPath = mirrorPathFor(
      opts.clonesDir,
      lease.repo_key,
      lease.repo_fetch_url,
    );
    ensureMirror(mirrorPath, lease.repo_fetch_url);
    if (baseSha !== null) {
      ensureBaseSha(mirrorPath, baseSha);
    } else {
      try {
        git(["-C", mirrorPath, "rev-parse", "--verify", `${baseRef}^{commit}`]);
      } catch (err) {
        throw new ClaimGitError(
          "base_sha_unresolvable",
          `base_sha not resolvable from origin: ${baseRef} (${gitErrorMessage(err)})`,
        );
      }
    }
    const resolved =
      baseSha ??
      git(["-C", mirrorPath, "rev-parse", "--verify", `${baseRef}^{commit}`]);
    preflightPushBranch(mirrorPath, resolved, branch);
    return {
      repoLocal: mirrorPath,
      baseRef: resolved,
      branch,
      pushToOrigin: true,
      preflightPushed: true,
      source: "mirror",
    };
  }

  // 3) Local fast path: no origin — cut from the delegate-time path if present.
  if (fs.existsSync(lease.repo)) {
    return {
      repoLocal: lease.repo,
      baseRef,
      branch,
      pushToOrigin: false,
      preflightPushed: false,
      source: "local",
    };
  }

  throw new ClaimGitError(
    "no_repo_source",
    `no repo source for task: missing repo_fetch_url and no local path at ${lease.repo} ` +
      `(configure runner.repos override or ensure origin is recorded on the task)`,
  );
}

// ---------------------------------------------------------------------------
// Held-mirror advertisement + manual prune (#318)
// ---------------------------------------------------------------------------

/** Read origin URL from a bare mirror; null when missing / unreadable. */
function readMirrorOriginUrl(mirrorPath: string): string | null {
  try {
    const url = git(["-C", mirrorPath, "config", "--get", "remote.origin.url"]);
    return url === "" ? null : url;
  } catch {
    return null;
  }
}

/**
 * Repo keys for which `clonesDir` holds a usable bare mirror (#318).
 * Derived by reading each bare's origin URL and normalizing — never from the
 * directory name alone (encoding is injective but not inverted here).
 */
export function listHeldMirrorRepoKeys(clonesDir: string): string[] {
  const keys = new Set<string>();
  if (!fs.existsSync(clonesDir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(clonesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (isMirrorTempName(ent.name)) continue;
    if (ent.name.endsWith(".lock")) continue;
    const full = path.join(clonesDir, ent.name);
    if (!isBareGitDir(full)) continue;
    const origin = readMirrorOriginUrl(full);
    if (origin === null) continue;
    const key = normalizeRepoKey(stripFetchUrlCredentials(origin));
    if (key !== null && key !== "") keys.add(key);
  }
  return [...keys].sort();
}

/** Recursive directory size in bytes (files only; follows nothing special). */
export function dirSizeBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile() || ent.isSymbolicLink()) {
          total += fs.lstatSync(full).size;
        }
      } catch {
        /* race / permission — skip */
      }
    }
  };
  try {
    const st = fs.lstatSync(root);
    if (st.isFile() || st.isSymbolicLink()) return st.size;
    if (st.isDirectory()) walk(root);
  } catch {
    return 0;
  }
  return total;
}

/** One managed mirror under `clones/` for list/prune (#318). */
export interface ManagedCloneInfo {
  /** Directory name under clones/. */
  name: string;
  /** Absolute path. */
  path: string;
  /** Normalized repo key when origin normalizes; null for path/file origins. */
  repo_key: string | null;
  /** Origin fetch URL with credentials stripped when known. */
  fetch_url: string | null;
  /** Total bytes under the mirror directory. */
  size_bytes: number;
  /**
   * True when a live (non-terminal) task references this mirror by key or by
   * raw fetch URL/path. Mirrors with undetermined usage are marked used so
   * prune never deletes on uncertainty (#318 review HIGH-4).
   */
  used: boolean;
}

/**
 * Live (non-terminal) task references used to mark mirrors "used" for list/prune.
 * Match by normalized key **and** raw fetch URL / local path so path-origin
 * mirrors (null key) are not falsely treated as free (#318 review HIGH-4).
 */
export interface LiveMirrorUsage {
  repoKeys: ReadonlySet<string>;
  /** `repo_fetch_url` and `repo` path values from live tasks. */
  refs: ReadonlySet<string>;
}

/** Empty usage set — all determinable mirrors appear unused. */
export function emptyLiveMirrorUsage(): LiveMirrorUsage {
  return { repoKeys: new Set(), refs: new Set() };
}

/**
 * Normalize the various historical call shapes for list/prune usage.
 * Accepts a Set of keys (legacy), a full {@link LiveMirrorUsage}, or nothing.
 */
function coerceLiveUsage(
  live:
    | LiveMirrorUsage
    | ReadonlySet<string>
    | readonly string[]
    | undefined,
): LiveMirrorUsage {
  if (live === undefined) return emptyLiveMirrorUsage();
  if (Array.isArray(live)) {
    return { repoKeys: new Set(live), refs: new Set() };
  }
  // LiveMirrorUsage shape (repoKeys + refs).
  if (
    typeof live === "object" &&
    live !== null &&
    "repoKeys" in live &&
    "refs" in live
  ) {
    return live as LiveMirrorUsage;
  }
  // ReadonlySet / Set of keys.
  return { repoKeys: new Set(live as ReadonlySet<string>), refs: new Set() };
}

/** Loose equality for path/file origins (resolve when both look like paths). */
function refsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // file:// URLs vs bare paths
  const stripFile = (s: string): string =>
    s.startsWith("file://") ? s.slice("file://".length) : s;
  const aa = stripFile(a);
  const bb = stripFile(b);
  if (aa === bb) return true;
  try {
    if (path.isAbsolute(aa) || path.isAbsolute(bb)) {
      return path.resolve(aa) === path.resolve(bb);
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Whether a mirror is referenced by any live task. Never returns false when
 * usage cannot be determined (null key and null/empty fetch URL).
 */
export function isMirrorUsedByLiveTasks(
  repoKey: string | null,
  fetchUrl: string | null,
  usage: LiveMirrorUsage,
): boolean {
  const keyOk = repoKey !== null && repoKey !== "";
  const urlOk = fetchUrl !== null && fetchUrl !== "";
  if (!keyOk && !urlOk) {
    // No identity at all — never delete on uncertainty.
    return true;
  }
  if (keyOk && usage.repoKeys.has(repoKey!)) return true;
  if (urlOk) {
    for (const ref of usage.refs) {
      if (refsMatch(ref, fetchUrl!)) return true;
    }
  }
  return false;
}

/**
 * List managed bare mirrors with sizes. Live usage marks a mirror used when
 * any non-terminal task references its key or raw origin URL/path (#318).
 */
export function listManagedClones(
  clonesDir: string,
  live: LiveMirrorUsage | ReadonlySet<string> | readonly string[] = emptyLiveMirrorUsage(),
): ManagedCloneInfo[] {
  const usage = coerceLiveUsage(live);
  if (!fs.existsSync(clonesDir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(clonesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ManagedCloneInfo[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (isMirrorTempName(ent.name)) continue;
    if (ent.name.endsWith(".lock")) continue;
    const full = path.join(clonesDir, ent.name);
    if (!isBareGitDir(full)) continue;
    const origin = readMirrorOriginUrl(full);
    const fetchUrl =
      origin !== null ? stripFetchUrlCredentials(origin) : null;
    const repoKey =
      fetchUrl !== null ? normalizeRepoKey(fetchUrl) : null;
    const used = isMirrorUsedByLiveTasks(repoKey, fetchUrl, usage);
    out.push({
      name: ent.name,
      path: full,
      repo_key: repoKey,
      fetch_url: fetchUrl,
      size_bytes: dirSizeBytes(full),
      used,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Remove unused managed mirrors. Never auto-called — only the explicit prune
 * verb. Takes the per-mirror lock (skips when held); never deletes used or
 * lock-busy mirrors. Returns removed and kept inventories.
 */
export function pruneUnusedClones(
  clonesDir: string,
  live: LiveMirrorUsage | ReadonlySet<string> | readonly string[] = emptyLiveMirrorUsage(),
): { removed: ManagedCloneInfo[]; kept: ManagedCloneInfo[] } {
  const all = listManagedClones(clonesDir, live);
  const removed: ManagedCloneInfo[] = [];
  const kept: ManagedCloneInfo[] = [];
  for (const entry of all) {
    if (entry.used) {
      kept.push(entry);
      continue;
    }
    let didRemove = false;
    try {
      const acquired = tryWithMirrorLock(entry.path, () => {
        // Re-read under lock: a peer may have started using it.
        if (!fs.existsSync(entry.path) || !isBareGitDir(entry.path)) {
          didRemove = true;
          return;
        }
        fs.rmSync(entry.path, { recursive: true, force: true });
        didRemove = true;
      }, 0);
      if (!acquired) {
        // Lock held by ensureMirror / peer — treat as in use.
        kept.push(entry);
        continue;
      }
    } catch {
      kept.push(entry);
      continue;
    }
    if (didRemove) {
      removed.push(entry);
    } else {
      kept.push(entry);
    }
  }
  return { removed, kept };
}

/**
 * Push a task branch from a worktree to origin (mirror / override handoff).
 * Surfaces git stderr on failure.
 */
export function pushTaskBranch(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): void {
  try {
    git(["-C", worktreePath, "push", "-u", "origin", branch]);
  } catch (err) {
    throw new Error(
      `git push origin ${branch} failed: ${gitErrorMessage(err)} (repo ${repoRoot})`,
    );
  }
}

/**
 * Detach HEAD in a linked worktree so the bare mirror can fetch/update branch
 * refs again. Daemon worktrees deliberately survive for review (`parley clean`);
 * leaving the task branch checked out blocks the next task's
 * `fetch --prune origin +refs/*:refs/*` (#318 review BLOCKER-1).
 *
 * Files and the branch tip on origin remain; only the checkout moves to
 * detached HEAD at the same commit. Best-effort — never throws.
 *
 * Prefers rewriting the worktree private HEAD file via the bare (works even
 * when the worktree briefly reports `is-inside-work-tree: false`); falls back
 * to `git checkout --detach`.
 */
export function detachWorktreeHead(worktreePath: string): void {
  if (!fs.existsSync(worktreePath)) return;
  // Prefer bare-side HEAD rewrite (reliable for bare-mirror linked worktrees).
  try {
    const common = git([
      "-C",
      worktreePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const privateGitDir = git([
      "-C",
      worktreePath,
      "rev-parse",
      "--absolute-git-dir",
    ]);
    if (detachWorktreeHeadAtGitDir(common, privateGitDir)) return;
  } catch {
    /* fall through to checkout */
  }
  try {
    git(["-C", worktreePath, "checkout", "--detach", "--force", "HEAD"]);
  } catch {
    /* residual attached checkout is preferable to failing terminal handoff */
  }
}

/**
 * Rewrite a worktree private HEAD from `ref: refs/heads/...` to a raw sha
 * (detached). Returns true when the HEAD file was detached (or already was).
 */
function detachWorktreeHeadAtGitDir(
  barePath: string,
  privateGitDir: string,
): boolean {
  const headFile = path.join(privateGitDir, "HEAD");
  if (!fs.existsSync(headFile)) return false;
  let head: string;
  try {
    head = fs.readFileSync(headFile, "utf8").trim();
  } catch {
    return false;
  }
  if (!head.startsWith("ref: ")) {
    // Already detached (raw sha) or empty.
    return head !== "";
  }
  const ref = head.slice("ref: ".length).trim();
  try {
    const sha = git(["-C", barePath, "rev-parse", "--verify", `${ref}^{commit}`]);
    fs.writeFileSync(headFile, `${sha}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detach every linked worktree of a bare that still has a branch checked out.
 * Called before mirror fetch so a leftover attached daemon worktree cannot
 * block `+refs/*:refs/*` (#318 review BLOCKER-1 belt-and-suspenders).
 */
export function detachLinkedWorktreeBranches(barePath: string): void {
  let porcelain: string;
  try {
    porcelain = git(["-C", barePath, "worktree", "list", "--porcelain"]);
  } catch {
    return;
  }
  let current: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch ") && current !== null) {
      if (current !== barePath) {
        // Bare-side first: resolve private gitdir from porcelain path.
        try {
          const privateGitDir = git([
            "-C",
            current,
            "rev-parse",
            "--absolute-git-dir",
          ]);
          if (!detachWorktreeHeadAtGitDir(barePath, privateGitDir)) {
            detachWorktreeHead(current);
          }
        } catch {
          detachWorktreeHead(current);
        }
      }
      current = null;
      continue;
    }
    if (line === "") current = null;
  }
}
