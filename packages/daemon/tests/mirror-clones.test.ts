/**
 * Managed clones list/prune + held-mirror key scan (#318).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import { openDatabase } from "../src/db.js";
import { TaskEngine } from "../src/engine.js";
import { fingerprintCapabilities } from "../src/fingerprint.js";
import {
  dirSizeBytes,
  encodeFetchUrlForFs,
  encodeRepoKeyForFs,
  ensureMirror,
  isMirrorUsedByLiveTasks,
  listHeldMirrorRepoKeys,
  listManagedClones,
  pruneUnusedClones,
  tryWithMirrorLock,
  type LiveMirrorUsage,
} from "../src/mirror.js";
import { withFakeAllowlist } from "./helpers.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Network-key-style bare: seed a bare then re-point origin at a https URL. */
function makeMirrorWithKey(
  clonesDir: string,
  repoKey: string,
  fetchUrl: string,
): string {
  // Use a local bare as the real clone source, then rewrite origin for key ads.
  const bare = tmp("parley-bare-");
  execFileSync("git", ["init", "--bare", "-b", "main"], {
    cwd: bare,
    stdio: "ignore",
  });
  const seed = tmp("parley-seed-");
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.email", "t@t"]);
  git(seed, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(seed, "README"), "hi\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "i"]);
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-u", "origin", "main"]);

  const mirrorPath = path.join(clonesDir, encodeRepoKeyForFs(repoKey));
  ensureMirror(mirrorPath, bare);
  // Rewrite origin to the network URL so listHeldMirrorRepoKeys normalizes it.
  git(mirrorPath, ["remote", "set-url", "origin", fetchUrl]);
  return mirrorPath;
}

/** Path-origin bare mirror (normalizeRepoKey → null). */
function makePathOriginMirror(clonesDir: string, bareOrigin: string): string {
  const mirrorPath = path.join(clonesDir, encodeFetchUrlForFs(bareOrigin));
  ensureMirror(mirrorPath, bareOrigin);
  return mirrorPath;
}

function seedBareOrigin(): string {
  const bare = tmp("parley-bare-");
  execFileSync("git", ["init", "--bare", "-b", "main"], {
    cwd: bare,
    stdio: "ignore",
  });
  const seed = tmp("parley-seed-");
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.email", "t@t"]);
  git(seed, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(seed, "README"), "hi\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "i"]);
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-u", "origin", "main"]);
  return bare;
}

describe("ensureMirror reuse with surviving worktrees (#318 BLOCKER-1)", () => {
  it("second ensureMirror fetch succeeds after linked worktree remains", () => {
    const bare = seedBareOrigin();
    const clones = tmp("parley-clones-reuse-");
    const mirror = path.join(clones, encodeFetchUrlForFs(bare));
    ensureMirror(mirror, bare);

    // Simulate daemon: cut worktree, push branch to origin, leave worktree.
    const wt = path.join(tmp("parley-wt-"), "t1");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    execFileSync(
      "git",
      ["-C", mirror, "worktree", "add", "-b", "parley/t1-reuse", wt, "HEAD"],
      { stdio: "ignore" },
    );
    execFileSync("git", ["-C", wt, "push", "-u", "origin", "parley/t1-reuse"], {
      stdio: "ignore",
    });
    // Still attached — naive fetch would refuse.
    expect(() =>
      execFileSync(
        "git",
        ["-C", mirror, "fetch", "--prune", "origin", "+refs/*:refs/*"],
        { stdio: "ignore" },
      ),
    ).toThrow();

    // ensureMirror must free the branch and fetch successfully.
    expect(() => ensureMirror(mirror, bare)).not.toThrow();
    // Worktree directory still present for review, HEAD detached.
    expect(fs.existsSync(wt)).toBe(true);
    const head = execFileSync(
      "git",
      ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    expect(head).toBe("HEAD");
  });
});

describe("listHeldMirrorRepoKeys", () => {
  it("returns normalized keys from bare origins", () => {
    const clones = tmp("parley-clones-");
    makeMirrorWithKey(
      clones,
      "github.com/org/a",
      "https://github.com/Org/A.git",
    );
    makeMirrorWithKey(
      clones,
      "github.com/org/b",
      "git@github.com:org/b.git",
    );
    expect(listHeldMirrorRepoKeys(clones)).toEqual([
      "github.com/org/a",
      "github.com/org/b",
    ]);
  });

  it("skips temp and lock dirs", () => {
    const clones = tmp("parley-clones-");
    fs.mkdirSync(path.join(clones, ".parley-clone-tmp-x"), { recursive: true });
    fs.mkdirSync(path.join(clones, "foo.lock"), { recursive: true });
    expect(listHeldMirrorRepoKeys(clones)).toEqual([]);
  });
});

describe("isMirrorUsedByLiveTasks", () => {
  it("matches by key or raw fetch URL/path; uncertainty is used", () => {
    const usage: LiveMirrorUsage = {
      repoKeys: new Set(["github.com/org/live"]),
      refs: new Set(["/tmp/path-origin.git", "https://github.com/org/other.git"]),
    };
    expect(
      isMirrorUsedByLiveTasks("github.com/org/live", "https://x", usage),
    ).toBe(true);
    expect(
      isMirrorUsedByLiveTasks(null, "/tmp/path-origin.git", usage),
    ).toBe(true);
    expect(
      isMirrorUsedByLiveTasks(null, "/tmp/other-unused.git", usage),
    ).toBe(false);
    // No identity at all → never delete.
    expect(isMirrorUsedByLiveTasks(null, null, usage)).toBe(true);
  });
});

describe("listManagedClones + pruneUnusedClones", () => {
  it("lists sizes and marks used by live repo_key", () => {
    const clones = tmp("parley-clones-");
    makeMirrorWithKey(
      clones,
      "github.com/org/live",
      "https://github.com/org/live.git",
    );
    makeMirrorWithKey(
      clones,
      "github.com/org/dead",
      "https://github.com/org/dead.git",
    );
    const listed = listManagedClones(
      clones,
      new Set(["github.com/org/live"]),
    );
    expect(listed).toHaveLength(2);
    const live = listed.find((c) => c.repo_key === "github.com/org/live");
    const dead = listed.find((c) => c.repo_key === "github.com/org/dead");
    expect(live?.used).toBe(true);
    expect(dead?.used).toBe(false);
    expect(live!.size_bytes).toBeGreaterThan(0);
    expect(dirSizeBytes(live!.path)).toBe(live!.size_bytes);
  });

  it("marks path-origin mirrors used by raw fetch URL of live tasks (#318 HIGH-4)", () => {
    const clones = tmp("parley-clones-");
    const bare = seedBareOrigin();
    const mirrorPath = makePathOriginMirror(clones, bare);
    const listed = listManagedClones(clones, {
      repoKeys: new Set(),
      refs: new Set([bare]),
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.repo_key).toBeNull();
    expect(listed[0]!.used).toBe(true);
    expect(listed[0]!.path).toBe(mirrorPath);

    // Without the ref, unused.
    const free = listManagedClones(clones, {
      repoKeys: new Set(),
      refs: new Set(),
    });
    expect(free[0]!.used).toBe(false);
  });

  it("prune removes only unused mirrors", () => {
    const clones = tmp("parley-clones-");
    const livePath = makeMirrorWithKey(
      clones,
      "github.com/org/live",
      "https://github.com/org/live.git",
    );
    const deadPath = makeMirrorWithKey(
      clones,
      "github.com/org/dead",
      "https://github.com/org/dead.git",
    );
    const result = pruneUnusedClones(
      clones,
      new Set(["github.com/org/live"]),
    );
    expect(result.removed.map((c) => c.repo_key)).toEqual([
      "github.com/org/dead",
    ]);
    expect(result.kept.map((c) => c.repo_key)).toEqual([
      "github.com/org/live",
    ]);
    expect(fs.existsSync(livePath)).toBe(true);
    expect(fs.existsSync(deadPath)).toBe(false);
  });

  it("prune keeps path-origin mirrors referenced by live task fetch URL", () => {
    const clones = tmp("parley-clones-");
    const bare = seedBareOrigin();
    const mirrorPath = makePathOriginMirror(clones, bare);
    const result = pruneUnusedClones(clones, {
      repoKeys: new Set(),
      refs: new Set([bare]),
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toHaveLength(1);
    expect(fs.existsSync(mirrorPath)).toBe(true);
  });

  it("prune skips a lock-held mirror (#318 HIGH-4)", () => {
    const clones = tmp("parley-clones-");
    const heldPath = makeMirrorWithKey(
      clones,
      "github.com/org/held",
      "https://github.com/org/held.git",
    );
    const freePath = makeMirrorWithKey(
      clones,
      "github.com/org/free",
      "https://github.com/org/free.git",
    );

    // Hold the lock without releasing until after prune (simulate ensureMirror).
    const lockDir = `${heldPath}.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid}\n${Date.now()}\n`);

    try {
      const result = pruneUnusedClones(clones, new Set());
      expect(result.removed.map((c) => c.repo_key)).toEqual([
        "github.com/org/free",
      ]);
      expect(result.kept.map((c) => c.repo_key)).toContain(
        "github.com/org/held",
      );
      expect(fs.existsSync(heldPath)).toBe(true);
      expect(fs.existsSync(freePath)).toBe(false);
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });

  it("tryWithMirrorLock returns false when lock is held", () => {
    const mirror = tmp("parley-lock-mirror-");
    const lockDir = `${mirror}.lock`;
    fs.mkdirSync(lockDir);
    try {
      let ran = false;
      const ok = tryWithMirrorLock(mirror, () => {
        ran = true;
      }, 0);
      expect(ok).toBe(false);
      expect(ran).toBe(false);
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

describe("real fingerprint held_mirrors + localHeld advertisement (#318 coverage)", () => {
  it("fingerprintCapabilities reads clones dir; daemon localHeld matches", async () => {
    const home = tmp("parley-home-fp-");
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify(withFakeAllowlist({})),
    );
    const paths = homePaths(home);
    fs.mkdirSync(paths.clones, { recursive: true });
    makeMirrorWithKey(
      paths.clones,
      "github.com/org/warm",
      "https://github.com/org/warm.git",
    );

    // Real fingerprint over the actual clones dir (not injected HTTP JSON).
    const caps = await fingerprintCapabilities({
      adapters: createAdapterRegistrySync(process.env),
      clonesDir: paths.clones,
      env: { ...process.env, PARLEY_HOME: home },
    });
    expect(caps.held_mirrors).toEqual(["github.com/org/warm"]);

    // Daemon engine advertises the same keys for the local executor.
    const db = openDatabase(paths);
    const engine = new TaskEngine(
      db,
      paths,
      createAdapterRegistrySync(process.env),
    );
    // listClones uses the clones dir; localHeld is internal — pin via ranking
    // surface: after a mirror exists, listClones reports it.
    const listed = engine.listClones();
    expect(listed.some((c) => c.repo_key === "github.com/org/warm")).toBe(true);

    // listHeldMirrorRepoKeys (same function localHeld uses) agrees.
    expect(listHeldMirrorRepoKeys(paths.clones)).toEqual([
      "github.com/org/warm",
    ]);
  });
});
