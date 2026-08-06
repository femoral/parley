/**
 * Offline publish-readiness check for @useparley/dashboard (#359).
 *
 * Does NOT hit the npm registry (this machine's packed-install.smoke hits
 * ETIMEDOUT). Instead:
 *   1. vite-build the dashboard (www/)
 *   2. npm pack the package
 *   3. inspect the tarball (parley.ui marker → www, files→www only,
 *      publishConfig, version independence from daemon)
 *   4. extract into a scratch PARLEY_HOME node_modules and prove the real
 *      daemon discovers + serves the packed bundle (mirror of
 *      packages/cli/tests/ui.test.ts home shaping)
 *
 * Usage (from monorepo root or package dir):
 *   pnpm --filter @useparley/dashboard verify:packed
 *   node --import tsx packages/dashboard/verify/scripts/packed-install.mjs
 *
 * Exit 0 on pass; non-zero with a clear message on fail.
 * Writes a compact proof into verify/ledger/issue-359/packed-install.json
 * when the ledger dir exists or can be created.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CORE_ENTRY,
  DAEMON_SERVER_ENTRY,
  DASHBOARD_ROOT,
  LEDGER_ROOT,
  REPO_ROOT,
  relFromRepo,
} from "../lib/paths.mjs";

const TICKET = "issue-359";
const BUILD_TIMEOUT_MS = 300_000;

/** @param {string} msg */
function fail(msg) {
  console.error(`[packed-install] FAIL: ${msg}`);
  process.exit(1);
}

/** @param {string} msg */
function ok(msg) {
  console.log(`[packed-install] ok — ${msg}`);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 */
function run(cmd, args, cwd) {
  execFileSync(cmd, args, {
    cwd,
    stdio: "pipe",
    timeout: BUILD_TIMEOUT_MS,
    env: process.env,
  });
}

/**
 * List files inside a npm pack tarball (paths relative to package root).
 * @param {string} tgzPath
 * @returns {string[]}
 */
function listTarballFiles(tgzPath) {
  const out = execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ""));
}

/**
 * Extract tarball into dest (creates package contents directly under dest).
 * @param {string} tgzPath
 * @param {string} dest
 */
