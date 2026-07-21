/**
 * #196 — session-state schema, path, atomic write, scan/read degrade.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSessionState,
  readSessionState,
  scanSessionStates,
  sessionStatePath,
  writeSessionState,
  type SessionState,
} from "../src/session-state.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ss-"));
  dirs.push(d);
  return d;
}

function sample(over: Partial<SessionState> = {}): SessionState {
  return {
    harness: "claude",
    harness_session_id: "sess-abc",
    model: "sonnet",
    effort: "high",
    pid: 12345,
    started_at: "2026-07-20T12:00:00.000Z",
    updated_at: "2026-07-20T12:05:00.000Z",
    ...over,
  };
}

describe("sessionStatePath", () => {
  it("joins home/vendors/<vendor>/sessions/<id>/state.json", () => {
    expect(sessionStatePath("/tmp/ph", "claude", "s1")).toBe(
      path.join("/tmp/ph", "vendors", "claude", "sessions", "s1", "state.json"),
    );
  });

  it("rejects path-escaping segments", () => {
    expect(() => sessionStatePath("/h", "../x", "s")).toThrow(/vendor/);
    expect(() => sessionStatePath("/h", "v", "a/b")).toThrow(/harness_session_id/);
  });
});

describe("parseSessionState", () => {
  it("accepts a full valid object", () => {
    expect(parseSessionState(sample())).toEqual(sample());
  });

  it("nulls missing/blank model and effort (partial fields)", () => {
    expect(
      parseSessionState({
        harness: "codex",
        harness_session_id: "x",
        pid: 1,
        model: null,
        effort: "",
        started_at: "t0",
        updated_at: "t1",
      }),
    ).toEqual({
      harness: "codex",
      harness_session_id: "x",
      model: null,
      effort: null,
      pid: 1,
      started_at: "t0",
      updated_at: "t1",
    });
  });

  it("rejects missing pid or harness_session_id", () => {
    expect(parseSessionState({ harness: "h", pid: 1 })).toBeNull();
    expect(parseSessionState({ harness_session_id: "s" })).toBeNull();
    expect(parseSessionState({ harness_session_id: "s", pid: 0 })).toBeNull();
    expect(parseSessionState(null)).toBeNull();
    expect(parseSessionState("nope")).toBeNull();
  });

  it("treats non-string model as null rather than rejecting the file", () => {
    const s = parseSessionState({
      harness: "g",
      harness_session_id: "s",
      pid: 9,
      model: 42,
      effort: { x: 1 },
    });
    expect(s).not.toBeNull();
    expect(s!.model).toBeNull();
    expect(s!.effort).toBeNull();
  });
});

describe("writeSessionState / readSessionState", () => {
  it("round-trips via atomic write", () => {
    const home = tmpHome();
    const file = sessionStatePath(home, "grok", "hs-1");
    const state = sample({ harness: "grok", harness_session_id: "hs-1" });
    writeSessionState(file, state);
    expect(fs.existsSync(file)).toBe(true);
    expect(readSessionState(file)).toEqual(state);
    // No leftover temps next to the file.
    const siblings = fs.readdirSync(path.dirname(file));
    expect(siblings).toEqual(["state.json"]);
  });

  it("returns null for missing file without noting", () => {
    const notes: string[] = [];
    expect(
      readSessionState(path.join(tmpHome(), "nope.json"), (m) => notes.push(m)),
    ).toBeNull();
    expect(notes).toEqual([]);
  });

  it("notes malformed JSON and returns null", () => {
    const home = tmpHome();
    const file = sessionStatePath(home, "v", "s");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    const notes: string[] = [];
    expect(readSessionState(file, (m) => notes.push(m))).toBeNull();
    expect(notes.join(" ")).toMatch(/malformed/i);
  });
});

describe("scanSessionStates", () => {
  it("finds state files under vendors/*/sessions/*/", () => {
    const home = tmpHome();
    writeSessionState(
      sessionStatePath(home, "claude", "a"),
      sample({ harness: "claude", harness_session_id: "a", pid: 1 }),
    );
    writeSessionState(
      sessionStatePath(home, "codex", "b"),
      sample({ harness: "codex", harness_session_id: "b", pid: 2 }),
    );
    const found = scanSessionStates(home);
    expect(found.map((f) => f.state.harness_session_id).sort()).toEqual(["a", "b"]);
  });

  it("skips garbage without throwing", () => {
    const home = tmpHome();
    const bad = sessionStatePath(home, "v", "bad");
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad, "[]");
    const notes: string[] = [];
    expect(scanSessionStates(home, (m) => notes.push(m))).toEqual([]);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("returns [] when vendors dir is absent", () => {
    expect(scanSessionStates(tmpHome())).toEqual([]);
  });
});
