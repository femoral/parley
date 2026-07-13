// Lockstep version bump for the release workflow (docs/spec/release-process.md).
//
// All @useparley/* packages under packages/* share one version. This script
// verifies they're currently in lockstep, computes the next version from a
// bump kind ("patch" | "minor" | an explicit "x.y.z"), and rewrites every
// package.json in place.
//
// Usage (from repo root):
//   node scripts/release/bump-version.mjs patch
//   node scripts/release/bump-version.mjs minor
//   node scripts/release/bump-version.mjs 0.5.0
//   node scripts/release/bump-version.mjs patch --dry-run
//
// Exits non-zero with a descriptive message on any validation failure, so it
// is safe to run as a gating step in CI.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse a strict `x.y.z` semver string (no prerelease/build metadata). */
export function parseVersion(version) {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(
      `invalid version "${version}": expected strict "major.minor.patch" (e.g. "0.5.2")`,
    );
  }
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/**
 * Compute the next version from the current one and a bump input.
 * `bump` is "patch", "minor", or an explicit "x.y.z" string.
 * Explicit versions must be strictly greater than the current version.
 */
export function computeNextVersion(currentVersion, bump) {
  const current = parseVersion(currentVersion);

  if (bump === "patch") {
    return formatVersion({ ...current, patch: current.patch + 1 });
  }
  if (bump === "minor") {
    return formatVersion({ ...current, minor: current.minor + 1, patch: 0 });
  }

  // Explicit version.
  const next = parseVersion(bump);
  const nextStr = formatVersion(next);
  if (compareVersions(next, current) <= 0) {
    throw new Error(
      `explicit version "${nextStr}" must be greater than the current version "${currentVersion}"`,
    );
  }
  return nextStr;
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** List every packages/*\/package.json manifest (path + parsed contents). */
export function listPackageManifests(packagesDir) {
  const entries = readdirSync(packagesDir).filter((name) =>
    statSync(join(packagesDir, name)).isDirectory(),
  );
  return entries
    .map((name) => join(packagesDir, name, "package.json"))
    .filter((path) => {
      try {
        statSync(path);
        return true;
      } catch {
        return false;
      }
    })
    .map((path) => {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        throw new Error(`${path}: manifest is missing a "name" or "version" field`);
      }
      return { path, manifest };
    })
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/**
 * Verify every manifest shares the same version ("lockstep"); returns that
 * shared version. Throws with the offending package names if they've drifted.
 */
export function readLockstepVersion(manifests) {
  if (manifests.length === 0) {
    throw new Error("no package manifests found");
  }
  const versions = new Set(manifests.map((m) => m.manifest.version));
  if (versions.size > 1) {
    const detail = manifests
      .map((m) => `${m.manifest.name}@${m.manifest.version}`)
      .join(", ");
    throw new Error(`packages are not in lockstep, refusing to bump: ${detail}`);
  }
  const [version] = versions;
  return version;
}

/**
 * Write `nextVersion` into every manifest's package.json, preserving 2-space
 * JSON formatting and a trailing newline. Returns the list of file paths
 * written (empty when `dryRun` is true).
 */
export function applyVersion(manifests, nextVersion, { dryRun = false } = {}) {
  const written = [];
  for (const { path, manifest } of manifests) {
    const updated = { ...manifest, version: nextVersion };
    if (!dryRun) {
      writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
    }
    written.push(path);
  }
  return written;
}

/**
 * Orchestrate a full lockstep bump: read manifests, verify lockstep, compute
 * the next version, and (unless dryRun) write it back to every package.json.
 */
export function bumpRelease({ packagesDir, bump, dryRun = false }) {
  const manifests = listPackageManifests(packagesDir);
  const previousVersion = readLockstepVersion(manifests);
  const nextVersion = computeNextVersion(previousVersion, bump);
  const updatedFiles = applyVersion(manifests, nextVersion, { dryRun });
  return {
    previousVersion,
    nextVersion,
    updatedFiles,
    packageNames: manifests.map((m) => m.manifest.name),
  };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const bump = args.find((a) => !a.startsWith("--"));

  if (!bump) {
    console.error("usage: bump-version.mjs <patch|minor|x.y.z> [--dry-run]");
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const packagesDir = join(here, "..", "..", "packages");

  try {
    const result = bumpRelease({ packagesDir, bump, dryRun });
    console.log(
      `${dryRun ? "[dry run] " : ""}bumped ${result.packageNames.length} package(s) ` +
        `${result.previousVersion} -> ${result.nextVersion}`,
    );
    for (const name of result.packageNames) {
      console.log(`  - ${name}`);
    }
    console.log(`RELEASE_VERSION=${result.nextVersion}`);
  } catch (err) {
    console.error(`release version bump failed: ${err.message}`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly (`node bump-version.mjs ...`), not
// when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
