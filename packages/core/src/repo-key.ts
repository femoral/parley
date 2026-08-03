/**
 * Repo identity for delegated tasks (#313 / #305).
 *
 * The canonical handle is a normalized **repo key** derived from the origin
 * fetch URL by folding SSH/HTTPS forms, stripping a trailing `.git`, and
 * case-folding into `host/path` (e.g. `github.com/femoral/parley`).
 *
 * Pure string helpers only — callers that need to read `git remote get-url
 * origin` live in the daemon (or runner) where process I/O is already used.
 */

/**
 * Normalize a git remote fetch URL into a stable repo key.
 *
 * Returns null when the URL is empty, not a network remote (e.g. bare path /
 * `file://`), or otherwise unparseable.
 *
 * @example
 * normalizeRepoKey("git@github.com:Org/Repo.git")
 * // → "github.com/org/repo"
 * normalizeRepoKey("https://github.com/Org/Repo.git")
 * // → "github.com/org/repo"
 */
export function normalizeRepoKey(raw: string): string | null {
  const url = raw.trim();
  if (url === "") return null;

  // scp-like SSH: git@host:path or user@host:path[/…]
  // Reject Windows drive paths (C:\…) and URLs that already have a scheme.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) && !/^[A-Za-z]:[\\/]/.test(url)) {
    const scp = /^[^@\s/]+@([^:\s]+):(.+)$/.exec(url);
    if (scp !== null) {
      return foldKey(scp[1] ?? "", scp[2] ?? "");
    }
  }

  // URL forms: https://, http://, ssh://, git+ssh://, git+https://, …
  try {
    const candidate = url.replace(/^git\+/i, "");
    const parsed = new URL(candidate);
    if (parsed.protocol === "file:") return null;
    const host = parsed.hostname;
    if (!host) return null;
    // pathname is "/org/repo.git"; drop leading slash(es).
    const pathPart = (parsed.pathname ?? "").replace(/^\/+/, "");
    return foldKey(host, pathPart);
  } catch {
    return null;
  }
}

/**
 * Fold host + path into the canonical key: lowercased `host/path` with a
 * trailing `.git` stripped and empty segments rejected.
 */
function foldKey(host: string, pathPart: string): string | null {
  const h = host.trim().toLowerCase();
  if (h === "") return null;

  let p = pathPart.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  // Strip a single trailing .git (common on both SSH and HTTPS remotes).
  if (p.toLowerCase().endsWith(".git")) {
    p = p.slice(0, -".git".length);
  }
  p = p.replace(/\/+$/, "");
  if (p === "") return null;

  return `${h}/${p.toLowerCase()}`;
}
