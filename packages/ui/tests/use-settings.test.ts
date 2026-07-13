/** @vitest-environment happy-dom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettings } from "../src/app/hooks/useSettings.js";

const STORAGE_KEY = "parley-cove:settings:v1";

// Node >= 25 exposes its own experimental `localStorage` global that shadows
// happy-dom's Storage on `window` and lacks the full Storage API. Pin a plain
// in-memory implementation so the round-trip is deterministic on every runtime.
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useSettings' defaults and localStorage round-trip (#70)", () => {
  it("defaults to ornaments on, kit band off, log follow on when nothing is stored", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.ornaments).toBe(true);
    expect(result.current.showKit).toBe(false);
    expect(result.current.followLogs).toBe(true);
  });

  it("toggling flips the value and persists it under the versioned key", () => {
    const { result } = renderHook(() => useSettings());

    act(() => result.current.toggleOrnaments());
    expect(result.current.ornaments).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ ornaments: false });

    act(() => result.current.toggleShowKit());
    expect(result.current.showKit).toBe(true);
    act(() => result.current.toggleFollowLogs());
    expect(result.current.followLogs).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      ornaments: false,
      showKit: true,
      followLogs: false,
    });
  });

  it("a fresh hook instance picks up a previously persisted preference set", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ornaments: false, showKit: true, followLogs: false }),
    );
    const { result } = renderHook(() => useSettings());
    expect(result.current.ornaments).toBe(false);
    expect(result.current.showKit).toBe(true);
    expect(result.current.followLogs).toBe(false);
  });

  it("falls back to defaults per-field when the stored value is partial or wrong-typed", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ornaments: "nope", showKit: true }));
    const { result } = renderHook(() => useSettings());
    // ornaments: wrong type -> default; showKit: valid -> honoured; followLogs: absent -> default.
    expect(result.current.ornaments).toBe(true);
    expect(result.current.showKit).toBe(true);
    expect(result.current.followLogs).toBe(true);
  });

  it("falls back to defaults entirely when the stored value isn't valid JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{ not json");
    const { result } = renderHook(() => useSettings());
    expect(result.current.ornaments).toBe(true);
    expect(result.current.showKit).toBe(false);
    expect(result.current.followLogs).toBe(true);
  });

  it("falls back to defaults when the stored value is valid JSON but not an object", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify("just a string"));
    const { result } = renderHook(() => useSettings());
    expect(result.current.ornaments).toBe(true);
    expect(result.current.showKit).toBe(false);
    expect(result.current.followLogs).toBe(true);
  });
});
