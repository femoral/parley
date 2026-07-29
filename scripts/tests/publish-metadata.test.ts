// Guards the manifest metadata that npm's registry validates at publish time,
// against the real packages/ tree rather than a fixture.
//
// The release workflow publishes with `--provenance`, and the registry refuses
// a provenance bundle whose subject manifest does not name the repository it
// was built from ("Error verifying sigstore provenance bundle: Failed to
// validate repository information"). That check lives only on the registry, so
// neither `pnpm publish --dry-run` nor any other local gate catches a missing
// `repository` — the release fails mid-publish, after the version bump, with
// some packages potentially already up. Assert it here instead, in the `unit`
// project the release gate runs.
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { listPackageManifests } from "../release/bump-version.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packagesDir = join(repoRoot, "packages");

// The canonical remote, in the `git+https://...git` form npm normalizes to the
// https URL its provenance subject carries.
const REPOSITORY_URL = "git+https://github.com/femoral/parley.git";

const manifests = listPackageManifests(packagesDir);

describe("publishable package metadata", () => {
  it("finds the workspace packages", () => {
    // A silently empty list would make every assertion below vacuous.
    expect(manifests.length).toBeGreaterThanOrEqual(9);
  });

  it.each(manifests.map((m) => [m.manifest.name, m] as const))(
    "%s declares the repository provenance validation requires",
    (_name, { path, manifest }) => {
      expect(manifest.repository, `${relative(repoRoot, path)} has no "repository"`).toBeDefined();
      expect(manifest.repository.type).toBe("git");
      expect(manifest.repository.url).toBe(REPOSITORY_URL);
      // Monorepo packages must point at their own subdirectory, POSIX-style,
      // repo-relative — that is what npm reads to locate the manifest.
      const expected = relative(repoRoot, dirname(path)).split(sep).join("/");
      expect(manifest.repository.directory).toBe(expected);
    },
  );
});
