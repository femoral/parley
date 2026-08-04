import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ClaimGitError,
  encodeFetchUrlForFs,
  encodeRepoKeyForFs,
  ensureBaseSha,
  ensureMirror,
  isMirrorTempName,
  isPushDeniedDetail,
  mirrorPathFor,
  MIRROR_TEMP_PREFIX,
  preflightPushBranch,
  prepareClaimRepo,
  resolveReposOverride,
  taskBranchName,
} from "../src/mirror.js";
import { sampleLease } from "./lease-transport.fake.js";

const temps: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Bare origin + one commit, returned as absolute path. */
function makeBareOrigin(): { bare: string; sha: string } {
  const bare = tmp("parley-bare-");
  execFileSync("git", ["init", "--bare", "-b", "main"], {
    cwd: bare,
    stdio: "ignore",
  });
  const seed = tmp("parley-seed-");
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.email", "test@parley.test"]);
  git(seed, ["config", "user.name", "parley test"]);
  fs.writeFileSync(path.join(seed, "README"), "hello\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  const sha = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-u", "origin", "main"]);
  return { bare, sha };
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("encodeRepoKeyForFs", () => {
  it("is stable for the same key and ends with sha256[:8]", () => {
    const a = encodeRepoKeyForFs("github.com/femoral/parley");
    const b = encodeRepoKeyForFs("github.com/femoral/parley");
    expect(a).toBe(b);
    const hash = createHash("sha256")
      .update("github.com/femoral/parley")
      .digest("hex")
      .slice(0, 8);
    expect(a.endsWith(`-${hash}`)).toBe(true);
    expect(a.startsWith("github.com--femoral--parley-")).toBe(true);
  });

  it("is injective for slug-colliding keys (F2)", () => {
    // Pairs that share a slug under `/`→`--` alone must still diverge.
    const pairs: [string, string][] = [
      ["a/b--c", "a--b/c"],
      ["g/s/p", "g--s/p"],
      ["org/re po", "org/re_po"],
      ["gitlab.com/group/sub/proj", "gitlab.com/group--sub/proj"],
    ];
    for (const [x, y] of pairs) {
      const ex = encodeRepoKeyForFs(x);
      const ey = encodeRepoKeyForFs(y);
      expect(ex).not.toBe(ey);
      // Distinct mirror dirs under the same parent.
      expect(path.join("/clones", ex)).not.toBe(path.join("/clones", ey));
    }
  });
});

describe("resolveReposOverride exact match (F1)", () => {
  it("matches exact repo key only — not basename", () => {
    const repos = {
      "github.com/acme/api": "/clones/acme-api",
    };
    expect(resolveReposOverride(repos, "github.com/acme/api")).toBe("/clones/acme-api");
    expect(resolveReposOverride(repos, "github.com/other/api")).toBeNull();
    expect(resolveReposOverride(repos, "api")).toBeNull();
  });

  it("matches exact path id when that is the map key", () => {
    const repos = { "/orch/repo": "/local/repo" };
    expect(resolveReposOverride(repos, "/orch/repo")).toBe("/local/repo");
    expect(resolveReposOverride(repos, "/other/repo")).toBeNull();
  });
});

describe("mirrorPathFor", () => {
  it("keys off repo_key when present", () => {
    const p = mirrorPathFor("/home/.parley/clones", "github.com/org/r", "https://x");
    expect(p).toBe(
      path.join("/home/.parley/clones", encodeRepoKeyForFs("github.com/org/r")),
    );
  });

  it("falls back to fetch-url hash when key is null", () => {
    const p = mirrorPathFor("/c", null, "/tmp/bare.git");
    expect(path.basename(p)).toBe(encodeFetchUrlForFs("/tmp/bare.git"));
    expect(path.basename(p).startsWith("url-")).toBe(true);
  });
});

describe("taskBranchName", () => {
  it("matches worktree naming", () => {
    expect(taskBranchName("t1", null)).toBe("parley/t1");
    expect(taskBranchName("t1", "Do The Thing")).toBe("parley/t1-do-the-thing");
  });
});

