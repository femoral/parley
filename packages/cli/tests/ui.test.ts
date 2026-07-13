import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupHome, makeHome, readDiscovery, runCli } from "./helpers.js";

let home: string;
const scratchDirs: string[] = [];

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The real `@useparley/ui` package directory — its Vite-built `www/` bundle
 * proves the discovery + serving path end-to-end against the actual package,
 * not a synthetic fixture (#64/#65 acceptance criterion). The bundle is built on
 * demand by the vitest global setup when missing. */
const REAL_UI_PACKAGE_DIR = fileURLToPath(new URL("../../ui", import.meta.url));

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ui-test-"));
  scratchDirs.push(dir);
  return dir;
}

/** Symlink `home/node_modules/<name>` to `target` — simulates an npm install. */
function installPackage(name: string, target: string): void {
  const nodeModules = path.join(home, "node_modules", ...name.split("/").slice(0, -1));
  fs.mkdirSync(nodeModules, { recursive: true });
  fs.symlinkSync(target, path.join(home, "node_modules", name), "dir");
}

/**
 * Build a minimal marker package (`package.json` + `parley.ui` dir) in a fresh
 * dir. Deliberately carries an `exports` map that does NOT list
 * `./package.json`: the spec's marker convention doesn't require that export,
 * so discovery must still read the marker through exports encapsulation.
 */
function buildMarkerPackage(name: string, indexBody: string): string {
  const dir = scratchDir();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, exports: {}, parley: { ui: "dist" } }, null, 2),
  );
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), indexBody);
  return dir;
}

function writeConfig(config: unknown): void {
  fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify(config, null, 2));
}

/**
 * Start the daemon (spawns lazily) and return its base URL. Clears `NODE_PATH`
 * for the spawn: the test runner (vitest's fork pool) sets it to its own
 * dependency chain, which happens to include pnpm's workspace virtual store —
 * and Node's module resolution always consults `NODE_PATH` as a fallback, even
 * with an explicit `paths` override, so an inherited value would leak every
 * workspace package (including the real `@useparley/ui`) into discovery
 * regardless of what a test actually installed. No real deployment sets
 * `NODE_PATH` to a monorepo's pnpm store, so this only strips a test-harness
 * artifact, not a real discovery path.
 */
async function startDaemon(): Promise<string> {
  const res = await runCli(["daemon", "start"], home, { extraEnv: { NODE_PATH: "" } });
  expect(res.code).toBe(0);
  const discovery = readDiscovery(home);
  if (!discovery) throw new Error("daemon did not publish discovery");
  return `http://127.0.0.1:${discovery.port}`;
}

describe("UI bundle serving and discovery (#64)", () => {
  it("nothing installed: no new routes, daemon behaves exactly as today", async () => {
    const base = await startDaemon();

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(404);
    expect((await root.json()) as { error: string }).toMatchObject({ error: "not_found" });

    // Existing API routes are unaffected.
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const tasks = await fetch(`${base}/tasks`);
    expect(tasks.status).toBe(200);
  });

  it("marker package found (default @useparley/ui): served at root with SPA fallback; API routes never shadowed", async () => {
    installPackage("@useparley/ui", REAL_UI_PACKAGE_DIR);
    const base = await startDaemon();

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toMatch(/text\/html/);
    const rootBody = await root.text();
    // The real Parley Cove cockpit shell (#65), not a placeholder.
    expect(rootBody).toContain("Parley Cove");

    // SPA fallback: an unknown client-side route still resolves to index.html.
    const spaRoute = await fetch(`${base}/some/deep/route/abc123`);
    expect(spaRoute.status).toBe(200);
    expect(await spaRoute.text()).toBe(rootBody);

    // A real (hashed) bundle asset referenced by index.html is served — not just
    // the SPA fallback — with a sane content type. Discover its URL from the
    // built HTML so the assertion doesn't hard-code a content hash.
    const scriptSrc = /<script[^>]+src="([^"]+\.js)"/.exec(rootBody)?.[1];
    expect(scriptSrc).toBeTruthy();
    const asset = await fetch(`${base}${scriptSrc}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    // The served asset is the JS bundle, not the HTML fallback.
    expect(await asset.text()).not.toContain("<!doctype html>");

    // API routes are never shadowed by the SPA fallback.
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()) as { status: string }).toMatchObject({ status: "ok" });
    const tasks = await fetch(`${base}/tasks`);
    expect(tasks.status).toBe(200);
    const unknownTask = await fetch(`${base}/tasks/does-not-exist`);
    expect(unknownTask.status).toBe(404);

    // Path traversal cannot escape the bundle dir — falls back to index.html
    // rather than leaking a host file.
    const traversal = await fetch(`${base}/..%2f..%2f..%2f..%2fetc%2fpasswd`);
    expect(traversal.status).toBe(200);
    expect(await traversal.text()).toBe(rootBody);
  });

  it("discovery order: explicit config path wins over config package and default", async () => {
    // All three tiers resolvable at once; the explicit path must win.
    installPackage("@useparley/ui", REAL_UI_PACKAGE_DIR);
    const customDir = buildMarkerPackage("@useparley/custom-ui", "<html>custom package bundle</html>");
    installPackage("@useparley/custom-ui", customDir);
    const explicitDir = buildMarkerPackage("unused-name", "<html>explicit path bundle</html>");
    writeConfig({ ui: { path: explicitDir + "/dist", package: "@useparley/custom-ui" } });

    const base = await startDaemon();
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toBe("<html>explicit path bundle</html>");
  });

  it("discovery order: config package wins over the default package", async () => {
    installPackage("@useparley/ui", REAL_UI_PACKAGE_DIR);
    const customDir = buildMarkerPackage("@useparley/custom-ui", "<html>custom package bundle</html>");
    installPackage("@useparley/custom-ui", customDir);
    writeConfig({ ui: { package: "@useparley/custom-ui" } });

    const base = await startDaemon();
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toBe("<html>custom package bundle</html>");
  });

  it("a corrupt parley.json never bricks the daemon: it starts UI-less and serves the API", async () => {
    installPackage("@useparley/ui", REAL_UI_PACKAGE_DIR);
    fs.writeFileSync(path.join(home, "parley.json"), "{ not json");

    const base = await startDaemon();
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    // Discovery failed loudly-but-gracefully: no UI is served.
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(404);
  });

  it("a symlink inside the bundle cannot serve a file outside it", async () => {
    const outside = scratchDir();
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "top secret");
    const bundlePkg = buildMarkerPackage("unused-name", "<html>bundle</html>");
    fs.symlinkSync(secret, path.join(bundlePkg, "dist", "leak.txt"));
    writeConfig({ ui: { path: path.join(bundlePkg, "dist") } });

    const base = await startDaemon();
    const leak = await fetch(`${base}/leak.txt`);
    // Served the SPA fallback, not the symlink target.
    expect(leak.status).toBe(200);
    expect(await leak.text()).toBe("<html>bundle</html>");
  });
});
