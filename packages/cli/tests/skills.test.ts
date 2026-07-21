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
/** Bundled skills source next to this package's tests (installs from here). */
const BUNDLED_SKILLS = fileURLToPath(new URL("../skills", import.meta.url));

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
      installs: { skill: string; changes: { file: string; status: string }[] }[];
    };
    // Count-agnostic: more bundled skills may ship; this test pins the
    // parley-delegate install's behavior.
    const firstDelegate = firstOut.installs.find((i) => i.skill === SKILL);
    expect(firstDelegate).toBeDefined();
    expect(firstDelegate!.changes.every((c) => c.status === "created")).toBe(true);

    // Local edit is clobbered by the upgrade path; unchanged files report so.
    const skillPath = path.join(target, SKILL, "SKILL.md");
    fs.writeFileSync(skillPath, "stale\n");

    const second = await runCli(["skills", "install", "--layout", target, "--json"], home);
    expect(second.code).toBe(0);
    const secondOut = JSON.parse(second.stdout) as {
      installs: { skill: string; changes: { file: string; status: string }[] }[];
    };
    const byFile = Object.fromEntries(
      secondOut.installs
        .find((i) => i.skill === SKILL)!
        .changes.map((c) => [c.file, c.status]),
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
    // Count-agnostic: more bundled skills may ship; pin the delegate entry.
    const delegate = out.skills.find((s) => s.name === SKILL);
    expect(delegate).toBeDefined();
    expect(delegate!.description).toMatch(/Delegate tasks/);
  });

  it("ships parley-wizard and not the retired parley-rubric skill", async () => {
    const res = await runCli(["skills", "list", "--json"], home);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as {
      skills: { name: string; description: string }[];
    };
    const names = out.skills.map((s) => s.name);
    expect(names).toContain("parley-wizard");
    expect(names).not.toContain("parley-rubric");
    const wizard = out.skills.find((s) => s.name === "parley-wizard");
    expect(wizard!.description).toMatch(/interview|Configure a parley project/i);
  });

  it("human list prints name and one-line description", async () => {
    const res = await runCli(["skills", "list"], home);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/parley-delegate/);
    expect(res.stdout).toMatch(/Delegate tasks/);
    expect(res.stdout).toMatch(/parley-wizard/);
    expect(res.stdout).not.toMatch(/parley-rubric/);
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

describe("bundled skill contents", () => {
  it("parley-wizard covers the full interview, skippable rubrics, lint, and dry-run cost warning", () => {
    const skillMd = fs.readFileSync(path.join(BUNDLED_SKILLS, "parley-wizard", "SKILL.md"), "utf8");
    // Interview areas from #167.
    for (const needle of [
      "eval",
      "taskTypes",
      "rubric",
      "classification",
      "retention",
      "resume",
      "retry",
      "daemon.url",
      "parley models",
      "parley lint",
      "--dry-run",
    ]) {
      expect(skillMd.toLowerCase()).toContain(needle.toLowerCase());
    }
    // Skippable rubrics, re-run/no-op, version bump, token cost.
    expect(skillMd).toMatch(/skippable/i);
    expect(skillMd).toMatch(/no-op/i);
    expect(skillMd).toMatch(/[Bb]ump.*version|version.*[Bb]ump/);
    expect(skillMd).toMatch(/token/i);
    expect(skillMd).toMatch(/factory-reset|never factory/i);
    // Settings scope: always asked first (#202); project/global/both choices explained.
    expect(skillMd).toMatch(/~\/?\.parley\/parley\.json|parley\.json/);
    expect(skillMd).toMatch(/~\/?\.parley\/config\.json|PARLEY_HOME/);
    expect(skillMd).toMatch(/project settings only|Project only/i);
    expect(skillMd).toMatch(/global settings|Global defaults|Global only/i);
    expect(skillMd).toMatch(/\bboth\b/i);
    expect(skillMd).toMatch(/defaults\.vendor|defaults\.profile/);
    expect(skillMd).toMatch(/always the first prompt|scope first/i);
    expect(skillMd).toMatch(/never suppress this question|Existing global files never suppress/i);
    // Per-vendor transport defaults + model discovery during setup.
    expect(skillMd).toMatch(/Child-channel defaults|childChannel/);
    expect(skillMd).toMatch(/\bpi\b[\s\S]*\bcli\b/i);
    expect(skillMd).toMatch(/No native MCP|no native MCP/i);
    expect(skillMd).toMatch(/parley models refresh|models refresh/);
    expect(skillMd).toMatch(/shipped catalog|point-in-time reference/i);
    // Model+effort allowlist pick/default/hint stage.
    expect(skillMd).toMatch(/Model\+effort allowlist|deny-by-default/i);
    expect(skillMd).toMatch(/Pick combos|pick model\+effort/i);
    expect(skillMd).toMatch(/Mark one default|default.*combo/i);
    expect(skillMd).toMatch(/Optional hints|hint/i);
    expect(skillMd).toMatch(/vendors\.\S+\.models/);
    for (const vendor of [
      "claude",
      "cline",
      "codex",
      "gemini",
      "goose",
      "grok",
      "hermes",
      "kilo",
      "kimi",
      "openclaw",
      "opencode",
      "openhands",
      "pi",
    ]) {
      expect(skillMd).toContain("`" + vendor + "`");
    }
    // No retired skill or issue/ADR sediment in the consumer entry point.
    expect(skillMd).not.toMatch(/parley-rubric/);
    expect(skillMd).not.toMatch(/ADR-\d+/);
    expect(skillMd).not.toMatch(/#\d{2,}/);
  });

  it("parley-delegate: step-0 info, session when eval, fix loop; defers config to info", () => {
    const skillDir = path.join(BUNDLED_SKILLS, "parley-delegate");
    const skillMd = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    // Step 0 + live config authority.
    expect(skillMd).toMatch(/parley info/);
    expect(skillMd).toMatch(/authoritative/i);
    // Conditional orchestrator session registration (env-only provenance #190).
    expect(skillMd).toMatch(/parley session/);
    expect(skillMd).toMatch(/PARLEY_HARNESS|harness plugin|env-only/i);
    expect(skillMd).not.toMatch(/self-report your harness|self-report model/i);
    expect(skillMd).not.toMatch(/parley session -v <harness> -m <model>/);
    // Delegate typing + eval-when-expected.
    expect(skillMd).toMatch(/--type/);
    expect(skillMd).toMatch(/parley eval <task> --answers/);
    expect(skillMd).not.toMatch(/--score/);
    // Fix loop covers both retry error codes.
    expect(skillMd).toMatch(/parley fix <task>/);
    expect(skillMd).toMatch(/parley fix --fresh/);
    expect(skillMd).toMatch(/retry_limit_exceeded/);
    expect(skillMd).toMatch(/reattempt_window_expired/);
    // Setup problems → wizard.
    expect(skillMd).toMatch(/\/parley-wizard|parley-wizard/);
    // Stable workflow preserved.
    expect(skillMd).toMatch(/parley watch --json/);
    expect(skillMd).toMatch(/--ack/);
    expect(skillMd).toMatch(/parley clean/);
    expect(skillMd).toMatch(/--base-ref/);
    expect(skillMd).toMatch(/--context/);
    expect(skillMd).toMatch(/self-contained brief/i);
    // No config-shaped vendor/classification dumps, retired skill, or lineage.
    expect(skillMd).not.toMatch(/`codex`,\s*`grok`|Vendors?:\s*`/);
    expect(skillMd).not.toMatch(/parley-rubric/);
    expect(skillMd).not.toMatch(/ADR-\d+/);
    expect(skillMd).not.toMatch(/#\d{2,}/);
    // Sibling off-path files exist (sessions wiring, shaping, bugs).
    expect(fs.existsSync(path.join(skillDir, "sessions.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, "task-shaping.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, "bug-report.md"))).toBe(true);
    // Whole skill folder free of retired score/rubric skill surface.
    for (const name of fs.readdirSync(skillDir)) {
      if (!name.endsWith(".md")) continue;
      const body = fs.readFileSync(path.join(skillDir, name), "utf8");
      expect(body).not.toMatch(/parley-rubric/);
      expect(body).not.toMatch(/--score/);
    }
  });

  it("does not ship parley-rubric", () => {
    expect(fs.existsSync(path.join(BUNDLED_SKILLS, "parley-rubric"))).toBe(false);
    expect(fs.existsSync(path.join(BUNDLED_SKILLS, "parley-wizard", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(BUNDLED_SKILLS, "parley-delegate", "SKILL.md"))).toBe(true);
  });
});
