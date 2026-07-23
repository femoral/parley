/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";

import {
  COVE_FIRST_SEEN_STORAGE_KEY,
  deriveVoyageDay,
  readCoveFirstSeen,
} from "../src/app/hooks/useCockpit.js";

afterEach(() => {
  window.localStorage.clear();
});

describe("Cove voyage tenure", () => {
  it("persists first seen once and reuses it across daemon restarts", () => {
    const firstLoad = Date.parse("2026-07-15T12:00:00.000Z");
    const restarted = Date.parse("2026-07-23T12:00:00.000Z");

    expect(readCoveFirstSeen(firstLoad)).toBe(firstLoad);
    expect(window.localStorage.getItem(COVE_FIRST_SEEN_STORAGE_KEY)).toBe(
      String(firstLoad),
    );
    expect(readCoveFirstSeen(restarted)).toBe(firstLoad);
    expect(deriveVoyageDay(firstLoad, restarted)).toBe(9);
  });

  it("falls back to daemon tenure when localStorage is unavailable", () => {
    const daemonStartedAt = Date.parse("2026-07-21T12:00:00.000Z");
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    try {
      const firstSeen = readCoveFirstSeen(now);
      expect(firstSeen).toBeNull();
      expect(deriveVoyageDay(firstSeen ?? daemonStartedAt, now)).toBe(3);
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    }
  });
});
