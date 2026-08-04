import fs from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev/preview proxy target — the local daemon, autodiscovered the same way
 * the CLI finds it (core `home.ts` + daemon discovery contract): the
 * `PARLEY_HOME` override or `~/.parley`, then `daemon.json` (`{ port, pid }`)
 * with a `kill(pid, 0)` liveness probe so a stale file from a dead daemon is
 * ignored. `VITE_DAEMON_URL` short-circuits discovery (e.g. a PARLEY_HOME
 * test daemon or a remote instance). Read once at config load; restart the
 * dev server after restarting the daemon (its port is ephemeral).
 */
function discoverDaemon(): string | undefined {
  const explicit = process.env.VITE_DAEMON_URL;
  if (explicit && explicit.trim() !== "") return explicit.trim();
  const override = process.env.PARLEY_HOME;
  const home =
    override && override.trim() !== "" ? path.resolve(override) : path.join(os.homedir(), ".parley");
  let discovery: unknown;
  try {
    discovery = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof discovery !== "object" || discovery === null) return undefined;
  const { port, pid } = discovery as Record<string, unknown>;
  if (!Number.isInteger(port) || !Number.isInteger(pid)) return undefined;
  try {
    process.kill(pid as number, 0);
  } catch (err) {
    // EPERM = alive but foreign-owned (still a live daemon); ESRCH = stale.
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * The cockpit client is same-origin (`ParleyClient({ baseUrl: "" })`), so in
 * dev every API prefix the SDK uses is forwarded to the daemon. `/events`
 * carries the SSE stream — http-proxy passes it through unbuffered.
 */
function daemonProxy(): Record<string, ProxyOptions> | undefined {
  const target = discoverDaemon();
  if (!target) {
    console.warn(
      "[parley-cove] no running daemon discovered (daemon.json absent or stale) — " +
        "the cockpit will show its offline states. Start one with `parley daemon start`, " +
        "or set VITE_DAEMON_URL.",
    );
    return undefined;
  }
  console.info(`[parley-cove] proxying API to daemon at ${target}`);
  // /runs and /deliverables power the run roster, inspector run view, chart
  // surface, and deliverable rendering (#266). Without them the whole run
  // surface is silent against a local daemon.
  const routes = [
    "/tasks",
    "/events",
    "/metrics",
    "/sessions",
    "/health",
    "/runs",
    "/deliverables",
    // Executor fleet for the Cove executors panel (#324).
    "/runners",
  ];
  return Object.fromEntries(routes.map((route) => [route, { target }]));
}

/**
 * Drop `.woff` fallbacks from the published package. Every browser capable of
 * running this app (React 19, container queries, `:has()`, `color-mix()`) will
 * request the `.woff2` listed first in each `@font-face` — shipping 500KB+ of
 * never-downloaded `.woff` only bloats the npm tarball. CSS `src` entries that
 * pointed at deleted files are stripped so no dangling URLs remain.
 */
function stripWoffFallback(): Plugin {
  return {
    name: "parley-cove-strip-woff",
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        // `.woff` but not `.woff2`
        if (fileName.endsWith(".woff")) delete bundle[fileName];
      }
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== "asset" || !fileName.endsWith(".css")) continue;
        const source =
          typeof item.source === "string"
            ? item.source
            : new TextDecoder().decode(item.source);
        // Vite emits: url(/assets/foo.woff) format("woff") after the woff2 entry.
        item.source = source.replace(
          /,\s*url\([^)]+\.woff\)\s*format\(["']woff["']\)/g,
          "",
        );
      }
    },
  };
}

/**
 * Preload the two critical latin faces (Cinzel 700 for panel titles, Outfit 500
 * for prose) so they start fetching before CSS is parsed — kills the FOUT on
 * first paint. Other faces stay lazily discovered via `@font-face`.
 *
 * Font files are content-hashed by Vite, so hrefs are resolved from the build
 * bundle (or the unhashed source path in dev) rather than hard-coded.
 */
