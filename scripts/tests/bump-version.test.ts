import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseVersion,
  formatVersion,
  computeNextVersion,
  listPackageManifests,
  readLockstepVersion,
  applyVersion,
  bumpRelease,
} from "../release/bump-version.mjs";

describe("parseVersion / formatVersion", () => {
  it("round-trips a strict semver string", () => {
    expect(formatVersion(parseVersion("1.2.3"))).toBe("1.2.3");
  });

  it("rejects non-strict versions", () => {
    expect(() => parseVersion("1.2")).toThrow(/invalid version/);
    expect(() => parseVersion("1.2.3-beta.1")).toThrow(/invalid version/);
    expect(() => parseVersion("v1.2.3")).toThrow(/invalid version/);
    expect(() => parseVersion("not-a-version")).toThrow(/invalid version/);
  });
});

describe("computeNextVersion", () => {
  it("bumps patch", () => {
    expect(computeNextVersion("0.4.9", "patch")).toBe("0.4.10");
  });

  it("bumps minor and resets patch", () => {
    expect(computeNextVersion("0.4.9", "minor")).toBe("0.5.0");
  });

  it("accepts an explicit version greater than current", () => {
    expect(computeNextVersion("0.4.9", "1.0.0")).toBe("1.0.0");
  });

  it("rejects an explicit version equal to current", () => {
    expect(() => computeNextVersion("0.4.9", "0.4.9")).toThrow(/must be greater/);
  });

  it("rejects an explicit version lower than current", () => {
    expect(() => computeNextVersion("0.4.9", "0.4.0")).toThrow(/must be greater/);
  });

  it("rejects a malformed explicit version", () => {
    expect(() => computeNextVersion("0.4.9", "not-a-version")).toThrow(/invalid version/);
  });
});

describe("package manifest helpers + bumpRelease", () => {
  let packagesDir: string;

  function writePackage(name: string, version: string, extra: Record<string, unknown> = {}) {
    const dir = join(packagesDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: `@useparley/${name}`, version, ...extra }, null, 2)}\n`,
    );
  }

  beforeEach(() => {
    packagesDir = mkdtempSync(join(tmpdir(), "parley-release-test-"));
  });

  afterEach(() => {
    rmSync(packagesDir, { recursive: true, force: true });
  });

  it("lists manifests sorted by package name", () => {
    writePackage("cli", "0.1.0");
    writePackage("core", "0.1.0");
    const manifests = listPackageManifests(packagesDir);
    expect(manifests.map((m) => m.manifest.name)).toEqual([
      "@useparley/cli",
      "@useparley/core",
    ]);
  });

  it("reads a shared lockstep version", () => {
    writePackage("cli", "0.2.0");
    writePackage("core", "0.2.0");
    const manifests = listPackageManifests(packagesDir);
    expect(readLockstepVersion(manifests)).toBe("0.2.0");
  });

  it("throws a descriptive error for a manifest missing name or version", () => {
    const dir = join(packagesDir, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "@useparley/broken" })}\n`);
    expect(() => listPackageManifests(packagesDir)).toThrow(/missing a "name" or "version"/);
  });

  it("throws if packages have drifted out of lockstep", () => {
    writePackage("cli", "0.2.0");
    writePackage("core", "0.1.0");
    const manifests = listPackageManifests(packagesDir);
    expect(() => readLockstepVersion(manifests)).toThrow(/not in lockstep/);
  });

  it("writes the next version to every manifest, preserving other fields", () => {
    writePackage("cli", "0.2.0", { private: true, dependencies: { "@useparley/core": "workspace:*" } });
    writePackage("core", "0.2.0");
    const manifests = listPackageManifests(packagesDir);
    const written = applyVersion(manifests, "0.3.0");

    expect(written).toHaveLength(2);
    for (const path of written) {
      const contents = readFileSync(path, "utf8");
      expect(contents.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(contents);
      expect(parsed.version).toBe("0.3.0");
    }
    const cli = JSON.parse(readFileSync(join(packagesDir, "cli", "package.json"), "utf8"));
    expect(cli.private).toBe(true);
    expect(cli.dependencies["@useparley/core"]).toBe("workspace:*");
  });

  it("dry run computes files but does not write them", () => {
    writePackage("cli", "0.2.0");
    const manifests = listPackageManifests(packagesDir);
    const written = applyVersion(manifests, "0.3.0", { dryRun: true });
    expect(written).toHaveLength(1);
    const cli = JSON.parse(readFileSync(join(packagesDir, "cli", "package.json"), "utf8"));
    expect(cli.version).toBe("0.2.0");
  });

  it("bumpRelease orchestrates lockstep verification, next-version computation, and writes", () => {
    writePackage("cli", "0.4.9");
    writePackage("core", "0.4.9");
    writePackage("ui", "0.4.9", { private: true });

    const result = bumpRelease({ packagesDir, bump: "minor" });

    expect(result.previousVersion).toBe("0.4.9");
    expect(result.nextVersion).toBe("0.5.0");
    expect(result.updatedFiles).toHaveLength(3);
    expect(result.packageNames).toEqual([
      "@useparley/cli",
      "@useparley/core",
      "@useparley/ui",
    ]);

    for (const name of ["cli", "core", "ui"]) {
      const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"));
      expect(manifest.version).toBe("0.5.0");
    }
  });

  it("bumpRelease refuses to write anything when packages have drifted", () => {
    writePackage("cli", "0.4.9");
    writePackage("core", "0.4.0");

    expect(() => bumpRelease({ packagesDir, bump: "patch" })).toThrow(/not in lockstep/);

    const cli = JSON.parse(readFileSync(join(packagesDir, "cli", "package.json"), "utf8"));
    expect(cli.version).toBe("0.4.9");
  });
});
