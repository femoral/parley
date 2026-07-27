// Lockstep version bump for the release workflow (.github/workflows/release.yml).
//
// All @useparley/* packages under packages/** share one version. This script
// verifies they're currently in lockstep, computes the next version from a
// bump kind ("patch" | "minor" | "prerelease" | an explicit "x.y.z[-pre]"),
// and rewrites every package.json in place.
//
// Usage (from repo root):
//   node scripts/release/bump-version.mjs patch
//   node scripts/release/bump-version.mjs minor
//   node scripts/release/bump-version.mjs prerelease --preid dev
//   node scripts/release/bump-version.mjs prerelease --preid dev --from 0.5.0-dev.3
//   node scripts/release/bump-version.mjs 0.5.0
//   node scripts/release/bump-version.mjs 0.5.0-rc.1
//   node scripts/release/bump-version.mjs patch --dry-run
//
// Exits non-zero with a descriptive message on any validation failure, so it
// is safe to run as a gating step in CI.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// major.minor.patch with an optional semver prerelease tail. Build metadata
// ("+sha") is deliberately unsupported: npm ignores it when resolving, so it
// would let two different releases claim the same version.
const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

// Prerelease ids are interpolated into a regex below, so keep them to a
// character set that carries no regex meaning. Leading digits are excluded so
// "<preid>.<counter>" can never be mistaken for a plain numeric tail.
const PREID_RE = /^[A-Za-z-][0-9A-Za-z-]*$/;

const DEFAULT_PREID = "dev";

/** Parse an `x.y.z` or `x.y.z-prerelease` semver string. */
export function parseVersion(version) {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(
      `invalid version "${version}": expected "major.minor.patch" with an optional ` +
        `prerelease tail (e.g. "0.5.2" or "0.5.2-dev.0")`,
    );
  }
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

export function formatVersion({ major, minor, patch, prerelease = null }) {
  const base = `${major}.${minor}.${patch}`;
  return prerelease === null ? base : `${base}-${prerelease}`;
}

/** True when `version` carries a prerelease tail (i.e. must not be `latest`). */
export function isPrerelease(version) {
  return parseVersion(version).prerelease !== null;
}

/**
 * Compute the next version from the current one and a bump input.
 * `bump` is "patch", "minor", "prerelease", or an explicit "x.y.z[-pre]".
 * `preid` names the prerelease channel and only applies to "prerelease".
 */
