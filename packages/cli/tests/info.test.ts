/**
 * CLI integration: `parley info` effective configuration (#163 / #169).
 *
 * Seam: real daemon + fake vendor. Asserts section headers against fixture
 * project/daemon configs, eval-related omission when off, configured vendors
 * only, prose/--json parity, and that the project root is sent explicitly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderInfoProse, type InfoConfig } from "@useparley/daemon/info.js";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  runCli,
  withFakeAllowlist,
  writeFiles,
} from "./helpers.js";

let home: string;
const scratch: string[] = [];

beforeEach(() => {
  home = makeHome({ seedAllowlist: false });
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

function vendorPath(...vendors: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-info-path-"));
  scratch.push(dir);
  for (const vendor of vendors) {
    const file = path.join(dir, vendor);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

describe("parley info — sections from live config (#163 / #169)", () => {
  it("lists PATH-detected vendors separately and explains the allowlist requirement", async () => {
    const cwd = projectDir();
    const detectedPath = vendorPath("codex", "grok");

    const prose = await runCli(["info"], home, {
      cwd,
      extraEnv: { PATH: detectedPath, PARLEY_FAKE_VENDOR_BIN: "" },
    });
    expect(prose.code).toBe(0);
    expect(prose.stdout).toContain("(none configured");
    expect(prose.stdout).toContain("### Detected, unconfigured vendors");
    expect(prose.stdout).toContain("`codex` — detected on PATH");
    expect(prose.stdout).toContain("`grok` — detected on PATH");
    expect(prose.stdout).toMatch(/delegation is denied until a model allowlist is configured/);
    expect(prose.stdout).toContain("/parley-wizard");

    const json = await runCli(["info", "--json"], home, {
      cwd,
      extraEnv: { PATH: detectedPath, PARLEY_FAKE_VENDOR_BIN: "" },
    });
    expect(json.code).toBe(0);
    const config = JSON.parse(json.stdout) as InfoConfig;
    expect(config.vendors).toEqual([]);
    expect(config.detected_vendors).toEqual(["codex", "grok"]);
  });

  it("excludes configured vendors from the detected, unconfigured group", async () => {
    const cwd = projectDir();
    const detectedPath = vendorPath("codex", "grok");
    writeFiles(home, {
      "parley.json": JSON.stringify({
        vendors: {
          codex: { models: { "gpt-5": { efforts: ["high"] } } },
        },
      }),
    });

    const res = await runCli(["info", "--json"], home, {
      cwd,
      extraEnv: { PATH: detectedPath, PARLEY_FAKE_VENDOR_BIN: "" },
    });
    expect(res.code).toBe(0);
    const config = JSON.parse(res.stdout) as InfoConfig;
    expect(config.vendors.map((vendor) => vendor.id)).toEqual(["codex"]);
    expect(config.detected_vendors).toEqual(["grok"]);
  });

  it("keeps an explicit empty configured state and wizard hint when nothing is detected", async () => {
    const cwd = projectDir();
    const emptyPath = vendorPath();
    const res = await runCli(["info"], home, {
      cwd,
      extraEnv: { PATH: emptyPath, PARLEY_FAKE_VENDOR_BIN: "" },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("(none configured");
    expect(res.stdout).toContain("/parley-wizard");
    expect(res.stdout).toContain("(none detected on PATH)");
  });

  it("renders all six section headers against fixture configs when eval is on", async () => {
    const cwd = projectDir();
    writeFiles(home, {
      "parley.json": JSON.stringify(
        withFakeAllowlist({
          profiles: {
            fast: { vendor: "fake", model: "m-fast", effort: "low" },
          },
          vendors: {
            fake: {
              childChannel: "cli",
              retryWindow: "45m",
              models: {
                "fake-model": {
                  efforts: ["low", "medium"],
                  default: "medium",
                  hint: "info fixture",
                },
                "m-fast": { efforts: ["low", "medium", "high"] },
              },
            },
          },
          defaults: { profile: "fast", vendor: "fake" },
        }),
      ),
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
    expect(out).toContain("`fake-model`");
    expect(out).toMatch(/default@medium/);
    expect(out).toMatch(/hint: info fixture/);
    expect(out).toContain("`fast`");
    expect(out).toMatch(/vendor=fake/);
    expect(out).toMatch(/model=m-fast/);
    expect(out).toContain("### Defaults");
    expect(out).toMatch(/profile: `fast`/);
    expect(out).toMatch(/vendor: `fake`/);
    const configuredSection = out.slice(
      out.indexOf("### Vendors"),
      out.indexOf("### Detected, unconfigured vendors"),
    );
    expect(configuredSection).not.toContain("`claude`");
    expect(configuredSection).not.toContain("`codex`");

    // Task types from project + automatic other.
    expect(out).toContain("`coding` → rubric `coding`");
    expect(out).toContain("`research` → rubric `research`");
    expect(out).toMatch(/`other` → rubric `generic`.*automatic fallback/s);

    // Classification guidance from project file.
    expect(out).toContain("`S`: Small fixture size.");
    expect(out).toContain("`easy`: Easy fixture difficulty.");
    expect(out).not.toContain("`XS`"); // shipped defaults replaced

    // Evaluation on: how-to + path refs (criteria live in rubric files).
    expect(out).toMatch(/Evaluation is \*\*on\*\*/);
    expect(out).toContain("parley eval <task> --answers");
    expect(out).toContain(".parley/rubrics-md/coding.md");
    expect(out).not.toContain("#### `coding`");
    expect(out).not.toContain("brief-implemented");
    expect(out).not.toContain("broke-existing");

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

  it("includes rubric path refs in --json when eval is on and writes slim md", async () => {
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
    expect(coding!.path).toBe(".parley/rubrics-md/coding.md");
    expect(coding!).not.toHaveProperty("criteria");
    expect(coding!).not.toHaveProperty("version");
    expect(coding!).not.toHaveProperty("baseline");
    expect(config.evaluation.howTo?.command).toMatch(/parley eval/);

    // Materialized files under project.
    const codingMdPath = path.join(cwd, ".parley", "rubrics-md", "coding.md");
    expect(fs.existsSync(codingMdPath)).toBe(true);
    const codingMd = fs.readFileSync(codingMdPath, "utf8");
    expect(codingMd).toMatch(/^- `brief-implemented`: /m);
    expect(codingMd).toMatch(/^- `broke-existing`: /m);
    for (const line of codingMd.trimEnd().split("\n")) {
      expect(line).toMatch(/^- `[a-z0-9-]+`: .+/);
    }
    const gi = fs.readFileSync(path.join(cwd, ".parley", ".gitignore"), "utf8");
    expect(gi.split(/\r?\n/).map((l) => l.trim())).toContain("rubrics-md/");

    const prose = await runCli(["info"], home, { cwd });
    expect(prose.stdout).toContain(".parley/rubrics-md/coding.md");
    expect(prose.stdout).not.toContain("brief-implemented");
    expect(renderInfoProse(config).trimEnd()).toBe(prose.stdout.trimEnd());
  });

  it("does not write rubrics-md when eval is off", async () => {
    const cwd = projectDir();
    // Default eval off — no config.
    const res = await runCli(["info"], home, { cwd });
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(cwd, ".parley", "rubrics-md"))).toBe(false);
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


