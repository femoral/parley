/**
 * #196 — ancestry-matched session-state selection (unit).
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionStatePath, writeSessionState, type SessionState } from "@useparley/core";
import {
  matchSessionState,
  resolveOrchestratorSessionId,
  resolveProvenanceField,
  resolveProvenanceFromEnvAndState,
} from "../src/session-state-match.js";
import type { ProcessAnchor } from "../src/ancestry.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ssm-"));
  dirs.push(d);
  return d;
}

function state(over: Partial<SessionState> & Pick<SessionState, "pid" | "harness_session_id">): SessionState {
  return {
    harness: "claude",
    model: "opus",
    effort: "high",
    started_at: "2026-07-20T10:00:00.000Z",
    updated_at: "2026-07-20T10:00:00.000Z",
    ...over,
  };
}

function write(
  home: string,
  vendor: string,
  s: SessionState,
): void {
  writeSessionState(sessionStatePath(home, vendor, s.harness_session_id), s);
}

const chain = (pids: number[]): ProcessAnchor[] =>
  pids.map((pid) => ({
    machine_id: "m",
    pid,
    start_time: `st-${pid}`,
  }));

describe("matchSessionState", () => {
  it("matches a live pid present in the ancestry chain", () => {
    const home = tmpHome();
    write(home, "claude", state({ pid: 50, harness_session_id: "hs-50" }));
    const matched = matchSessionState(home, chain([100, 50, 1]), {
      isAlive: (pid) => pid === 50 || pid === 100 || pid === 1,
    });
    expect(matched?.harness_session_id).toBe("hs-50");
    expect(matched?.harness).toBe("claude");
  });

  it("prefers the deepest (closest-to-self) pid", () => {
    const home = tmpHome();
    write(home, "a", state({ pid: 1, harness_session_id: "outer", harness: "a" }));
    write(home, "b", state({ pid: 50, harness_session_id: "inner", harness: "b" }));
    const matched = matchSessionState(home, chain([100, 50, 1]), {
      isAlive: () => true,
    });
    expect(matched?.harness_session_id).toBe("inner");
  });

  it("at same depth prefers most-recent updated_at", () => {
    const home = tmpHome();
    write(
      home,
      "old",
      state({
        pid: 50,
        harness_session_id: "old",
        updated_at: "2026-07-20T10:00:00.000Z",
      }),
    );
    write(
      home,
      "new",
      state({
        pid: 50,
        harness_session_id: "new",
        updated_at: "2026-07-20T12:00:00.000Z",
      }),
    );
    const matched = matchSessionState(home, chain([50]), { isAlive: () => true });
    expect(matched?.harness_session_id).toBe("new");
  });

  it("ignores dead pids with a diag note", () => {
    const home = tmpHome();
    write(home, "v", state({ pid: 99999, harness_session_id: "dead" }));
    const notes: string[] = [];
    const matched = matchSessionState(home, chain([99999]), {
      isAlive: () => false,
      note: (m) => notes.push(m),
    });
    expect(matched).toBeNull();
    expect(notes.join(" ")).toMatch(/dead pid/i);
  });

  it("ignores files whose pid is not in the chain", () => {
    const home = tmpHome();
    write(home, "v", state({ pid: 42, harness_session_id: "other" }));
    expect(
      matchSessionState(home, chain([1, 2]), { isAlive: () => true }),
    ).toBeNull();
  });

  it("skips on start_time mismatch when a reader is provided", () => {
    const home = tmpHome();
    write(home, "v", state({ pid: 50, harness_session_id: "recycled" }));
    const notes: string[] = [];
    const matched = matchSessionState(home, chain([50]), {
      isAlive: () => true,
      readStartTime: () => "different-start",
      note: (m) => notes.push(m),
    });
    expect(matched).toBeNull();
    expect(notes.join(" ")).toMatch(/start_time/i);
  });

  it("returns null when home has no vendors", () => {
    expect(matchSessionState(tmpHome(), chain([1]), { isAlive: () => true })).toBeNull();
  });
});

describe("resolveOrchestratorSessionId / provenance", () => {
  it("env > flag > state > null", () => {
    expect(
      resolveOrchestratorSessionId({
        envSessionId: "from-env",
        flagSessionId: "from-flag",
        stateSessionId: "from-state",
      }),
    ).toBe("from-env");
    expect(
      resolveOrchestratorSessionId({
        envSessionId: undefined,
        flagSessionId: "from-flag",
        stateSessionId: "from-state",
      }),
    ).toBe("from-flag");
    expect(
      resolveOrchestratorSessionId({
        envSessionId: "",
        flagSessionId: null,
        stateSessionId: "from-state",
      }),
    ).toBe("from-state");
    expect(
      resolveOrchestratorSessionId({
        envSessionId: undefined,
        flagSessionId: null,
        stateSessionId: null,
      }),
    ).toBeNull();
  });

  it("env beats state for provenance fields", () => {
    const matched = state({
      pid: 1,
      harness_session_id: "s",
      harness: "file-h",
      model: "file-m",
      effort: "file-e",
    });
    expect(
      resolveProvenanceFromEnvAndState(
        { PARLEY_HARNESS: "env-h", PARLEY_MODEL: "env-m", PARLEY_EFFORT: "env-e" },
        matched,
      ),
    ).toEqual({ harness: "env-h", model: "env-m", effort: "env-e" });
    expect(resolveProvenanceFromEnvAndState({}, matched)).toEqual({
      harness: "file-h",
      model: "file-m",
      effort: "file-e",
    });
    expect(resolveProvenanceField(undefined, null)).toBeNull();
  });
});
