/**
 * #313 — resolveRepoIdentity / origin read against real git checkouts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeRepoKey } from "@useparley/core";
import { readOriginFetchUrl, resolveRepoIdentity } from "../src/repo-identity.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function initRepo(origin?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-repo-id-"));
  temps.push(dir);
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@parley.test"]);
  run(["config", "user.name", "parley test"]);
  fs.writeFileSync(path.join(dir, "README"), "x\n");
  run(["add", "README"]);
  run(["commit", "-m", "init"]);
  if (origin !== undefined) {
    run(["remote", "add", "origin", origin]);
  }
  return dir;
}

describe("resolveRepoIdentity", () => {
  it("returns key + fetch URL for an origin remote", () => {
    const repo = initRepo("git@github.com:Org/Repo.git");
    const id = resolveRepoIdentity(repo);
    expect(id.localPath).toBe(repo);
    expect(id.fetchUrl).toBe("git@github.com:Org/Repo.git");
    expect(id.key).toBe("github.com/org/repo");
    expect(id.key).toBe(normalizeRepoKey(id.fetchUrl!));
  });

  it("returns null key/URL when there is no origin", () => {
    const repo = initRepo();
    const id = resolveRepoIdentity(repo);
    expect(id.localPath).toBe(repo);
    expect(id.key).toBeNull();
    expect(id.fetchUrl).toBeNull();
    expect(readOriginFetchUrl(repo)).toBeNull();
  });

  it("SSH and HTTPS remotes produce the same key", () => {
    const a = initRepo("git@github.com:femoral/parley.git");
    const b = initRepo("https://github.com/femoral/parley.git");
    expect(resolveRepoIdentity(a).key).toBe(resolveRepoIdentity(b).key);
  });
});
