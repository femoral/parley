import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { loadWorkflowDefinition } from "@useparley/core";
import {
  EXAMPLE_WORKFLOW_IDS,
  isInteractiveInit,
  cliSelectionDefaultEffort,
  modelsWithCliSelection,
  populateInitConfig,
  promptVendorModels,
  seedExampleWorkflows,
  seedVendorModels,
  workflowSeedsSourceDir,
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

  describe("modelsWithCliSelection (#284)", () => {
    it("injects a missing CLI selection so empty catalogs can pre-fill", () => {
      expect(
        modelsWithCliSelection([], { model: "cli-model", effort: "high" }),
      ).toEqual([
        { id: "cli-model", efforts: ["high"], default_effort: "high" },
      ]);
    });

    it("leaves the list unchanged when selection is null", () => {
      const models = [{ id: "a", efforts: ["low"], default_effort: null }];
      expect(modelsWithCliSelection(models, null)).toEqual(models);
    });

    it("does not inject a disk-only effort onto an existing catalog entry (ADR-0014)", () => {
      // Disk effort "high" is not in the catalog — must not widen the list.
      // A regression that re-adds it would let non-interactive init write it
      // into the authoritative allowlist as default.
      const models = [{ id: "a", efforts: ["low"], default_effort: null }];
      expect(
        modelsWithCliSelection(models, { model: "a", effort: "high" }),
      ).toEqual([{ id: "a", efforts: ["low"], default_effort: null }]);
    });

    it("does not inject an unknown model into a non-empty catalog", () => {
      // Catalogued vendors keep their list; we never invent a brand-new key
      // from disk for them (empty-catalog inject only).
      const models = [{ id: "a", efforts: ["low"], default_effort: null }];
      expect(
        modelsWithCliSelection(models, { model: "brand-new-from-disk", effort: "high" }),
      ).toEqual(models);
    });

    it("refuses adversarial model ids (newline/ANSI) — no inject", () => {
      // Load-bearing: a poisoned vendor file must not become an allowlist key.
      // Fails against the pre-fix inject that wrote disk strings verbatim.
      const sneaky =
        "goose-model\n\x1b[1;31m>>> ALL MODELS ALLOWED <<<\x1b[0m\nx";
      expect(
        modelsWithCliSelection([], { model: sneaky, effort: "high" }),
      ).toEqual([]);
    });

    it("refuses unsafe effort on an empty-catalog inject", () => {
      expect(
        modelsWithCliSelection([], {
          model: "deepseek-v4-flash",
          effort: "high\n>>> injected",
        }),
      ).toEqual([
        { id: "deepseek-v4-flash", efforts: [], default_effort: null },
      ]);
    });
  });

  describe("cliSelectionDefaultEffort (#284)", () => {
    it("accepts effort only when present on the pre-injection catalog entry", () => {
      const catalog = [
        { id: "kwaipilot/kat-coder", efforts: ["low", "high"], default_effort: "low" },
      ];
      expect(
        cliSelectionDefaultEffort(catalog, {
          model: "kwaipilot/kat-coder",
          effort: "high",
        }),
      ).toBe("high");
      // Disk-only effort — not in catalog — must not become the default.
      expect(
        cliSelectionDefaultEffort(catalog, {
          model: "kwaipilot/kat-coder",
          effort: "ultra-max",
        }),
      ).toBeUndefined();
    });

    it("accepts the CLI effort when the model is a pure empty-catalog inject", () => {
      // goose/openhands: empty catalog + selection → deliberate allowlist seed.
      expect(
        cliSelectionDefaultEffort([], { model: "deepseek-v4-flash", effort: "medium" }),
      ).toBe("medium");
    });

    it("rejects unsafe effort tokens even on the empty-catalog path", () => {
      expect(
        cliSelectionDefaultEffort([], {
          model: "deepseek-v4-flash",
          effort: "xhigh\nALL",
        }),
      ).toBeUndefined();
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

      await promptVendorModels("fake", catalog);

      const modelCall = vi.mocked(p.multiselect).mock.calls[0]![0] as {
        message: string;
        initialValues: string[];
      };
      expect(modelCall.message).toBe("fake: models to allow (submit empty to skip)");
      expect(modelCall.initialValues).toEqual([]);
      // Footer hints installed exactly once, no matter how often init prompts.
      const shortcuts = (p as unknown as { MULTISELECT_INSTRUCTIONS: string[] })
        .MULTISELECT_INSTRUCTIONS;
      expect(shortcuts.filter((entry) => entry.includes("toggle all"))).toHaveLength(1);
      expect(shortcuts.filter((entry) => entry.includes("invert"))).toHaveLength(1);
    });

    it("pre-fills the multiselect and default effort from CLI selection (#284)", async () => {
      const catalog = [
        { id: "a", efforts: ["low", "medium", "high"], default_effort: "medium" },
        { id: "b", efforts: ["low"], default_effort: null },
      ];
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["a"]) // operator keeps the pre-fill
        .mockResolvedValueOnce(["medium", "high"]); // keep multiple efforts
      // Single model → no default-model select; default effort uses CLI initial.
      vi.mocked(p.select).mockResolvedValueOnce("high");

      const allowlist = await promptVendorModels("cline", catalog, {
        model: "a",
        effort: "high",
      });

      const modelCall = vi.mocked(p.multiselect).mock.calls[0]![0] as {
        message: string;
        initialValues: string[];
      };
      expect(modelCall.initialValues).toEqual(["a"]);
      // Prompt must not claim "submit empty to skip" when Enter accepts the pre-fill.
      expect(modelCall.message).toMatch(/CLI selection pre-filled/);
      expect(modelCall.message).toMatch(/deselect all and submit empty to skip/);
      const effortsCall = vi.mocked(p.multiselect).mock.calls[1]![0] as {
        initialValues: string[];
      };
      expect(effortsCall.initialValues).toEqual(["high"]);
      const effortCall = vi.mocked(p.select).mock.calls[0]![0] as {
        initialValue: string;
      };
      // CLI effort "high" wins over catalog default "medium" as the initial value.
      expect(effortCall.initialValue).toBe("high");
      expect(allowlist).toEqual({
        a: { efforts: ["medium", "high"], default: "high" },
      });
    });

    it("behaves as today when CLI selection is unreadable (null)", async () => {
      const catalog = [{ id: "solo", efforts: ["low", "high"], default_effort: "low" }];
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["solo"])
        .mockResolvedValueOnce([]);
      vi.mocked(p.select).mockResolvedValueOnce("low");

      await promptVendorModels("goose", catalog, null);

      const modelCall = vi.mocked(p.multiselect).mock.calls[0]![0] as {
        initialValues: string[];
      };
      expect(modelCall.initialValues).toEqual([]);
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
      expect(effortsCall.message).toBe("fake: efforts to allow for a (submit empty to keep all)");
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
      // Single selected model → the default-model select is skipped, so the
      // only select is the default effort.
      vi.mocked(p.select).mockResolvedValueOnce("medium");

      await promptVendorModels("codex", catalog);

      expect(p.select).toHaveBeenCalledTimes(1);
      const effortCall = vi.mocked(p.select).mock.calls[0]![0] as { initialValue: string };
      expect(effortCall.initialValue).toBe("medium");
    });

    it("skips the default-effort select when only one effort is allowed", async () => {
      const catalog = [{ id: "a", efforts: ["low", "high"], default_effort: "low" }];
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["a"])
        .mockResolvedValueOnce(["high"]); // narrow to one effort

      const allowlist = await promptVendorModels("fake", catalog);

      // Single model and single allowed effort → no selects at all.
      expect(p.select).not.toHaveBeenCalled();
      expect(allowlist).toEqual({
        a: { efforts: ["high"], default: true },
      });
    });

    it("returns null when the model multiselect is submitted empty", async () => {
      const catalog = [{ id: "a", efforts: ["low", "high"], default_effort: "low" }];
      vi.mocked(p.multiselect).mockResolvedValueOnce([]);

      const allowlist = await promptVendorModels("fake", catalog);

      expect(allowlist).toBeNull();
      expect(p.multiselect).toHaveBeenCalledTimes(1);
      expect(p.select).not.toHaveBeenCalled();
    });

    it("keeps all catalog efforts when the effort multiselect is submitted empty", async () => {
      const catalog = [{ id: "a", efforts: ["low", "high"], default_effort: "high" }];
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["a"])
        .mockResolvedValueOnce([]); // continue without narrowing
      vi.mocked(p.select).mockResolvedValueOnce("high"); // default effort over full set

      const allowlist = await promptVendorModels("fake", catalog);

      expect(allowlist).toEqual({
        a: { efforts: ["low", "high"], default: "high" },
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
      // Single model → no default-model select; first select is the effort.
      vi.mocked(p.select).mockResolvedValueOnce(CANCEL);

      await expect(promptVendorModels("fake", catalog)).rejects.toBeInstanceOf(PromptCancelled);
    });
  });

  describe("interactive vendor picker", () => {
    beforeEach(() => {
      vi.mocked(p.multiselect).mockReset();
      vi.mocked(p.select).mockReset();
    });

    const catalog = {
      fake: {
        fetched_at: null,
        source: "stub",
        models: [{ id: "fake-model", efforts: ["low", "high"], default_effort: "low" }],
      },
      other: {
        fetched_at: null,
        source: "stub",
        models: [{ id: "other-model", efforts: [], default_effort: null }],
      },
    };

    it("prompts which vendors to configure and only walks the chosen ones", async () => {
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["fake"]) // vendor picker
        .mockResolvedValueOnce(["fake-model"]) // models for fake
        .mockResolvedValueOnce([]); // efforts: keep all
      vi.mocked(p.select).mockResolvedValueOnce("high"); // default effort

      const result = await populateInitConfig({
        config: {},
        harnesses: ["fake", "other"],
        catalog,
        interactive: true,
      });

      const pickerCall = vi.mocked(p.multiselect).mock.calls[0]![0] as {
        message: string;
        options: { value: string; hint?: string }[];
        initialValues: string[];
      };
      expect(pickerCall.message).toBe("vendors to configure (submit empty to skip)");
      expect(pickerCall.options.map((o) => o.value)).toEqual(["fake", "other"]);
      expect(pickerCall.initialValues).toEqual([]);
      expect(result.configuredVendors).toEqual(["fake"]);
      expect(result.config.vendors).toEqual({
        fake: { models: { "fake-model": { efforts: ["low", "high"], default: "high" } } },
      });
      expect(result.config.defaults?.vendor).toBe("fake");
    });

    it("non-interactive seeds use CLI selection as default when present (#284)", async () => {
      const adapters = new Map([
        [
          "fake",
          {
            id: "fake",
            readSelectedModel: () => ({ model: "fake-model", effort: "high" }),
          },
        ],
      ]) as never;
      const result = await populateInitConfig({
        config: {},
        harnesses: ["fake"],
        catalog,
        interactive: false,
        adapters,
      });
      expect(result.config.vendors?.fake?.models).toEqual({
        "fake-model": { efforts: ["low", "high"], default: "high" },
      });
    });

    it("non-interactive does not write a disk-only effort into the allowlist (#284)", async () => {
      // Catalog knows low/high; CLI reports ultra-max. Guard must use the
      // pre-injection catalog — a vacuous post-injection check would pass and
      // mark ultra-max as default (ADR-0014 regression).
      const adapters = new Map([
        [
          "fake",
          {
            id: "fake",
            readSelectedModel: () => ({
              model: "fake-model",
              effort: "ultra-max",
            }),
          },
        ],
      ]) as never;
      const result = await populateInitConfig({
        config: {},
        harnesses: ["fake"],
        catalog,
        interactive: false,
        adapters,
      });
      const entry = result.config.vendors?.fake?.models?.["fake-model"];
      expect(entry?.efforts).toEqual(["low", "high"]);
      expect(entry?.efforts).not.toContain("ultra-max");
      // Default falls back to catalog marker (not ultra-max).
      expect(entry?.default).not.toBe("ultra-max");
    });

    it("non-interactive empty-catalog vendor becomes delegatable from CLI selection", async () => {
      // Deliberate: goose/openhands ship models:[] — with a readable selection
      // they gain a one-entry allowlist so setup pre-fill is useful.
      const adapters = new Map([
        [
          "goose",
          {
            id: "goose",
            readSelectedModel: () => ({
              model: "deepseek-v4-flash",
              effort: null,
            }),
          },
        ],
      ]) as never;
      const result = await populateInitConfig({
        config: {},
        harnesses: ["goose"],
        catalog: {}, // empty shipped catalog for goose
        interactive: false,
        adapters,
      });
      expect(result.config.vendors?.goose?.models).toEqual({
        "deepseek-v4-flash": { efforts: [], default: true },
      });
    });

    it("non-interactive refuses to seed an adversarial CLI model id (#284)", async () => {
      // Load-bearing security: disk string with newline/ANSI must never become
      // a vendors.<id>.models key (would later print raw via formatAllowedCombos).
      const sneaky =
        "goose-model\n\x1b[1;31m>>> ALL MODELS ALLOWED <<<\x1b[0m\nx";
      const adapters = new Map([
        [
          "goose",
          {
            id: "goose",
            readSelectedModel: () => ({ model: sneaky, effort: null }),
          },
        ],
      ]) as never;
      const result = await populateInitConfig({
        config: {},
        harnesses: ["goose"],
        catalog: {},
        interactive: false,
        adapters,
      });
      // Unreadable/unsafe selection → same as no selection: no vendor models.
      expect(result.config.vendors?.goose?.models).toBeUndefined();
      expect(JSON.stringify(result.config)).not.toContain("ALL MODELS");
      expect(JSON.stringify(result.config)).not.toContain("\x1b");
    });

    it("submitting an empty vendor pick shortcuts vendor configuration", async () => {
      vi.mocked(p.multiselect).mockResolvedValueOnce([]);

      const result = await populateInitConfig({
        config: {},
        harnesses: ["fake", "other"],
        catalog,
        interactive: true,
      });

      expect(p.multiselect).toHaveBeenCalledTimes(1);
      expect(result.configuredVendors).toEqual([]);
      expect(result.config.vendors).toBeUndefined();
      expect(result.changed).toBe(false);
    });

    it("a vendor skipped at the model prompt is not marked configured", async () => {
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["fake", "other"]) // vendor picker
        .mockResolvedValueOnce([]) // fake: submit empty models → skip
        .mockResolvedValueOnce(["other-model"]); // other: pick its model

      const result = await populateInitConfig({
        config: {},
        harnesses: ["fake", "other"],
        catalog,
        interactive: true,
      });

      expect(result.configuredVendors).toEqual(["other"]);
      expect(result.config.vendors).toEqual({
        other: { models: { "other-model": { efforts: [], default: true } } },
      });
      expect(result.config.defaults?.vendor).toBe("other");
    });

    it("does not prompt for vendors that already have models configured", async () => {
      const existing = { efforts: ["max"], default: "max" as const };
      vi.mocked(p.multiselect)
        .mockResolvedValueOnce(["other"])
        .mockResolvedValueOnce(["other-model"]);

      const result = await populateInitConfig({
        config: { vendors: { fake: { models: { custom: existing } } } },
        harnesses: ["fake", "other"],
        catalog,
        interactive: true,
      });

      const pickerCall = vi.mocked(p.multiselect).mock.calls[0]![0] as {
        options: { value: string }[];
      };
      expect(pickerCall.options.map((o) => o.value)).toEqual(["other"]);
      expect(result.configuredVendors).toEqual(["fake", "other"]);
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
      workflows: {
        seeds: { id: string; dest: string; status: string }[];
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

    // Example workflows seeded under the project layer.
    expect(out.workflows.seeds.map((s) => s.id).sort()).toEqual([...EXAMPLE_WORKFLOW_IDS].sort());
    for (const seed of out.workflows.seeds) {
      expect(seed.status).toBe("created");
      expect(fs.existsSync(path.join(seed.dest, "workflow.json"))).toBe(true);
    }
    expect(fs.existsSync(path.join(repo, ".parley", "workflows", "coding-1", "workflow.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(repo, ".parley", "workflows", "research", "types", "source.schema.json"))).toBe(
      true,
    );
    // Prompt bodies ship with the seeds (not stubs).
    expect(
      fs.readFileSync(path.join(repo, ".parley", "workflows", "coding-1", "prompts", "plan.md"), "utf8")
        .length,
    ).toBeGreaterThan(100);

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

  it("does not overwrite an existing .parley/workflows/<id>/", async () => {
    const repo = makeRepo();
    const custom = path.join(repo, ".parley", "workflows", "coding-1");
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, "workflow.json"), '{"id":"coding-1","user":"owned"}\n');
    fs.writeFileSync(path.join(custom, "KEEP.md"), "do not clobber\n");

    const res = await runCli(["init", "--json", "--yes"], home, {
      cwd: repo,
      extraEnv: {
        HOME: mkTemp("parley-init-ow-"),
        PATH: pathWithGitOnly(),
        PARLEY_FAKE_VENDOR_BIN: "",
      },
    });
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as {
      workflows: { seeds: { id: string; status: string }[] };
    };
    const byId = Object.fromEntries(out.workflows.seeds.map((s) => [s.id, s.status]));
    expect(byId["coding-1"]).toBe("skipped");
    expect(byId["coding-2"]).toBe("created");
    expect(byId["research"]).toBe("created");

    expect(fs.readFileSync(path.join(custom, "KEEP.md"), "utf8")).toBe("do not clobber\n");
    expect(fs.readFileSync(path.join(custom, "workflow.json"), "utf8")).toContain("user");
    // Sibling seeds still land.
    expect(fs.existsSync(path.join(repo, ".parley", "workflows", "coding-2", "workflow.json"))).toBe(
      true,
    );
  });

  it("skips workflow seeds when scope is global", async () => {
    const repo = makeRepo();
    const res = await runCli(
      ["init", "--scope", "global", "--layout", "agents", "--json"],
      home,
      {
        cwd: repo,
        extraEnv: {
          HOME: mkTemp("parley-init-wf-global-"),
          PATH: pathWithGitOnly(),
          PARLEY_FAKE_VENDOR_BIN: "",
        },
      },
    );
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as {
      workflows: { seeds: unknown[] };
    };
    expect(out.workflows.seeds).toEqual([]);
    expect(fs.existsSync(path.join(repo, ".parley", "workflows"))).toBe(false);
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

  describe("example workflow seeds", () => {
    it("ships three complete seeds that parse and type-check with no warnings", () => {
      const root = workflowSeedsSourceDir();
      for (const id of EXAMPLE_WORKFLOW_IDS) {
        const dir = path.join(root, id);
        const { definition, warnings } = loadWorkflowDefinition(dir);
        expect(warnings, `${id} should have no parse warnings`).toEqual([]);
        expect(definition.id).toBe(id);
        expect(definition.dir).toBe(path.resolve(dir));
        // Every step prompt path resolves on disk (prompt bodies are the product).
        for (const node of definition.nodes) {
          if (node.kind !== "step") continue;
          const promptPath = path.join(dir, node.prompt);
          expect(fs.existsSync(promptPath), `${id}: missing ${node.prompt}`).toBe(true);
          expect(fs.readFileSync(promptPath, "utf8").trim().length).toBeGreaterThan(40);
          if (node.slots) {
            for (const [slotName, slot] of Object.entries(node.slots)) {
              if (!slot.prompt_append) continue;
              const appendPath = path.join(dir, slot.prompt_append);
              expect(
                fs.existsSync(appendPath),
                `${id} slot ${slotName}: missing ${slot.prompt_append}`,
              ).toBe(true);
            }
          }
        }
      }
    });

    it("seedExampleWorkflows copies missing ids and skips existing ones", () => {
      const dest = mkTemp("parley-wf-seed-");
      const first = seedExampleWorkflows(dest);
      expect(first.map((r) => r.status)).toEqual(["created", "created", "created"]);
      expect(fs.existsSync(path.join(dest, "research", "types", "validation.schema.json"))).toBe(
        true,
      );

      // Mutate one seed destination so a second pass would clobber if buggy.
      const marker = path.join(dest, "coding-2", "USER.md");
      fs.writeFileSync(marker, "mine\n");

      const second = seedExampleWorkflows(dest);
      expect(second.every((r) => r.status === "skipped")).toBe(true);
      expect(fs.readFileSync(marker, "utf8")).toBe("mine\n");
    });
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
