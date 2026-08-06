/**
 * UI discovery unit tests (#348 / ADR-0033): ordered config-less probe
 * `@useparley/dashboard` → `@useparley/ui`, plus explicit config tiers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { discoverUiBundle } from "../src/ui.js";

let home: string;
const scratchDirs: string[] = [];
/** Vitest's fork pool sets NODE_PATH into the monorepo store; strip it so
 * discovery only sees packages this suite installs under `$PARLEY_HOME`
 * (same isolation as `packages/cli/tests/ui.test.ts`). Must re-init module
 * paths — Node only reads NODE_PATH at `_initPaths` time. */
let savedNodePath: string | undefined;

function setNodePath(value: string | undefined): void {
  if (value === undefined) delete process.env.NODE_PATH;
  else process.env.NODE_PATH = value;
  (Module as unknown as { _initPaths: () => void })._initPaths();
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-daemon-ui-"));
  savedNodePath = process.env.NODE_PATH;
  setNodePath("");
});

afterEach(() => {
  setNodePath(savedNodePath);
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ui-pkg-"));
  scratchDirs.push(dir);
  return dir;
}

/** Symlink `home/node_modules/<name>` → `target` (simulates an npm install). */
function installPackage(name: string, target: string): void {
  const parts = name.split("/");
  const nodeModules = path.join(home, "node_modules", ...parts.slice(0, -1));
  fs.mkdirSync(nodeModules, { recursive: true });
  fs.symlinkSync(target, path.join(home, "node_modules", name), "dir");
}

/**
 * Minimal marker package: `parley.ui` → `dist/`, with `index.html` body.
 * Empty `exports` map so discovery cannot rely on `./package.json` export.
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

/** Package that resolves but has no (or empty) `parley.ui` marker. */
function buildMarkerLessPackage(name: string): string {
  const dir = scratchDir();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, exports: {} }, null, 2),
  );
  return dir;
}

function writeConfig(config: unknown): void {
  fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify(config, null, 2));
}

function bundleIndex(dir: string): string {
  return fs.readFileSync(path.join(dir, "index.html"), "utf8");
}

describe("discoverUiBundle ordered probe (#348)", () => {
  it("Cove-only install with no config.ui still serves Cove (no regression)", () => {
    installPackage("@useparley/ui", buildMarkerPackage("@useparley/ui", "<html>cove</html>"));

    const dir = discoverUiBundle(homePaths(home));
    expect(dir).not.toBeNull();
    expect(bundleIndex(dir!)).toBe("<html>cove</html>");
  });

  it("both installed with no config.ui → console wins (probe order)", () => {
    installPackage(
      "@useparley/dashboard",
      buildMarkerPackage("@useparley/dashboard", "<html>console</html>"),
    );
    installPackage("@useparley/ui", buildMarkerPackage("@useparley/ui", "<html>cove</html>"));

    const dir = discoverUiBundle(homePaths(home));
    expect(dir).not.toBeNull();
    expect(bundleIndex(dir!)).toBe("<html>console</html>");
  });

  it('config.ui.package = "@useparley/ui" selects Cove even when dashboard is installed', () => {
    installPackage(
      "@useparley/dashboard",
      buildMarkerPackage("@useparley/dashboard", "<html>console</html>"),
    );
    installPackage("@useparley/ui", buildMarkerPackage("@useparley/ui", "<html>cove</html>"));
    writeConfig({ ui: { package: "@useparley/ui" } });

    const dir = discoverUiBundle(homePaths(home));
    expect(dir).not.toBeNull();
    expect(bundleIndex(dir!)).toBe("<html>cove</html>");
  });

  it("marker-less resolved package is a config mistake: no UI, no fall-through", () => {
    // Explicit package that resolves without a marker — must not invent a UI.
    installPackage("@useparley/broken-ui", buildMarkerLessPackage("@useparley/broken-ui"));
    installPackage("@useparley/ui", buildMarkerPackage("@useparley/ui", "<html>cove</html>"));
    writeConfig({ ui: { package: "@useparley/broken-ui" } });

    expect(discoverUiBundle(homePaths(home))).toBeNull();
  });

  it("marker-less first default stops the probe (does not fall through to Cove)", () => {
    installPackage(
      "@useparley/dashboard",
      buildMarkerLessPackage("@useparley/dashboard"),
    );
    installPackage("@useparley/ui", buildMarkerPackage("@useparley/ui", "<html>cove</html>"));

    expect(discoverUiBundle(homePaths(home))).toBeNull();
  });

  it("nothing installed → null (daemon serves no UI)", () => {
    expect(discoverUiBundle(homePaths(home))).toBeNull();
  });

  it("console-only install serves console", () => {
    installPackage(
      "@useparley/dashboard",
      buildMarkerPackage("@useparley/dashboard", "<html>console</html>"),
    );

    const dir = discoverUiBundle(homePaths(home));
    expect(dir).not.toBeNull();
    expect(bundleIndex(dir!)).toBe("<html>console</html>");
  });
});
