/**
 * #162 — daemon-side ancestry matching with crafted chains.
 */
import { describe, expect, it } from "vitest";
import type { SessionRow } from "../src/db.js";
import {
  matchSessionByAncestry,
  resolveSessionBinding,
  sessionRequiredMessage,
} from "../src/session-binding.js";

function session(
  overrides: Partial<SessionRow> & Pick<SessionRow, "id">,
): SessionRow {
  return {
    harness: "claude",
    model: "opus",
    effort: "high",
    workspace_root: "/repo",
    anchor_machine: "m1",
    anchor_pid: 100,
    anchor_start: "1000",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchSessionByAncestry (#162)", () => {
  it("picks the deepest (closest-to-self) matching session", () => {
    const a = session({
      id: "sess-a",
      anchor_pid: 100,
      anchor_start: "1000",
    });
    const b = session({
      id: "sess-b",
      anchor_pid: 50,
      anchor_start: "500",
    });
    // Caller chain: self(200) → a(100) → b(50) → init
    const chain = [
      { machine_id: "m1", pid: 200, start_time: "2000" },
      { machine_id: "m1", pid: 100, start_time: "1000" },
      { machine_id: "m1", pid: 50, start_time: "500" },
    ];
    expect(matchSessionByAncestry(chain, [a, b])?.id).toBe("sess-a");
  });

  it("never cross-binds two same-cwd sessions (distinct anchors)", () => {
    const a = session({
      id: "orch-1",
      workspace_root: "/same",
      anchor_pid: 111,
      anchor_start: "t1",
    });
    const b = session({
      id: "orch-2",
      workspace_root: "/same",
      anchor_pid: 222,
      anchor_start: "t2",
    });
    // Caller is a descendant of orch-2 only.
    const chain = [
      { machine_id: "m1", pid: 999, start_time: "now" },
      { machine_id: "m1", pid: 222, start_time: "t2" },
      { machine_id: "m1", pid: 1, start_time: "boot" },
    ];
    expect(matchSessionByAncestry(chain, [a, b])?.id).toBe("orch-2");
    // Chain containing only orch-1's anchor binds orch-1.
    const chain1 = [
      { machine_id: "m1", pid: 888, start_time: "now" },
      { machine_id: "m1", pid: 111, start_time: "t1" },
    ];
    expect(matchSessionByAncestry(chain1, [a, b])?.id).toBe("orch-1");
  });

  it("requires machine_id + start_time (pid alone is not enough)", () => {
    const s = session({ id: "s", anchor_pid: 10, anchor_start: "real" });
    // Same pid, wrong start_time → no match (pid recycling).
    expect(
      matchSessionByAncestry(
        [{ machine_id: "m1", pid: 10, start_time: "recycled" }],
        [s],
      ),
    ).toBeNull();
    // Wrong machine → no match (remote namespace).
    expect(
      matchSessionByAncestry(
        [{ machine_id: "other", pid: 10, start_time: "real" }],
        [s],
      ),
    ).toBeNull();
  });
});

describe("resolveSessionBinding (#162)", () => {
  const a = session({ id: "a", workspace_root: "/repo", anchor_pid: 10, anchor_start: "x" });
  const b = session({ id: "b", workspace_root: "/repo", anchor_pid: 20, anchor_start: "y" });
  const other = session({
    id: "c",
    workspace_root: "/other",
    anchor_pid: 30,
    anchor_start: "z",
  });

  it("--session override always wins (known registered id)", () => {
    const r = resolveSessionBinding({
      explicitSessionId: "b",
      ancestryChain: [{ machine_id: "m1", pid: 10, start_time: "x" }],
      workspaceRoot: "/repo",
      sessions: [a, b],
    });
    expect(r).toEqual({ kind: "bound", session: b });
  });

  it("--session override to unknown id is freeform", () => {
    const r = resolveSessionBinding({
      explicitSessionId: "free-form",
      ancestryChain: [],
      workspaceRoot: "/repo",
      sessions: [a],
    });
    expect(r).toEqual({ kind: "freeform", sessionId: "free-form" });
  });

  it("falls back to the single live session for the workspace root", () => {
    const r = resolveSessionBinding({
      explicitSessionId: null,
      ancestryChain: [],
      workspaceRoot: "/repo",
      sessions: [a, other],
    });
    expect(r).toEqual({ kind: "bound", session: a });
  });

  it("errors as ambiguous when multiple live sessions and no ancestry match", () => {
    const r = resolveSessionBinding({
      explicitSessionId: null,
      ancestryChain: [],
      workspaceRoot: "/repo",
      sessions: [a, b],
    });
    expect(r).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("returns unresolved when nothing matches", () => {
    const r = resolveSessionBinding({
      explicitSessionId: null,
      ancestryChain: [],
      workspaceRoot: "/empty",
      sessions: [a],
    });
    expect(r).toEqual({ kind: "unresolved" });
  });

  it("session_required message teaches the command", () => {
    expect(sessionRequiredMessage()).toMatch(/parley session/);
    expect(sessionRequiredMessage()).toMatch(/PARLEY_HARNESS|harness plugin|unknown provenance/);
  });
});
