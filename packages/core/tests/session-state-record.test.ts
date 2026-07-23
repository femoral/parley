/**
 * #211 — write-side provenance recorder: merge policy, skip-if-unchanged,
 * invalid observation, env materialization, malformed-state tolerance.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyProvenanceEnv,
  nonEmptyString,
  provenanceEnvVars,
  readSessionState,
  recordSessionState,
  sessionStatePath,
  writeSessionState,
  type ProvenanceObservation,
  type SessionState,
} from "../src/session-state.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ssr-"));
  dirs.push(d);
  return d;
}

function baseObs(
  over: Partial<ProvenanceObservation> = {},
): ProvenanceObservation {
  return {
    harness: "codex",
    harness_session_id: "sess-1",
    pid: 100,
    ...over,
  };
}

function record(
  home: string,
  obs: ProvenanceObservation,
  now: string,
  extra: { skipIfUnchanged?: boolean } = {},
) {
  return recordSessionState(obs, {
    parleyHome: home,
    now: () => new Date(now),
    ...extra,
  });
}

describe("nonEmptyString", () => {
  it("trims and rejects blank / non-string", () => {
    expect(nonEmptyString("  abc  ")).toBe("abc");
    expect(nonEmptyString("")).toBeNull();
    expect(nonEmptyString("   ")).toBeNull();
    expect(nonEmptyString(null)).toBeNull();
    expect(nonEmptyString(42)).toBeNull();
    expect(nonEmptyString(undefined)).toBeNull();
  });
});

describe("recordSessionState merge policy", () => {
  it("fill keeps previous when observation is null", () => {
    const home = tmpHome();
    const first = record(home, baseObs({ model: "gpt-5", effort: "high" }), "2026-07-20T10:00:00.000Z");
    expect(first?.written).toBe(true);

    const second = record(
      home,
      baseObs({ model: null, effort: null, pid: 100 }),
      "2026-07-20T11:00:00.000Z",
    );
    expect(second?.state.model).toBe("gpt-5");
    expect(second?.state.effort).toBe("high");
    // Unchanged identity fields → skip rewrite
    expect(second?.written).toBe(false);
  });

  it("fill uses new non-empty observation over previous", () => {
    const home = tmpHome();
    record(home, baseObs({ model: "old" }), "2026-07-20T10:00:00.000Z");
    const next = record(
      home,
      baseObs({ model: "new", pid: 101 }),
      "2026-07-20T11:00:00.000Z",
    );
    expect(next?.state.model).toBe("new");
    expect(next?.state.pid).toBe(101);
    expect(next?.written).toBe(true);
  });

  it("replace + observed clears previous to null (honest unknown)", () => {
    const home = tmpHome();
    record(
      home,
      baseObs({ model: "grok-4.5", effort: "high" }),
      "2026-07-20T10:00:00.000Z",
    );
    const next = record(
      home,
      baseObs({
        model: null,
        effort: null,
        modelPolicy: "replace",
        effortPolicy: "replace",
        observed: { model: true, effort: true },
      }),
      "2026-07-20T11:00:00.000Z",
    );
    expect(next?.state.model).toBeNull();
    expect(next?.state.effort).toBeNull();
    expect(next?.written).toBe(true);
  });

  it("replace without observed keeps previous", () => {
    const home = tmpHome();
    record(
      home,
      baseObs({ model: "grok-4.5", effort: "high" }),
      "2026-07-20T10:00:00.000Z",
    );
    const next = record(
      home,
      baseObs({
        model: null,
        effort: null,
        modelPolicy: "replace",
        effortPolicy: "replace",
        observed: { model: false, effort: false },
      }),
      "2026-07-20T11:00:00.000Z",
    );
    expect(next?.state.model).toBe("grok-4.5");
    expect(next?.state.effort).toBe("high");
    expect(next?.written).toBe(false);
  });

  it("replace with observed true and non-empty values updates", () => {
    const home = tmpHome();
    record(home, baseObs({ model: null, effort: null }), "2026-07-20T10:00:00.000Z");
    const next = record(
      home,
      baseObs({
        model: "grok-4.5",
        effort: "medium",
        modelPolicy: "replace",
        effortPolicy: "replace",
        observed: { model: true, effort: true },
      }),
      "2026-07-20T11:00:00.000Z",
    );
    expect(next?.state).toMatchObject({
      model: "grok-4.5",
      effort: "medium",
      started_at: "2026-07-20T10:00:00.000Z",
      updated_at: "2026-07-20T11:00:00.000Z",
    });
  });
});

describe("recordSessionState skip-if-unchanged", () => {
  it("suppresses rewrite when identity fields match", () => {
    const home = tmpHome();
    const first = record(
      home,
      baseObs({ model: "m", effort: "e" }),
      "2026-07-20T10:00:00.000Z",
    );
    const file = sessionStatePath(home, "codex", "sess-1");
    const mtime1 = fs.statSync(file).mtimeMs;

    const second = record(
      home,
      baseObs({ model: "m", effort: "e" }),
      "2026-07-20T12:00:00.000Z",
    );
    expect(second?.written).toBe(false);
    expect(second?.state.updated_at).toBe("2026-07-20T10:00:00.000Z");
    expect(second?.state).toEqual(first?.state);
    expect(fs.statSync(file).mtimeMs).toBe(mtime1);
  });

  it("first write always lands and preserves started_at on update", () => {
    const home = tmpHome();
    const first = record(home, baseObs({ model: "a" }), "2026-07-20T10:00:00.000Z");
    expect(first?.written).toBe(true);
    expect(first?.previous).toBeNull();

    const second = record(
      home,
      baseObs({ model: "b", pid: 200 }),
      "2026-07-20T11:00:00.000Z",
    );
    expect(second?.written).toBe(true);
    expect(second?.state.started_at).toBe("2026-07-20T10:00:00.000Z");
    expect(second?.state.updated_at).toBe("2026-07-20T11:00:00.000Z");
  });

  it("skipIfUnchanged false forces rewrite even when unchanged", () => {
    const home = tmpHome();
    record(home, baseObs({ model: "m" }), "2026-07-20T10:00:00.000Z");
    const forced = record(
      home,
      baseObs({ model: "m" }),
      "2026-07-20T12:00:00.000Z",
      { skipIfUnchanged: false },
    );
    expect(forced?.written).toBe(true);
    expect(forced?.state.updated_at).toBe("2026-07-20T12:00:00.000Z");
  });
});

describe("recordSessionState invalid / tolerant inputs", () => {
  it("returns null for invalid session id or pid without throwing", () => {
    const home = tmpHome();
    expect(
      recordSessionState(baseObs({ harness_session_id: "" }), {
        parleyHome: home,
      }),
    ).toBeNull();
    expect(
      recordSessionState(baseObs({ harness_session_id: "a/b" }), {
        parleyHome: home,
      }),
    ).toBeNull();
    expect(
      recordSessionState(baseObs({ pid: 0 }), { parleyHome: home }),
    ).toBeNull();
    expect(
      recordSessionState(baseObs({ pid: -1 }), { parleyHome: home }),
    ).toBeNull();
    expect(
      recordSessionState(baseObs({ harness: "" }), { parleyHome: home }),
    ).toBeNull();
    expect(fs.existsSync(path.join(home, "vendors"))).toBe(false);
  });

  it("treats malformed previous state as absent (first write lands)", () => {
    const home = tmpHome();
    const file = sessionStatePath(home, "codex", "sess-1");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json", "utf8");

    const result = record(
      home,
      baseObs({ model: "recovered" }),
      "2026-07-20T10:00:00.000Z",
    );
    expect(result?.written).toBe(true);
    expect(result?.previous).toBeNull();
    expect(result?.state.model).toBe("recovered");
    expect(readSessionState(file)?.model).toBe("recovered");
  });

  it("treats schema-invalid previous state as absent", () => {
    const home = tmpHome();
    const file = sessionStatePath(home, "codex", "sess-1");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ harness: "codex" }), "utf8");

    const result = record(home, baseObs({ model: "ok" }), "2026-07-20T10:00:00.000Z");
    expect(result?.written).toBe(true);
    expect(result?.previous).toBeNull();
  });
});

describe("provenanceEnvVars / applyProvenanceEnv", () => {
  it("omits null model and effort", () => {
    expect(
      provenanceEnvVars({
        harness_session_id: "s1",
        harness: "pi",
        model: null,
        effort: null,
      }),
    ).toEqual({
      PARLEY_SESSION_ID: "s1",
      PARLEY_HARNESS: "pi",
    });
  });

  it("includes non-null model and effort", () => {
    expect(
      provenanceEnvVars({
        harness_session_id: "s1",
        harness: "pi",
        model: "anthropic/claude",
        effort: "high",
      }),
    ).toEqual({
      PARLEY_SESSION_ID: "s1",
      PARLEY_HARNESS: "pi",
      PARLEY_MODEL: "anthropic/claude",
      PARLEY_EFFORT: "high",
    });
  });

  it("applyProvenanceEnv sets and clears keys on a target env", () => {
    const env: NodeJS.ProcessEnv = {
      PARLEY_MODEL: "stale/model",
      PARLEY_EFFORT: "stale",
    };
    applyProvenanceEnv(
      {
        harness_session_id: "s1",
        harness: "pi",
        model: null,
        effort: "xhigh",
      },
      env,
    );
    expect(env.PARLEY_SESSION_ID).toBe("s1");
    expect(env.PARLEY_HARNESS).toBe("pi");
    expect(env.PARLEY_MODEL).toBeUndefined();
    expect(env.PARLEY_EFFORT).toBe("xhigh");
  });
});

describe("recordSessionState identity fields", () => {
  it("always takes harness, session id, and pid from the observation", () => {
    const home = tmpHome();
    const prior: SessionState = {
      harness: "old-harness",
      harness_session_id: "other",
      model: "m",
      effort: null,
      pid: 1,
      started_at: "2026-07-20T09:00:00.000Z",
      updated_at: "2026-07-20T09:00:00.000Z",
    };
    // Seed a file under the observation's path so "previous" is for this session.
    writeSessionState(sessionStatePath(home, "codex", "sess-1"), {
      ...prior,
      harness: "codex",
      harness_session_id: "sess-1",
    });

    const result = record(
      home,
      baseObs({ model: null, pid: 999 }),
      "2026-07-20T12:00:00.000Z",
    );
    expect(result?.state).toMatchObject({
      harness: "codex",
      harness_session_id: "sess-1",
      model: "m", // fill from previous
      pid: 999,
      started_at: "2026-07-20T09:00:00.000Z",
    });
  });
});
