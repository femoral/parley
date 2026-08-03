/**
 * Resolve repo identity at task create time (#313 / #305).
 *
 * Reads `origin` from the local git checkout and normalizes it into the
 * stable repo key. Repos with no origin (or a non-network fetch URL) record
 * only the local path — key and fetch URL stay null.
 *
 * Fetch URLs are credential-stripped before storage so embedded tokens never
 * land in the db, status output, child envelopes, or runner leases.
 */
import { execFileSync } from "node:child_process";
import { normalizeRepoKey, stripFetchUrlCredentials } from "@useparley/core";
import { repoRoot } from "./worktree.js";

/** Bound git I/O so a hung filesystem cannot stall every delegate. */
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 64 * 1024;

/** Identity triple recorded on every task (local path always; key/URL when known). */
export interface RepoIdentity {
  /** Delegate-time local path (repo root or cwd as stored in `tasks.repo`). */
  localPath: string;
  /** Normalized `host/path` key, or null when origin is missing / unparseable. */
  key: string | null;
  /**
   * Origin fetch URL with userinfo stripped, or null when origin is missing.
   * Never contains embedded tokens.
   */
  fetchUrl: string | null;
}

/**
 * Read the configured origin URL for a checkout.
 *
 * Uses `git config remote.origin.url` rather than `git remote get-url origin`
 * so `url.<base>.insteadOf` rewrites are not applied — the stored fetch URL
 * must be the operator-configured remote, usable off-host on runners.
 *
 * Returns null when the path is not a git repo, has no origin, git fails, or
 * the call times out.
 */
export function readOriginFetchUrl(dir: string): string | null {
  try {
    const url = execFileSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    }).trim();
    return url === "" ? null : url;
  } catch {
    // Includes timeout (ETIMEDOUT), missing remote, and non-repo dirs.
    return null;
  }
}

/**
 * Resolve identity for the path that will be stored as `tasks.repo`.
 * Origin is looked up from the enclosing git root when `localPath` is inside
 * a worktree or subdirectory. Credentials are stripped before return.
 */
export function resolveRepoIdentity(localPath: string): RepoIdentity {
  const root = repoRoot(localPath) ?? localPath;
  let origin: string | null;
  try {
    origin = readOriginFetchUrl(root);
  } catch {
    // Defensive: treat any unexpected failure as no-origin so delegate succeeds.
    return { localPath, key: null, fetchUrl: null };
  }
  if (origin === null) {
    return { localPath, key: null, fetchUrl: null };
  }
  const fetchUrl = stripFetchUrlCredentials(origin);
  return {
    localPath,
    key: normalizeRepoKey(fetchUrl),
    fetchUrl,
  };
}