describe("ensureMirror + warm reuse", () => {
  it("clones a bare mirror then reuses it on second ensure", () => {
    const { bare, sha } = makeBareOrigin();
    const clones = tmp("parley-clones-");
    const mirror = mirrorPathFor(clones, "local/test", bare);

    ensureMirror(mirror, bare);
    expect(fs.existsSync(path.join(mirror, "HEAD"))).toBe(true);
    expect(git(mirror, ["rev-parse", "HEAD"])).toBe(sha);

    const st1 = fs.statSync(mirror);
    ensureMirror(mirror, bare);
    const st2 = fs.statSync(mirror);
    expect(st1.ino).toBe(st2.ino);
    expect(st1.dev).toBe(st2.dev);
  });

  it("recovers when a non-bare half-clone dir is present (F4)", () => {
    const { bare, sha } = makeBareOrigin();
    const clones = tmp("parley-clones-");
    const mirror = mirrorPathFor(clones, "half/clone", bare);
    // Simulate crashed clone: final path is a plain directory, not a bare repo.
    fs.mkdirSync(mirror, { recursive: true });
    fs.writeFileSync(path.join(mirror, "junk"), "not a git dir\n");
    expect(fs.existsSync(path.join(mirror, "junk"))).toBe(true);

    ensureMirror(mirror, bare);
    expect(fs.existsSync(path.join(mirror, "HEAD"))).toBe(true);
    expect(git(mirror, ["rev-parse", "HEAD"])).toBe(sha);
  });

  it("temp clone names cannot collide with real mirror encodings (F4)", () => {
    const keys = [
      "github.com/org/repo",
      ".parley-clone-tmp-evil",
      "a/b--c",
      "url-abcdef",
    ];
    for (const k of keys) {
      expect(isMirrorTempName(encodeRepoKeyForFs(k))).toBe(false);
    }
    expect(isMirrorTempName(`${MIRROR_TEMP_PREFIX}github.com--org-abc123`)).toBe(
      true,
    );
  });
});

describe("ensureBaseSha", () => {
  it("accepts a sha already in the mirror", () => {
    const { bare, sha } = makeBareOrigin();
    const mirror = path.join(tmp("parley-clones-"), "m");
    ensureMirror(mirror, bare);
    expect(() => ensureBaseSha(mirror, sha)).not.toThrow();
  });

  it("throws base_sha_unresolvable for unknown sha", () => {
    const { bare } = makeBareOrigin();
    const mirror = path.join(tmp("parley-clones-"), "m");
    ensureMirror(mirror, bare);
    const fake = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(() => ensureBaseSha(mirror, fake)).toThrow(ClaimGitError);
    try {
      ensureBaseSha(mirror, fake);
    } catch (err) {
      expect(err).toBeInstanceOf(ClaimGitError);
      expect((err as ClaimGitError).code).toBe("base_sha_unresolvable");
      expect((err as ClaimGitError).message).toMatch(/base_sha not resolvable from origin/);
    }
  });
});