function preloadCriticalFonts(): Plugin {
  /** Unhashed basenames that Vite fingerprints into `assets/`. */
  const CRITICAL = [
    "cinzel-latin-700-normal",
    "outfit-latin-500-normal",
  ] as const;

  return {
    name: "parley-cove-preload-critical-fonts",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const hrefs: string[] = [];
        if (ctx.bundle) {
          for (const fileName of Object.keys(ctx.bundle)) {
            if (!fileName.endsWith(".woff2")) continue;
            // Match latin (not latin-ext) critical faces by fingerprint stem.
            const base = fileName.split("/").pop() ?? fileName;
            if (
              CRITICAL.some(
                (name) =>
                  base.startsWith(`${name}-`) || base === `${name}.woff2`,
              )
            ) {
              // `base: "/"` — absolute asset URLs match the SPA origin root.
              hrefs.push(`/${fileName}`);
            }
          }
          hrefs.sort();
        } else {
          // Dev server: unhashed files from @fontsource packages.
          hrefs.push(
            "/node_modules/@fontsource/cinzel/files/cinzel-latin-700-normal.woff2",
            "/node_modules/@fontsource/outfit/files/outfit-latin-500-normal.woff2",
          );
        }

        // head-prepend so the browser starts fetching before CSS/JS parse.
        const tags = hrefs.map((href) => ({
          tag: "link" as const,
          attrs: {
            rel: "preload",
            href,
            as: "font",
            type: "font/woff2",
            crossorigin: "",
          },
          injectTo: "head-prepend" as const,
        }));
        return tags;
      },
    },
  };
}

/** Bare Node builtin names (no `node:` prefix), plus their `node:` forms. */
const NODE_BUILTIN_IDS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => (m.startsWith("node:") ? m : `node:${m}`)),
]);

/**
 * Fail the production client build if any Node builtin would enter the graph.
 *
 * `@useparley/core` exposes a node-free barrel under the `"browser"` export
 * condition (#330). Soft externalization ("Module path has been externalized
 * for browser compatibility") used to ship a DOA cockpit; this turns the next
 * barrel leak into a hard build failure instead.
 *
 * Vitest inherits this config but does not run production `build` — tests may
 * still import `node:fs` / `node:path` for filesystem fixtures.
 */
export function rejectNodeBuiltinsInClient(): Plugin {
  return {
    name: "parley-cove-reject-node-builtins",
    apply: "build",
    enforce: "pre",
    resolveId(id, importer) {
      if (id.startsWith("\0")) return;
      // Ignore deep imports of packages that happen to start with a builtin name.
      const bare = id.startsWith("node:") ? id.slice("node:".length) : id;
      if (bare.includes("/") || bare.includes("\\")) return;
      if (!NODE_BUILTIN_IDS.has(id) && !NODE_BUILTIN_IDS.has(bare)) return;
      const from = importer ? ` (imported by ${importer})` : "";
      return this.error(
        `[parley-cove] Node builtin "${id}" must not enter the browser bundle${from}. ` +
          "Import only browser-safe exports from @useparley/core " +
          "(packages/core/src/browser.ts); host-only modules belong on the daemon/CLI.",
      );
    },
  };
}

/**
 * Parley Cove build. The daemon serves the emitted bundle at `/` via the
 * `parley.ui` discovery marker (which points at `www`), so:
 *  - `outDir: "www"` puts the build exactly where discovery looks (#64/#65).
 *  - `base: "/"` — the cockpit mounts at the origin root and the SPA fallback
 *    re-serves `index.html` for deep routes, so absolute `/assets/*` URLs
 *    resolve on a hard reload of any client-side route.
 *  - Fonts are self-hosted (`@fontsource`, imported from `src`); Vite fingerprints
 *    the woff2 into `www/assets`. Nothing is ever fetched from a CDN at runtime.
 *  - `.woff` fallbacks are stripped at emit time (see {@link stripWoffFallback}).
 *  - Critical faces are preloaded into `index.html` (see {@link preloadCriticalFonts}).
 *  - Node builtins in the client graph fail the build (see
 *    {@link rejectNodeBuiltinsInClient}) — #330.
 */
export default defineConfig(() => {
  const proxy = daemonProxy();
  return {
    plugins: [
      react(),
      stripWoffFallback(),
      preloadCriticalFonts(),
      rejectNodeBuiltinsInClient(),
    ],
    base: "/",
    server: { proxy },
    preview: { proxy },
    build: {
      outDir: "www",
      emptyOutDir: true,
      // Cockpit chrome + fonts fit comfortably; keep the warning honest.
      chunkSizeWarningLimit: 900,
    },
  };
});
