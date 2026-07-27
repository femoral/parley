import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseVersion,
  formatVersion,
  isPrerelease,
  computeNextVersion,
  listPackageManifests,
  readLockstepVersion,
  applyVersion,
  bumpRelease,
  parseArgs,
} from "../release/bump-version.mjs";

describe("parseVersion / formatVersion", () => {
  it("round-trips a strict semver string", () => {
    expect(formatVersion(parseVersion("1.2.3"))).toBe("1.2.3");
  });

  it("round-trips a prerelease version", () => {
    expect(formatVersion(parseVersion("1.2.3-dev.0"))).toBe("1.2.3-dev.0");
    expect(formatVersion(parseVersion("1.2.3-rc.10"))).toBe("1.2.3-rc.10");
  });

  it("exposes the prerelease tail", () => {
    expect(parseVersion("1.2.3").prerelease).toBeNull();
    expect(parseVersion("1.2.3-dev.4").prerelease).toBe("dev.4");
  });

  it("rejects malformed versions", () => {
    expect(() => parseVersion("1.2")).toThrow(/invalid version/);
    expect(() => parseVersion("v1.2.3")).toThrow(/invalid version/);
    expect(() => parseVersion("not-a-version")).toThrow(/invalid version/);
    expect(() => parseVersion("1.2.3-")).toThrow(/invalid version/);
    // Build metadata is unsupported: npm ignores it when resolving.
    expect(() => parseVersion("1.2.3+abc123")).toThrow(/invalid version/);
  });
});

