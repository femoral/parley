/**
 * CLI integration: `parley info` effective configuration (#163 / #169).
 *
 * Seam: real daemon + fake vendor. Asserts section headers against fixture
 * project/daemon configs, eval-related omission when off, configured vendors
 * only, prose/--json parity, and that the project root is sent explicitly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderInfoProse, type InfoConfig } from "@useparley/daemon/info.js";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  runCli,
  writeFiles,
} from "./helpers.js";

let home: string;
const scratch: string[] = [];

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function projectDir(): string {
  const dir = makeTaskDir([{ submit_report: { summary: "ok", outcome: "success", files_changed: [] } }]);
  scratch.push(dir);
  return dir;
}

function writeProject(root: string, files: Record<string, string>): void {
  writeFiles(root, files);
}

describe("parley info — sections from live config (#163 / #169)", () => {
  it("renders all six section headers against fixture configs when eval is on", async () => {
    const cwd = projectDir();
    writeFiles(home, {
      "parley.json": JSON.stringify({
        profiles: {
          fast: { vendor: "fake", model: "m-fast", effort: "low" },
        },
        vendors: {
          fake: { childChannel: "cli", retryWindow: "45m" },
        },
        defaults: { profile: "fast", vendor: "fake" },
      }),
      "orchestrator/PROMPT.md": "ORCH-HOME-LINE",
    });
    writeProject(cwd, {
      ".parley/orchestrator/PROMPT.md": "ORCH-PROJECT-LINE",
      ".parley/config.json": JSON.stringify({
        eval: { enabled: true },
        resume: { enabled: true },
        retry: { max: 2, window: "15m" },
        taskTypes: {
          coding: { rubric: "coding" },
          research: { rubric: "research" },
        },
      }),
      ".parley/classification.json": JSON.stringify({
        version: 1,
        sizes: [{ id: "S", guidance: "Small fixture size." }],
        difficulties: [{ id: "easy", guidance: "Easy fixture difficulty." }],
      }),
    });

    const res = await runCli(["info"], home, { cwd });
    expect(res.code).toBe(0);
    const out = res.stdout;

    // Six required section headers when eval is on.
    expect(out).toMatch(/^# Parley project info/m);
    expect(out).toContain("## Instructions");
    expect(out).toContain("## Vendors & profiles");
    expect(out).toContain("## Task types");
    expect(out).toContain("## Classification");
    expect(out).toContain("## Evaluation");
    expect(out).toContain("## Fix & retries");

    // Instructions compound home → project.
    expect(out).toContain("ORCH-HOME-LINE");
    expect(out).toContain("ORCH-PROJECT-LINE");
    expect(out.indexOf("ORCH-HOME-LINE")).toBeLessThan(out.indexOf("ORCH-PROJECT-LINE"));

    // Vendors & profiles from daemon config only (not full catalog).
    expect(out).toContain("`fake`");
    expect(out).toMatch(/child channel: cli/);
    expect(out).toMatch(/retry window: 45 minutes/);
    expect(out).toContain("`fast`");
    expect(out).toMatch(/vendor=fake/);
    expect(out).toMatch(/model=m-fast/);
    expect(out).toContain("### Defaults");
    expect(out).toMatch(/profile: `fast`/);
    expect(out).toMatch(/vendor: `fake`/);
    expect(out).not.toContain("`claude`");
    expect(out).not.toContain("`codex`");

    // Task types from project + automatic other.
    expect(out).toContain("`coding` → rubric `coding`");
    expect(out).toContain("`research` → rubric `research`");
    expect(out).toMatch(/`other` → rubric `generic`.*automatic fallback/s);

    // Classification guidance from project file.
    expect(out).toContain("`S`: Small fixture size.");
    expect(out).toContain("`easy`: Easy fixture difficulty.");
    expect(out).not.toContain("`XS`"); // shipped defaults replaced

    // Evaluation on: how-to + rubric summaries.
    expect(out).toMatch(/Evaluation is \*\*on\*\*/);
    expect(out).toContain("parley eval <task> --answers");
    expect(out).toContain("#### `coding`");
    expect(out).toContain("brief-implemented");
    expect(out).toContain("broke-existing");

    // Fix & retries from project retry/resume.
    expect(out).toContain('parley fix <task> "<brief>"');
    expect(out).toContain("parley fix --fresh");
    expect(out).toMatch(/retry\.max: \*\*2\*\*/);
    expect(out).toMatch(/retry\.window: \*\*15 minutes\*\*/);
    expect(out).toContain("retry_limit_exceeded");
    expect(out).toContain("reattempt_window_expired");
    expect(out).toMatch(/exit 7/);
    expect(out).toMatch(/exit 8/);
  });

  it("omits Task types, Classification, and Evaluation when eval is off (default)", async () => {
    const cwd = projectDir();
    // No .parley/config.json ⇒ eval off.
    const res = await runCli(["info"], home, { cwd });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("## Instructions");
    expect(res.stdout).toContain("## Vendors & profiles");
    expect(res.stdout).toContain("## Fix & retries");
    expect(res.stdout).not.toContain("## Task types");
    expect(res.stdout).not.toContain("## Classification");
    expect(res.stdout).not.toContain("## Evaluation");
    expect(res.stdout).not.toContain("Evaluation is off");
    expect(res.stdout).not.toContain("### How to eval");
    expect(res.stdout).not.toContain("### Rubrics by type");
  });

  it("shows shipped defaults when eval is on and project has no classification/taskTypes", async () => {
    const cwd = projectDir();
    writeProject(cwd, {
      ".parley/config.json": JSON.stringify({ eval: { enabled: true } }),
    });
    const res = await runCli(["info"], home, { cwd });
    expect(res.code).toBe(0);
    // Shipped sizes + difficulties present.
    expect(res.stdout).toContain("`XS`:");
    expect(res.stdout).toContain("`trivial`:");
    // Shipped task types.
    expect(res.stdout).toContain("`coding` → rubric `coding`");
    expect(res.stdout).toContain("`planning` → rubric `planning`");
    expect(res.stdout).toMatch(/`other`/);
  });

  it("lists only configured vendors in --json, not the full adapter catalog", async () => {
    const cwd = projectDir();
    writeFiles(home, {
      "parley.json": JSON.stringify({
        vendors: { fake: { childChannel: "mcp" } },
        profiles: { only: { vendor: "fake", model: "m-only" } },
      }),
    });
    const res = await runCli(["info", "--json"], home, { cwd });
    expect(res.code).toBe(0);
    const config = JSON.parse(res.stdout) as InfoConfig;
    expect(config.vendors.map((v) => v.id)).toEqual(["fake"]);
    expect(config.vendors.some((v) => v.id === "claude")).toBe(false);
    expect(config.profiles.map((p) => p.model)).toEqual(["m-only"]);
    // No full models catalog dump.
    expect(config).not.toHaveProperty("models");
  });
});

