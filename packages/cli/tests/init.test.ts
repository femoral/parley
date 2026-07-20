import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInteractiveInit } from "../src/commands/init.js";
import { cleanupHome, FAKE_VENDOR_BIN, makeHome, runCli } from "./helpers.js";

/** PATH with only git's directory — no vendor CLIs, but repo detection still works. */
function pathWithGitOnly(): string {
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  return path.dirname(git);
}

let home: string;
let temps: string[];

function mkTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function makeRepo(): string {
  const dir = mkTemp("parley-init-repo-");
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

beforeEach(() => {
  home = makeHome();
  temps = [];
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parley init", () => {
  it("only enables prompts on a TTY without --yes or --json", () => {
    expect(isInteractiveInit({ stdinIsTTY: true, json: false, yes: false })).toBe(true);
    expect(isInteractiveInit({ stdinIsTTY: false, json: false, yes: false })).toBe(false);
    expect(isInteractiveInit({ stdinIsTTY: undefined, json: false, yes: false })).toBe(false);
    expect(isInteractiveInit({ stdinIsTTY: true, json: true, yes: false })).toBe(false);
    expect(isInteractiveInit({ stdinIsTTY: true, json: false, yes: true })).toBe(false);
  });

  it("happy path: skills, config, models with fake harness on empty PATH", async () => {
    const repo = makeRepo();
    const fakeHome = mkTemp("parley-init-home-");
    const res = await runCli(["init", "--json", "--yes"], home, {
      cwd: repo,
      extraEnv: {
        HOME: fakeHome,
        // PATH with git only so harness detection sees no real vendor CLIs.
        PATH: pathWithGitOnly(),
        PARLEY_FAKE_VENDOR_BIN: FAKE_VENDOR_BIN,
      },
    });
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as {
      skills: { installs: { skill: string; dest: string }[] };
      configuration: {
        scope: string;
        home: { path: string; created: boolean };
        project: { path: string; created: boolean } | null;
      };
      harnesses: string[];
      models: { file: string; vendors: { vendor: string; modelCount: number }[] };
    };

    // Skills installed (project x agents default).
    expect(out.skills.installs.length).toBeGreaterThan(0);
    expect(out.skills.installs.some((i) => i.skill === "parley-delegate")).toBe(true);
    expect(
      fs.existsSync(path.join(repo, ".agents", "skills", "parley-delegate", "SKILL.md")),
    ).toBe(true);

    // Config layers.
    expect(out.configuration.scope).toBe("project");
    expect(fs.existsSync(path.join(home, "parley.json"))).toBe(true);
    expect(out.configuration.project).not.toBeNull();
    expect(fs.existsSync(path.join(repo, ".parley", "config.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(home, "parley.json"), "utf8"))).toEqual({});
    expect(
      JSON.parse(fs.readFileSync(path.join(repo, ".parley", "config.json"), "utf8")),
    ).toEqual({});

    // Fake harness detected; models catalog written.
    expect(out.harnesses).toEqual(["fake"]);
    expect(fs.existsSync(out.models.file)).toBe(true);
    expect(out.models.file).toBe(path.join(home, "models.json"));
    const catalog = JSON.parse(fs.readFileSync(out.models.file, "utf8")) as Record<
      string,
      { models: unknown[] }
    >;
    expect(catalog.fake).toBeDefined();
    expect(catalog.fake!.models.length).toBeGreaterThan(0);
  });

  it("no-harness fallback messaging lists vendors and points to wizard", async () => {
    const res = await runCli(["init", "--scope", "global", "--layout", "agents"], home, {
      extraEnv: {
        HOME: mkTemp("parley-init-nh-"),
        PATH: pathWithGitOnly(),
        // helpers always set PARLEY_FAKE_VENDOR_BIN; clear it for this case.
        PARLEY_FAKE_VENDOR_BIN: "",
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/## Skills/);
    expect(res.stdout).toMatch(/## Configuration/);
    expect(res.stdout).toMatch(/## Harnesses/);
    expect(res.stdout).toMatch(/## Models/);
    expect(res.stdout).toMatch(/No built-in vendor CLIs detected/);
    expect(res.stdout).toMatch(/claude/);
    expect(res.stdout).toMatch(/codex/);
    expect(res.stdout).toMatch(/parley-wizard|\/parley-wizard/);
    expect(res.stdout).toMatch(/models\.json/);
    expect(fs.existsSync(path.join(home, "parley.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, "models.json"))).toBe(true);
  });

  it("global scope does not write project config", async () => {
    const repo = makeRepo();
    const res = await runCli(
      ["init", "--scope", "global", "--layout", "agents", "--json"],
      home,
      {
        cwd: repo,
        extraEnv: {
          HOME: mkTemp("parley-init-global-"),
          PATH: pathWithGitOnly(),
          PARLEY_FAKE_VENDOR_BIN: "",
        },
      },
    );
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as {
      configuration: { scope: string; project: unknown };
    };
    expect(out.configuration.scope).toBe("global");
    expect(out.configuration.project).toBeNull();
    expect(fs.existsSync(path.join(repo, ".parley", "config.json"))).toBe(false);
  });
});

describe("parley skills install deprecation", () => {
  it("still installs skills and prints deprecation notice to stderr", async () => {
    const target = mkTemp("parley-skills-alias-");
    const res = await runCli(["skills", "install", "--layout", target, "--json"], home);
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/deprecated/);
    expect(res.stderr).toMatch(/parley init/);
    const out = JSON.parse(res.stdout) as { installs: { skill: string }[] };
    expect(out.installs.some((i) => i.skill === "parley-delegate")).toBe(true);
    expect(fs.existsSync(path.join(target, "parley-delegate", "SKILL.md"))).toBe(true);
  });
});