describe("isPrerelease", () => {
  it("distinguishes releases from prereleases", () => {
    expect(isPrerelease("1.2.3")).toBe(false);
    expect(isPrerelease("1.2.3-dev.0")).toBe(true);
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

  it("accepts an explicit prerelease version", () => {
    expect(computeNextVersion("0.4.9", "0.5.0-rc.1")).toBe("0.5.0-rc.1");
  });

  it("ranks a prerelease below the release it precedes", () => {
    // 0.5.0-rc.1 < 0.5.0, so it is not a valid bump from the release.
    expect(() => computeNextVersion("0.5.0", "0.5.0-rc.1")).toThrow(/must be greater/);
    expect(computeNextVersion("0.5.0-rc.1", "0.5.0")).toBe("0.5.0");
  });

  it("orders prerelease counters numerically, not lexically", () => {
    expect(computeNextVersion("0.5.0-dev.9", "0.5.0-dev.10")).toBe("0.5.0-dev.10");
    expect(() => computeNextVersion("0.5.0-dev.10", "0.5.0-dev.9")).toThrow(/must be greater/);
  });
});

describe("computeNextVersion — prereleases", () => {
  it("opens a new prerelease series off the next patch", () => {
    expect(computeNextVersion("0.4.9", "prerelease", { preid: "dev" })).toBe("0.4.10-dev.0");
  });

  it("defaults the preid to dev", () => {
    expect(computeNextVersion("0.4.9", "prerelease")).toBe("0.4.10-dev.0");
  });

  it("increments an existing series of the same preid", () => {
    expect(computeNextVersion("0.4.10-dev.0", "prerelease", { preid: "dev" })).toBe(
      "0.4.10-dev.1",
    );
    expect(computeNextVersion("0.4.10-dev.9", "prerelease", { preid: "dev" })).toBe(
      "0.4.10-dev.10",
    );
  });

  it("restarts the counter on the same base when switching channels", () => {
    expect(computeNextVersion("0.4.10-dev.3", "prerelease", { preid: "rc" })).toBe(
      "0.4.10-rc.0",
    );
  });

  it("rejects a preid that is not a bare identifier", () => {
    expect(() => computeNextVersion("0.4.9", "prerelease", { preid: "0dev" })).toThrow(
      /invalid prerelease id/,
    );
    expect(() => computeNextVersion("0.4.9", "prerelease", { preid: "de v" })).toThrow(
      /invalid prerelease id/,
    );
    expect(() => computeNextVersion("0.4.9", "prerelease", { preid: "" })).toThrow(
      /invalid prerelease id/,
    );
  });

  it("promotes a prerelease to its base version on a patch bump", () => {
    expect(computeNextVersion("0.5.0-dev.2", "patch")).toBe("0.5.0");
    expect(computeNextVersion("0.5.3-dev.2", "patch")).toBe("0.5.3");
  });

  it("promotes an x.y.0 prerelease to its base version on a minor bump", () => {
    expect(computeNextVersion("0.5.0-dev.2", "minor")).toBe("0.5.0");
  });

  it("moves past the current minor when the prerelease is not on x.y.0", () => {
    expect(computeNextVersion("0.5.3-dev.2", "minor")).toBe("0.6.0");
  });
});

describe("parseArgs", () => {
  it("reads a bare bump kind", () => {
    expect(parseArgs(["patch"])).toEqual({
      bump: "patch",
      preid: null,
      from: null,
      dryRun: false,
    });
  });

  it("reads --preid in both spellings", () => {
    expect(parseArgs(["prerelease", "--preid", "rc"]).preid).toBe("rc");
    expect(parseArgs(["prerelease", "--preid=rc"]).preid).toBe("rc");
  });

  it("does not mistake a --preid value for the bump kind", () => {
    expect(parseArgs(["--preid", "rc", "prerelease"]).bump).toBe("prerelease");
  });

  it("reads --from in both spellings", () => {
    expect(parseArgs(["prerelease", "--from", "0.5.0-dev.3"]).from).toBe("0.5.0-dev.3");
    expect(parseArgs(["prerelease", "--from=0.5.0-dev.3"]).from).toBe("0.5.0-dev.3");
  });

  it("treats an empty --from as absent", () => {
    // The workflow passes an empty registry lookup straight through.
    expect(parseArgs(["prerelease", "--from", ""]).from).toBeNull();
  });

  it("reads --dry-run", () => {
    expect(parseArgs(["patch", "--dry-run"]).dryRun).toBe(true);
  });

  it("rejects unknown flags and extra positionals", () => {
    expect(() => parseArgs(["patch", "--nope"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["patch", "minor"])).toThrow(/single bump argument/);
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

  /** A package under a grouping directory, e.g. packages/plugins/codex. */
  function writeNestedPackage(group: string, name: string, version: string) {
    const dir = join(packagesDir, group, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: `@useparley/${name}`, version }, null, 2)}\n`,
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

  it("lists packages nested under a grouping directory", () => {
    writePackage("cli", "0.1.0");
    writeNestedPackage("plugins", "plugin-codex", "0.1.0");
    writeNestedPackage("plugins", "plugin-grok", "0.1.0");

    const manifests = listPackageManifests(packagesDir);
    expect(manifests.map((m) => m.manifest.name)).toEqual([
      "@useparley/cli",
      "@useparley/plugin-codex",
      "@useparley/plugin-grok",
    ]);
  });

  it("does not descend into a directory that is itself a package", () => {
    writePackage("ui", "0.1.0");
    // Build output or a vendored fixture inside a package is not a workspace
    // member, even though it carries a package.json.
    const nested = join(packagesDir, "ui", "www");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "package.json"),
      `${JSON.stringify({ name: "bundled-thing", version: "9.9.9" }, null, 2)}\n`,
    );

    const manifests = listPackageManifests(packagesDir);
    expect(manifests.map((m) => m.manifest.name)).toEqual(["@useparley/ui"]);
  });

  it("ignores node_modules at both levels", () => {
    writePackage("cli", "0.1.0");
    for (const dir of [
      join(packagesDir, "node_modules", "left-pad"),
      join(packagesDir, "plugins", "node_modules", "left-pad"),
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify({ name: "left-pad", version: "1.0.0" }, null, 2)}\n`,
      );
    }

    const manifests = listPackageManifests(packagesDir);
    expect(manifests.map((m) => m.manifest.name)).toEqual(["@useparley/cli"]);
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

  it("bumpRelease keeps nested packages in lockstep with the top-level ones", () => {
    writePackage("cli", "0.4.9");
    writePackage("core", "0.4.9");
    writeNestedPackage("plugins", "plugin-codex", "0.4.9");

    const result = bumpRelease({ packagesDir, bump: "patch" });

    expect(result.nextVersion).toBe("0.4.10");
    expect(result.updatedFiles).toHaveLength(3);
    const plugin = JSON.parse(
      readFileSync(join(packagesDir, "plugins", "plugin-codex", "package.json"), "utf8"),
    );
    expect(plugin.version).toBe("0.4.10");
  });

  it("bumpRelease reports whether the new version is a prerelease", () => {
    writePackage("cli", "0.4.9");
    writePackage("core", "0.4.9");

    const pre = bumpRelease({ packagesDir, bump: "prerelease", preid: "dev", dryRun: true });
    expect(pre.nextVersion).toBe("0.4.10-dev.0");
    expect(pre.prerelease).toBe(true);

    const release = bumpRelease({ packagesDir, bump: "patch", dryRun: true });
    expect(release.nextVersion).toBe("0.4.10");
    expect(release.prerelease).toBe(false);
  });

  it("bumpRelease writes a prerelease version to every manifest", () => {
    writePackage("cli", "0.4.9");
    writeNestedPackage("plugins", "plugin-codex", "0.4.9");

    bumpRelease({ packagesDir, bump: "prerelease", preid: "dev" });

    for (const path of [
      join(packagesDir, "cli", "package.json"),
      join(packagesDir, "plugins", "plugin-codex", "package.json"),
    ]) {
      expect(JSON.parse(readFileSync(path, "utf8")).version).toBe("0.4.10-dev.0");
    }
  });

  it("bumpRelease continues a prerelease series from the registry seed", () => {
    // The tree is still on the last release; the dev channel has moved ahead.
    writePackage("cli", "0.4.9");
    writePackage("core", "0.4.9");

    const result = bumpRelease({
      packagesDir,
      bump: "prerelease",
      preid: "dev",
      from: "0.4.10-dev.3",
    });

    expect(result.previousVersion).toBe("0.4.9");
    expect(result.baseVersion).toBe("0.4.10-dev.3");
    expect(result.nextVersion).toBe("0.4.10-dev.4");
  });

  it("bumpRelease ignores a --from that trails the tree", () => {
    writePackage("cli", "0.5.0");
    writePackage("core", "0.5.0");

    const result = bumpRelease({
      packagesDir,
      bump: "prerelease",
      preid: "dev",
      from: "0.4.10-dev.3",
    });

    expect(result.baseVersion).toBe("0.5.0");
    expect(result.nextVersion).toBe("0.5.1-dev.0");
  });

  it("bumpRelease refuses to write anything when packages have drifted", () => {
    writePackage("cli", "0.4.9");
    writePackage("core", "0.4.0");

    expect(() => bumpRelease({ packagesDir, bump: "patch" })).toThrow(/not in lockstep/);

    const cli = JSON.parse(readFileSync(join(packagesDir, "cli", "package.json"), "utf8"));
    expect(cli.version).toBe("0.4.9");
  });
});
