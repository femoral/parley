/**
 * Managed clones list/prune + held-mirror key scan (#318).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dirSizeBytes,
  encodeRepoKeyForFs,
  ensureMirror,
  listHeldMirrorRepoKeys,
  listManagedClones,
  pruneUnusedClones,
} from "../src/mirror.js";

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
});