describe("parley info — prose / --json parity (#163 / #169)", () => {
  it("prints structured config with --json and prose without; prose matches render(config)", async () => {
    const cwd = projectDir();
    writeFiles(home, {
      "parley.json": JSON.stringify({
        profiles: { deep: { vendor: "fake", model: "m1" } },
      }),
      "orchestrator/PROMPT.md": "HOME-ORCH",
    });
    writeProject(cwd, {
      ".parley/config.json": JSON.stringify({
        eval: { enabled: false },
        retry: { max: 3, window: "1h" },
        taskTypes: { coding: "coding" },
      }),
    });

    const proseRes = await runCli(["info"], home, { cwd });
    expect(proseRes.code).toBe(0);
    const jsonRes = await runCli(["info", "--json"], home, { cwd });
    expect(jsonRes.code).toBe(0);

    const config = JSON.parse(jsonRes.stdout) as InfoConfig;
    // --json is the config object only (not the full { prose, config } envelope).
    expect(config).toHaveProperty("project");
    expect(config).toHaveProperty("vendors");
    expect(config).toHaveProperty("evaluation");
    expect(config).toHaveProperty("fix");
    expect(config.project).toBe(path.resolve(cwd));
    expect(config.evaluation.enabled).toBe(false);
    // Eval-off: taskTypes/classification omitted from JSON twin (#169).
    expect(config.taskTypes).toBeUndefined();
    expect(config.classification).toBeUndefined();
    expect(config.fix.retryMax).toBe(3);
    expect(config.instructions).toContain("HOME-ORCH");
    expect(config.profiles.some((p) => p.name === "deep")).toBe(true);
    // Profile vendor alone is enough to configure that vendor.
    expect(config.vendors.map((v) => v.id)).toEqual(["fake"]);

    // Parity: prose is exactly the render of the structured config.
    const expected = renderInfoProse(config);
    const actual = proseRes.stdout.endsWith("\n")
      ? proseRes.stdout
      : `${proseRes.stdout}\n`;
    // renderInfoProse ends with a trailing blank line; CLI ensures trailing \n.
    expect(actual).toBe(expected.endsWith("\n") ? expected : `${expected}\n`);
  });

  it("includes rubric summaries in --json when eval is on", async () => {
    const cwd = projectDir();
    writeProject(cwd, {
      ".parley/config.json": JSON.stringify({
        eval: { enabled: true },
        taskTypes: { coding: { rubric: "coding" } },
      }),
    });

    const jsonRes = await runCli(["info", "--json"], home, { cwd });
    expect(jsonRes.code).toBe(0);
    const config = JSON.parse(jsonRes.stdout) as InfoConfig;
    expect(config.evaluation.enabled).toBe(true);
    expect(config.evaluation.rubrics).toBeDefined();
    expect(config.taskTypes?.some((t) => t.id === "coding")).toBe(true);
    expect(config.classification).toBeDefined();
    const coding = config.evaluation.rubrics?.find((r) => r.type === "coding");
    expect(coding).toBeDefined();
    expect(coding!.rubricId).toBe("coding");
    expect(coding!.criteria.some((c) => c.id === "brief-implemented")).toBe(true);
    expect(config.evaluation.howTo?.command).toMatch(/parley eval/);

    const prose = await runCli(["info"], home, { cwd });
    expect(prose.stdout).toContain("brief-implemented");
    expect(renderInfoProse(config).trimEnd()).toBe(prose.stdout.trimEnd());
  });
});

