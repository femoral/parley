import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import {
  isInteractiveInit,
  populateInitConfig,
  promptVendorModels,
  seedVendorModels,
} from "../src/commands/init.js";
import { PromptCancelled } from "../src/commands/skills/prompts.js";
import { listBundledPlugins } from "../src/commands/plugins/list.js";
import { cleanupHome, FAKE_VENDOR_BIN, makeHome, runCli } from "./helpers.js";

/** Sentinel returned by mocked clack prompts to simulate cancel. */
const { CANCEL } = vi.hoisted(() => ({ CANCEL: Symbol("clack-cancel") }));

vi.mock("@clack/prompts", () => ({
  multiselect: vi.fn(),
  select: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL,
  MULTISELECT_INSTRUCTIONS: [] as string[],
}));

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
  home = makeHome({ seedAllowlist: false });
  temps = [];
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parley init", () => {
  it("enumerates the first-party provenance plugins separately from adapters", () => {
    expect(listBundledPlugins().map((plugin) => [plugin.harness, plugin.packageName])).toEqual([
      ["claude", "@useparley/plugin-claude-code"],
      ["codex", "@useparley/plugin-codex"],
      ["grok", "@useparley/plugin-grok"],
      ["pi", "@useparley/plugin-pi"],
    ]);
  });

  it("seeds every effort and exactly one model default", () => {
    const models = seedVendorModels([
      { id: "one", efforts: ["low", "high"], default_effort: "high" },
      { id: "two", efforts: [], default_effort: null },
    ]);
    expect(models).toEqual({
      one: { efforts: ["low", "high"], default: "high" },
      two: { efforts: [] },
    });
    expect(Object.values(models).filter((model) => model.default !== undefined)).toHaveLength(1);
  });

  it("accepts an explicit default effort instead of deriving via defaultMarker", () => {
    const models = seedVendorModels(
      [
        { id: "one", efforts: ["low", "medium", "high"], default_effort: "high" },
        { id: "two", efforts: ["low"], default_effort: null },
      ],
      ["one", "two"],
      "one",
      "low",
    );
    expect(models).toEqual({
      one: { efforts: ["low", "medium", "high"], default: "low" },
      two: { efforts: ["low"] },
    });
  });

  it("narrows a model's efforts via effortsById and derives the marker from the allowed set", () => {
    const models = seedVendorModels(
      [
        { id: "one", efforts: ["low", "medium", "high"], default_effort: "low" },
        { id: "two", efforts: ["low", "high"], default_effort: null },
      ],
      ["one", "two"],
      "one",
      undefined,
      { one: ["medium", "high"], two: ["low"] },
    );
    expect(models).toEqual({
      // Catalog default_effort "low" is no longer allowed → first allowed effort.
      one: { efforts: ["medium", "high"], default: "medium" },
      two: { efforts: ["low"] },
    });
  });

  it("falls back to defaultMarker when default effort is not passed", () => {
    // Non-interactive path: single-arg seed must remain derivation-only.
    const models = seedVendorModels([
      { id: "multi", efforts: ["low", "high"], default_effort: "high" },
      { id: "single", efforts: ["max"], default_effort: null },
      { id: "none", efforts: [], default_effort: null },
    ]);
    expect(models).toEqual({
      multi: { efforts: ["low", "high"], default: "high" },
      single: { efforts: ["max"] },
      none: { efforts: [] },
    });
  });

  describe("promptVendorModels", () => {
    beforeEach(() => {
      vi.mocked(p.multiselect).mockReset();
      vi.mocked(p.select).mockReset();
    });

    it("starts the model multiselect deselected and surfaces a/i in the instructions footer", async () => {
      const catalog = [{ id: "solo", efforts: ["low"], default_effort: null }];
      vi.mocked(p.multiselect).mockResolvedValueOnce(["solo"]);
      vi.mocked(p.select).mockResolvedValueOnce("solo");

      await promptVendorModels("fake", catalog);

      const modelCall = vi.mocked(p.multiselect).mock.calls[0]![0] as {
        message: string;
        initialValues: string[];
      };
      expect(modelCall.message).toBe("fake: models to allow");
      expect(modelCall.initialValues).toEqual([]);
      // Footer hints installed exactly once, no matter how often init prompts.
      const shortcuts = (p as unknown as { MULTISELECT_INSTRUCTIONS: string[] })
        .MULTISELECT_INSTRUCTIONS;
      expect(shortcuts.filter((entry) => entry.includes("toggle all"))).toHaveLength(1);
      expect(shortcuts.filter((entry) => entry.includes("invert"))).toHaveLength(1);
    });

    it("prompts opt-in efforts per selected multi-effort model, then the default effort", async () => {
      const catalog = [
        { id: "a", efforts: ["low", "medium", "high"], default_effort: "medium" },
        { id: "b", efforts: ["low"], default_effort: null },
      ];
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["a", "b"]) // models
        .mockResolvedValueOnce(["medium", "high"]); // efforts for "a"
      vi.mocked(p.select)
        .mockResolvedValueOnce("a") // default model
        .mockResolvedValueOnce("high"); // default effort

      const allowlist = await promptVendorModels("fake", catalog);

      expect(p.multiselect).toHaveBeenCalledTimes(2);
      const effortsCall = vi.mocked(p.multiselect).mock.calls[1]![0] as {
        message: string;
        options: { value: string; hint?: string }[];
        initialValues: string[];
      };
      expect(effortsCall.message).toBe("fake: efforts to allow for a");
      expect(effortsCall.options.map((o) => o.value)).toEqual(["low", "medium", "high"]);
      expect(effortsCall.options.find((o) => o.value === "medium")?.hint).toBe("catalog default");
      // Opt-in: nothing preselected.
      expect(effortsCall.initialValues).toEqual([]);

      expect(p.select).toHaveBeenCalledTimes(2);
      const effortCall = vi.mocked(p.select).mock.calls[1]![0] as {
        message: string;
        options: { value: string }[];
        initialValue: string;
      };
      expect(effortCall.message).toBe("fake: default effort for a");
      // Only the allowed efforts are offered; catalog default_effort pre-selected.
      expect(effortCall.options.map((o) => o.value)).toEqual(["medium", "high"]);
      expect(effortCall.initialValue).toBe("medium");
      expect(allowlist).toEqual({
        a: { efforts: ["medium", "high"], default: "high" },
        b: { efforts: ["low"] },
      });
    });

    it("pre-selects the first allowed effort when the catalog default is not allowed", async () => {
      const catalog = [{ id: "solo", efforts: ["low", "medium", "high"], default_effort: "low" }];
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["solo"])
        .mockResolvedValueOnce(["medium", "high"]);
      vi.mocked(p.select).mockResolvedValueOnce("solo").mockResolvedValueOnce("medium");

      await promptVendorModels("codex", catalog);

      const effortCall = vi.mocked(p.select).mock.calls[1]![0] as { initialValue: string };
      expect(effortCall.initialValue).toBe("medium");
    });

    it("skips the default-effort select when only one effort is allowed", async () => {
      const catalog = [{ id: "a", efforts: ["low", "high"], default_effort: "low" }];
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["a"])
        .mockResolvedValueOnce(["high"]); // narrow to one effort
      vi.mocked(p.select).mockResolvedValueOnce("a");

      const allowlist = await promptVendorModels("fake", catalog);

      expect(p.select).toHaveBeenCalledTimes(1);
      // Single allowed effort → defaultMarker yields true.
      expect(allowlist).toEqual({
        a: { efforts: ["high"], default: true },
      });
    });

    it("skips the effort prompts entirely for single- and zero-effort models", async () => {
      const catalog = [
        { id: "one-effort", efforts: ["high"], default_effort: null },
        { id: "effortless", efforts: [], default_effort: null },
      ];
      vi.mocked(p.multiselect).mockResolvedValueOnce(["one-effort", "effortless"]);
      vi.mocked(p.select).mockResolvedValueOnce("one-effort");

      const allowlist = await promptVendorModels("pi", catalog);

      expect(p.multiselect).toHaveBeenCalledTimes(1);
      expect(p.select).toHaveBeenCalledTimes(1);
      expect(allowlist).toEqual({
        "one-effort": { efforts: ["high"], default: true },
        effortless: { efforts: [] },
      });
    });

    it("throws PromptCancelled when the per-model efforts prompt is cancelled", async () => {
      const catalog = [{ id: "a", efforts: ["low", "high"], default_effort: "low" }];
      vi.mocked(p.multiselect).mockResolvedValueOnce(["a"]).mockResolvedValueOnce(CANCEL);

      await expect(promptVendorModels("fake", catalog)).rejects.toBeInstanceOf(PromptCancelled);
    });

    it("throws PromptCancelled when the default-effort prompt is cancelled", async () => {
      const catalog = [{ id: "a", efforts: ["low", "high"], default_effort: "low" }];
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["a"])
        .mockResolvedValueOnce(["low", "high"]);
      vi.mocked(p.select).mockResolvedValueOnce("a").mockResolvedValueOnce(CANCEL);

      await expect(promptVendorModels("fake", catalog)).rejects.toBeInstanceOf(PromptCancelled);
    });
  });

  it("populates missing delegation config without clobbering existing values", async () => {
    const existing = { efforts: ["max"], default: "max" as const };
    const result = await populateInitConfig({
      config: {
        vendors: { codex: { bin: "/custom/codex", models: { custom: existing } } },
        profiles: { reviewer: { vendor: "codex" } },
        defaults: { vendor: "codex" },
      },
      harnesses: ["codex", "fake"],
      catalog: {},
      interactive: false,
    });
    expect(result.config.vendors?.codex).toEqual({
      bin: "/custom/codex",
      models: { custom: existing },
    });
    expect(result.config.vendors?.fake?.models?.["fake-model"]).toEqual({
      efforts: ["low", "medium", "high"],
      default: "medium",
    });
    expect(result.config.defaults).toEqual({ vendor: "codex", profile: "reviewer" });
  });

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
    // Init writes an authoritative allowlist and defaults into daemon-home config.
    const homeCfg = JSON.parse(fs.readFileSync(path.join(home, "parley.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(homeCfg).toEqual(expect.any(Object));
    expect(homeCfg).toMatchObject({
      vendors: {
        fake: {
          models: {
            "fake-model": { efforts: ["low", "medium", "high"], default: "medium" },
          },
        },
      },
      defaults: { vendor: "fake" },
    });
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
