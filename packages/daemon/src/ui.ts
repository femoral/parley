import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, type HomePaths } from "@useparley/core";

/**
 * Optional UI bundle serving and discovery (`docs/spec/ui-interface-contract.md`
 * §"Serving convention", #64). No JS from the UI package ever executes inside
 * the daemon process — this module only locates and serves a static directory.
 */

/** API path prefixes the UI's SPA fallback must never shadow (spec list). */
const RESERVED_PREFIXES = new Set([
  "tasks",
  "events",
  "health",
  "clean",
  "mcp",
  "sessions",
  "child",
  "runner",
  "config",
  "metrics",
]);

export function isReservedPath(firstSegment: string | undefined): boolean {
  return firstSegment !== undefined && RESERVED_PREFIXES.has(firstSegment);
}

/** The default UI package name, tried when config sets neither `ui.path` nor `ui.package`. */
const DEFAULT_UI_PACKAGE = "@useparley/ui";

/**
 * Locate a package's `package.json` starting from `base` (spec: "resolved via
 * `createRequire` from the parley home dir, then from the daemon package
 * itself"). `createRequire` is primary; when it fails — most commonly
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, since a package with an `exports` map that
 * doesn't list `./package.json` blocks the subpath even though the file
 * exists — fall back to walking `base`'s `node_modules` ancestry directly.
 * The spec's marker convention doesn't require exporting `./package.json`, so
 * exports encapsulation must not hide an otherwise valid UI package.
 */
function resolvePackageJson(pkgName: string, base: string): string | null {
  try {
    // `createRequire` only uses the filename's directory to seed resolution;
    // the file need not exist.
    const req = createRequire(path.join(base, "__parley_ui_resolution__.js"));
    return req.resolve(`${pkgName}/package.json`);
  } catch {
    // Manual node_modules walk, mirroring Node's directory ancestry.
    for (let dir = base; ; ) {
      const candidate = path.join(dir, "node_modules", ...pkgName.split("/"), "package.json");
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here; keep walking up.
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

/**
 * Read a package's `parley.ui` marker (spec §"Package marker") and resolve it
 * to an absolute bundle directory, trying each `base` in order. Returns null
 * if the package isn't resolvable from any base, or resolves but carries no
 * (or an empty) marker.
 */
function resolvePackageBundleDir(pkgName: string, bases: string[]): string | null {
  for (const base of bases) {
    const pkgJsonPath = resolvePackageJson(pkgName, base);
    if (pkgJsonPath === null) continue;
    let pkgJson: unknown;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    } catch {
      continue;
    }
    const marker =
      typeof pkgJson === "object" && pkgJson !== null
        ? (pkgJson as { parley?: { ui?: unknown } }).parley?.ui
        : undefined;
    if (typeof marker === "string" && marker !== "") {
      return path.resolve(path.dirname(pkgJsonPath), marker);
    }
    // Resolved but no usable marker — not a UI-serving package. Don't fall
    // through to the next base for the *same* package name; a package that
    // exists without the marker is a configuration mistake, not "not found".
    return null;
  }
  return null;
}

/** Bundle directories are only a hit when they actually hold an `index.html`. */
function hasIndex(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "index.html")).isFile();
  } catch {
    return false;
  }
}

/**
 * Discover the UI bundle directory to serve at `/`, per the spec's three-tier
 * order (first hit wins): explicit config path, config package name, then the
 * `@useparley/ui` default. Package names resolve from the parley home dir
 * first, then from this daemon package's own location (so a sibling install
 * next to the daemon is also found). Returns null when nothing hits — the
 * daemon must then behave exactly as it does with no UI installed.
 */
export function discoverUiBundle(paths: HomePaths): string | null {
  const config = readConfig(paths.config);
  const daemonBase = path.dirname(fileURLToPath(import.meta.url));
  const bases = [paths.home, daemonBase];

  const dir = config.ui?.path
    ? path.resolve(paths.home, config.ui.path)
    : resolvePackageBundleDir(config.ui?.package ?? DEFAULT_UI_PACKAGE, bases);
  return dir !== null && hasIndex(dir) ? dir : null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function sendFile(res: http.ServerResponse, file: string): void {
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": contentTypeFor(file),
    "content-length": body.length,
  });
  res.end(body);
}

/**
 * Serve one request out of `bundleDir` (spec §"Routes"): the exact file when
 * `pathname` maps to one inside the bundle, else the SPA fallback
 * (`index.html`) — so client-side routes resolve on a hard reload. `pathname`
 * is resolved and bounds-checked against `bundleDir` before any filesystem
 * access — first lexically (`..` segments), then by real path (`realpathSync`),
 * so neither a `..`-laden path nor a symlink planted inside the bundle can
 * reach a file outside it. An escape attempt is treated the same as "unknown
 * path" (serves the fallback).
 */
export function serveUiRequest(bundleDir: string, res: http.ServerResponse, pathname: string): void {
  const indexPath = path.join(bundleDir, "index.html");
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendFile(res, indexPath);
    return;
  }
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.normalize(path.join(bundleDir, relative));
  if (isWithin(bundleDir, candidate)) {
    try {
      // Re-check against real paths: statSync/readFileSync follow symlinks, so
      // the lexical bound alone would let `assets/evil -> /outside/secret`
      // serve a file outside the bundle.
      const realCandidate = fs.realpathSync(candidate);
      if (
        isWithin(fs.realpathSync(bundleDir), realCandidate) &&
        fs.statSync(realCandidate).isFile()
      ) {
        sendFile(res, realCandidate);
        return;
      }
    } catch {
      // Falls through to the SPA fallback below.
    }
  }
  sendFile(res, indexPath);
}

/** True when `candidate` is `dir` itself or lexically inside it. */
function isWithin(dir: string, candidate: string): boolean {
  return candidate === dir || candidate.startsWith(dir + path.sep);
}
