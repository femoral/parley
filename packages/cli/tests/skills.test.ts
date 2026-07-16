import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const FIXTURE_BUNDLE = fileURLToPath(new URL("./fixtures/skills-bundle", import.meta.url));

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
    const firstOut = JSON.parse(first.stdout) as {
      installs: { changes: { file: string; status: string }[] }[];
    };
    expect(firstOut.installs).toHaveLength(1);
    expect(firstOut.installs[0]!.changes.every((c) => c.status === "created")).toBe(true);

    // Local edit is clobbered by the upgrade path; unchanged files report so.
    const skillPath = path.join(target, SKILL, "SKILL.md");
    fs.writeFileSync(skillPath, "stale\n");

    const second = await runCli(["skills", "install", "--layout", target, "--json"], home);
    expect(second.code).toBe(0);
    const secondOut = JSON.parse(second.stdout) as {
      installs: { changes: { file: string; status: string }[] }[];
    };
    const byFile = Object.fromEntries(
      secondOut.installs[0]!.changes.map((c) => [c.file, c.status]),
    );
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

  it("--skill selects a single skill; default installs all bundled", async () => {
    const target = mkTemp("parley-skill-flag-");
    const only = await runCli(
      ["skills", "install", "--layout", target, "--skill", SKILL, "--json"],
      home,
    );
    expect(only.code).toBe(0);
    const onlyOut = JSON.parse(only.stdout) as { installs: { skill: string }[] };
    expect(onlyOut.installs.map((i) => i.skill)).toEqual([SKILL]);

    const unknown = await runCli(
      ["skills", "install", "--layout", target, "--skill", "no-such-skill"],
      home,
    );
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/unknown skill/);
  });

  it("multi-skill install copies every selected skill into the target", async () => {
    const target = mkTemp("parley-multi-");
    const res = await runCli(["skills", "install", "--layout", target, "--json"], home, {
      extraEnv: { PARLEY_SKILLS_SOURCE: FIXTURE_BUNDLE },
    });
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as {
      installs: { skill: string; dest: string; changes: { status: string }[] }[];
    };
    expect(out.installs.map((i) => i.skill).sort()).toEqual(["fixture-alpha", "fixture-beta"]);
    expect(fs.existsSync(path.join(target, "fixture-alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "fixture-alpha", "note.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "fixture-beta", "SKILL.md"))).toBe(true);

    // --skill can narrow to one of several bundled skills.
    const target2 = mkTemp("parley-multi-one-");
    const one = await runCli(
      ["skills", "install", "--layout", target2, "--skill", "fixture-beta", "--json"],
      home,
      { extraEnv: { PARLEY_SKILLS_SOURCE: FIXTURE_BUNDLE } },
    );
    expect(one.code).toBe(0);
    const oneOut = JSON.parse(one.stdout) as { installs: { skill: string }[] };
    expect(oneOut.installs.map((i) => i.skill)).toEqual(["fixture-beta"]);
    expect(fs.existsSync(path.join(target2, "fixture-beta", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target2, "fixture-alpha"))).toBe(false);

    // Link rewrite is skill-name-aware for multi-skill bundles.
    const alphaMd = fs.readFileSync(path.join(target, "fixture-alpha", "SKILL.md"), "utf8");
    expect(alphaMd).toContain(
      "https://github.com/femoral/parley/blob/main/docs/out.md",
    );
    expect(alphaMd).toContain("(note.md)");
  });

  it("--yes is accepted as a non-interactive flag alongside layout/scope", async () => {
    const fakeHome = mkTemp("parley-yes-");
    const res = await runCli(
      ["skills", "install", "--scope", "global", "--layout", "claude", "--yes", "--json"],
      home,
      { extraEnv: { HOME: fakeHome } },
    );
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(fakeHome, ".claude", "skills", SKILL, "SKILL.md"))).toBe(true);
  });

  it("human output is a compact target → skill tree summary", async () => {
    const target = mkTemp("parley-tree-");
    const res = await runCli(["skills", "install", "--layout", target], home, {
      extraEnv: { PARLEY_SKILLS_SOURCE: FIXTURE_BUNDLE },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/custom path/);
    expect(res.stdout).toMatch(/fixture-alpha/);
    expect(res.stdout).toMatch(/fixture-beta/);
    expect(res.stdout).toMatch(/created/);
  });
});

describe("parley skills list", () => {
  it("lists the bundled skill with description", async () => {
    const res = await runCli(["skills", "list", "--json"], home);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as {
      skills: { name: string; description: string }[];
    };
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0]!.name).toBe(SKILL);
    expect(out.skills[0]!.description).toMatch(/Delegate tasks/);
  });

  it("human list prints name and one-line description", async () => {
    const res = await runCli(["skills", "list"], home);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/parley-delegate/);
    expect(res.stdout).toMatch(/Delegate tasks/);
  });

  it("list --json includes descriptions for multi-skill fixtures", async () => {
    const res = await runCli(["skills", "list", "--json"], home, {
      extraEnv: { PARLEY_SKILLS_SOURCE: FIXTURE_BUNDLE },
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      skills: [
        {
          name: "fixture-alpha",
          description: "Tiny fixture skill alpha for multi-skill install tests.",
        },
        {
          name: "fixture-beta",
          description: "Tiny fixture skill beta for multi-skill install tests.",
        },
      ],
    });
  });
});
