import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupHome, makeHome, runCli } from "./helpers.js";

let home: string;
/** Temp dirs to remove after each test (fake HOME, custom install targets). */
let temps: string[];

function mkTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A throwaway git repo to stand in for a user's project (for project scope). */
function makeRepo(): string {
  const dir = mkTemp("parley-skills-repo-");
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@parley.test"]);
  run(["config", "user.name", "parley test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return dir;
}

const SKILL = "parley-delegate";

beforeEach(() => {
  home = makeHome();
  temps = [];
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parley skills install", () => {
  it("global × claude installs the whole folder into ~/.claude/skills", async () => {
    const fakeHome = mkTemp("parley-home-");
    const res = await runCli(["skills", "install", "--scope", "global", "--layout", "claude"], home, {
      extraEnv: { HOME: fakeHome },
    });
    expect(res.code).toBe(0);
    const dest = path.join(fakeHome, ".claude", "skills", SKILL);
    expect(fs.existsSync(path.join(dest, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "bug-report.md"))).toBe(true);
  });

  it("global × agents installs into ~/.agents/skills", async () => {
    const fakeHome = mkTemp("parley-home-");
    const res = await runCli(["skills", "install", "--scope", "global", "--layout", "agents"], home, {
      extraEnv: { HOME: fakeHome },
    });
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(fakeHome, ".agents", "skills", SKILL, "SKILL.md"))).toBe(true);
  });

  it("project × claude installs into <repo>/.claude/skills at the repo root", async () => {
    const repo = makeRepo();
    // Invoke from a subdir to prove it resolves the repo root, not cwd.
    const sub = path.join(repo, "nested");
    fs.mkdirSync(sub);
    const res = await runCli(["skills", "install", "--scope", "project", "--layout", "claude"], home, {
      cwd: sub,
    });
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(repo, ".claude", "skills", SKILL, "SKILL.md"))).toBe(true);
  });

  it("project × agents installs into <repo>/.agents/skills", async () => {
    const repo = makeRepo();
    const res = await runCli(["skills", "install", "--scope", "project", "--layout", "agents"], home, {
      cwd: repo,
    });
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(repo, ".agents", "skills", SKILL, "SKILL.md"))).toBe(true);
  });

  it("a custom --layout path installs there regardless of scope", async () => {
    const target = mkTemp("parley-custom-");
    const res = await runCli(["skills", "install", "--layout", target], home);
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(target, SKILL, "SKILL.md"))).toBe(true);
  });

  it("rewrites repo-relative links to GitHub URLs but keeps sibling links", async () => {
    const target = mkTemp("parley-links-");
    await runCli(["skills", "install", "--layout", target], home);
    const skillMd = fs.readFileSync(path.join(target, SKILL, "SKILL.md"), "utf8");
    // `../../docs/agents/troubleshooting.md` → absolute GitHub blob URL.
    expect(skillMd).toContain(
      "https://github.com/femoral/parley/blob/main/docs/agents/troubleshooting.md",
    );
    expect(skillMd).not.toContain("../../docs/agents/troubleshooting.md");
    // Sibling link travels with the folder — stays relative.
    expect(skillMd).toContain("(bug-report.md)");
    // Already-absolute links are untouched.
    expect(skillMd).toContain("(https://github.com/femoral/parley)");
  });

  it("re-install overwrites cleanly and reports what changed (--json)", async () => {
    const target = mkTemp("parley-reinstall-");
    const first = await runCli(["skills", "install", "--layout", target, "--json"], home);
    const firstOut = JSON.parse(first.stdout) as { changes: { file: string; status: string }[] };
    expect(firstOut.changes.every((c) => c.status === "created")).toBe(true);

    // Local edit is clobbered by the upgrade path; unchanged files report so.
    const skillPath = path.join(target, SKILL, "SKILL.md");
    fs.writeFileSync(skillPath, "stale\n");

    const second = await runCli(["skills", "install", "--layout", target, "--json"], home);
    expect(second.code).toBe(0);
    const secondOut = JSON.parse(second.stdout) as {
      changes: { file: string; status: string }[];
    };
    const byFile = Object.fromEntries(secondOut.changes.map((c) => [c.file, c.status]));
    expect(byFile["SKILL.md"]).toBe("updated");
    expect(byFile["bug-report.md"]).toBe("unchanged");
    expect(fs.readFileSync(skillPath, "utf8")).not.toBe("stale\n");
  });

  it("is non-interactive-safe: missing flags are usage errors (exit 2)", async () => {
    // No TTY in the test subprocess, so prompting is impossible; must error.
    const noLayout = await runCli(["skills", "install", "--scope", "global"], home);
    expect(noLayout.code).toBe(2);
    expect(noLayout.stderr).toMatch(/--layout/);

    const noScope = await runCli(["skills", "install", "--layout", "claude"], home);
    expect(noScope.code).toBe(2);
    expect(noScope.stderr).toMatch(/--scope/);
  });

  it("project scope outside a git repo is a usage error", async () => {
    const notRepo = mkTemp("parley-notrepo-");
    const res = await runCli(["skills", "install", "--scope", "project", "--layout", "claude"], home, {
      cwd: notRepo,
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/git repository/);
  });
});

describe("parley skills list", () => {
  it("lists the bundled skill", async () => {
    const res = await runCli(["skills", "list", "--json"], home);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ skills: [SKILL] });
  });
});
