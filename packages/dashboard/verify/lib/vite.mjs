/**
 * Ephemeral Vite dev server for the dashboard package.
 * Proxies API routes to the harness daemon via VITE_DAEMON_URL.
 */
import path from "node:path";
import { createServer } from "vite";
import { DASHBOARD_ROOT } from "./paths.mjs";

/**
 * @param {object} opts
 * @param {string} opts.daemonUrl  e.g. http://127.0.0.1:PORT
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startDashboardVite(opts) {
  const prev = process.env.VITE_DAEMON_URL;
  process.env.VITE_DAEMON_URL = opts.daemonUrl;

  const server = await createServer({
    root: DASHBOARD_ROOT,
    configFile: path.join(DASHBOARD_ROOT, "vite.config.ts"),
    logLevel: "error",
    server: {
      port: 0,
      strictPort: false,
      // Host loopback only — local harness, not a shared surface.
      host: "127.0.0.1",
    },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) {
    await server.close();
    throw new Error("vite did not report a local URL");
  }

  return {
    url: url.replace(/\/$/, ""),
    async close() {
      await server.close();
      if (prev === undefined) delete process.env.VITE_DAEMON_URL;
      else process.env.VITE_DAEMON_URL = prev;
    },
  };
}