describe("preflightPushBranch", () => {
  it("succeeds against a writable bare origin", () => {
    const { bare, sha } = makeBareOrigin();
    const mirror = path.join(tmp("parley-clones-"), "m");
    ensureMirror(mirror, bare);
    expect(() => preflightPushBranch(mirror, sha, "parley/t-test")).not.toThrow();
    expect(git(bare, ["rev-parse", "parley/t-test"])).toBe(sha);
  });

  it("throws push_denied when pre-receive rejects", () => {
    const { bare, sha } = makeBareOrigin();
    git(bare, ["config", "core.hooksPath", path.join(bare, "hooks")]);
    const hooks = path.join(bare, "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\necho DENIED_BY_HOOK >&2\nexit 1\n");
    fs.chmodSync(hook, 0o755);

    const mirror = path.join(tmp("parley-clones-"), "m");
    ensureMirror(mirror, bare);
    let threw: unknown;
    try {
      preflightPushBranch(mirror, sha, "parley/t-denied");
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(ClaimGitError);
    expect((threw as ClaimGitError).code).toBe("push_denied");
    expect((threw as ClaimGitError).message).toMatch(/push denied at claim time/);
  });

  it("classes read-only origin object-dir errors as push_denied (F6)", () => {
    expect(
      isPushDeniedDetail("unable to create temporary object directory"),
    ).toBe(true);
    expect(isPushDeniedDetail("Read-only file system")).toBe(true);
    expect(isPushDeniedDetail("some unrelated pack error")).toBe(false);
  });
});

describe("prepareClaimRepo", () => {
  it("creates a managed mirror for a fetch URL with no repos config", () => {
    const { bare, sha } = makeBareOrigin();
    const clones = tmp("parley-clones-");
    const lease = sampleLease({
      task_id: "t9",
      name: "feat",
      repo: "/orch/missing",
      repo_key: "test.local/demo",
      repo_fetch_url: bare,
      base_sha: sha,
    });
    const prepared = prepareClaimRepo(lease, { repos: {}, clonesDir: clones });
    expect(prepared.source).toBe("mirror");
    expect(prepared.pushToOrigin).toBe(true);
    expect(prepared.preflightPushed).toBe(true);
    expect(prepared.baseRef).toBe(sha);
    expect(prepared.branch).toBe("parley/t9-feat");
    expect(fs.existsSync(prepared.repoLocal)).toBe(true);
    expect(prepared.repoLocal).toBe(
      mirrorPathFor(clones, "test.local/demo", bare),
    );
  });

  it("routes repos override by exact repo key", () => {
    const { bare, sha } = makeBareOrigin();
    const clone = tmp("parley-op-clone-");
    execFileSync("git", ["clone", bare, clone], { stdio: "ignore" });
    git(clone, ["config", "user.email", "test@parley.test"]);
    git(clone, ["config", "user.name", "parley test"]);

    const clones = tmp("parley-clones-");
    const lease = sampleLease({
      repo: "/orch/other",
      repo_key: "test.local/demo",
      repo_fetch_url: bare,
      base_sha: sha,
    });
    const prepared = prepareClaimRepo(lease, {
      repos: { "test.local/demo": clone },
      clonesDir: clones,
    });
    expect(prepared.source).toBe("override");
    expect(prepared.repoLocal).toBe(clone);
    expect(fs.existsSync(mirrorPathFor(clones, "test.local/demo", bare))).toBe(
      false,
    );
  });

  it("does not use basename-colliding override — uses managed mirror (F1)", () => {
    const acme = makeBareOrigin();
    const other = makeBareOrigin();
    // Distinct content so we can prove which origin was used.
    const acmeClone = tmp("parley-acme-clone-");
    execFileSync("git", ["clone", acme.bare, acmeClone], { stdio: "ignore" });
    git(acmeClone, ["config", "user.email", "test@parley.test"]);
    git(acmeClone, ["config", "user.name", "parley test"]);

    const clones = tmp("parley-clones-");
    const lease = sampleLease({
      task_id: "t-other",
      name: null,
      repo: "/orch/other-api",
      repo_key: "github.com/other/api",
      repo_fetch_url: other.bare,
      base_sha: other.sha,
    });
    const prepared = prepareClaimRepo(lease, {
      // Basename "api" collides — must NOT match other/api.
      repos: { "github.com/acme/api": acmeClone },
      clonesDir: clones,
    });
    expect(prepared.source).toBe("mirror");
    expect(prepared.repoLocal).toBe(
      mirrorPathFor(clones, "github.com/other/api", other.bare),
    );
    expect(prepared.repoLocal).not.toBe(acmeClone);
    // Preflight landed on OTHER origin, not ACME.
    expect(git(other.bare, ["rev-parse", "parley/t-other"])).toBe(other.sha);
    expect(() => git(acme.bare, ["rev-parse", "parley/t-other"])).toThrow();
  });

  it("fails with no_repo_source when nothing is available", () => {
    const lease = sampleLease({
      repo: "/no/such/path-xyz",
      repo_key: null,
      repo_fetch_url: null,
    });
    expect(() =>
      prepareClaimRepo(lease, { repos: {}, clonesDir: tmp("c-") }),
    ).toThrow(/no repo source/);
  });

  it("redacts credential userinfo from mirror clone diagnoses (F8)", () => {
    const clones = tmp("parley-clones-");
    const lease = sampleLease({
      repo: "/orch/x",
      repo_key: "github.com/org/secret-repo",
      repo_fetch_url: "https://x-access-token:ghp_SUPERSECRET@127.0.0.1:1/org/repo.git",
      base_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    let threw: unknown;
    try {
      prepareClaimRepo(lease, { repos: {}, clonesDir: clones });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(ClaimGitError);
    const msg = (threw as ClaimGitError).message;
    expect(msg).not.toContain("ghp_SUPERSECRET");
    expect(msg).not.toContain("x-access-token:");
    expect(msg).toMatch(/mirror clone failed/);
  });
});
