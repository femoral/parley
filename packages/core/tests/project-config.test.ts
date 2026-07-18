/**
 * Layered project config: deep merge + precedence (#178).
 */
import { describe, expect, it } from "vitest";
import {
  deepMerge,
  extractProjectConfigLayer,
  mergeProjectConfigLayers,
  resolveEffectiveProjectSettings,
  type ProjectConfigLayer,
} from "../src/project-config.js";

describe("deepMerge", () => {
  it("merges nested objects without whole-file replacement", () => {
    const a = { retry: { max: 1, window: "30m" }, eval: { enabled: true } };
    const b = { retry: { max: 2 } };
    expect(deepMerge(a, b)).toEqual({
      retry: { max: 2, window: "30m" },
      eval: { enabled: true },
    });
  });

  it("later layer wins scalars; undefined does not clear", () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: 3, b: undefined })).toEqual({ a: 3, b: 2 });
  });
});

describe("mergeProjectConfigLayers / resolveEffectiveProjectSettings", () => {
  it("partial project inherits global eval and other retry fields", () => {
    const global: ProjectConfigLayer = {
      eval: { enabled: true },
      retry: { max: 5, window: "1h" },
      resume: { enabled: true },
    };
    const project: ProjectConfigLayer = {
      retry: { max: 2 },
    };
    const merged = mergeProjectConfigLayers(global, project);
    expect(merged).toEqual({
      eval: { enabled: true },
      retry: { max: 2, window: "1h" },
      resume: { enabled: true },
    });

    const effective = resolveEffectiveProjectSettings(global, project);
    expect(effective.evalEnabled).toBe(true);
    expect(effective.retryMax).toBe(2);
    expect(effective.retryWindow).toBe("1h");
    expect(effective.provenance.eval).toBe("global");
    expect(effective.provenance.retryMax).toBe("project");
    expect(effective.provenance.retryWindow).toBe("global");
  });

  it("project eval.enabled false overrides global true", () => {
    const effective = resolveEffectiveProjectSettings(
      { eval: { enabled: true } },
      { eval: { enabled: false } },
    );
    expect(effective.evalEnabled).toBe(false);
    expect(effective.provenance.eval).toBe("project");
  });

  it("global eval only → enabled with global provenance", () => {
    const effective = resolveEffectiveProjectSettings(
      { eval: { enabled: true } },
      {},
    );
    expect(effective.evalEnabled).toBe(true);
    expect(effective.provenance.eval).toBe("global");
  });

  it("defaults when both layers empty", () => {
    const effective = resolveEffectiveProjectSettings({}, {});
    expect(effective.evalEnabled).toBe(false);
    expect(effective.resumeEnabled).toBe(true);
    expect(effective.retryMax).toBe(1);
    expect(effective.retryWindow).toBeUndefined();
    expect(effective.provenance.eval).toBe("default");
    expect(effective.provenance.resume).toBe("default");
    expect(Object.keys(effective.taskTypes).length).toBeGreaterThan(0);
    expect(effective.provenance.taskTypes).toBe("default");
  });

  it("project taskTypes replace global taskTypes wholly", () => {
    const effective = resolveEffectiveProjectSettings(
      { taskTypes: { coding: "coding", research: "research" } },
      { taskTypes: { design: "design" } },
    );
    expect(Object.keys(effective.taskTypes).sort()).toEqual(["design"]);
    expect(effective.provenance.taskTypes).toBe("project");
  });

  it("global taskTypes used when project omits section", () => {
    const effective = resolveEffectiveProjectSettings(
      { taskTypes: { coding: { rubric: "coding" } } },
      { retry: { max: 0 } },
    );
    expect(Object.keys(effective.taskTypes).sort()).toEqual(["coding"]);
    expect(effective.provenance.taskTypes).toBe("global");
    expect(effective.retryMax).toBe(0);
  });
});

describe("extractProjectConfigLayer", () => {
  it("pulls only project-settings keys", () => {
    const layer = extractProjectConfigLayer({
      eval: { enabled: true },
      daemon: { url: "http://x" },
      retry: { max: 3, window: "90s" },
      vendors: { fake: { bin: "x" } },
    });
    expect(layer).toEqual({
      eval: { enabled: true },
      retry: { max: 3, window: "90s" },
    });
  });

  it("ignores non-objects", () => {
    expect(extractProjectConfigLayer(null)).toEqual({});
    expect(extractProjectConfigLayer("x")).toEqual({});
  });
});
