/**
 * Pure-function unit tests for effective-config rendering (#163 / #169).
 * Combinatorial edges live here; CLI seam covers end-to-end fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePathsFromEnv } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import { buildInfo, buildInfoConfig, renderInfoProse } from "../src/info.js";

let home: string;
let project: string;

function write(root: string, rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-info-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "parley-info-proj-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe("buildInfo / renderInfoProse (#163 / #169)", () => {
  it("prose is always renderInfoProse(config) of the same object", () => {
    write(home, "orchestrator/PROMPT.md", "H");
    write(project, ".parley/orchestrator/PROMPT.md", "P");
    write(
      project,
      ".parley/config.json",
      JSON.stringify({ eval: { enabled: false }, retry: { max: 0, window: "90s" } }),
    );

    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync({ PARLEY_FAKE_VENDOR_BIN: "fake" });
    const response = buildInfo({ projectDir: project, paths, adapters });
    expect(response.prose).toBe(renderInfoProse(response.config));
    expect(response.config.instructions).toBe("H\n\nP");
    expect(response.config.evaluation.enabled).toBe(false);
    expect(response.config.fix.retryMax).toBe(0);
    expect(response.config.fix.retryWindow).toBe("90 seconds");
  });

  it("eval-on includes one rubric summary per type including other", () => {
    write(
      project,
      ".parley/config.json",
      JSON.stringify({
        eval: { enabled: true },
        taskTypes: { coding: { rubric: "coding" } },
      }),
    );
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync();
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.evaluation.enabled).toBe(true);
    const types = (config.evaluation.rubrics ?? []).map((r) => r.type).sort();
    expect(types).toEqual(["coding", "other"]);
    const prose = renderInfoProse(config);
    expect(prose).toContain("### How to eval");
    expect(prose).toContain("#### `coding`");
    expect(prose).toContain("#### `other`");
  });

  it("eval-off omits taskTypes and classification from config and prose", () => {
    write(
      project,
      ".parley/config.json",
      JSON.stringify({
        eval: { enabled: false },
        taskTypes: { coding: { rubric: "coding" } },
      }),
    );
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync();
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.evaluation.enabled).toBe(false);
    expect(config.taskTypes).toBeUndefined();
    expect(config.classification).toBeUndefined();
    expect(config.evaluation.rubrics).toBeUndefined();
    expect(config.evaluation.howTo).toBeUndefined();
    const prose = renderInfoProse(config);
    expect(prose).not.toContain("## Task types");
    expect(prose).not.toContain("## Classification");
    expect(prose).not.toContain("## Evaluation");
    expect(prose).not.toContain("Evaluation is off");
    expect(prose).toContain("## Instructions");
    expect(prose).toContain("## Vendors & profiles");
    expect(prose).toContain("## Fix & retries");
  });

  it("eval-on includes taskTypes and classification", () => {
    write(
      project,
      ".parley/config.json",
      JSON.stringify({
        eval: { enabled: true },
        taskTypes: { coding: { rubric: "coding" } },
      }),
    );
    write(
      project,
      ".parley/classification.json",
      JSON.stringify({
        version: 1,
        sizes: [{ id: "S", guidance: "Small." }],
        difficulties: [{ id: "easy", guidance: "Easy." }],
      }),
    );
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync();
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.taskTypes?.some((t) => t.id === "coding")).toBe(true);
    expect(config.classification?.sizes.some((s) => s.id === "S")).toBe(true);
    const prose = renderInfoProse(config);
    expect(prose).toContain("## Task types");
    expect(prose).toContain("## Classification");
    expect(prose).toContain("## Evaluation");
  });

  it("lists only configured vendors (not full adapter registry) and profiles sorted", () => {
    const adapters = createAdapterRegistrySync();
    const pathsEmpty = homePathsFromEnv({ PARLEY_HOME: home });
    const empty = buildInfoConfig({ projectDir: project, paths: pathsEmpty, adapters });
    expect(empty.vendors).toEqual([]);
    expect(renderInfoProse(empty)).toContain("(none configured)");

    write(
      home,
      "parley.json",
      JSON.stringify({
        profiles: {
          zed: { vendor: "fake" },
          alpha: { vendor: "fake", model: "m" },
        },
        vendors: {
          fake: { childChannel: "cli" },
        },
      }),
    );
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.vendors.map((v) => v.id)).toEqual(["fake"]);
    expect(config.vendors.some((v) => v.id === "claude" || v.id === "codex")).toBe(false);
    expect(config.profiles.map((p) => p.name)).toEqual(["alpha", "zed"]);
    expect(config.defaults).toEqual({ vendor: null, profile: null });
    // Models only via profiles — no full catalog dump.
    expect(config.profiles.find((p) => p.name === "alpha")?.model).toBe("m");
    const prose = renderInfoProse(config);
    expect(prose.indexOf("`alpha`")).toBeLessThan(prose.indexOf("`zed`"));
    expect(prose).toContain("### Defaults");
    expect(prose).toMatch(/defaults\.profile|defaults\.vendor/);
    expect(prose).not.toContain("gpt-5");
    expect(prose).not.toContain("grok-4");
  });

  it("surfaces defaults.vendor and defaults.profile in config and prose (#175)", () => {
    write(
      home,
      "parley.json",
      JSON.stringify({
        profiles: { deep: { vendor: "fake" } },
        defaults: { vendor: "codex", profile: "deep" },
      }),
    );
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync({ PARLEY_FAKE_VENDOR_BIN: "fake" });
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.defaults).toEqual({ vendor: "codex", profile: "deep" });
    const prose = renderInfoProse(config);
    expect(prose).toContain("### Defaults");
    expect(prose).toContain("`deep`");
    expect(prose).toContain("`codex`");
  });
});
