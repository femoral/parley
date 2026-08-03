/**
 * Parley-managed bare mirrors + claim-time repo sync (ADR-0031 / #316).
 *
 * On claim the runner ensures a bare mirror under the parley home's `clones/`
 * dir (or uses an optional operator-managed clone override), fetches with
 * prune, verifies `base_sha` (direct sha fetch as fallback), and preflight-
 * pushes the base sha to the task branch name — all before the vendor child
 * is spawned. Credentials are ambient host git credentials only; nothing is
 * stored in parley config or on the wire.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RunnerLeaseSpec } from "@useparley/core";
import { resolveRepoPath } from "./config.js";

/** Bound git I/O so a hung remote cannot stall the runner forever. */
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Diagnosis class for claim-time git failures. The `code` is a stable token
 * for operators / tests; `message` is the human-readable fail string.
 */
export type ClaimGitFailureCode =
  | "no_repo_source"
  | "mirror_clone_failed"
  | "mirror_fetch_failed"
  | "base_sha_unresolvable"
  | "push_denied"
  | "push_preflight_failed"
  | "override_missing";

export class ClaimGitError extends Error {
  readonly code: ClaimGitFailureCode;

  constructor(code: ClaimGitFailureCode, message: string) {
    super(message);
    this.name = "ClaimGitError";
    this.code = code;
  }
}

/**
 * Encode a repo key (`host/path`, may contain `/`) into a single filesystem
 * path segment. Slashes become `--`; other path-hostile chars are replaced
 * with `_`. Empty / degenerate results fall back to a short hash of the key.
 *
 * @example
 * encodeRepoKeyForFs("github.com/femoral/parley")
 * // → "github.com--femoral--parley"
 */
export function encodeRepoKeyForFs(repoKey: string): string {
  const cleaned = repoKey
    .trim()
    .toLowerCase()
    .replace(/\//g, "--")
    .replace(/[^a-z0-9._+-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return `key-${shortHash(repoKey)}`;
  }
  // Cap length so deeply nested group paths stay within path limits.
  if (cleaned.length > 180) {
    return `${cleaned.slice(0, 140)}-${shortHash(repoKey)}`;
  }
  return cleaned;
}

/**
 * Directory name for a mirror when the lease has no `repo_key` (e.g. bare
 * path / `file://` origin that does not normalize). Stable hash of the fetch
 * URL so warm reuse still works.
 */
export function encodeFetchUrlForFs(fetchUrl: string): string {
  return `url-${shortHash(fetchUrl.trim())}`;
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

/**
 * Create the bare mirror if missing, otherwise fetch all refs with prune.
 * Uses the host's ambient git credentials.
 *
 * Implementation note: we clone with `--mirror` for a full ref fetch, then
 * clear `remote.origin.mirror` so later `git push origin <refspec>` (claim-time
 * preflight and post-task branch handoff) can target a single branch. A pure
 * mirror remote rejects refspecs (`--mirror can't be combined with refspecs`).
 */
export function ensureMirror(mirrorPath: string, fetchUrl: string): void {
  if (isBareGitDir(mirrorPath)) {
    try {
      configureMirrorRemote(mirrorPath, fetchUrl);
      // Fetch every ref and drop deleted remote refs (warm-mirror update).
      git(["-C", mirrorPath, "fetch", "--prune", "origin", "+refs/*:refs/*"]);
    } catch (err) {
      if (err instanceof ClaimGitError) throw err;
      throw new ClaimGitError(
        "mirror_fetch_failed",
        `mirror fetch failed for ${fetchUrl}: ${gitErrorMessage(err)}`,
      );
    }
    return;
  }

  // Stale non-bare residue — clear so clone can proceed.
  if (fs.existsSync(mirrorPath)) {
    fs.rmSync(mirrorPath, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  try {
    git(["clone", "--mirror", fetchUrl, mirrorPath]);
    configureMirrorRemote(mirrorPath, fetchUrl);
  } catch (err) {
    if (err instanceof ClaimGitError) throw err;
    throw new ClaimGitError(
      "mirror_clone_failed",
      `mirror clone failed for ${fetchUrl}: ${gitErrorMessage(err)}`,
    );
  }
}

/**
 * Keep full-ref fetch while allowing single-branch push (see ensureMirror).
 */
function configureMirrorRemote(mirrorPath: string, fetchUrl: string): void {
  try {
    // Ensure origin points at the lease fetch URL (may change if URL moved).
    git(["-C", mirrorPath, "remote", "set-url", "origin", fetchUrl]);
  } catch {
    try {
      git(["-C", mirrorPath, "remote", "add", "origin", fetchUrl]);
    } catch (err) {
      throw new ClaimGitError(
        "mirror_fetch_failed",
        `could not set origin to ${fetchUrl}: ${gitErrorMessage(err)}`,
      );
    }
  }
  // Disable mirror *push* mode so refspec pushes work; keep broad fetch.
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

  // Direct sha fetch fallback (object may not be on any advertised branch).
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
    const denied =
      /denied|forbidden|not allowed|pre-receive hook declined|hook declined|authentication failed|permission|read.only|PROHIBITED|unauthorized/i.test(
        detail,
      );
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

  // 1) Optional operator-managed clone override (keyed by repo_key, then path).
  const overrideId = lease.repo_key ?? lease.repo;
  const override = resolveRepoPath(opts.repos, overrideId);
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
      // No recorded sha — ensure the ref resolves at all.
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
      source: "local",
    };
  }

  throw new ClaimGitError(
    "no_repo_source",
    `no repo source for task: missing repo_fetch_url and no local path at ${lease.repo} ` +
      `(configure runner.repos override or ensure origin is recorded on the task)`,
  );
}
