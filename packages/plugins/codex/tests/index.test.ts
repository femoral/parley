import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readSessionState,
  sessionStatePath,
} from "../../../core/src/session-state.js";
import {
  effortFromTranscript,
  recordCodexSession,
} from "../src/index.js";

const temporaryHomes: string[] = [];
const fixtures = path.join(import.meta.dirname, "fixtures");

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-codex-test-"));
  temporaryHomes.push(home);
  return home;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("Codex SessionStart provenance", () => {
  it("writes recorded stdin fields and the harness parent pid", () => {
    const home = temporaryHome();
    const input = JSON.parse(
      fs.readFileSync(path.join(fixtures, "session-start.json"), "utf8"),
    ) as Record<string, unknown>;
    const state = recordCodexSession(
      input,
      {
        parleyHome: home,
        harnessPid: 4242,
        now: () => new Date("2026-07-20T10:00:00.000Z"),
      },
    );

    expect(state).toEqual({
      harness: "codex",
      harness_session_id: "codex-session-123",
      model: "gpt-5.5-codex",
      effort: null,
      pid: 4242,
      started_at: "2026-07-20T10:00:00.000Z",
      updated_at: "2026-07-20T10:00:00.000Z",
    });
    expect(
      readSessionState(
        sessionStatePath(home, "codex", "codex-session-123"),
      ),
    ).toEqual(state);
  });

  it("fills effective effort from a later Codex turn_context artifact", () => {
    const home = temporaryHome();
    const transcript = path.join(home, "rollout.jsonl");
    fs.copyFileSync(path.join(fixtures, "resumed-rollout.jsonl"), transcript);

    expect(effortFromTranscript(transcript)).toBe("high");
    expect(
      recordCodexSession(
        { session_id: "s1", model: "gpt-5.5", transcript_path: transcript },
        { parleyHome: home, harnessPid: 99 },
      )?.effort,
    ).toBe("high");
  });

  it("updates changing values while preserving the original start time", () => {
    const home = temporaryHome();
    recordCodexSession(
      { session_id: "s1", model: "gpt-5.4" },
      {
        parleyHome: home,
        harnessPid: 10,
        now: () => new Date("2026-07-20T10:00:00.000Z"),
      },
    );
    const state = recordCodexSession(
      { session_id: "s1", model: "gpt-5.5" },
      {
        parleyHome: home,
        harnessPid: 11,
        now: () => new Date("2026-07-20T11:00:00.000Z"),
      },
    );

    expect(state).toMatchObject({
      model: "gpt-5.5",
      effort: null,
      pid: 11,
      started_at: "2026-07-20T10:00:00.000Z",
      updated_at: "2026-07-20T11:00:00.000Z",
    });
  });

  it("ignores malformed or identity-less hook input", () => {
    const home = temporaryHome();
    expect(recordCodexSession({}, { parleyHome: home })).toBeNull();
    expect(effortFromTranscript(path.join(home, "missing.jsonl"))).toBeNull();
    expect(fs.existsSync(path.join(home, "vendors"))).toBe(false);
  });
});
