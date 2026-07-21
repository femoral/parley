/**
 * Engine integration for vendor model allowlist (#185 / ADR-0014).
 * Pure helpers live in packages/core; this covers delegate / profile / fix paths.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  getTask,
  openDatabase,
  updateTask,
  type DatabaseHandle,
} from "../src/db.js";
import { DelegateError, TaskEngine } from "../src/engine.js";
import { withFakeAllowlist } from "./helpers.js";

const FAKE_VENDOR_BIN = fileURLToPath(
  new URL("../../cli/tests/fake-vendor.mjs", import.meta.url),
);

let home: string;
let db: DatabaseHandle;
let cwd: string;

function writeConfig(body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify(body));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-allowlist-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "parley-allowlist-cwd-"));
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
  db = openDatabase(homePaths(home));
  process.env.PARLEY_HOME = home;
  process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.PARLEY_FAKE_VENDOR_BIN;
  delete process.env.PARLEY_HOME;
});

function engine(): TaskEngine {
  return new TaskEngine(db, homePaths(home), createAdapterRegistrySync(process.env));
}

function baseRequest(
  overrides: Partial<Parameters<TaskEngine["delegate"]>[0]> = {},
): Parameters<TaskEngine["delegate"]>[0] {
  return {
    prompt: "do it",
    vendor: "fake",
    profile: null,
    model: null,
    effort: null,
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
    ...overrides,
  };
}

describe("delegate allowlist choke point (#185)", () => {
  it("fails fast with no allowlist, naming wizard/config", () => {
    writeConfig({});
    expect(() => engine().delegate(baseRequest())).toThrow(DelegateError);
    expect(() => engine().delegate(baseRequest())).toThrow(/no models configured/);
    expect(() => engine().delegate(baseRequest())).toThrow(/parley-wizard/);
    expect(() => engine().delegate(baseRequest())).toThrow(/parley\.json/);
  });

  it("rejects out-of-list combo with allowed list and nearest suggestion", () => {
    writeConfig(
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
    );
    expect(() =>
      engine().delegate(baseRequest({ model: "fake-model", effort: "ultra" })),
    ).toThrow(/ultra/);
    expect(() =>
      engine().delegate(baseRequest({ model: "fake-model", effort: "ultra" })),
    ).toThrow(/Allowed combos:/);
    expect(() =>
      engine().delegate(baseRequest({ model: "fake-model", effort: "ultra" })),
    ).toThrow(/did you mean/);
  });

  it("omitted -m/-e uses default-flagged combo", () => {
    writeConfig(withFakeAllowlist({}));
    const row = engine().delegate(baseRequest());
    expect(row.model).toBe("fake-model");
    expect(row.effort).toBe("medium");
  });

  it("errors when no default is flagged and -m/-e omitted", () => {
    writeConfig({
      vendors: {
        fake: {
          models: {
            "fake-model": { efforts: ["low", "high"] },
          },
        },
      },
    });
    expect(() => engine().delegate(baseRequest())).toThrow(/no default model\+effort/);
  });

  it("listed model accepts only explicitly named efforts", () => {
    writeConfig(
      withFakeAllowlist({
        vendors: {
          fake: {
            models: {
              "fake-model": { efforts: ["low"], default: true },
            },
          },
        },
      }),
    );
    const ok = engine().delegate(baseRequest({ model: "fake-model", effort: "low" }));
    expect(ok.effort).toBe("low");
    expect(() =>
      engine().delegate(baseRequest({ model: "fake-model", effort: "high" })),
    ).toThrow(/high/);
  });

  it("profile-supplied combos go through the same validation", () => {
    writeConfig(
      withFakeAllowlist({
        profiles: {
          bad: { vendor: "fake", model: "fake-model", effort: "ultra" },
          good: { vendor: "fake", model: "fake-model", effort: "low" },
        },
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
    );
    expect(() => engine().delegate(baseRequest({ vendor: null, profile: "bad" }))).toThrow(
      /ultra/,
    );
    const row = engine().delegate(baseRequest({ vendor: null, profile: "good" }));
    expect(row.model).toBe("fake-model");
    expect(row.effort).toBe("low");
    expect(row.profile).toBe("good");
  });

  it("fix reattempt on a now-disallowed combo fails with the same error shape", () => {
    writeConfig(
      withFakeAllowlist({
        vendors: {
          fake: {
            models: {
              "fake-model": {
                efforts: ["low", "medium", "high"],
                default: "medium",
              },
            },
          },
        },
      }),
    );
    const parent = engine().delegate(
      baseRequest({ model: "fake-model", effort: "high" }),
    );
    // Force terminal so fix is allowed.
    updateTask(db, parent.id, {
      state: "completed",
      completed_at: new Date().toISOString(),
    });

    // Shrink allowlist: high is no longer permitted.
    writeConfig({
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
    });

    expect(() =>
      engine().fix({
        parentRef: parent.id,
        prompt: "try again",
        fresh: true,
        orchestratorSessionId: "orch",
      }),
    ).toThrow(/high/);
    expect(() =>
      engine().fix({
        parentRef: parent.id,
        prompt: "try again",
        fresh: true,
        orchestratorSessionId: "orch",
      }),
    ).toThrow(/Allowed combos:/);
    // No new row created.
    expect(getTask(db, "t2")).toBeUndefined();
  });
});
