import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readPidStartTime, readSessionState, sessionStatePath } from "@useparley/core";
import {
  effortFromTranscript,
  recordCodexSession,
} from "../src/index.js";

const temporaryHomes: string[] = [];
const fixtures = path.join(import.meta.dirname, "fixtures");

/**
 * A pid the kernel can never assign, so `readPidStartTime` finds no
 * `/proc/<pid>/stat` and the hook records no `start_time`. Linux caps
 * `pid_max` at 2^22, and platforms without /proc report nothing either way.
 *
 * Guessing a plausible-looking pid does not work: on a busy host it can be
 * live, and the exact-shape assertions below then see an extra `start_time`.
 * Nor does scanning for a currently-free pid — the suite's own worker
 * processes can claim it between the scan and the assertion.
 */
const UNASSIGNABLE_PID = 0x7fff_ffff;

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
        harnessPid: UNASSIGNABLE_PID,
        now: () => new Date("2026-07-20T10:00:00.000Z"),
      },
    );

    expect(state).toEqual({
      harness: "codex",
      harness_session_id: "codex-session-123",
      model: "gpt-5.5-codex",
      effort: null,
      pid: UNASSIGNABLE_PID,
      started_at: "2026-07-20T10:00:00.000Z",
      updated_at: "2026-07-20T10:00:00.000Z",
    });
    expect(
      readSessionState(
        sessionStatePath(home, "codex", "codex-session-123"),
      ),
    ).toEqual(state);
  });

  it("records the live harness process start-time token (#383)", () => {
    const home = temporaryHome();
    const state = recordCodexSession(
      { session_id: "live-pid" },
      { parleyHome: home, harnessPid: process.pid },
    );
    expect(state?.start_time).toBe(readPidStartTime(process.pid));
    expect(state?.start_time).toMatch(/^\d+$/);
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

  it("keeps the previous model when a later event omits it", () => {
    const home = temporaryHome();
    recordCodexSession(
      { session_id: "s1", model: "gpt-5.5" },
      { parleyHome: home, harnessPid: 10 },
    );

    const state = recordCodexSession(
      { session_id: "s1" },
      { parleyHome: home, harnessPid: 10 },
    );

    expect(state?.model).toBe("gpt-5.5");
  });

  it("keeps the previous effort when a later transcript is unreadable", () => {
    const home = temporaryHome();
    const transcript = path.join(home, "rollout.jsonl");
    fs.copyFileSync(path.join(fixtures, "resumed-rollout.jsonl"), transcript);
    recordCodexSession(
      { session_id: "s1", model: "gpt-5.5", transcript_path: transcript },
      { parleyHome: home, harnessPid: 10 },
    );

    const state = recordCodexSession(
      {
        session_id: "s1",
        model: "gpt-5.5",
        transcript_path: path.join(home, "missing.jsonl"),
      },
      { parleyHome: home, harnessPid: 10 },
    );

    expect(state?.effort).toBe("high");
  });

  it("ignores malformed or identity-less hook input", () => {
    const home = temporaryHome();
    expect(recordCodexSession({}, { parleyHome: home })).toBeNull();
    expect(effortFromTranscript(path.join(home, "missing.jsonl"))).toBeNull();
    expect(fs.existsSync(path.join(home, "vendors"))).toBe(false);
  });
});
