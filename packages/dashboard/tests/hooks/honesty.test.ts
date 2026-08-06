/** @vitest-environment happy-dom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveHonestyPhase,
  projectHonesty,
  useHonesty,
  useStaleFlag,
} from "../../src/data/honesty.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("deriveHonestyPhase", () => {
  it("covers loading / connecting / offline / stale / panel-error / empty / live", () => {
    expect(
      deriveHonestyPhase({
        ready: false,
        streamConnected: false,
        healthOnline: false,
        streamLostSince: null,
        taskCount: 0,
        stale: false,
      }),
    ).toBe("loading");

    expect(
      deriveHonestyPhase({
        ready: false,
        streamConnected: true,
        healthOnline: false,
        streamLostSince: null,
        taskCount: 0,
        stale: false,
      }),
    ).toBe("connecting");

    expect(
      deriveHonestyPhase({
        ready: false,
        streamConnected: false,
        healthOnline: false,
        streamLostSince: Date.now(),
        taskCount: 0,
        stale: true,
      }),
    ).toBe("offline");

    expect(
      deriveHonestyPhase({
        ready: true,
        streamConnected: false,
        healthOnline: false,
        streamLostSince: Date.now(),
        taskCount: 3,
        stale: true,
      }),
    ).toBe("stale-reconnecting");

    expect(
      deriveHonestyPhase({
        ready: true,
        streamConnected: true,
        healthOnline: true,
        streamLostSince: null,
        taskCount: 2,
        panelError: "metrics failed",
        stale: false,
      }),
    ).toBe("panel-error");

    expect(
      deriveHonestyPhase({
        ready: true,
        streamConnected: true,
        healthOnline: true,
        streamLostSince: null,
        taskCount: 0,
        stale: false,
      }),
    ).toBe("empty");

    expect(
      deriveHonestyPhase({
        ready: true,
        streamConnected: true,
        healthOnline: true,
        streamLostSince: null,
        taskCount: 4,
        stale: false,
      }),
    ).toBe("live");
  });

  it("projectHonesty carries transport fields", () => {
    const h = projectHonesty({
      ready: true,
      streamConnected: true,
      healthOnline: true,
      streamLostSince: null,
      taskCount: 1,
      stale: false,
    });
    expect(h.phase).toBe("live");
    expect(h.ready).toBe(true);
    expect(h.stale).toBe(false);
  });
});

describe("useStaleFlag / useHonesty", () => {
  it("debounces stale then clears immediately on recovery", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ stream, health }: { stream: boolean; health: boolean }) =>
        useStaleFlag(stream, health, 1000),
      { initialProps: { stream: false, health: false } },
    );
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(true);

    rerender({ stream: true, health: true });
    expect(result.current).toBe(false);
  });

  it("useHonesty promotes to stale-reconnecting after debounce", () => {
    vi.useFakeTimers();
    const initial = {
      ready: true as boolean,
      streamConnected: true as boolean,
      healthOnline: true as boolean,
      streamLostSince: null as number | null,
      taskCount: 2,
    };
    const { result, rerender } = renderHook(
      (props: typeof initial) => useHonesty({ ...props, staleDebounceMs: 500 }),
      { initialProps: initial },
    );
    expect(result.current.phase).toBe("live");

    rerender({
      ready: true,
      streamConnected: false,
      healthOnline: false,
      streamLostSince: Date.now(),
      taskCount: 2,
    });
    // !transportOk yields stale-reconnecting once ready has latched.
    expect(result.current.phase).toBe("stale-reconnecting");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.stale).toBe(true);
    expect(result.current.phase).toBe("stale-reconnecting");
  });
});
