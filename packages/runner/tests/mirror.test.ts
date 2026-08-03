import { afterEach, describe, expect, it } from "vitest";
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
  mirrorPathFor,
  preflightPushBranch,
  prepareClaimRepo,
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
  it("replaces slashes with --", () => {
    expect(encodeRepoKeyForFs("github.com/femoral/parley")).toBe(
      "github.com--femoral--parley",
    );
  });

  it("is stable for the same key", () => {
    const a = encodeRepoKeyForFs("gitlab.com/group/sub/repo");
    const b = encodeRepoKeyForFs("gitlab.com/group/sub/repo");
    expect(a).toBe(b);
    expect(a).toBe("gitlab.com--group--sub--repo");
  });
});

describe("mirrorPathFor", () => {
  it("keys off repo_key when present", () => {
    const p = mirrorPathFor("/home/.parley/clones", "github.com/org/r", "https://x");
    expect(p).toBe(path.join("/home/.parley/clones", "github.com--org--r"));
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

    // Stamp so we can detect no re-clone (same directory inode preserved).
    const st1 = fs.statSync(mirror);
    ensureMirror(mirror, bare);
    const st2 = fs.statSync(mirror);
    expect(st1.ino).toBe(st2.ino);
    expect(st1.dev).toBe(st2.dev);
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
    // Branch now exists on origin at base_sha.
    expect(git(bare, ["rev-parse", "parley/t-test"])).toBe(sha);
  });

  it("throws push_denied when pre-receive rejects", () => {
    const { bare, sha } = makeBareOrigin();
    // This environment may set global core.hooksPath; pin hooks to the bare.
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
    expect(prepared.baseRef).toBe(sha);
    expect(prepared.branch).toBe("parley/t9-feat");
    expect(fs.existsSync(prepared.repoLocal)).toBe(true);
    expect(prepared.repoLocal).toBe(
      mirrorPathFor(clones, "test.local/demo", bare),
    );
  });

  it("routes repos override by repo key", () => {
    const { bare, sha } = makeBareOrigin();
    // Operator clone (non-bare) of the same origin.
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
    // No managed mirror created when override wins.
    expect(fs.existsSync(mirrorPathFor(clones, "test.local/demo", bare))).toBe(
      false,
    );
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
});
