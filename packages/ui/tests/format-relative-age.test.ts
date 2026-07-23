import { describe, expect, it } from "vitest";
import { formatRelativeAge } from "../src/hud/formatRelativeAge.js";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("formatRelativeAge (shared roster/inbox)", () => {
  it("returns null for missing or unparseable timestamps", () => {
    expect(formatRelativeAge(null, NOW)).toBeNull();
    expect(formatRelativeAge(undefined, NOW)).toBeNull();
    expect(formatRelativeAge("not-a-date", NOW)).toBeNull();
  });

  it("uses a minute floor instead of seconds or 'now'", () => {
    expect(formatRelativeAge(isoAgo(0), NOW)).toBe("<1m");
    expect(formatRelativeAge(isoAgo(12_000), NOW)).toBe("<1m");
    expect(formatRelativeAge(isoAgo(59_000), NOW)).toBe("<1m");
  });

  it("formats minutes, hours (to 48h), then days with one unit", () => {
    expect(formatRelativeAge(isoAgo(12 * 60_000), NOW)).toBe("12m");
    expect(formatRelativeAge(isoAgo(59 * 60_000), NOW)).toBe("59m");
    expect(formatRelativeAge(isoAgo(60 * 60_000), NOW)).toBe("1h");
    expect(formatRelativeAge(isoAgo(4 * 60 * 60_000), NOW)).toBe("4h");
    expect(formatRelativeAge(isoAgo(47 * 60 * 60_000), NOW)).toBe("47h");
    expect(formatRelativeAge(isoAgo(48 * 60 * 60_000), NOW)).toBe("2d");
    expect(formatRelativeAge(isoAgo(72 * 60 * 60_000), NOW)).toBe("3d");
  });

  it("never returns future-looking negatives", () => {
    expect(formatRelativeAge(isoAgo(-5_000), NOW)).toBe("<1m");
  });
});
