/**
 * Run-start preflight + per-step execution config (ADR-0016 / #239).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseWorkflowDefinition,
  type ParleyConfig,
  type WorkflowDefinition,
  type WorkflowStepNode,
} from "@useparley/core";
import {
  formatRunPreflight,
  mergeStepAndSlot,
  preflightRunStart,
  resolveStepExecution,
  StepConfigError,
} from "../src/run-preflight.js";
import {
  RepoModeRequiresRepoError,
  ScratchBaseRefNotAllowedError,
} from "../src/run-workspace.js";

const scratch: string[] = [];

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(d);
  return d;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function step(partial: Partial<WorkflowStepNode> & { id: string }): WorkflowStepNode {
  return {
    kind: "step",
    prompt: "prompts/x.md",
    in: {},
    out: {},
    ...partial,
  };
}

function baseConfig(overrides: Partial<ParleyConfig> = {}): ParleyConfig {
  return {
    vendors: {
      fake: {
        models: {
          "fake-model": {
            efforts: ["low", "medium", "high"],
            default: "medium",
          },
          "m-deep": { efforts: ["high", "low"] },
          "m-fast": { efforts: ["low"] },
          "m-explicit": { efforts: ["high"] },
        },
        maxConcurrent: 2,
      },
      codex: {
        models: {
          "gpt-test": { efforts: ["high"], default: "high" },
        },
        maxConcurrent: 1,
      },
    },
    profiles: {
      deep: {
        vendor: "fake",
        model: "m-deep",
        effort: "high",
        sandbox: "workspace",
        maxConcurrent: 1,
      },
      fast: {
        vendor: "fake",
        model: "m-fast",
        effort: "low",
        sandbox: "read-only",
      },
      templated: {
        vendor: "custom-bin",
        model: "declared-m",
        effort: "declared-e",
        template: ["$BIN", "$PROMPT"],
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mergeStepAndSlot
// ---------------------------------------------------------------------------

describe("mergeStepAndSlot", () => {
  it("returns step fields when no slot", () => {
    expect(
      mergeStepAndSlot(
        step({
          id: "a",
          profile: "deep",
          vendor: "fake",
          model: "m",
          effort: "high",
          sandbox: "full",
        }),
      ),
    ).toEqual({
      profile: "deep",
      vendor: "fake",
      model: "m",
      effort: "high",
      sandbox: "full",
      promptAppend: null,
    });
  });

  it("field-wise merges slot over step when slot has no profile", () => {
    const merged = mergeStepAndSlot(
      step({
        id: "review",
        sandbox: "read-only",
        profile: "deep",
      }),
      {
        vendor: "codex",
        model: "gpt-test",
        effort: "high",
        prompt_append: "prompts/slot.md",
      },
    );
    expect(merged).toEqual({
      profile: "deep",
      vendor: "codex",
      model: "gpt-test",
      effort: "high",
      sandbox: "read-only",
      promptAppend: "prompts/slot.md",
    });
  });

  it("replaces profile wholesale when slot names one", () => {
    const merged = mergeStepAndSlot(
      step({ id: "review", profile: "deep", sandbox: "workspace" }),
      { profile: "fast", prompt_append: "prompts/house.md" },
    );
    // profile from slot only — deep discarded; sandbox still field-merges
    expect(merged.profile).toBe("fast");
    expect(merged.sandbox).toBe("workspace");
    expect(merged.promptAppend).toBe("prompts/house.md");
  });

  it("slot profile + slot model do not keep the old profile's model via half-merge", () => {
    // Step pins deep (model m-deep via profile at resolve time). Slot replaces
    // profile with fast and does not set model — merge leaves model null so
    // resolve picks fast's model, not deep's.
    const merged = mergeStepAndSlot(
      step({ id: "r", profile: "deep" }),
      { profile: "fast" },
    );
    expect(merged.profile).toBe("fast");
    expect(merged.model).toBeNull();
    expect(merged.vendor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveStepExecution
// ---------------------------------------------------------------------------

describe("resolveStepExecution", () => {
  const configPath = "/tmp/parley.json";

  it("explicit → profile chain: step profile supplies vendor/model/effort", () => {
    const r = resolveStepExecution({
      step: step({ id: "implement", profile: "deep" }),
      config: baseConfig(),
      configPath,
    });
    expect(r.vendor).toBe("fake");
    expect(r.model).toBe("m-deep");
    expect(r.effort).toBe("high");
    expect(r.profile).toBe("deep");
    expect(r.sandbox).toBe("workspace");
    expect(r.launchTemplate).toBe(false);
    expect(r.usedAllowlistDefault).toBe(false);
  });

  it("slot field-wise override of model/vendor on top of step profile", () => {
    const r = resolveStepExecution({
      step: step({ id: "review", profile: "deep", sandbox: "read-only" }),
      slot: { vendor: "codex", model: "gpt-test", effort: "high" },
      slotId: "adversarial",
      config: baseConfig(),
      configPath,
    });
    expect(r.vendor).toBe("codex");
    expect(r.model).toBe("gpt-test");
    expect(r.effort).toBe("high");
    expect(r.profile).toBe("deep");
    expect(r.sandbox).toBe("read-only");
    expect(r.slotId).toBe("adversarial");
  });

  it("slot profile replaces wholesale — resolves against the new profile", () => {
    const r = resolveStepExecution({
      step: step({ id: "review", profile: "deep" }),
      slot: { profile: "fast" },
      slotId: "house-style",
      config: baseConfig(),
      configPath,
    });
    expect(r.profile).toBe("fast");
    expect(r.model).toBe("m-fast");
    expect(r.effort).toBe("low");
    expect(r.sandbox).toBe("read-only");
  });

  it("defaults.profile when step/slot omit both vendor and profile", () => {
    const r = resolveStepExecution({
      step: step({ id: "a" }),
      config: baseConfig({ defaults: { profile: "deep" } }),
      configPath,
    });
    expect(r.profile).toBe("deep");
    expect(r.model).toBe("m-deep");
  });

  it("defaults.vendor when no profile default", () => {
    const r = resolveStepExecution({
      step: step({ id: "a" }),
      config: baseConfig({ defaults: { vendor: "fake" } }),
      configPath,
    });
    expect(r.vendor).toBe("fake");
    expect(r.model).toBe("fake-model");
    expect(r.effort).toBe("medium");
    expect(r.usedAllowlistDefault).toBe(true);
  });

  it("defaults.profile wins over defaults.vendor", () => {
    const r = resolveStepExecution({
      step: step({ id: "a" }),
      config: baseConfig({
        defaults: { profile: "fast", vendor: "codex" },
      }),
      configPath,
    });
    expect(r.profile).toBe("fast");
    expect(r.vendor).toBe("fake");
  });

  it("never consults task_type for vendor selection", () => {
    const r = resolveStepExecution({
      step: step({ id: "a", task_type: "coding", profile: "deep" }),
      config: baseConfig(),
      configPath,
    });
    expect(r.vendor).toBe("fake");
    expect(r.profile).toBe("deep");
  });

  it("sandbox from step overrides profile sandbox", () => {
    const r = resolveStepExecution({
      step: step({ id: "a", profile: "deep", sandbox: "full" }),
      config: baseConfig(),
      configPath,
    });
    expect(r.sandbox).toBe("full");
  });

  it("launch-template profile skips allowlist", () => {
    const r = resolveStepExecution({
      step: step({ id: "a", profile: "templated" }),
      config: baseConfig(),
      configPath,
    });
    expect(r.launchTemplate).toBe(true);
    expect(r.vendor).toBe("custom-bin");
    expect(r.model).toBe("declared-m");
    expect(r.effort).toBe("declared-e");
    expect(r.usedAllowlistDefault).toBe(false);
  });

  it("refuses unknown profile", () => {
    expect(() =>
      resolveStepExecution({
        step: step({ id: "a", profile: "nope" }),
        config: baseConfig(),
        configPath,
      }),
    ).toThrow(StepConfigError);
    try {
      resolveStepExecution({
        step: step({ id: "a", profile: "nope" }),
        config: baseConfig(),
        configPath,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(StepConfigError);
      expect((err as StepConfigError).code).toBe("unknown_profile");
    }
  });

  it("refuses model outside allowlist", () => {
    expect(() =>
      resolveStepExecution({
        step: step({
          id: "a",
          vendor: "fake",
          model: "not-allowed",
          effort: "high",
        }),
        config: baseConfig(),
        configPath,
      }),
    ).toThrow(/not allowed/);
  });

  it("enriches allowlist rejection with CLI selection when wired (#284)", () => {
    let reads = 0;
    try {
      resolveStepExecution({
        step: step({
          id: "a",
          vendor: "fake",
          model: "not-allowed",
          effort: "high",
        }),
        config: baseConfig(),
        configPath,
        readSelectedModel: (vendor) => {
          reads += 1;
          expect(vendor).toBe("fake");
          return { model: "cli-selected-model", effort: "high" };
        },
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(
        /CLI currently has "cli-selected-model@high" selected/,
      );
    }
    // Lazy: only one read on the rejection path (not on success).
    expect(reads).toBe(1);
  });

  it("does not call readSelectedModel on a successful allowlist resolution", () => {
    let reads = 0;
    const r = resolveStepExecution({
      step: step({
        id: "a",
        vendor: "fake",
        model: "fake-model",
        effort: "medium",
      }),
      config: baseConfig(),
      configPath,
      readSelectedModel: () => {
        reads += 1;
        return { model: "should-not-be-read", effort: null };
      },
    });
    expect(r.model).toBe("fake-model");
    expect(reads).toBe(0);
  });

  it("refuses missing vendor/profile with no defaults", () => {
    expect(() =>
      resolveStepExecution({
        step: step({ id: "lonely" }),
        config: baseConfig({ defaults: undefined }),
        configPath,
      }),
    ).toThrow(/vendor or profile is required/);
  });

  it("refuses invalid sandbox string", () => {
    expect(() =>
      resolveStepExecution({
        step: step({ id: "a", vendor: "fake", sandbox: "jail" }),
        config: baseConfig(),
        configPath,
      }),
    ).toThrow(/invalid sandbox/);
  });
});

// ---------------------------------------------------------------------------
// preflightRunStart
// ---------------------------------------------------------------------------

function loadMiniWorkflow(
  dir: string,
  raw: Record<string, unknown>,
): WorkflowDefinition {
  fs.mkdirSync(dir, { recursive: true });
  const result = parseWorkflowDefinition(raw, { dir, typeCheck: false });
  return result.definition;
}

describe("preflightRunStart", () => {
  let wfDir: string;
  let configPath: string;

  beforeEach(() => {
    wfDir = tmpDir("parley-pf-wf-");
    configPath = path.join(tmpDir("parley-pf-cfg-"), "parley.json");
  });

  it("resolves every (node, slot) and prints caps without refusing throughput", () => {
    const definition = loadMiniWorkflow(wfDir, {
      id: path.basename(wfDir),
      version: 1,
      type: "coding",
      workspace: "scratch",
      inputs: {},
      outputs: {},
      nodes: [
        {
          id: "implement",
          kind: "step",
          profile: "deep",
          prompt: "prompts/i.md",
          in: {},
          out: { branch: { type: "text" } },
        },
        {
          id: "review",
          kind: "step",
          sandbox: "read-only",
          prompt: "prompts/r.md",
          slots: {
            adversarial: {
              vendor: "codex",
              model: "gpt-test",
              effort: "high",
            },
            house: { profile: "fast" },
          },
          in: {},
          out: { notes: { type: "text" } },
        },
        {
          id: "gate",
          kind: "gate",
          question: "ok?",
          shows: {},
          on_reject: "finish",
        },
      ],
    });

    const result = preflightRunStart({
      definition,
      config: baseConfig({ defaults: { profile: "deep" } }),
      configPath,
    });

    expect(result.workspace).toBe("scratch");
    expect(result.rows).toHaveLength(3); // implement + 2 slots; gate skipped
    expect(result.rows.map((r) => `${r.nodeId}/${r.slotId ?? "—"}`)).toEqual([
      "implement/—",
      "review/adversarial",
      "review/house",
    ]);

    const adv = result.rows.find((r) => r.slotId === "adversarial")!;
    expect(adv.vendor).toBe("codex");
    expect(adv.model).toBe("gpt-test");
    expect(adv.sandbox).toBe("read-only");

    const house = result.rows.find((r) => r.slotId === "house")!;
    expect(house.profile).toBe("fast");
    expect(house.model).toBe("m-fast");

    // Caps collected, never a refuse reason even when tight
    expect(result.caps.some((c) => c.kind === "vendor" && c.id === "fake")).toBe(
      true,
    );
    expect(result.caps.some((c) => c.kind === "vendor" && c.id === "codex")).toBe(
      true,
    );
    expect(result.caps.some((c) => c.kind === "profile" && c.id === "deep")).toBe(
      true,
    );

    const text = formatRunPreflight(result);
    expect(text).toContain("run preflight");
    expect(text).toContain("implement / —");
    expect(text).toContain("review / adversarial");
    expect(text).toContain("maxConcurrent=");
    // Throughput never refuses — format always succeeds
    expect(text).not.toMatch(/refus/i);
  });

  it("scratch mode refuses --base via preflightScratchRun", () => {
    const definition = loadMiniWorkflow(wfDir, {
      id: path.basename(wfDir),
      version: 1,
      type: "research",
      workspace: "scratch",
      inputs: {},
      outputs: {},
      nodes: [
        {
          id: "scope",
          kind: "step",
          profile: "deep",
          prompt: "prompts/s.md",
          in: {},
          out: { q: { type: "text" } },
        },
      ],
    });
    expect(() =>
      preflightRunStart({
        definition,
        config: baseConfig(),
        configPath,
        baseRef: "main",
      }),
    ).toThrow(ScratchBaseRefNotAllowedError);
  });

  it("repo mode refuses missing repo root via preflightRepoRun", () => {
    const definition = loadMiniWorkflow(wfDir, {
      id: path.basename(wfDir),
      version: 1,
      type: "coding",
      workspace: "repo",
      inputs: {},
      outputs: {},
      nodes: [
        {
          id: "plan",
          kind: "step",
          profile: "deep",
          prompt: "prompts/p.md",
          in: {},
          out: { plan: { type: "text" } },
        },
      ],
    });
    expect(() =>
      preflightRunStart({
        definition,
        config: baseConfig(),
        configPath,
        repoRoot: null,
      }),
    ).toThrow(RepoModeRequiresRepoError);
  });

  it("repo mode accepts a repo root", () => {
    const definition = loadMiniWorkflow(wfDir, {
      id: path.basename(wfDir),
      version: 1,
      type: "coding",
      workspace: "repo",
      inputs: {},
      outputs: {},
      nodes: [
        {
          id: "plan",
          kind: "step",
          profile: "deep",
          prompt: "prompts/p.md",
          in: {},
          out: { plan: { type: "text" } },
        },
      ],
    });
    const result = preflightRunStart({
      definition,
      config: baseConfig(),
      configPath,
      repoRoot: "/some/repo",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.vendor).toBe("fake");
  });

  it("surfaces allowlist failure before any spawn (refuses on correctness)", () => {
    const definition = loadMiniWorkflow(wfDir, {
      id: path.basename(wfDir),
      version: 1,
      type: "coding",
      workspace: "scratch",
      inputs: {},
      outputs: {},
      nodes: [
        {
          id: "bad",
          kind: "step",
          vendor: "fake",
          model: "nope",
          effort: "high",
          prompt: "prompts/b.md",
          in: {},
          out: { x: { type: "text" } },
        },
      ],
    });
    expect(() =>
      preflightRunStart({
        definition,
        config: baseConfig(),
        configPath,
      }),
    ).toThrow(StepConfigError);
  });

  it("data fan-out step resolves once (shared config)", () => {
    const definition = loadMiniWorkflow(wfDir, {
      id: path.basename(wfDir),
      version: 1,
      type: "research",
      workspace: "scratch",
      inputs: { q: { type: "text[]", max_items: 5 } },
      outputs: {},
      nodes: [
        {
          id: "search",
          kind: "step",
          profile: "deep",
          over: "queries",
          prompt: "prompts/s.md",
          in: {
            queries: { type: "text", from: "run.q" },
          },
          out: { hit: { type: "text" } },
        },
      ],
    });
    const result = preflightRunStart({
      definition,
      config: baseConfig(),
      configPath,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.slotId).toBeNull();
    expect(result.rows[0]!.profile).toBe("deep");
  });
});