describe("parley info — layered config (#178)", () => {
  it("eval only in global parley.json shows on via GET /config merge", async () => {
    const cwd = projectDir();
    writeFiles(home, {
      "parley.json": JSON.stringify({ eval: { enabled: true } }),
    });
    // Empty project — no .parley/config.json
    const res = await runCli(["info"], home, { cwd });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Evaluation is \*\*on\*\*/);
    expect(res.stdout).toContain("source: global");

    const jsonRes = await runCli(["info", "--json"], home, { cwd });
    expect(jsonRes.code).toBe(0);
    const config = JSON.parse(jsonRes.stdout) as InfoConfig;
    expect(config.evaluation.enabled).toBe(true);
    expect(config.provenance.evaluation).toBe("global");
  });

  it("project eval.enabled false overrides global true", async () => {
    const cwd = projectDir();
    writeFiles(home, {
      "parley.json": JSON.stringify({ eval: { enabled: true }, retry: { max: 4 } }),
    });
    writeProject(cwd, {
      ".parley/config.json": JSON.stringify({
        eval: { enabled: false },
        retry: { max: 2 },
      }),
    });
    const jsonRes = await runCli(["info", "--json"], home, { cwd });
    expect(jsonRes.code).toBe(0);
    const config = JSON.parse(jsonRes.stdout) as InfoConfig;
    expect(config.evaluation.enabled).toBe(false);
    expect(config.fix.retryMax).toBe(2);
    expect(config.provenance.evaluation).toBe("project");
    expect(config.provenance.retryMax).toBe("project");
  });

  it("deep merge: partial project inherits global eval and retry.window", async () => {
    const cwd = projectDir();
    writeFiles(home, {
      "config.json": JSON.stringify({
        eval: { enabled: true },
        retry: { max: 5, window: "1h" },
      }),
    });
    writeProject(cwd, {
      ".parley/config.json": JSON.stringify({ retry: { max: 2 } }),
    });
    const jsonRes = await runCli(["info", "--json"], home, { cwd });
    expect(jsonRes.code).toBe(0);
    const config = JSON.parse(jsonRes.stdout) as InfoConfig;
    expect(config.evaluation.enabled).toBe(true);
    expect(config.fix.retryMax).toBe(2);
    expect(config.fix.retryWindowMs).toBe(3_600_000);
    expect(config.provenance.evaluation).toBe("global");
    expect(config.provenance.retryMax).toBe("project");
    expect(config.provenance.retryWindow).toBe("global");

    const prose = await runCli(["info"], home, { cwd });
    expect(prose.stdout).toMatch(/Evaluation is \*\*on\*\*/);
    expect(prose.stdout).toMatch(/retry\.max: \*\*2\*\*/);
    // Prose/--json parity via same layered config.
    expect(renderInfoProse(config).trimEnd()).toBe(prose.stdout.trimEnd());
  });
});
