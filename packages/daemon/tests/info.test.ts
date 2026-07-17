/**
 * Pure-function unit tests for effective-config rendering (#163).
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

describe("buildInfo / renderInfoProse (#163)", () => {
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

  it("lists registered vendors sorted and profiles from daemon config", () => {
    write(
      home,
      "parley.json",
      JSON.stringify({
        profiles: {
          zed: { vendor: "fake" },
          alpha: { vendor: "fake", model: "m" },
        },
      }),
    );
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync();
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.vendors.some((v) => v.id === "fake")).toBe(true);
    expect(config.profiles.map((p) => p.name)).toEqual(["alpha", "zed"]);
    const prose = renderInfoProse(config);
    expect(prose.indexOf("`alpha`")).toBeLessThan(prose.indexOf("`zed`"));
  });
});
