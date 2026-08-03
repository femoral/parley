/**
 * MaterializedFile write + --cwd git-exclude (#286 review).
 *
 * Engine materialization goes through writeMaterializedFiles; --cwd tasks
 * exclude secrets via excludeMaterializedFilesInCwdRepo → .git/info/exclude.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  excludeMaterializedFilesInCwdRepo,
  writeMaterializedFiles,
} from "../src/worktree.js";
import { makeGitRepo } from "./helpers.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

describe("writeMaterializedFiles (engine materialization path)", () => {
  it("applies mode 0o600 to credential files after write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-mat-"));
    temps.push(dir);
    writeMaterializedFiles(dir, [
      {
        path: ".parley-antigravity/.gemini/antigravity-cli/antigravity-oauth-token",
        contents: "secret-token\n",
        mode: 0o600,
      },
      {
        path: ".parley-antigravity/.gemini/antigravity-cli/settings.json",
        contents: "{}\n",
      },
    ]);
    const tokenPath = path.join(
      dir,
      ".parley-antigravity/.gemini/antigravity-cli/antigravity-oauth-token",
    );
    const settingsPath = path.join(
      dir,
      ".parley-antigravity/.gemini/antigravity-cli/settings.json",
    );
    expect(fs.readFileSync(tokenPath, "utf8")).toBe("secret-token\n");
    const tokenMode = fs.statSync(tokenPath).mode & 0o777;
    expect(tokenMode).toBe(0o600);
    // Unspecified mode keeps umask default (not forced to 0600).
    const settingsMode = fs.statSync(settingsPath).mode & 0o777;
    expect(settingsMode).not.toBe(0o600);
  });
});

describe("excludeMaterializedFilesInCwdRepo (--cwd tasks)", () => {
  it("appends materialized paths to .git/info/exclude and dedupes", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    temps.push(repo);
    const rel = [
      ".parley-antigravity/.gemini/antigravity-cli/antigravity-oauth-token",
      ".parley-antigravity/parley-mcp-bridge.mjs",
    ];
    excludeMaterializedFilesInCwdRepo(repo, rel);
    excludeMaterializedFilesInCwdRepo(repo, rel); // second call must not grow

    const excludePath = path.join(repo, ".git", "info", "exclude");
    const text = fs.readFileSync(excludePath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const tokenEntry = "/.parley-antigravity/.gemini/antigravity-cli/antigravity-oauth-token";
    const bridgeEntry = "/.parley-antigravity/parley-mcp-bridge.mjs";
    expect(lines.filter((l) => l === tokenEntry)).toHaveLength(1);
    expect(lines.filter((l) => l === bridgeEntry)).toHaveLength(1);

    // Write a file and confirm git status ignores it.
    const tokenAbs = path.join(repo, rel[0]!);
    fs.mkdirSync(path.dirname(tokenAbs), { recursive: true });
    fs.writeFileSync(tokenAbs, "tok\n", { mode: 0o600 });
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], {
      encoding: "utf8",
    });
    expect(status).not.toMatch(/parley-antigravity/);
  });

  it("skips silently when cwd is not a git repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-nongit-"));
    temps.push(dir);
    expect(() =>
      excludeMaterializedFilesInCwdRepo(dir, [".parley-antigravity/x"]),
    ).not.toThrow();
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  });

  it("excludes via common git dir when cwd is a linked worktree", () => {
    // gitDir(linked) → <repo>/.git/worktrees/<name>/; git only reads
    // info/exclude from the common dir (<repo>/.git/). Materialize + exclude
    // into the linked checkout and assert git status stays clean.
    const repo = makeGitRepo({ "README.md": "hi\n" });
    temps.push(repo);
    const linked = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
    temps.push(linked);
    execFileSync(
      "git",
      ["-C", repo, "worktree", "add", "--detach", linked, "HEAD"],
      { encoding: "utf8" },
    );

    const rel = [
      ".parley-antigravity/.gemini/antigravity-cli/antigravity-oauth-token",
    ];
    writeMaterializedFiles(linked, [
      {
        path: rel[0]!,
        contents: "secret-token\n",
        mode: 0o600,
      },
    ]);
    excludeMaterializedFilesInCwdRepo(linked, rel);

    // Entry must land in common .git/info/exclude, not worktree-private gitdir.
    const commonExclude = path.join(repo, ".git", "info", "exclude");
    const excludeText = fs.readFileSync(commonExclude, "utf8");
    expect(excludeText).toContain(
      "/.parley-antigravity/.gemini/antigravity-cli/antigravity-oauth-token",
    );

    const status = execFileSync("git", ["-C", linked, "status", "--porcelain"], {
      encoding: "utf8",
    });
    expect(status).not.toMatch(/parley-antigravity/);
  });
});