function extractTarball(tgzPath, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // npm pack always roots at package/; strip that prefix.
  run("tar", ["-xzf", tgzPath, "--strip-components=1", "-C", dest], dest);
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "parley-dash-packed-"));
  const proof = {
    kind: "packed-install",
    offline: true,
    steps: /** @type {Record<string, unknown>} */ ({}),
  };

  try {
    // --- 1. Build ---
    console.log("[packed-install] building @useparley/dashboard…");
    run("pnpm", ["--filter", "@useparley/dashboard", "build"], REPO_ROOT);
    const wwwIndex = path.join(DASHBOARD_ROOT, "www", "index.html");
    if (!fs.existsSync(wwwIndex)) fail("build did not produce www/index.html");
    ok("build → www/index.html");
    proof.steps.build = { wwwIndex: relFromRepo(wwwIndex) };

    // --- 2. Pack ---
    const packDest = path.join(scratch, "tarballs");
    fs.mkdirSync(packDest, { recursive: true });
    console.log("[packed-install] npm pack…");
    // npm pack (not pnpm pack): works offline for a local package with no
    // registry fetch of self; still writes the tarball next to packDest.
    const packOut = execFileSync("npm", ["pack", "--pack-destination", packDest], {
      cwd: DASHBOARD_ROOT,
      encoding: "utf8",
      timeout: BUILD_TIMEOUT_MS,
      env: { ...process.env, npm_config_cache: path.join(scratch, "npm-cache") },
    });
    const tgzName = packOut
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    if (!tgzName) fail("npm pack produced no tarball name");
    const tgzPath = path.isAbsolute(tgzName)
      ? tgzName
      : path.join(packDest, path.basename(tgzName));
    if (!fs.existsSync(tgzPath)) {
      // Some npm versions print only the basename.
      const alt = path.join(packDest, path.basename(tgzName));
      if (!fs.existsSync(alt)) fail(`tarball missing: ${tgzPath}`);
    }
    const resolvedTgz = fs.existsSync(tgzPath)
      ? tgzPath
      : path.join(packDest, path.basename(tgzName));
    ok(`packed ${path.basename(resolvedTgz)}`);
    proof.steps.pack = { tarball: path.basename(resolvedTgz) };

    // --- 3. Inspect package.json (source of truth for marker / files / publish) ---
    const pkg = JSON.parse(
      fs.readFileSync(path.join(DASHBOARD_ROOT, "package.json"), "utf8"),
    );
    const daemonPkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "packages/daemon/package.json"), "utf8"),
    );

    if (pkg.name !== "@useparley/dashboard") {
      fail(`unexpected package name ${pkg.name}`);
    }
    if (pkg.parley?.ui !== "www") {
      fail(`parley.ui marker must be "www", got ${JSON.stringify(pkg.parley?.ui)}`);
    }
    ok('parley.ui marker → "www"');

    const files = pkg.files;
    if (!Array.isArray(files) || !files.includes("www")) {
      fail(`files must include "www", got ${JSON.stringify(files)}`);
    }
    // Only the built bundle ships — no src/, verify/, tests/ in the publish set.
    const unexpectedFiles = files.filter((f) => f !== "www");
    if (unexpectedFiles.length > 0) {
      fail(`files should ship www only; also listed: ${unexpectedFiles.join(", ")}`);
    }
    ok('files → ["www"] only');

    if (pkg.publishConfig?.access !== "public") {
      fail(`publishConfig.access must be "public", got ${pkg.publishConfig?.access}`);
    }
    ok('publishConfig.access = "public"');

    if (typeof pkg.version !== "string" || pkg.version.length === 0) {
      fail("package version missing");
    }
    if (pkg.version === daemonPkg.version) {
      // Independence means the packages are free to diverge — same number is
      // accidental but allowed only if we still record they are separate
      // packages. Prefer a hard assert that versions are not *tied* by a
      // workspace protocol: dashboard is not a daemon dependency.
      // Soft check: versions currently differ (0.0.1 vs 0.0.4); if they ever
      // coincide, still pass versionIndependence as long as neither package
      // depends on the other's version.
      ok(
        `versions currently equal (${pkg.version}) — independence is package-graph, not number`,
      );
    } else {
      ok(`version independence: dashboard ${pkg.version} ≠ daemon ${daemonPkg.version}`);
    }
    const daemonDeps = {
      ...(daemonPkg.dependencies ?? {}),
      ...(daemonPkg.optionalDependencies ?? {}),
      ...(daemonPkg.peerDependencies ?? {}),
    };
    if (daemonDeps["@useparley/dashboard"] !== undefined) {
      fail("daemon must not depend on @useparley/dashboard (optional install)");
    }
    ok("daemon does not depend on @useparley/dashboard");
    proof.steps.inspect = {
      name: pkg.name,
      version: pkg.version,
      daemonVersion: daemonPkg.version,
      parleyUi: pkg.parley.ui,
      files: pkg.files,
      publishConfigAccess: pkg.publishConfig.access,
      versionIndependent: pkg.version !== daemonPkg.version,
      daemonDoesNotDepend: true,
    };

    // --- 4. Tarball content inspection ---
    const tarFiles = listTarballFiles(resolvedTgz);
    if (!tarFiles.includes("package.json")) {
      fail("tarball missing package.json");
    }
    if (!tarFiles.some((f) => f === "www/index.html" || f.startsWith("www/"))) {
      fail("tarball missing www/ bundle");
    }
    // Source / harness must not ship.
    const banned = tarFiles.filter(
      (f) =>
        f === "src" ||
        f.startsWith("src/") ||
        f === "verify" ||
        f.startsWith("verify/") ||
        f === "tests" ||
        f.startsWith("tests/") ||
        f === "docs" ||
        f.startsWith("docs/"),
    );
    if (banned.length > 0) {
      fail(`tarball contains non-publish paths: ${banned.slice(0, 8).join(", ")}`);
    }
    ok(`tarball ships package.json + www only (${tarFiles.length} entries)`);
    proof.steps.tarball = {
      entryCount: tarFiles.length,
      hasWwwIndex: tarFiles.includes("www/index.html"),
      banned: banned.length,
    };

    // --- 5. Offline install into scratch home + daemon serve ---
    console.log("[packed-install] extracting into scratch PARLEY_HOME…");
    const home = path.join(scratch, "home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify(
        {
          vendors: {
            fake: {
              models: {
                "fake-model": {
                  efforts: ["low", "medium", "high"],
                  default: "medium",
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const installDir = path.join(home, "node_modules", "@useparley", "dashboard");
    extractTarball(resolvedTgz, installDir);
    if (!fs.existsSync(path.join(installDir, "www", "index.html"))) {
      fail("extracted package missing www/index.html");
    }
    if (!fs.existsSync(path.join(installDir, "package.json"))) {
      fail("extracted package missing package.json");
    }
    const extractedPkg = JSON.parse(
      fs.readFileSync(path.join(installDir, "package.json"), "utf8"),
    );
    if (extractedPkg.parley?.ui !== "www") {
      fail("extracted package lost parley.ui marker");
    }
    ok("extracted into home/node_modules/@useparley/dashboard");

    // Boot real daemon against this home (in-process, no registry).
    process.env.PARLEY_HOME = home;
    process.env.PARLEY_DAEMON_ID = `packed-${path.basename(scratch)}`;
    // Clear NODE_PATH so workspace packages do not leak into discovery
    // (same isolation as packages/cli/tests/ui.test.ts).
    const prevNodePath = process.env.NODE_PATH;
    delete process.env.NODE_PATH;

    const { homePaths } = await import(pathToFileURL(CORE_ENTRY).href);
    const { startServer } = await import(pathToFileURL(DAEMON_SERVER_ENTRY).href);
    const paths = homePaths(home);
    const server = await startServer(paths);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const healthRes = await fetch(`${base}/health`);
      if (!healthRes.ok) fail(`/health status ${healthRes.status}`);
      const health = /** @type {{ ui_available?: boolean }} */ (await healthRes.json());
      if (health.ui_available !== true) {
        fail(`health.ui_available is ${health.ui_available} (expected true)`);
      }
      ok("daemon health.ui_available = true");

      const rootRes = await fetch(`${base}/`);
      if (!rootRes.ok) fail(`GET / status ${rootRes.status}`);
      const ct = rootRes.headers.get("content-type") ?? "";
      if (!/text\/html/i.test(ct)) fail(`GET / content-type ${ct}`);
      const body = await rootRes.text();
      if (!body.includes("<!DOCTYPE html") && !body.includes("<!doctype html")) {
        // Vite may emit either case; also accept lowercase doctype via HTML5.
        if (!/<html[\s>]/i.test(body)) fail("GET / body does not look like the SPA shell");
      }
      // Console identity — built index should reference the app; accept either
      // the product title or a hashed asset script (packed www is content-hashed).
      const looksLikeConsole =
        /parley|console|fleet|root/i.test(body) || /<script[^>]+src=/.test(body);
      if (!looksLikeConsole) fail("GET / body does not look like a served UI bundle");
      ok("daemon serves packed bundle at /");

      // SPA fallback + API not shadowed.
      const spa = await fetch(`${base}/some/deep/route`);
      if (spa.status !== 200) fail(`SPA fallback status ${spa.status}`);
      const tasks = await fetch(`${base}/tasks`);
      if (tasks.status !== 200) fail(`/tasks shadowed or broken: ${tasks.status}`);
      ok("SPA fallback works; /tasks not shadowed");

      proof.steps.serve = {
        port: server.port,
        ui_available: true,
        rootStatus: rootRes.status,
        spaStatus: spa.status,
        tasksStatus: tasks.status,
        bodyBytes: body.length,
      };
    } finally {
      await server.close();
      if (prevNodePath !== undefined) process.env.NODE_PATH = prevNodePath;
      else delete process.env.NODE_PATH;
    }

    proof.ok = true;
    proof.recordedAt = new Date().toISOString();

    // Persist proof under issue-359 ledger (relative paths only).
    const ledgerDir = path.join(LEDGER_ROOT, TICKET);
    fs.mkdirSync(ledgerDir, { recursive: true });
    const outPath = path.join(ledgerDir, "packed-install.json");
    fs.writeFileSync(outPath, `${JSON.stringify(proof, null, 2)}\n`);
    console.log(`[packed-install] wrote ${relFromRepo(outPath)}`);
    console.log("[packed-install] PASS");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[packed-install] error:", err);
  process.exit(1);
});
