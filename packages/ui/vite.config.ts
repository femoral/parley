import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, type ProxyOptions } from "vite";
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
  const routes = ["/tasks", "/events", "/metrics", "/sessions", "/health"];
  return Object.fromEntries(routes.map((route) => [route, { target }]));
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
 */
export default defineConfig(() => {
  const proxy = daemonProxy();
  return {
    plugins: [react()],
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
