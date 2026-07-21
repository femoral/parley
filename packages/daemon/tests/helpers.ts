import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Write a set of `relative path → contents` files under `dir`, making dirs. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

/**
 * Default fake-vendor allowlist for daemon unit tests (#185 / ADR-0014).
 * Deny-by-default: every `delegate`/`fix` path needs `vendors.fake.models`.
 */
export const TEST_FAKE_MODELS = {
  "fake-model": {
    efforts: ["low", "medium", "high"],
    default: "medium" as const,
    hint: "test double default",
  },
  "fake-model-1": { efforts: ["low", "medium", "high"] },
  "m-profile": { efforts: ["high", "low", "medium"] },
  "m-explicit": { efforts: ["low", "high", "medium"] },
  "adapter-model": { efforts: ["adapter-effort", "low", "medium", "high"] },
  "prof-m": { efforts: ["prof-e", "low", "medium", "high"] },
  "req-m": { efforts: ["req-e", "low", "medium", "high"] },
  explicit: { efforts: ["low", "medium", "high"] },
  "from-profile": { efforts: ["low", "medium", "high"] },
  "m-def": { efforts: ["low", "medium", "high"] },
  "m-default": { efforts: ["high", "low", "medium"] },
  "other-model": { efforts: ["low", "medium", "high"] },
  m1: { efforts: ["low", "medium", "high"] },
  "m-fast": { efforts: ["low", "medium", "high"] },
  "m-only": { efforts: ["low", "medium", "high"] },
};

export function testFakeVendor(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const { models: modelsOverride, ...rest } = extra;
  return {
    models:
      modelsOverride !== undefined
        ? modelsOverride
        : { ...TEST_FAKE_MODELS },
    ...rest,
  };
}

/** Merge a body with a seeded `vendors.fake` allowlist (does not clobber other vendors). */
export function withFakeAllowlist(
  body: Record<string, unknown> = {},
): Record<string, unknown> {
  const vendorsIn =
    typeof body.vendors === "object" && body.vendors !== null && !Array.isArray(body.vendors)
      ? (body.vendors as Record<string, unknown>)
      : {};
  const fakeIn =
    typeof vendorsIn.fake === "object" && vendorsIn.fake !== null && !Array.isArray(vendorsIn.fake)
      ? (vendorsIn.fake as Record<string, unknown>)
      : {};
  return {
    ...body,
    vendors: {
      ...vendorsIn,
      fake: testFakeVendor(fakeIn),
    },
  };
}

/**
 * Create a real git repository — the worktree fixture the daemon adapter tests
 * cut worktrees from. `files` adds extra committed content. Returns the repo's
 * absolute path. (The CLI integration suite has a richer `makeGitRepo` that also
 * seeds the fake-vendor script; the daemon adapter tests only need a repo.)
 */
export function makeGitRepo(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-repo-"));
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@parley.test"]);
  run(["config", "user.name", "parley test"]);
  writeFiles(dir, files);
  run(["add", "-A"]);
  run(["commit", "--allow-empty", "-m", "initial"]);
  return dir;
}
