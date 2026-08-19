/**
 * #383 / #384 — shared live-process start-time reader.
 */
import { describe, expect, it } from "vitest";
import {
  parseProcStatLine,
  pidStartEpochMs,
  pidStartedAfter,
  readPidStartTime,
} from "../src/pid-start-time.js";

describe("parseProcStatLine", () => {
  it("parses a realistic /proc/stat line with spaces in comm", () => {
    const fields = [
      "1",
      "(systemd)",
      "S",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "12345",
    ];
    expect(parseProcStatLine(fields.join(" "))).toEqual({
      pid: 1,
      ppid: 0,
      start_time: "12345",
    });
  });

  it("returns null for a truncated line", () => {
    expect(parseProcStatLine("1 (x) S")).toBeNull();
  });
});

describe("readPidStartTime", () => {
  it("reads this process's opaque /proc starttime token", () => {
    const token = readPidStartTime(process.pid);
    expect(token).toMatch(/^\d+$/);
  });

  it("returns null for a pid that is not alive", () => {
    expect(readPidStartTime(2_147_483_646)).toBeNull();
  });

  it("returns null for a non-positive pid", () => {
    expect(readPidStartTime(0)).toBeNull();
    expect(readPidStartTime(-1)).toBeNull();
  });
});

describe("pidStartedAfter", () => {
  it("treats a process that began after the recorded time as later", () => {
    // token 20000 jiffies / 100 Hz = 200s since boot; uptime 250s → started 50s ago.
    expect(
      pidStartedAfter("20000", "2000-01-01T00:00:00.000Z", {
        nowMs: Date.parse("2026-08-19T00:00:50.000Z"),
        uptimeSec: 250,
      }),
    ).toBe(true);
  });

  it("treats a process that began before the recorded time as not later", () => {
    expect(
      pidStartedAfter("20000", "2026-08-19T00:00:50.000Z", {
        nowMs: Date.parse("2026-08-19T00:00:50.000Z"),
        uptimeSec: 250,
      }),
    ).toBe(false);
  });

  it("returns null for an unreadable token or timestamp", () => {
    expect(pidStartedAfter("not-digits", "2026-01-01T00:00:00.000Z")).toBeNull();
    expect(pidStartedAfter("100", "not-iso")).toBeNull();
    expect(pidStartEpochMs("abc")).toBeNull();
  });
});
