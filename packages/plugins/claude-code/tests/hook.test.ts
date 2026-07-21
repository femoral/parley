import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readSessionState, sessionStatePath } from "@useparley/core";
import { afterEach, describe, expect, it } from "vitest";

import { runHook } from "../src/hook.js";

const roots: string[] = [];

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parley-claude-hook-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

describe("Claude Code session provenance hook", () => {
  it("writes startup state and shell-safe environment exports", () => {
    const root = fixtureRoot();
    const envFile = path.join(root, "claude-env");

    runHook(
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "claude-session-123",
        model: "claude-sonnet-5",
        transcript_path: path.join(root, "transcript.jsonl"),
      }),
      { parleyHome: root, envFile, harnessPid: 4321, now: () => "2026-07-20T10:00:00.000Z" },
    );

    expect(readSessionState(sessionStatePath(root, "claude", "claude-session-123"))).toEqual({
      harness: "claude",
      harness_session_id: "claude-session-123",
      model: "claude-sonnet-5",
      effort: null,
      pid: 4321,
      started_at: "2026-07-20T10:00:00.000Z",
      updated_at: "2026-07-20T10:00:00.000Z",
    });
    expect(fs.readFileSync(envFile, "utf8")).toBe(
      "export PARLEY_SESSION_ID='claude-session-123'\n" +
        "export PARLEY_HARNESS='claude'\n" +
        "export PARLEY_MODEL='claude-sonnet-5'\n",
    );
  });

  it("keeps unavailable startup metadata honestly null", () => {
    const root = fixtureRoot();
    const envFile = path.join(root, "claude-env");

    runHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "unknown-model" }), {
      parleyHome: root,
      envFile,
      harnessPid: 99,
      now: () => "2026-07-20T11:00:00.000Z",
    });

    expect(readSessionState(sessionStatePath(root, "claude", "unknown-model"))?.model).toBeNull();
    expect(fs.readFileSync(envFile, "utf8")).not.toContain("PARLEY_MODEL");
  });

  it("preserves the original start time when Claude resumes the session", () => {
    const root = fixtureRoot();
    const first = { parleyHome: root, harnessPid: 11, now: () => "2026-07-20T11:00:00.000Z" };
    runHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "resumed" }), first);

    runHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "resumed" }), {
      ...first,
      harnessPid: 22,
      now: () => "2026-07-20T13:00:00.000Z",
    });

    expect(readSessionState(sessionStatePath(root, "claude", "resumed"))).toMatchObject({
      pid: 22,
      started_at: "2026-07-20T11:00:00.000Z",
      updated_at: "2026-07-20T13:00:00.000Z",
    });
  });

  it("fills model from a later transcript event and preserves session start time", () => {
    const root = fixtureRoot();
    const transcript = path.join(root, "transcript.jsonl");
    const options = {
      parleyHome: root,
      envFile: path.join(root, "claude-env"),
      harnessPid: 321,
      now: () => "2026-07-20T12:00:00.000Z",
    };
    runHook(
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "lazy-model",
        transcript_path: transcript,
      }),
      options,
    );
    fs.writeFileSync(
      transcript,
      '{"type":"system","subtype":"init","model":"claude-opus-5","session_id":"lazy-model"}\n',
    );

    runHook(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "lazy-model",
        transcript_path: transcript,
      }),
      { ...options, now: () => "2026-07-20T12:05:00.000Z" },
    );

    expect(readSessionState(sessionStatePath(root, "claude", "lazy-model"))).toMatchObject({
      model: "claude-opus-5",
      effort: null,
      started_at: "2026-07-20T12:00:00.000Z",
      updated_at: "2026-07-20T12:05:00.000Z",
    });
  });

  it("ignores malformed input and unknown transcript formats without throwing", () => {
    const root = fixtureRoot();
    const transcript = path.join(root, "transcript.jsonl");
    fs.writeFileSync(transcript, "not-json\n{\"type\":\"other\",\"model\":\"guess-me-not\"}\n");

    expect(() => runHook("not-json", { parleyHome: root, harnessPid: 1 })).not.toThrow();
    expect(() =>
      runHook(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "missing-start",
          transcript_path: transcript,
        }),
        { parleyHome: root, harnessPid: 1 },
      ),
    ).not.toThrow();
    expect(readSessionState(sessionStatePath(root, "claude", "missing-start"))).toBeNull();
  });
});
