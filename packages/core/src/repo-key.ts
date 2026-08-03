/**
 * Repo identity for delegated tasks (#313 / #305).
 *
 * The canonical handle is a normalized **repo key** derived from the origin
 * fetch URL by folding SSH/HTTPS forms, stripping a trailing `.git`, and
 * case-folding into `host/path` (e.g. `github.com/femoral/parley`).
 *
 * Pure string helpers only — callers that need to read git config for origin
 * live in the daemon (or runner) where process I/O is already used.
 */

/** Well-known default ports stripped from the key (maintainer-ratified #313). */
const WELL_KNOWN_PORTS = new Set(["22", "80", "443", "9418"]);

/**
 * Strip userinfo (embedded credentials) from a git fetch URL for safe storage
 * and display. Returns `scheme://host[:port]/path` without username/password.
 *
 * scp-like forms (`git@host:path`) are returned unchanged — `git@` is the SSH
 * user, not a secret token. When the URL has no userinfo, the original string
 * is returned so the exact configured form is preserved.
 *
 * @example
 * stripFetchUrlCredentials("https://x-access-token:ghp_x@github.com/org/repo.git")
 * // → "https://github.com/org/repo.git"
 * stripFetchUrlCredentials("git@github.com:org/repo.git")
 * // → "git@github.com:org/repo.git"
 */
export function stripFetchUrlCredentials(raw: string): string {
  const url = raw.trim();
  if (url === "") return url;

  // scp-like / bare paths: no URL userinfo segment to strip.
  if (!hasUrlScheme(url)) {
    return url;
  }

  try {
    const gitPlus = /^git\+/i.test(url);
    const candidate = gitPlus ? url.replace(/^git\+/i, "") : url;
    const parsed = new URL(candidate);
    if (parsed.username === "" && parsed.password === "") {
      // No credentials — keep the caller's exact string (spacing/case of scheme).
      return url;
    }

    const scheme = parsed.protocol; // e.g. "https:"
    let host = parsed.hostname;
    // Node may return IPv6 hostname with or without brackets; always bracket for re-emit.
    if (host.includes(":") && !host.startsWith("[")) {
      host = `[${host}]`;
    }
    const port = parsed.port !== "" ? `:${parsed.port}` : "";
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    let out = `${scheme}//${host}${port}${path}`;
    if (gitPlus) out = `git+${out}`;
    return out;
  } catch {
    return url;
  }
}

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

  // scp-like SSH: git@host:path, user@[ipv6]:path — not scheme:// and not C:\…
  if (!hasUrlScheme(url) && !/^[A-Za-z]:[\\/]/.test(url)) {
    const scp = parseScpLike(url);
    if (scp !== null) {
      return foldKey(scp.host, scp.path, null);
    }
  }

  // URL forms: https://, http://, ssh://, git+ssh://, git+https://, git://, …
  try {
    const candidate = url.replace(/^git\+/i, "");
    const parsed = new URL(candidate);
    if (parsed.protocol === "file:") return null;
    const host = parsed.hostname;
    if (!host) return null;
    const pathPart = (parsed.pathname ?? "").replace(/^\/+/, "");
    const port = parsed.port !== "" ? parsed.port : null;
    return foldKey(host, pathPart, port);
  } catch {
    return null;
  }
}

/** True when the string begins with a URI scheme (`https://`, `ssh://`, …). */
function hasUrlScheme(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url);
}

/**
 * Parse scp-like `user@host:path` with bracket-aware IPv6 hosts.
 * e.g. `git@github.com:org/repo.git`, `git@[2001:db8::1]:org/repo.git`.
 */
function parseScpLike(url: string): { host: string; path: string } | null {
  const at = url.indexOf("@");
  if (at <= 0) return null;
  const rest = url.slice(at + 1);
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return null;
    const host = rest.slice(1, close);
    if (rest[close + 1] !== ":") return null;
    const path = rest.slice(close + 2);
    if (host === "" || path === "") return null;
    return { host, path };
  }
  // hostname cannot contain unbracketed colons (IPv6 must be bracketed).
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const host = rest.slice(0, colon);
  const path = rest.slice(colon + 1);
  if (host === "" || path === "" || host.includes("/")) return null;
  return { host, path };
}

/**
 * Fold host + path [+ non-default port] into the canonical key:
 * lowercased `host[/port]/path` with trailing `.git` stripped, duplicate
 * slashes collapsed, and percent-encoding decoded so SSH and HTTPS forms match.
 */
function foldKey(
  host: string,
  pathPart: string,
  port: string | null,
): string | null {
  let h = host.trim();
  // Strip IPv6 brackets for a stable key (scp and ssh:// both land here).
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  h = h.toLowerCase();
  if (h === "") return null;

  // Keep non-well-known ports so host:8443 is distinct from host.
  if (port !== null && port !== "" && !WELL_KNOWN_PORTS.has(port)) {
    h = `${h}:${port}`;
  }

  const p = normalizePathForKey(pathPart);
  if (p === "") return null;

  return `${h}/${p}`;
}

/**
 * Path side of the key: unify separators, collapse //, percent-decode so
 * scp raw bytes and URL-encoded paths fold together, strip trailing .git.
 */
function normalizePathForKey(pathPart: string): string {
  let p = pathPart.replace(/\\/g, "/");
  // Collapse duplicate slashes (org//repo → org/repo).
  p = p.replace(/\/+/g, "/");
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");

  // Decode percent-encoding so HTTPS (`%20`) and scp (raw space) match.
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed % sequences — keep as-is rather than failing the whole key.
  }

  if (p.toLowerCase().endsWith(".git")) {
    p = p.slice(0, -".git".length);
  }
  p = p.replace(/\/+$/, "");
  return p.toLowerCase();
}
