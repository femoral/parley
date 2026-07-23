import { describe, expect, it } from "vitest";
import { deriveUptime } from "../src/app/hooks/useCockpit.js";

describe("useCockpit uptime honesty", () => {
  const startedAt = Date.parse("2026-07-23T12:00:00.000Z");

  it("leaves uptime unavailable while the first probe is connecting", () => {
    expect(deriveUptime("connecting", null, startedAt + 1_000)).toBe("");
  });

  it("does not show a growing uptime while the daemon is offline", () => {
    expect(deriveUptime("offline", startedAt, startedAt + 60_000)).toBe("");
    expect(deriveUptime("offline", startedAt, startedAt + 3_600_000)).toBe("");
  });

  it("resumes uptime from the online probe's start time", () => {
    expect(deriveUptime("online", startedAt, startedAt + 1_000)).toBe("1s");
  });
});