describe("parley info — remote-safe project root (#163)", () => {
  it("resolves project from CLI cwd (absolute path in --json), not daemon home", async () => {
    const cwd = projectDir();
    writeProject(cwd, {
      ".parley/orchestrator/PROMPT.md": "FROM-PROJECT-CWD",
      ".parley/config.json": JSON.stringify({
        eval: { enabled: true },
        taskTypes: { design: { rubric: "design" } },
      }),
    });
    // Poison the daemon home with different project-shaped content that must
    // not be read as the project layer (project layers live under cwd/.parley).
    writeFiles(home, {
      "orchestrator/PROMPT.md": "FROM-DAEMON-HOME",
    });

    const jsonRes = await runCli(["info", "--json"], home, { cwd });
    expect(jsonRes.code).toBe(0);
    const config = JSON.parse(jsonRes.stdout) as InfoConfig;
    expect(config.project).toBe(path.resolve(cwd));
    expect(config.instructions).toContain("FROM-PROJECT-CWD");
    expect(config.instructions).toContain("FROM-DAEMON-HOME"); // home layer still compounds
    expect(config.taskTypes?.some((t) => t.id === "design")).toBe(true);
    expect(config.taskTypes?.some((t) => t.id === "coding")).toBe(false);
  });

  it("usage: rejects unexpected positionals (exit 2)", async () => {
    const res = await runCli(["info", "extra"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/unexpected argument/);
  });
});
