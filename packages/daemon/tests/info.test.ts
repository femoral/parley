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
import {
  buildInfo,
  buildInfoConfig,
  formatRubricMarkdown,
  materializeInfoRubrics,
  renderInfoProse,
  writeRubricMarkdownFiles,
  type InfoTaskType,
} from "../src/info.js";

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

  it("eval-on includes one rubric path ref per type including other", () => {
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
    const rubrics = config.evaluation.rubrics ?? [];
    const types = rubrics.map((r) => r.type).sort();
    expect(types).toEqual(["coding", "other"]);
    const coding = rubrics.find((r) => r.type === "coding");
    expect(coding).toEqual({
      type: "coding",
      rubricId: "coding",
      path: ".parley/rubrics-md/coding.md",
    });
    expect(coding).not.toHaveProperty("criteria");
    expect(coding).not.toHaveProperty("version");
    expect(coding).not.toHaveProperty("baseline");
    const prose = renderInfoProse(config);
    expect(prose).toContain("### How to eval");
    expect(prose).toContain("`coding` → rubric `.parley/rubrics-md/coding.md`");
    expect(prose).toContain("`other` → rubric `.parley/rubrics-md/generic.md`");
    expect(prose).not.toContain("#### `coding`");
    expect(prose).not.toContain("brief-implemented");
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
          fake: {
            childChannel: "cli",
            models: {
              "fake-model": {
                efforts: ["low", "medium"],
                default: "medium",
                hint: "test default",
              },
            },
          },
        },
      }),
    );
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.vendors.map((v) => v.id)).toEqual(["fake"]);
    expect(config.vendors.some((v) => v.id === "claude" || v.id === "codex")).toBe(false);
    expect(config.profiles.map((p) => p.name)).toEqual(["alpha", "zed"]);
    expect(config.defaults).toEqual({ vendor: null, profile: null });
    // Models only via allowlist + profiles — no full catalog dump.
    expect(config.profiles.find((p) => p.name === "alpha")?.model).toBe("m");
    expect(config.vendors[0]?.models).toEqual([
      {
        id: "fake-model",
        efforts: ["low", "medium"],
        isDefault: true,
        defaultEffort: "medium",
        hint: "test default",
      },
    ]);
    const prose = renderInfoProse(config);
    expect(prose.indexOf("`alpha`")).toBeLessThan(prose.indexOf("`zed`"));
    expect(prose).toContain("### Defaults");
    expect(prose).toMatch(/defaults\.profile|defaults\.vendor/);
    expect(prose).toContain("`fake-model`");
    expect(prose).toContain("default@medium");
    expect(prose).toContain("hint: test default");
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


describe("layered config (#178)", () => {
  it("eval enabled only in global parley.json → info shows on", () => {
    write(
      home,
      "parley.json",
      JSON.stringify({ eval: { enabled: true } }),
    );
    // No project config.
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync({ PARLEY_FAKE_VENDOR_BIN: "fake" });
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.evaluation.enabled).toBe(true);
    expect(config.provenance.evaluation).toBe("global");
    const prose = renderInfoProse(config);
    expect(prose).toMatch(/Evaluation is \*\*on\*\*/);
    expect(prose).toContain("source: global");
  });

  it("eval enabled only in home config.json → info shows on", () => {
    write(
      home,
      "config.json",
      JSON.stringify({ eval: { enabled: true }, retry: { window: "45m" } }),
    );
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync();
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.evaluation.enabled).toBe(true);
    expect(config.fix.retryWindow).toBe("45 minutes");
    expect(config.provenance.evaluation).toBe("global");
    expect(config.provenance.retryWindow).toBe("global");
  });

  it("project eval.enabled false overrides global true", () => {
    write(home, "parley.json", JSON.stringify({ eval: { enabled: true } }));
    write(
      project,
      ".parley/config.json",
      JSON.stringify({ eval: { enabled: false } }),
    );
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync();
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.evaluation.enabled).toBe(false);
    expect(config.provenance.evaluation).toBe("project");
  });

  it("deep merge: project retry.max inherits global eval and retry.window", () => {
    write(
      home,
      "parley.json",
      JSON.stringify({
        eval: { enabled: true },
        retry: { max: 5, window: "1h" },
      }),
    );
    write(
      project,
      ".parley/config.json",
      JSON.stringify({ retry: { max: 2 } }),
    );
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync();
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.evaluation.enabled).toBe(true);
    expect(config.fix.retryMax).toBe(2);
    expect(config.fix.retryWindow).toBe("1 hour");
    expect(config.provenance.evaluation).toBe("global");
    expect(config.provenance.retryMax).toBe("project");
    expect(config.provenance.retryWindow).toBe("global");
  });
});


describe("rubric markdown materialization (#176)", () => {
  it("formatRubricMarkdown emits only id+text lines with trailing newline", () => {
    const md = formatRubricMarkdown([
      { id: "brief-implemented", text: "Did the work." },
      { id: "broke-existing", text: "Regressions." },
    ]);
    expect(md).toBe(
      "- `brief-implemented`: Did the work.\n- `broke-existing`: Regressions.\n",
    );
    expect(md).not.toMatch(/positive|negative|weight|baseline|version/i);
  });

  it("writeRubricMarkdownFiles creates slim md + gitignore and cleans orphans", () => {
    const taskTypes: InfoTaskType[] = [
      { id: "coding", rubric: "coding", automatic: false },
      { id: "other", rubric: "generic", automatic: true },
    ];
    // Seed an orphan that should be deleted.
    const dir = path.join(project, ".parley", "rubrics-md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stale.md"), "- `x`: gone\n", "utf8");

    const summaries = writeRubricMarkdownFiles(project, taskTypes);
    expect(summaries.map((s) => s.type).sort()).toEqual(["coding", "other"]);
    expect(summaries.find((s) => s.type === "coding")).toEqual({
      type: "coding",
      rubricId: "coding",
      path: ".parley/rubrics-md/coding.md",
    });

    const codingPath = path.join(project, ".parley", "rubrics-md", "coding.md");
    const genericPath = path.join(project, ".parley", "rubrics-md", "generic.md");
    expect(fs.existsSync(codingPath)).toBe(true);
    expect(fs.existsSync(genericPath)).toBe(true);
    expect(fs.existsSync(path.join(dir, "stale.md"))).toBe(false);

    const codingMd = fs.readFileSync(codingPath, "utf8");
    expect(codingMd).toMatch(/^- `brief-implemented`: /m);
    expect(codingMd).not.toMatch(/\+|−|weight|baseline|version/i);
    // Only id+text lines.
    for (const line of codingMd.trimEnd().split("\n")) {
      expect(line).toMatch(/^- `[a-z0-9-]+`: .+/);
    }

    const gi = fs.readFileSync(path.join(project, ".parley", ".gitignore"), "utf8");
    expect(gi.split(/\r?\n/).map((l) => l.trim())).toContain("rubrics-md/");
  });

  it("materializeInfoRubrics is a no-op when eval is off", () => {
    const paths = homePathsFromEnv({ PARLEY_HOME: home });
    const adapters = createAdapterRegistrySync();
    write(
      project,
      ".parley/config.json",
      JSON.stringify({ eval: { enabled: false } }),
    );
    const config = buildInfoConfig({ projectDir: project, paths, adapters });
    expect(config.evaluation.enabled).toBe(false);
    const next = materializeInfoRubrics(project, config);
    expect(next).toBe(config);
    expect(fs.existsSync(path.join(project, ".parley", "rubrics-md"))).toBe(false);
  });
});
