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
 * ignored. `VITE_DAEMON_URL` short-circuits discovery.
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
 * Same-origin client (`ParleyClient({ baseUrl: "" })`), so in dev every API
 * prefix the SDK uses is forwarded to the daemon. `/events` carries the SSE
 * stream — http-proxy passes it through unbuffered.
 */
function daemonProxy(): Record<string, ProxyOptions> | undefined {
  const target = discoverDaemon();
  if (!target) {
    console.warn(
      "[parley-console] no running daemon discovered (daemon.json absent or stale) — " +
        "the console will show its offline states. Start one with `parley daemon start`, " +
        "or set VITE_DAEMON_URL.",
    );
    return undefined;
  }
  console.info(`[parley-console] proxying API to daemon at ${target}`);
  const routes = [
    "/tasks",
    "/events",
    "/metrics",
    "/sessions",
    "/health",
    "/runs",
    "/deliverables",
    "/runners",
  ];
  return Object.fromEntries(routes.map((route) => [route, { target }]));
}

/** Bare Node builtin names (no `node:` prefix), plus their `node:` forms. */
const NODE_BUILTIN_IDS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => (m.startsWith("node:") ? m : `node:${m}`)),
]);

/**
 * Fail the production client build if any Node builtin would enter the graph.
 * Soft externalization used to ship a DOA client; this turns the next leak
 * into a hard build failure instead. Mirrors packages/ui (#330).
 */
export function rejectNodeBuiltinsInClient(): Plugin {
  return {
    name: "parley-console-reject-node-builtins",
    apply: "build",
    enforce: "pre",
    resolveId(id, importer) {
      if (id.startsWith("\0")) return;
      const bare = id.startsWith("node:") ? id.slice("node:".length) : id;
      if (bare.includes("/") || bare.includes("\\")) return;
      if (!NODE_BUILTIN_IDS.has(id) && !NODE_BUILTIN_IDS.has(bare)) return;
      const from = importer ? ` (imported by ${importer})` : "";
      return this.error(
        `[parley-console] Node builtin "${id}" must not enter the browser bundle${from}. ` +
          "Import only browser-safe exports from @useparley/core " +
          "(packages/core/src/browser.ts); host-only modules belong on the daemon/CLI.",
      );
    },
  };
}

/**
 * Preload the critical latin faces (Sans 500 body, Mono 500 data) so they
 * start fetching before CSS is parsed. Fonts live in `public/fonts/` and are
 * served at `/fonts/*` (no content-hash; stable paths for offline daemon serve).
 */
function preloadCriticalFonts(): Plugin {
  const CRITICAL = [
    "/fonts/ibm-plex-sans-latin-500-normal.woff2",
    "/fonts/ibm-plex-mono-latin-500-normal.woff2",
  ] as const;

  return {
    name: "parley-console-preload-critical-fonts",
    transformIndexHtml: {
      order: "post",
      handler() {
        return CRITICAL.map((href) => ({
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
      },
    },
  };
}

/**
 * Parley Console build. The daemon serves the emitted bundle at `/` via the
 * `parley.ui` discovery marker (which points at `www`), so:
 *  - `outDir: "www"` puts the build exactly where discovery looks.
 *  - `base: "/"` — mounts at the origin root; SPA fallback re-serves
 *    `index.html` for deep routes.
 *  - Fonts are self-hosted under `public/fonts/` (no CDN at runtime).
 *  - Node builtins in the client graph fail the build.
 */
export default defineConfig(() => {
  const proxy = daemonProxy();
  return {
    plugins: [react(), preloadCriticalFonts(), rejectNodeBuiltinsInClient()],
    base: "/",
    server: { proxy },
    preview: { proxy },
    build: {
      outDir: "www",
      emptyOutDir: true,
      chunkSizeWarningLimit: 900,
    },
  };
});
