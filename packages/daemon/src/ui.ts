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
  "runs",
  "events",
  "health",
  "clean",
  "mcp",
  "sessions",
  "child",
  "runner",
  "config",
  "metrics",
  "prompt",
  "gc",
]);

export function isReservedPath(firstSegment: string | undefined): boolean {
  return firstSegment !== undefined && RESERVED_PREFIXES.has(firstSegment);
}

/**
 * Config-less default probe order (#348 / ADR-0033): try the console first,
 * then Cove. First package with a usable `parley.ui` marker wins. Neither is
 * a daemon dependency — optional installs only.
 */
const DEFAULT_UI_PACKAGES = ["@useparley/dashboard", "@useparley/ui"] as const;

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
 * Outcome of resolving one package name against the discovery bases.
 *
 * - `hit` — usable marker and built bundle (`index.html` present)
 * - `not_found` — package not installed; only this advances the default probe
 * - `marker_less` / `unbuilt` / `unparseable` — package resolved but is a
 *   configuration mistake for that name: stop the probe, do not fall through
 *   (#361 / ADR-0033)
 */
type PackageBundleResult =
  | { kind: "hit"; dir: string }
  | { kind: "not_found" }
  | { kind: "marker_less"; package: string; path: string }
  | { kind: "unbuilt"; package: string; path: string }
  | { kind: "unparseable"; package: string; path: string };

/** Bundle directories are only a hit when they actually hold an `index.html`. */
function hasIndex(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "index.html")).isFile();
  } catch {
    return false;
  }
}

/**
 * One loud startup line when discovery stops on a resolved package (or path)
 * rather than serving a UI. Names package, reason, and the path inspected so
 * "why is there no UI" is answerable from the daemon log (#361).
 */
function logUiDiscoveryStop(args: {
  package?: string;
  reason: "marker_less" | "unbuilt" | "unparseable" | "path_unbuilt";
  path: string;
}): void {
  const reasons: Record<typeof args.reason, string> = {
    marker_less: "no usable parley.ui marker",
    unbuilt: "marker present but bundle has no index.html",
    unparseable: "unparseable package.json",
    path_unbuilt: "config.ui.path has no index.html",
  };
  const pkg = args.package !== undefined ? `package ${args.package}` : "config.ui.path";
  process.stderr.write(
    `parley daemon: UI discovery stopped: ${pkg}: ${reasons[args.reason]} (inspected ${args.path})\n`,
  );
}

/**
 * Read a package's `parley.ui` marker (spec §"Package marker") and resolve it
 * to an absolute bundle directory, trying each `base` in order. Index existence
 * is part of the per-name verdict so "unbuilt" is distinguishable from a hit
 * and from not-found (#361).
 */
function resolvePackageBundle(pkgName: string, bases: string[]): PackageBundleResult {
  for (const base of bases) {
    const pkgJsonPath = resolvePackageJson(pkgName, base);
    if (pkgJsonPath === null) continue;
    let pkgJson: unknown;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    } catch {
      // Resolved but unreadable/unparseable — config mistake for this name;
      // do not try the next base or fall through to the next default (#361).
      return { kind: "unparseable", package: pkgName, path: pkgJsonPath };
    }
    const marker =
      typeof pkgJson === "object" && pkgJson !== null
        ? (pkgJson as { parley?: { ui?: unknown } }).parley?.ui
        : undefined;
    if (typeof marker === "string" && marker !== "") {
      const dir = path.resolve(path.dirname(pkgJsonPath), marker);
      if (!hasIndex(dir)) {
        return { kind: "unbuilt", package: pkgName, path: dir };
      }
      return { kind: "hit", dir };
    }
    // Resolved but no usable marker — not a UI-serving package. Don't fall
    // through to the next base for the *same* package name; a package that
    // exists without the marker is a configuration mistake, not "not found".
    return { kind: "marker_less", package: pkgName, path: pkgJsonPath };
  }
  return { kind: "not_found" };
}

/**
 * Apply a per-name package result: hit → dir; not_found → null without log;
 * any stop kind → one log line and null.
 */
function finishPackageResult(result: PackageBundleResult): string | null {
  if (result.kind === "hit") return result.dir;
  if (result.kind === "not_found") return null;
  logUiDiscoveryStop({
    package: result.package,
    reason: result.kind,
    path: result.path,
  });
  return null;
}

/**
 * Config-less default: probe {@link DEFAULT_UI_PACKAGES} in order. A stop
 * outcome on any probed name ends the chain (config mistake per name); only
 * `not_found` advances to the next default (#361 / ADR-0033).
 */
function resolveDefaultUiBundle(bases: string[]): string | null {
  for (const pkg of DEFAULT_UI_PACKAGES) {
    const result = resolvePackageBundle(pkg, bases);
    if (result.kind === "hit") return result.dir;
    if (result.kind === "not_found") continue;
    return finishPackageResult(result);
  }
  return null;
}

/**
 * Discover the UI bundle directory to serve at `/`, per the ordered
 * discovery chain (first hit wins): explicit config path, config package
 * name, then the config-less defaults `@useparley/dashboard` →
 * `@useparley/ui` (#348 / ADR-0033). Package names resolve from the parley
 * home dir first, then from this daemon package's own location (so a sibling
 * install next to the daemon is also found). Returns null when nothing hits
 * — the daemon must then behave exactly as it does with no UI installed.
 *
 * Stop cases (marker-less, unbuilt, unparseable) emit one stderr line naming
 * the package, reason, and inspected path (#361). Genuine not-found is silent
 * and advances the default probe.
 */
export function discoverUiBundle(paths: HomePaths): string | null {
  const config = readConfig(paths.config);
  const daemonBase = path.dirname(fileURLToPath(import.meta.url));
  const bases = [paths.home, daemonBase];

  if (config.ui?.path) {
    const dir = path.resolve(paths.home, config.ui.path);
    if (hasIndex(dir)) return dir;
    logUiDiscoveryStop({ reason: "path_unbuilt", path: dir });
    return null;
  }
  if (config.ui?.package) {
    return finishPackageResult(resolvePackageBundle(config.ui.package, bases));
  }
  return resolveDefaultUiBundle(bases);
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
