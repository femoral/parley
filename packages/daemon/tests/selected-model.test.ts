/**
 * Selected-model drift guard (#284) — goose, cline, openhands.
 *
 * These vendors persist only a current selection, never a catalog. Reads must
 * fail soft, never feed models.json, and never leak cline credentials.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatAllowedCombos,
  formatCliSelectedHint,
  homePaths,
  listAllowedCombos,
  ModelAllowlistError,
  refreshCatalog,
  resolveAllowedCombo,
} from "@useparley/core";
import {
  createGooseAdapter,
  parseGooseSelectedModel,
  readGooseSelectedModel,
} from "../src/adapters/goose.js";
import {
  createClineAdapter,
  parseClineSelectedModel,
  readClineSelectedModel,
} from "../src/adapters/cline.js";
import {
  createOpenhandsAdapter,
  parseOpenhandsSelectedModel,
  readOpenhandsSelectedModel,
} from "../src/adapters/openhands.js";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import { createFakeAdapter } from "../src/adapters/fake.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { DelegateError, TaskEngine } from "../src/engine.js";
import { withFakeAllowlist } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function readFixture(...parts: string[]): string {
  return fs.readFileSync(path.join(FIXTURES, ...parts), "utf8");
}

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parley-selected-"));
}

const CONFIG_PATH = "/tmp/parley-test/parley.json";

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe("parseGooseSelectedModel", () => {
  it("reads active_provider model with no per-model effort", () => {
    const { model, error } = parseGooseSelectedModel(
      readFixture("goose", "config.well-formed.yaml"),
    );
    expect(error).toBeNull();
    expect(model).toBe("claude-sonnet-4-5-20250929");
  });

  it("returns null model for empty-but-valid config", () => {
    const { model, error } = parseGooseSelectedModel(
      readFixture("goose", "config.empty.yaml"),
    );
    expect(error).toBeNull();
    expect(model).toBeNull();
  });

  it("degrades on malformed / truncated YAML", () => {
    const { model } = parseGooseSelectedModel(
      readFixture("goose", "config.malformed.yaml"),
    );
    // Fail soft: no model (unterminated string value is unusable).
    expect(model).toBeNull();
  });

  it("returns null when shape is valid-but-unexpected (no providers model)", () => {
    const { model, error } = parseGooseSelectedModel(
      readFixture("goose", "config.unexpected.yaml"),
    );
    expect(model).toBeNull();
    // Missing providers entry is "no selection", not a structural hard error.
    expect(error).toBeNull();
  });
});

describe("parseClineSelectedModel", () => {
  it("returns model and reasoning effort from lastUsedProvider", () => {
    const { model, effort, error } = parseClineSelectedModel(
      readFixture("cline", "providers.well-formed.json"),
    );
    expect(error).toBeNull();
    expect(model).toBe("claude-sonnet-4-5");
    expect(effort).toBe("high");
  });

  it("returns null for empty-but-valid settings", () => {
    expect(parseClineSelectedModel(readFixture("cline", "providers.empty.json"))).toEqual({
      model: null,
      effort: null,
      error: null,
    });
  });

  it("flags malformed JSON without embedding source (no secret leak)", () => {
    const text = readFixture("cline", "providers.malformed.json");
    // Fixture places the syntax error next to the dummy secret so a
    // regression that interpolated JSON.parse's message would leak it.
    expect(text).toContain("sk-test-dummy-secret-must-never-leak");
    const result = parseClineSelectedModel(text);
    expect(result.model).toBeNull();
    // Load-bearing: fixed shape string only — never err.message (which can
    // embed a source fragment carrying the secret on modern Node).
    expect(result.error).toBe("malformed providers.json");
    expect(result).toEqual({
      model: null,
      effort: null,
      error: "malformed providers.json",
    });
  });

  it("degrades on unexpected shape without throwing", () => {
    const result = parseClineSelectedModel(
      readFixture("cline", "providers.unexpected.json"),
    );
    expect(result.model).toBeNull();
    expect(result.effort).toBeNull();
    // Fail soft: either a fixed shape error or silent empty — never a throw,
    // never credential material.
    if (result.error !== null) {
      expect(result.error).toMatch(/unexpected|malformed/);
    }
  });

  it("never returns credential keys from a well-formed file", () => {
    const text = readFixture("cline", "providers.well-formed.json");
    expect(text).toContain("sk-test-dummy-secret-must-never-leak");
    const { model, effort, error } = parseClineSelectedModel(text);
    const serialized = JSON.stringify({ model, effort, error });
    expect(serialized).not.toContain("sk-test");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("dummy-secret");
  });
});

describe("parseOpenhandsSelectedModel", () => {
  it("reads llm.model", () => {
    const { model, error } = parseOpenhandsSelectedModel(
      readFixture("openhands", "agent_settings.well-formed.json"),
    );
    expect(error).toBeNull();
    expect(model).toBe("anthropic/claude-sonnet-4-5-20250929");
  });

  it("returns null for empty-but-valid settings", () => {
    expect(
      parseOpenhandsSelectedModel(readFixture("openhands", "agent_settings.empty.json")),
    ).toEqual({ model: null, error: null });
  });

  it("flags malformed JSON without embedding source", () => {
    const text = readFixture("openhands", "agent_settings.malformed.json");
    expect(text).toContain("sk-test-dummy-openhands-secret");
    const result = parseOpenhandsSelectedModel(text);
    expect(result.model).toBeNull();
    // Fixed shape only — never interpolate JSON.parse's message.
    expect(result.error).toBe("malformed agent_settings.json");
    expect(result).toEqual({
      model: null,
      error: "malformed agent_settings.json",
    });
  });

  it("flags unexpected shape", () => {
    const result = parseOpenhandsSelectedModel(
      readFixture("openhands", "agent_settings.unexpected.json"),
    );
    expect(result.model).toBeNull();
    expect(result.error).toBeNull(); // llm not an object → no selection
  });
});

// ---------------------------------------------------------------------------
// Adapter readSelectedModel (operator home)
// ---------------------------------------------------------------------------

describe("adapter readSelectedModel via operator home", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("goose reads config.yaml under the operator config dir", () => {
    home = makeHome();
    const configDir = path.join(home, ".config", "goose");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.yaml"),
      readFixture("goose", "config.well-formed.yaml"),
    );
    const adapter = createGooseAdapter({ HOME: home });
    expect(adapter.readSelectedModel?.()).toEqual({
      model: "claude-sonnet-4-5-20250929",
      effort: null,
    });
  });

  it("goose returns null when config is missing (fresh home)", () => {
    home = makeHome();
    const adapter = createGooseAdapter({ HOME: home });
    expect(adapter.readSelectedModel?.()).toBeNull();
  });

  it("goose returns null without hanging when config.yaml is a FIFO (#288/#284)", () => {
    home = makeHome();
    const configDir = path.join(home, ".config", "goose");
    fs.mkdirSync(configDir, { recursive: true });
    const fifo = path.join(configDir, "config.yaml");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    const result = readGooseSelectedModel({ HOME: home });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toBeNull();
  });

  it("goose refuses isolated GOOSE_PATH_ROOT and falls back to operator home", () => {
    home = makeHome();
    const isolated = path.join(home, "work", ".parley-goose");
    fs.mkdirSync(path.join(isolated, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(isolated, "config", "config.yaml"),
      "active_provider: only-isolated\nproviders:\n  only-isolated:\n    model: isolated-model\n",
    );
    // Operator home empty → null, not the isolated model.
    const result = readGooseSelectedModel({
      HOME: home,
      GOOSE_PATH_ROOT: isolated,
    });
    expect(result).toBeNull();
  });

  it("cline reads providers.json and returns model+effort", () => {
    home = makeHome();
    const settingsDir = path.join(home, ".cline", "data", "settings");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "providers.json"),
      readFixture("cline", "providers.well-formed.json"),
    );
    const adapter = createClineAdapter({ HOME: home });
    expect(adapter.readSelectedModel?.()).toEqual({
      model: "claude-sonnet-4-5",
      effort: "high",
    });
  });

  it("cline returns null on missing file and never throws on malformed", () => {
    home = makeHome();
    const adapter = createClineAdapter({ HOME: home });
    expect(adapter.readSelectedModel?.()).toBeNull();

    const settingsDir = path.join(home, ".cline", "data", "settings");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "providers.json"),
      readFixture("cline", "providers.malformed.json"),
    );
    expect(adapter.readSelectedModel?.()).toBeNull();
  });

  it("cline refuses CLINE_DATA_DIR pointing at .cline-parley", () => {
    home = makeHome();
    const isolated = path.join(home, "work", ".cline-parley");
    const settingsDir = path.join(isolated, "data", "settings");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "providers.json"),
      JSON.stringify({
        lastUsedProvider: "x",
        providers: { x: { settings: { model: "only-isolated" } } },
      }),
    );
    expect(
      readClineSelectedModel({ HOME: home, CLINE_DATA_DIR: isolated }),
    ).toBeNull();
  });

  it("cline returns null without hanging when providers.json is a FIFO (#288/#284)", () => {
    home = makeHome();
    const settingsDir = path.join(home, ".cline", "data", "settings");
    fs.mkdirSync(settingsDir, { recursive: true });
    const fifo = path.join(settingsDir, "providers.json");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    const result = readClineSelectedModel({ HOME: home });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toBeNull();
  });

  it("openhands reads agent_settings.json llm.model", () => {
    home = makeHome();
    const oh = path.join(home, ".openhands");
    fs.mkdirSync(oh, { recursive: true });
    fs.writeFileSync(
      path.join(oh, "agent_settings.json"),
      readFixture("openhands", "agent_settings.well-formed.json"),
    );
    const adapter = createOpenhandsAdapter({ HOME: home });
    expect(adapter.readSelectedModel?.()).toEqual({
      model: "anthropic/claude-sonnet-4-5-20250929",
      effort: null,
    });
  });

  it("openhands returns null on missing/malformed", () => {
    home = makeHome();
    expect(createOpenhandsAdapter({ HOME: home }).readSelectedModel?.()).toBeNull();
    const oh = path.join(home, ".openhands");
    fs.mkdirSync(oh, { recursive: true });
    fs.writeFileSync(
      path.join(oh, "agent_settings.json"),
      readFixture("openhands", "agent_settings.malformed.json"),
    );
    expect(readOpenhandsSelectedModel({ HOME: home })).toBeNull();
  });

  it("openhands returns null without hanging when agent_settings.json is a FIFO (#288/#284)", () => {
    home = makeHome();
    const oh = path.join(home, ".openhands");
    fs.mkdirSync(oh, { recursive: true });
    const fifo = path.join(oh, "agent_settings.json");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    const result = readOpenhandsSelectedModel({ HOME: home });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Catalog isolation — selected-model data never reaches models.json
// ---------------------------------------------------------------------------

describe("selected-model data never reaches the model catalog (#284)", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("refresh for goose/cline/openhands is unaffected by selection files", async () => {
    home = makeHome();
    // Plant rich selection data under the operator home.
    const gooseDir = path.join(home, ".config", "goose");
    fs.mkdirSync(gooseDir, { recursive: true });
    fs.writeFileSync(
      path.join(gooseDir, "config.yaml"),
      readFixture("goose", "config.well-formed.yaml"),
    );
    const clineDir = path.join(home, ".cline", "data", "settings");
    fs.mkdirSync(clineDir, { recursive: true });
    fs.writeFileSync(
      path.join(clineDir, "providers.json"),
      readFixture("cline", "providers.well-formed.json"),
    );
    const ohDir = path.join(home, ".openhands");
    fs.mkdirSync(ohDir, { recursive: true });
    fs.writeFileSync(
      path.join(ohDir, "agent_settings.json"),
      readFixture("openhands", "agent_settings.well-formed.json"),
    );

    const adapters = createAdapterRegistrySync({ HOME: home });
    // Sanity: selected reads work.
    expect(adapters.get("goose")!.readSelectedModel?.()?.model).toBe(
      "claude-sonnet-4-5-20250929",
    );
    expect(adapters.get("cline")!.readSelectedModel?.()?.model).toBe("claude-sonnet-4-5");
    expect(adapters.get("openhands")!.readSelectedModel?.()?.model).toBe(
      "anthropic/claude-sonnet-4-5-20250929",
    );

    // These three must NOT implement readModels (selection ≠ catalog).
    expect(adapters.get("goose")!.readModels).toBeUndefined();
    expect(adapters.get("cline")!.readModels).toBeUndefined();
    expect(adapters.get("openhands")!.readModels).toBeUndefined();

    const before = {
      goose: {
        fetched_at: null,
        source: "manual",
        models: [{ id: "pre-existing-goose", efforts: [], default_effort: null }],
      },
      cline: {
        fetched_at: null,
        source: "manual",
        models: [{ id: "pre-existing-cline", efforts: ["high"], default_effort: null }],
      },
      openhands: {
        fetched_at: null,
        source: "manual",
        models: [{ id: "pre-existing-oh", efforts: [], default_effort: null }],
      },
    };

    const { catalog, warnings } = await refreshCatalog(
      before,
      ["goose", "cline", "openhands"],
      adapters,
      () => "2026-07-30T00:00:00.000Z",
    );

    // Existing entries kept (no discovery channel to overwrite them).
    expect(catalog.goose!.models.map((m) => m.id)).toEqual(["pre-existing-goose"]);
    expect(catalog.cline!.models.map((m) => m.id)).toEqual(["pre-existing-cline"]);
    expect(catalog.openhands!.models.map((m) => m.id)).toEqual(["pre-existing-oh"]);

    // Selection ids must not appear in the catalog.
    const allIds = ["goose", "cline", "openhands"].flatMap((v) =>
      catalog[v]!.models.map((m) => m.id),
    );
    expect(allIds).not.toContain("claude-sonnet-4-5-20250929");
    expect(allIds).not.toContain("claude-sonnet-4-5");
    expect(allIds).not.toContain("anthropic/claude-sonnet-4-5-20250929");

    // Selection files must not introduce new warning classes. The only
    // expected lines are the pre-existing "no probe" keep-existing notices —
    // nothing about providers.json / config.yaml / agent_settings.
    for (const w of warnings) {
      expect(w).toMatch(/no refresh probe available; kept existing entry/);
      expect(w).not.toMatch(/providers\.json|config\.yaml|agent_settings|selected/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Allowlist rejection enrichment
// ---------------------------------------------------------------------------

describe("allowlist rejection names CLI selection (#284)", () => {
  const cfg = {
    models: {
      "gpt-5": { efforts: ["low", "medium"], default: "low" as const },
      "gpt-4": { efforts: ["high"] },
    },
  };

  it("formatCliSelectedHint adds a line when selection is outside the allowlist", () => {
    // Callers (engine / run-preflight) append this to the pure-gate message.
    const combos = listAllowedCombos(cfg);
    let body: string | undefined;
    try {
      resolveAllowedCombo({
        vendor: "cline",
        vendorCfg: cfg,
        model: "gpt-6",
        effort: "low",
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelAllowlistError);
      body = (err as Error).message;
    }
    // Pre-existing rejection shape intact (no hint from the gate itself).
    expect(body).toMatch(/not allowed/);
    expect(body).toMatch(/Allowed:/);
    expect(body).toMatch(/did you mean/);
    expect(body).toMatch(/gpt-/);
    expect(body).not.toMatch(/CLI currently has/);
    // Append path — the single choke point after item-3 cleanup.
    const msg =
      body! +
      formatCliSelectedHint({ model: "claude-sonnet-4-5", effort: "high" }, combos);
    expect(msg).toMatch(/CLI currently has "claude-sonnet-4-5@high" selected/);
    expect(msg).toMatch(/not on the allowlist/);
  });

  it("preserves pre-existing output when no CLI selection is known", () => {
    let without: string | undefined;
    try {
      resolveAllowedCombo({
        vendor: "codex",
        vendorCfg: cfg,
        model: "gpt-6",
        effort: "low",
        configPath: CONFIG_PATH,
      });
      expect.unreachable();
    } catch (err) {
      without = (err as Error).message;
    }
    const combos = listAllowedCombos(cfg);
    const withNullHint = without! + formatCliSelectedHint(null, combos);
    expect(without).toBe(withNullHint);
    expect(without).not.toMatch(/CLI currently has/);
  });

  it("omits the line when the CLI selection is already allowlisted", () => {
    const combos = listAllowedCombos(cfg);
    expect(
      formatCliSelectedHint({ model: "gpt-5", effort: "medium" }, combos),
    ).toBe("");
  });

  it("formatCliSelectedHint from a real cline fixture never includes credentials", () => {
    // End-to-end: parse a fixture that co-locates a dummy secret, then format.
    // A vacuous hand-built literal cannot produce credential material; this can.
    const text = readFixture("cline", "providers.well-formed.json");
    expect(text).toContain("sk-test-dummy-secret-must-never-leak");
    const { model, effort } = parseClineSelectedModel(text);
    expect(model).toBe("claude-sonnet-4-5");
    const combos = listAllowedCombos(cfg);
    const hint = formatCliSelectedHint({ model: model!, effort }, combos);
    expect(hint).toMatch(/claude-sonnet-4-5@high/);
    expect(hint).not.toMatch(/sk-test|apiKey|dummy-secret|secret/i);
    expect(JSON.stringify({ model, effort, hint })).not.toMatch(
      /sk-test|apiKey|dummy-secret/i,
    );
    // Baseline allowed list still formats without the selection.
    expect(formatAllowedCombos(combos)).toMatch(/gpt-5@low/);
  });
});

// ---------------------------------------------------------------------------
// Engine e2e: advisory line reaches a real spawn rejection (#284)
// ---------------------------------------------------------------------------

describe("engine spawn path surfaces CLI selection on allowlist rejection (#284)", () => {
  let parleyHome: string;
  let cwd: string;
  let db: DatabaseHandle;
  const FAKE_VENDOR_BIN = fileURLToPath(
    new URL("../../cli/tests/fake-vendor.mjs", import.meta.url),
  );

  beforeEach(() => {
    parleyHome = fs.mkdtempSync(path.join(os.tmpdir(), "parley-sel-eng-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "parley-sel-cwd-"));
    fs.writeFileSync(
      path.join(cwd, ".fake-vendor.json"),
      JSON.stringify([
        {
          submit_report: {
            summary: "ok",
            outcome: "success",
            files_changed: [],
          },
        },
      ]),
    );
    db = openDatabase(homePaths(parleyHome));
    process.env.PARLEY_HOME = parleyHome;
    process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(parleyHome, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.PARLEY_FAKE_VENDOR_BIN;
    delete process.env.PARLEY_HOME;
  });

  it("rejection message includes the adapter's selected model (advisory only)", () => {
    fs.writeFileSync(
      path.join(parleyHome, "parley.json"),
      JSON.stringify(
        withFakeAllowlist({
          vendors: {
            fake: {
              models: {
                "fake-model": {
                  efforts: ["low", "medium"],
                  default: "medium",
                },
              },
            },
          },
        }),
      ),
    );

    const fake = createFakeAdapter(process.env);
    // Inject a selection reader on the fake vendor so the engine path is real.
    const adapters = new Map([
      [
        "fake",
        {
          ...fake,
          readSelectedModel: () => ({
            model: "cli-only-model",
            effort: "high" as string | null,
          }),
        },
      ],
    ]);
    const engine = new TaskEngine(db, homePaths(parleyHome), adapters);

    try {
      engine.delegate({
        prompt: "do it",
        vendor: "fake",
        profile: null,
        model: "not-on-list",
        effort: "low",
        name: null,
        orchestratorSessionId: "orch",
        cwd,
        useWorktree: false,
        baseRef: null,
        sandbox: null,
        network: null,
        answerTimeoutMs: null,
        reportSchema: null,
        contexts: [],
        runner: null,
        size: null,
        difficulty: null,
        type: null,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DelegateError);
      const msg = (err as Error).message;
      // Pre-existing rejection shape intact.
      expect(msg).toMatch(/not allowed/);
      expect(msg).toMatch(/Allowed/);
      expect(msg).toMatch(/did you mean/);
      // Advisory line reached through engine.resolveModelAllowlist.
      expect(msg).toMatch(/CLI currently has "cli-only-model@high" selected/);
      expect(msg).toMatch(/not on the allowlist/);
    }
  });

  it("cliSelected matching the requested combo still rejects (no allowlist bypass)", () => {
    // M3: engine must not short-circuit when adapter selection equals the
    // request. Deleting the gate (or skipping when selection === request)
    // would make this pass without throwing — must stay red under that mutation.
    fs.writeFileSync(
      path.join(parleyHome, "parley.json"),
      JSON.stringify(
        withFakeAllowlist({
          vendors: {
            fake: {
              models: {
                "fake-model": { efforts: ["low"], default: "low" },
              },
            },
          },
        }),
      ),
    );
    const fake = createFakeAdapter(process.env);
    const adapters = new Map([
      [
        "fake",
        {
          ...fake,
          // Selection equals the requested non-allowlisted combo — must still reject.
          readSelectedModel: () => ({
            model: "evil-max-model",
            effort: "ultra" as string | null,
          }),
        },
      ],
    ]);
    const engine = new TaskEngine(db, homePaths(parleyHome), adapters);
    expect(() =>
      engine.delegate({
        prompt: "do it",
        vendor: "fake",
        profile: null,
        model: "evil-max-model",
        effort: "ultra",
        name: null,
        orchestratorSessionId: "orch",
        cwd,
        useWorktree: false,
        baseRef: null,
        sandbox: null,
        network: null,
        answerTimeoutMs: null,
        reportSchema: null,
        contexts: [],
        runner: null,
        size: null,
        difficulty: null,
        type: null,
      }),
    ).toThrow(/not allowed/);
  });

  it("engine startRun preflight surfaces CLI selection on allowlist rejection (#284 M6)", () => {
    // Load-bearing: deleting host.readSelectedModel wiring in engine.startRun
    // (or preflightRunStart pass-through) makes the advisory line vanish.
    // This is the operator-visible run/workflow path.
    fs.writeFileSync(
      path.join(parleyHome, "parley.json"),
      JSON.stringify(
        withFakeAllowlist({
          vendors: {
            fake: {
              models: {
                "fake-model": {
                  efforts: ["low", "medium"],
                  default: "medium",
                },
              },
            },
          },
          profiles: {
            deep: {
              vendor: "fake",
              model: "fake-model",
              effort: "medium",
            },
          },
        }),
      ),
    );

    // Workflow with an explicit non-allowlisted model on the step.
    const wfId = "sel-m6";
    const wfDir = path.join(parleyHome, "workflows", wfId);
    fs.mkdirSync(path.join(wfDir, "prompts"), { recursive: true });
    fs.writeFileSync(path.join(wfDir, "prompts", "s.md"), "do it\n");
    fs.writeFileSync(
      path.join(wfDir, "workflow.json"),
      JSON.stringify({
        id: wfId,
        version: 1,
        type: "research",
        workspace: "scratch",
        inputs: {},
        outputs: { out: { type: "text", from: "scope.report" } },
        nodes: [
          {
            id: "scope",
            kind: "step",
            vendor: "fake",
            model: "not-on-list",
            effort: "low",
            prompt: "prompts/s.md",
            in: {},
            out: { report: { type: "text" } },
          },
        ],
      }),
    );

    const fake = createFakeAdapter(process.env);
    const adapters = new Map([
      [
        "fake",
        {
          ...fake,
          readSelectedModel: () => ({
            model: "cli-only-model",
            effort: "high" as string | null,
          }),
        },
      ],
    ]);
    const engine = new TaskEngine(db, homePaths(parleyHome), adapters);
    const result = engine.startRun({
      workflow: wfId,
      cwd: parleyHome,
      orchestratorSessionId: "orch",
    });
    expect(result.kind).toBe("usage");
    if (result.kind !== "usage") return;
    // Pre-existing shape intact.
    expect(result.message).toMatch(/not allowed/);
    expect(result.message).toMatch(/Allowed/);
    // Advisory line from engine → startRun host → preflight wiring.
    expect(result.message).toMatch(
      /CLI currently has "cli-only-model@high" selected/,
    );
  });

  it("engine step-spawn path includes CLI selection on allowlist rejection (#284 M6 spawn)", () => {
    // Direct spawnStepTasks path (hot-apply mid-run). Deleting the
    // readSelectedModel block at spawnStepTasks must make this fail.
    fs.writeFileSync(
      path.join(parleyHome, "parley.json"),
      JSON.stringify(
        withFakeAllowlist({
          vendors: {
            fake: {
              models: {
                "fake-model": { efforts: ["low"], default: "low" },
              },
            },
          },
        }),
      ),
    );
    const fake = createFakeAdapter(process.env);
    const adapters = new Map([
      [
        "fake",
        {
          ...fake,
          readSelectedModel: () => ({
            model: "cli-spawn-model",
            effort: "high" as string | null,
          }),
        },
      ],
    ]);
    const engine = new TaskEngine(db, homePaths(parleyHome), adapters);

    // Minimal scratch workspace so resolveRunWorkspaceRoot succeeds.
    const runId = "r-m6spawn";
    const ws = path.join(homePaths(parleyHome).runs, runId);
    fs.mkdirSync(ws, { recursive: true });
    const run = {
      id: runId,
      workflow: "m6",
      version: 1,
      type: "research",
      workspace: "scratch" as const,
      repo: null,
      state: "running" as const,
      current_node: "scope",
      iteration: 1,
      parent_run_id: null,
      attempt: 1,
      orchestrator_session_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
      error: null,
      purged_at: null,
      base_ref: null,
      base_commit: null,
    };
    const definition = {
      id: "m6",
      version: 1,
      type: "research",
      workspace: "scratch" as const,
      inputs: {},
      outputs: {},
      nodes: [],
    };
    const step = {
      id: "scope",
      kind: "step" as const,
      vendor: "fake",
      model: "not-on-list",
      effort: "low",
      prompt: "prompts/s.md",
      in: {},
      out: {},
    };
    const result = (
      engine as unknown as {
        spawnStepTasks: (args: unknown) => void | { error: string };
      }
    ).spawnStepTasks({
      run,
      definition,
      step,
      iteration: 1,
      inputs: {},
      loopFills: {},
    });
    expect(result).toBeDefined();
    expect(result).toHaveProperty("error");
    const err = (result as { error: string }).error;
    expect(err).toMatch(/not allowed/);
    expect(err).toMatch(/CLI currently has "cli-spawn-model@high" selected/);
  });
});

// ---------------------------------------------------------------------------
// Adapter contract: no defaultModel / defaultEffort
// ---------------------------------------------------------------------------

describe("VendorAdapter no longer declares defaultModel/defaultEffort (#284)", () => {
  it("no built-in adapter sets defaultModel or defaultEffort", () => {
    const registry = createAdapterRegistrySync({});
    for (const [id, adapter] of registry) {
      expect(adapter, id).not.toHaveProperty("defaultModel");
      expect(adapter, id).not.toHaveProperty("defaultEffort");
    }
  });
});
