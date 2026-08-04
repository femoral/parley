import fs from "node:fs";
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
 *  - Browser shims for `node:path` / `node:os` — see alias block below (#330).
 */
export default defineConfig(() => {
  const proxy = daemonProxy();
  const shimDir = path.resolve(import.meta.dirname, "src/shims");
  // Vitest inherits this config; keep real Node path/os for test filesystem
  // helpers (resolve/readFileSync). Shims are for the browser client only.
  const isVitest = process.env.VITEST === "true";
  return {
    plugins: [react(), stripWoffFallback(), preloadCriticalFonts()],
    base: "/",
    resolve: {
      // Work around: incomplete tree-shaking of `@useparley/core` lets Node
      // builtins (`path`/`os`, e.g. top-level `join` in vendor-home) leak into
      // the browser client bundle and crash production Cove at boot. These
      // aliases redirect to tiny browser shims under `src/shims/`. Proper
      // core-side fix tracked as GitHub issue #330 — do not remove until
      // that lands; do not attempt the core fix from packages/ui.
      alias: isVitest
        ? []
        : [
            { find: /^node:path$/, replacement: path.join(shimDir, "path.ts") },
            { find: /^path$/, replacement: path.join(shimDir, "path.ts") },
            { find: /^node:os$/, replacement: path.join(shimDir, "os.ts") },
            { find: /^os$/, replacement: path.join(shimDir, "os.ts") },
          ],
    },
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
