/**
 * #154 — launch-command capture helpers and model/effort resolution order.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  openDatabase,
  openDatabaseUpTo,
  SCHEMA_VERSION,
  type DatabaseHandle,
} from "../src/db.js";
import { DelegateError, TaskEngine } from "../src/engine.js";
import {
  appendLaunchCommand,
  captureLaunchCommand,
  parseLaunchCommands,
  resolveTraceField,
  upgradeTraceField,
} from "../src/trace.js";
import { withFakeAllowlist } from "./helpers.js";

describe("resolveTraceField (request > profile > adapter default)", () => {
  it("prefers explicit request over profile and adapter default", () => {
    expect(resolveTraceField("req", "prof", "adapt")).toEqual({
      value: "req",
      source: "resolved",
    });
  });

  it("uses profile when request is null", () => {
    expect(resolveTraceField(null, "prof", "adapt")).toEqual({
      value: "prof",
      source: "resolved",
    });
  });

  it("uses adapter default when request and profile are null", () => {
    expect(resolveTraceField(null, null, "adapt")).toEqual({
      value: "adapt",
      source: "resolved",
    });
  });

  it("stays null when no tier supplies a value — never fabricates", () => {
    expect(resolveTraceField(null, null, null)).toEqual({ value: null, source: null });
    expect(resolveTraceField(undefined, undefined, undefined)).toEqual({
      value: null,
      source: null,
    });
    expect(resolveTraceField("", "", "")).toEqual({ value: null, source: null });
  });
});

describe("upgradeTraceField (vendor session_meta)", () => {
  it("upgrades a resolved value to vendor when the stream reports one", () => {
    expect(
      upgradeTraceField({ value: "resolved-m", source: "resolved" }, "vendor-m"),
    ).toEqual({ value: "vendor-m", source: "vendor" });
  });

  it("fills an unknown field from the vendor report", () => {
    expect(upgradeTraceField({ value: null, source: null }, "vendor-m")).toEqual({
      value: "vendor-m",
      source: "vendor",
    });
  });

  it("leaves the current field alone when the vendor reports nothing", () => {
    const current = { value: "resolved-m" as string | null, source: "resolved" as const };
    expect(upgradeTraceField(current, null)).toEqual(current);
    expect(upgradeTraceField(current, undefined)).toEqual(current);
    expect(upgradeTraceField(current, "")).toEqual(current);
  });
});

describe("captureLaunchCommand / appendLaunchCommand", () => {
  it("elides the prompt and records env names only (sorted)", () => {
    const prompt = "do the thing with secrets";
    const record = captureLaunchCommand(
      {
        argv: ["codex", "exec", "--json", prompt],
        cwd: "/tmp/wt",
        env: { CODEX_API_KEY: "sk-secret", NO_COLOR: "1" },
      },
      prompt,
      { CODEX_API_KEY: "sk-secret", NO_COLOR: "1", PARLEY_TASK_ID: "t1" },
    );
    expect(record.argv).toEqual(["codex", "exec", "--json", "<prompt>"]);
    expect(record.cwd).toBe("/tmp/wt");
    expect(record.env_names).toEqual(["CODEX_API_KEY", "NO_COLOR", "PARLEY_TASK_ID"]);
    // Values must never appear in the serialized record.
    const json = JSON.stringify(record);
    expect(json).not.toContain("sk-secret");
    expect(json).not.toContain("do the thing");
  });

  it("appends one entry per spawn", () => {
    const a = captureLaunchCommand(
      { argv: ["v", "a"], cwd: "/a", env: {} },
      "p",
      { A: "1" },
    );
    const b = captureLaunchCommand(
      { argv: ["v", "b"], cwd: "/b", env: {} },
      "p",
      { B: "2" },
    );
    const json = appendLaunchCommand(appendLaunchCommand(null, a), b);
    expect(parseLaunchCommands(json)).toEqual([a, b]);
  });
});

describe("launch_command + model_source migration (#154)", () => {
  let home: string;
  let db: DatabaseHandle;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-trace-mig-"));
    db = openDatabase(homePaths(home));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("adds launch_command, model_source, effort_source columns on open", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-trace-mig-"));
    // Version 19 is the schema just before the #154 launch_command migration;
    // pinned absolute so later appended migrations don't shift this fixture.
    const prev = openDatabaseUpTo(homePaths(home), 19);
    const colsBefore = prev
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsBefore).not.toContain("launch_command");
    expect(colsBefore).not.toContain("model_source");
    expect(colsBefore).not.toContain("effort_source");
    prev.close();

    db = openDatabase(homePaths(home));
    const colsAfter = db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsAfter).toContain("launch_command");
    expect(colsAfter).toContain("model_source");
    expect(colsAfter).toContain("effort_source");
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
  });
});

describe("engine resolution order with allowlist default (#154 / #185)", () => {
  let home: string;
  let db: DatabaseHandle;
  const FAKE_VENDOR_BIN = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../cli/tests/fake-vendor.mjs",
  );

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-trace-eng-"));
    db = openDatabase(homePaths(home));
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify(withFakeAllowlist({})),
    );
    process.env.PARLEY_FAKE_VENDOR_BIN = FAKE_VENDOR_BIN;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.PARLEY_FAKE_VENDOR_BIN;
  });

  function engineBare(): TaskEngine {
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
      cwd: home,
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

  it("uses allowlist default when request and profile omit model/effort", () => {
    const row = engineBare().delegate(baseRequest());
    expect(row.model).toBe("fake-model");
    expect(row.effort).toBe("medium");
    expect(row.model_source).toBe("resolved");
    expect(row.effort_source).toBe("resolved");
  });

  it("profile beats allowlist default; request beats profile", () => {
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify(
        withFakeAllowlist({
          profiles: {
            deep: { vendor: "fake", model: "prof-m", effort: "prof-e" },
          },
        }),
      ),
    );
    const viaProfile = engineBare().delegate(
      baseRequest({ vendor: null, profile: "deep" }),
    );
    expect(viaProfile.model).toBe("prof-m");
    expect(viaProfile.effort).toBe("prof-e");
    expect(viaProfile.model_source).toBe("resolved");

    const viaRequest = engineBare().delegate(
      baseRequest({
        vendor: null,
        profile: "deep",
        model: "req-m",
        effort: "req-e",
      }),
    );
    expect(viaRequest.model).toBe("req-m");
    expect(viaRequest.effort).toBe("req-e");
    expect(viaRequest.model_source).toBe("resolved");
  });

  it("fails when vendor has no allowlist (deny-by-default)", () => {
    fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify({}));
    const engine = engineBare();
    expect(() => engine.delegate(baseRequest())).toThrow(DelegateError);
    expect(() => engine.delegate(baseRequest())).toThrow(/no models configured/);
    expect(() => engine.delegate(baseRequest())).toThrow(/parley-wizard/);
  });
});
