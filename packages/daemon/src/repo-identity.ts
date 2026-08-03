/**
 * Resolve repo identity at task create time (#313 / #305).
 *
 * Reads `origin` from the local git checkout and normalizes it into the
 * stable repo key. Repos with no origin (or a non-network fetch URL) record
 * only the local path — key and fetch URL stay null.
 */
import { execFileSync } from "node:child_process";
import { normalizeRepoKey } from "@useparley/core";
import { repoRoot } from "./worktree.js";

/** Identity triple recorded on every task (local path always; key/URL when known). */
export interface RepoIdentity {
  /** Delegate-time local path (repo root or cwd as stored in `tasks.repo`). */
  localPath: string;
  /** Normalized `host/path` key, or null when origin is missing / unparseable. */
  key: string | null;
  /** Exact origin fetch URL, or null when origin is missing. */
  fetchUrl: string | null;
}

/**
 * Read `git remote get-url origin` for a checkout. Returns null when the
 * path is not a git repo, has no origin, or git fails.
 */
export function readOriginFetchUrl(dir: string): string | null {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return url === "" ? null : url;
  } catch {
    return null;
  }
}

/**
 * Resolve identity for the path that will be stored as `tasks.repo`.
 * Origin is looked up from the enclosing git root when `localPath` is inside
 * a worktree or subdirectory.
 */
export function resolveRepoIdentity(localPath: string): RepoIdentity {
  const root = repoRoot(localPath) ?? localPath;
  const fetchUrl = readOriginFetchUrl(root);
  if (fetchUrl === null) {
    return { localPath, key: null, fetchUrl: null };
  }
  return {
    localPath,
    key: normalizeRepoKey(fetchUrl),
    fetchUrl,
  };
}
