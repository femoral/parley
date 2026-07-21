/** @vitest-environment happy-dom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVisibleClock } from "../src/app/hooks/useCockpit.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the cockpit HUD clock (#199)", () => {
  it("does not tick while hidden and catches up immediately on visibility", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const { result } = renderHook(() => useVisibleClock());
    expect(result.current).toBe(10_000);

    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(10_000);

    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current).toBe(15_000);
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(16_000);
  });
});