export function computeNextVersion(currentVersion, bump, { preid } = {}) {
  const current = parseVersion(currentVersion);

  if (bump === "patch") {
    // A prerelease is already on its way to the base version, so promoting
    // 0.5.0-dev.2 with a patch bump lands on 0.5.0 rather than 0.5.1.
    if (current.prerelease !== null) {
      return formatVersion({ ...current, prerelease: null });
    }
    return formatVersion({ ...current, patch: current.patch + 1, prerelease: null });
  }

  if (bump === "minor") {
    // Same promotion rule: 0.5.0-dev.2 minor-bumps to 0.5.0, but 0.5.3-dev.2
    // has already left 0.5.0 behind and goes on to 0.6.0.
    if (current.prerelease !== null && current.patch === 0) {
      return formatVersion({ ...current, prerelease: null });
    }
    return formatVersion({
      major: current.major,
      minor: current.minor + 1,
      patch: 0,
      prerelease: null,
    });
  }

  if (bump === "prerelease") {
    return formatVersion(nextPrerelease(current, preid ?? DEFAULT_PREID));
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

/**
 * Advance the prerelease counter for `preid`, or open a new prerelease series.
 * Mirrors `npm version prerelease --preid <id>`: a release bumps its patch and
 * starts at `.0`, an existing series increments, and switching channels
 * restarts the counter on the same base version.
 */
function nextPrerelease(current, preid) {
  if (!PREID_RE.test(preid)) {
    throw new Error(
      `invalid prerelease id "${preid}": expected letters, digits and hyphens ` +
        `starting with a letter (e.g. "dev", "next", "rc")`,
    );
  }

  if (current.prerelease !== null) {
    const counter = new RegExp(`^${preid}\\.(\\d+)$`).exec(current.prerelease);
    if (counter) {
      return { ...current, prerelease: `${preid}.${Number(counter[1]) + 1}` };
    }
    return { ...current, prerelease: `${preid}.0` };
  }

  return { ...current, patch: current.patch + 1, prerelease: `${preid}.0` };
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Semver §11 precedence: a release outranks any prerelease of the same base. */
function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    // A shorter set of identifiers sorts lower when the shared prefix is equal.
    if (i >= left.length) return -1;
    if (i >= right.length) return 1;
    const cmp = compareIdentifiers(left[i], right[i]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function compareIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The higher-precedence of two versions. */
export function maxVersion(a, b) {
  return compareVersions(parseVersion(a), parseVersion(b)) >= 0 ? a : b;
}

/**
 * List every publishable manifest under `packagesDir` (path + parsed
 * contents), covering both the `packages/*` and `packages/plugins/*` globs in
 * pnpm-workspace.yaml. A directory holding its own package.json is a package
 * and is never descended into, so nested build output or fixtures can't be
 * mistaken for workspace members.
 */
export function listPackageManifests(packagesDir) {
  const paths = [];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;

    const dir = join(packagesDir, entry.name);
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      paths.push(manifest);
      continue;
    }

    // A grouping directory such as packages/plugins — look one level deeper.
    for (const nested of readdirSync(dir, { withFileTypes: true })) {
      if (!nested.isDirectory() || nested.name === "node_modules") continue;
      const nestedManifest = join(dir, nested.name, "package.json");
      if (existsSync(nestedManifest)) paths.push(nestedManifest);
    }
  }

  return paths
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
 *
 * `from` seeds the computation with a version that exists outside the tree —
 * the release currently on the npm dist-tag being published to. Prerelease
 * counters live only on the registry (a dev build is never committed), so
 * without it every dev publish would recompute the same `-dev.0` and collide.
 * The higher of the two wins, so a stale seed can never walk the tree
 * backwards.
 */
export function bumpRelease({ packagesDir, bump, preid, from = null, dryRun = false }) {
  const manifests = listPackageManifests(packagesDir);
  const previousVersion = readLockstepVersion(manifests);
  const baseVersion = from ? maxVersion(previousVersion, from) : previousVersion;
  const nextVersion = computeNextVersion(baseVersion, bump, { preid });
  const updatedFiles = applyVersion(manifests, nextVersion, { dryRun });
  return {
    previousVersion,
    baseVersion,
    nextVersion,
    prerelease: isPrerelease(nextVersion),
    updatedFiles,
    packageNames: manifests.map((m) => m.manifest.name),
  };
}

/** Split argv into the bump kind and its flags. */
export function parseArgs(argv) {
  const positional = [];
  let dryRun = false;
  let preid = null;
  let from = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--preid") {
      preid = argv[++i] ?? null;
    } else if (arg.startsWith("--preid=")) {
      preid = arg.slice("--preid=".length);
    } else if (arg === "--from") {
      from = argv[++i] ?? null;
    } else if (arg.startsWith("--from=")) {
      from = arg.slice("--from=".length);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag "${arg}"`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error(`expected a single bump argument, got: ${positional.join(", ")}`);
  }

  // An absent --from is normal (no such dist-tag yet); an empty one is the
  // caller passing through an empty registry lookup, which means the same.
  return { bump: positional[0] ?? null, preid, from: from || null, dryRun };
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`release version bump failed: ${err.message}`);
    process.exit(1);
  }

  if (!parsed.bump) {
    console.error(
      "usage: bump-version.mjs <patch|minor|prerelease|x.y.z> " +
        "[--preid <id>] [--from <version>] [--dry-run]",
    );
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const packagesDir = join(here, "..", "..", "packages");

  try {
    const result = bumpRelease({ packagesDir, ...parsed });
    console.log(
      `${parsed.dryRun ? "[dry run] " : ""}bumped ${result.packageNames.length} package(s) ` +
        `${result.previousVersion} -> ${result.nextVersion}`,
    );
    if (result.baseVersion !== result.previousVersion) {
      console.log(`  (continued from ${result.baseVersion}, already on the registry)`);
    }
    for (const name of result.packageNames) {
      console.log(`  - ${name}`);
    }
    console.log(`RELEASE_VERSION=${result.nextVersion}`);
    console.log(`RELEASE_PRERELEASE=${result.prerelease}`);
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
