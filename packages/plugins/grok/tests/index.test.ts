import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readSessionState,
  sessionStatePath,
  type SessionState,
} from "@useparley/core";

import {
  findSessionSummaryPath,
  HARNESS,
  readSummaryProvenance,
  resolveGrokHome,
  resolveSessionId,
  runHook,
} from "../src/index.js";

const FIXED_NOW = new Date("2026-07-20T12:00:00.000Z");
const LATER_NOW = new Date("2026-07-20T12:05:00.000Z");

let tmpRoot: string;
let parleyHome: string;
let grokHome: string;

function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeSummary(
  sessionId: string,
  cwdKey: string,
  body: unknown,
): string {
  const dir = path.join(grokHome, "sessions", cwdKey, sessionId);
  mkdirp(dir);
  const file = path.join(dir, "summary.json");
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

function envFor(sessionId?: string): NodeJS.ProcessEnv {
  return {
    PARLEY_HOME: parleyHome,
    GROK_HOME: grokHome,
    HOME: tmpRoot,
    ...(sessionId !== undefined ? { GROK_SESSION_ID: sessionId } : {}),
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-grok-"));
  parleyHome = path.join(tmpRoot, "parley");
  grokHome = path.join(tmpRoot, "grok");
  mkdirp(parleyHome);
  mkdirp(path.join(grokHome, "sessions"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveSessionId", () => {
  it("prefers GROK_SESSION_ID over stdin", () => {
    expect(
      resolveSessionId(
        { GROK_SESSION_ID: "from-env" },
        { sessionId: "from-stdin" },
      ),
    ).toBe("from-env");
  });

  it("falls back to stdin.sessionId", () => {
    expect(resolveSessionId({}, { sessionId: "from-stdin" })).toBe(
      "from-stdin",
    );
  });

  it("rejects path-like session ids", () => {
    expect(resolveSessionId({ GROK_SESSION_ID: "a/b" })).toBeNull();
    expect(resolveSessionId({}, { sessionId: ".." })).toBeNull();
  });

  it("returns null when neither source has a session id", () => {
    expect(resolveSessionId({}, {})).toBeNull();
  });
});

describe("resolveGrokHome", () => {
  it("uses GROK_HOME when set", () => {
    expect(resolveGrokHome({ GROK_HOME: "/tmp/custom-grok" })).toBe(
      path.resolve("/tmp/custom-grok"),
    );
  });

  it("defaults to $HOME/.grok", () => {
    expect(resolveGrokHome({ HOME: "/tmp/home" })).toBe(
      path.join("/tmp/home", ".grok"),
    );
  });
});

describe("findSessionSummaryPath / readSummaryProvenance", () => {
  const sessionId = "019f8258-cdc5-72e2-a032-d339185df539";

  it("finds summary.json under sessions/<cwd>/<id>/", () => {
    const file = writeSummary(sessionId, "%2Ftmp%2Fproj", {
      current_model_id: "grok-4.5",
      reasoning_effort: "high",
    });
    expect(findSessionSummaryPath(grokHome, sessionId)).toBe(file);
  });

  it("returns null when the session has no summary", () => {
    expect(findSessionSummaryPath(grokHome, sessionId)).toBeNull();
  });

  it("reads model and effort from a valid summary", () => {
    const file = writeSummary(sessionId, "cwd", {
      current_model_id: "grok-4.5",
      reasoning_effort: "low",
    });
    expect(readSummaryProvenance(file)).toEqual({
      model: "grok-4.5",
      effort: "low",
      found: true,
    });
  });

  it("tolerates missing fields as nulls", () => {
    const file = writeSummary(sessionId, "cwd", { info: { id: sessionId } });
    expect(readSummaryProvenance(file)).toEqual({
      model: null,
      effort: null,
      found: true,
    });
  });

  it("tolerates malformed JSON without throwing", () => {
    const dir = path.join(grokHome, "sessions", "cwd", sessionId);
    mkdirp(dir);
    const file = path.join(dir, "summary.json");
    fs.writeFileSync(file, "{not-json", "utf8");
    expect(readSummaryProvenance(file)).toEqual({
      model: null,
      effort: null,
      found: false,
    });
  });

  it("tolerates non-object JSON without throwing", () => {
    const file = writeSummary(sessionId, "cwd", ["array"]);
    // writeSummary stringifies — write a raw array payload
    fs.writeFileSync(file, "[1,2,3]\n", "utf8");
    expect(readSummaryProvenance(file)).toEqual({
      model: null,
      effort: null,
      found: false,
    });
  });

  it("tolerates missing path", () => {
    expect(readSummaryProvenance(null)).toEqual({
      model: null,
      effort: null,
      found: false,
    });
    expect(readSummaryProvenance("/no/such/summary.json")).toEqual({
      model: null,
      effort: null,
      found: false,
    });
  });
});

describe("runHook", () => {
  const sessionId = "sess-abc-123";
  const harnessPid = 4242;

  function readState(): SessionState | null {
    return readSessionState(sessionStatePath(parleyHome, HARNESS, sessionId));
  }

  it("writes state.json from GROK_SESSION_ID with null model/effort at start", () => {
    const state = runHook({
      env: envFor(sessionId),
      stdin: { hookEventName: "session_start", sessionId },
      harnessPid,
      now: () => FIXED_NOW,
    });

    expect(state).toEqual({
      harness: "grok",
      harness_session_id: sessionId,
      model: null,
      effort: null,
      pid: harnessPid,
      started_at: FIXED_NOW.toISOString(),
      updated_at: FIXED_NOW.toISOString(),
    });
    expect(readState()).toEqual(state);
  });

  it("uses stdin.sessionId when env is absent", () => {
    const state = runHook({
      env: envFor(),
      stdin: { sessionId },
      harnessPid,
      now: () => FIXED_NOW,
    });
    expect(state?.harness_session_id).toBe(sessionId);
    expect(readState()?.harness_session_id).toBe(sessionId);
  });

  it("lazy-fills model/effort from summary.json when available", () => {
    writeSummary(sessionId, "%2Fwork", {
      current_model_id: "grok-4.5",
      reasoning_effort: "high",
    });

    const state = runHook({
      env: envFor(sessionId),
      stdin: { hookEventName: "stop" },
      harnessPid,
      now: () => FIXED_NOW,
    });

    expect(state?.model).toBe("grok-4.5");
    expect(state?.effort).toBe("high");
    expect(readState()?.model).toBe("grok-4.5");
  });

  it("updates model/effort on later hooks and preserves started_at", () => {
    runHook({
      env: envFor(sessionId),
      harnessPid,
      now: () => FIXED_NOW,
    });

    writeSummary(sessionId, "cwd", {
      current_model_id: "grok-4.5",
      reasoning_effort: "medium",
    });

    const updated = runHook({
      env: envFor(sessionId),
      harnessPid,
      now: () => LATER_NOW,
    });

    expect(updated).toMatchObject({
      model: "grok-4.5",
      effort: "medium",
      started_at: FIXED_NOW.toISOString(),
      updated_at: LATER_NOW.toISOString(),
      pid: harnessPid,
    });
  });

  it("keeps prior model/effort when summary later goes missing", () => {
    writeSummary(sessionId, "cwd", {
      current_model_id: "grok-4.5",
      reasoning_effort: "high",
    });
    runHook({
      env: envFor(sessionId),
      harnessPid,
      now: () => FIXED_NOW,
    });

    // Remove summary artifact (e.g. mid-session path churn).
    fs.rmSync(path.join(grokHome, "sessions"), { recursive: true, force: true });

    const kept = runHook({
      env: envFor(sessionId),
      harnessPid,
      now: () => LATER_NOW,
    });

    expect(kept?.model).toBe("grok-4.5");
    expect(kept?.effort).toBe("high");
    // No material change → started_at and previous updated_at retained via
    // skip-rewrite path (returns existing).
    expect(kept?.started_at).toBe(FIXED_NOW.toISOString());
  });

  it("does nothing without a session id", () => {
    expect(
      runHook({
        env: envFor(),
        stdin: {},
        harnessPid,
        now: () => FIXED_NOW,
      }),
    ).toBeNull();
    expect(fs.existsSync(path.join(parleyHome, "vendors"))).toBe(false);
  });

  it("does nothing with an invalid harness pid", () => {
    expect(
      runHook({
        env: envFor(sessionId),
        harnessPid: 0,
        now: () => FIXED_NOW,
      }),
    ).toBeNull();
  });

  it("stays tolerant of malformed summary during lazy completion", () => {
    const dir = path.join(grokHome, "sessions", "cwd", sessionId);
    mkdirp(dir);
    fs.writeFileSync(path.join(dir, "summary.json"), "NOT JSON {{{", "utf8");

    const state = runHook({
      env: envFor(sessionId),
      harnessPid,
      now: () => FIXED_NOW,
    });

    expect(state).toMatchObject({
      harness: "grok",
      harness_session_id: sessionId,
      model: null,
      effort: null,
      pid: harnessPid,
    });
  });
});
