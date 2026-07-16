/**
 * Profile resolution precedence (#113) and profile column migration.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  getTask,
  openDatabase,
  openDatabaseUpTo,
  SCHEMA_VERSION,
  type DatabaseHandle,
} from "../src/db.js";
import { DelegateError, TaskEngine } from "../src/engine.js";

let home: string;
let db: DatabaseHandle;

function writeParleyConfig(body: unknown): void {
  fs.writeFileSync(path.join(home, "parley.json"), JSON.stringify(body));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-profiles-"));
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

function engine(): TaskEngine {
  return new TaskEngine(db, homePaths(home), createAdapterRegistrySync({}));
}

function baseRequest(
  overrides: Partial<Parameters<TaskEngine["delegate"]>[0]> = {},
): Parameters<TaskEngine["delegate"]>[0] {
  return {
    prompt: "do it",
    vendor: null,
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
    ...overrides,
  };
}

describe("profile resolution precedence (#113)", () => {
  it("uses profile vendor/model/effort/sandbox/network when request omits them", () => {
    writeParleyConfig({
      profiles: {
        deep: {
          vendor: "fake",
          model: "m-profile",
          effort: "high",
          sandbox: "read-only",
          network: false,
        },
      },
    });
    // fake adapter needs PARLEY_FAKE_VENDOR_BIN only at spawn — delegate just checks registry.
    const row = engine().delegate(baseRequest({ profile: "deep" }));
    expect(row.vendor).toBe("fake");
    expect(row.model).toBe("m-profile");
    expect(row.effort).toBe("high");
    expect(row.sandbox).toBe("read-only");
    expect(row.network).toBe(0);
    expect(row.profile).toBe("deep");
  });

  it("explicit request fields beat profile values", () => {
    writeParleyConfig({
      profiles: {
        deep: {
          vendor: "fake",
          model: "m-profile",
          effort: "high",
          sandbox: "read-only",
          network: false,
        },
      },
    });
    const row = engine().delegate(
      baseRequest({
        profile: "deep",
        vendor: "fake",
        model: "m-explicit",
        effort: "low",
        sandbox: "full",
        network: true,
      }),
    );
    expect(row.model).toBe("m-explicit");
    expect(row.effort).toBe("low");
    expect(row.sandbox).toBe("full");
    expect(row.network).toBe(1);
    expect(row.profile).toBe("deep");
  });

  it("falls back to ADR defaults when neither request nor profile set posture", () => {
    writeParleyConfig({
      profiles: { bare: { vendor: "fake" } },
    });
    const row = engine().delegate(baseRequest({ profile: "bare" }));
    expect(row.sandbox).toBe("workspace");
    expect(row.network).toBe(1);
  });

  it("rejects an unknown profile naming known ones", () => {
    writeParleyConfig({
      profiles: { deep: { vendor: "fake" }, quick: { vendor: "codex" } },
    });
    expect(() => engine().delegate(baseRequest({ profile: "nope" }))).toThrow(DelegateError);
    expect(() => engine().delegate(baseRequest({ profile: "nope" }))).toThrow(
      /unknown profile: nope \(known: deep, quick\)/,
    );
  });

  it("rejects when profile resolves to an unknown vendor", () => {
    writeParleyConfig({
      profiles: { bad: { vendor: "not-a-vendor" } },
    });
    expect(() => engine().delegate(baseRequest({ profile: "bad" }))).toThrow(
      /unknown vendor: not-a-vendor/,
    );
  });

  it("requires vendor or profile", () => {
    expect(() => engine().delegate(baseRequest())).toThrow(/vendor is required/);
  });
});

describe("profile column migration (#113)", () => {
  it("adds the profile column on open", () => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-profile-mig-"));
    // Profile is the second-to-last migration; runner (#111) is last. Open at
    // SCHEMA_VERSION - 2 so neither profile nor runner columns exist yet.
    const prev = openDatabaseUpTo(homePaths(home), SCHEMA_VERSION - 2);
    const colsBefore = prev
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsBefore).not.toContain("profile");
    expect(colsBefore).not.toContain("runner");
    prev.close();

    db = openDatabase(homePaths(home));
    const colsAfter = db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colsAfter).toContain("profile");
    expect(colsAfter).toContain("runner");
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
  });

  it("persists profile on insert and surfaces it on getTask", () => {
    writeParleyConfig({ profiles: { deep: { vendor: "fake" } } });
    const row = engine().delegate(baseRequest({ profile: "deep", name: "n1" }));
    const got = getTask(db, row.id)!;
    expect(got.profile).toBe("deep");
  });
});
