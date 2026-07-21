/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scene, type IslandTask } from "../src/scene/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const TASK: IslandTask = {
  id: "reduced-ship",
  name: "still-waters",
  state: "running",
  coat: "#10a37f",
  coatDark: "#0b7359",
  emblem: { kind: "glyph", char: "C" },
};

describe("the sailing simulation under prefers-reduced-motion", () => {
  it("keeps an orbiting ship on the same on-station frame as wall time advances", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const { container } = render(
      <Scene
        sessions={[{ id: "rm", label: "rm", tasks: [TASK], attention: null }]}
        activeSessionId="rm"
        onSelectTask={() => undefined}
        onSelectSession={() => undefined}
      />,
    );
    const ship = container.querySelector('[data-sailing-ship="sloop"]') as HTMLElement;
    expect(container.querySelector(".pc-sailing-layer")?.getAttribute("data-motion")).toBe(
      "reduced",
    );

    act(() => frames.shift()?.(1_000));
    const firstFrame = ship.style.transform;
    const firstHeading = ship.style.getPropertyValue("--sailing-heading");
    expect(firstHeading).toBe("1");
    act(() => frames.shift()?.(9_000));
    expect(ship.style.transform).toBe(firstFrame);
    expect(ship.style.getPropertyValue("--sailing-heading")).toBe(firstHeading);
  });
});

describe("the sailing simulation ambient scheduler", () => {
  it("keeps scheduling settled ambient ticks after each timeout fires", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    let frameCount = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = window.setTimeout(() => {
        frameCount += 1;
        callback(performance.now());
      }, 0);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      window.clearTimeout(id);
    });

    render(
      <Scene
        sessions={[
          {
            id: "ambient",
            label: "ambient",
            tasks: [{ ...TASK, state: "awaiting_answer" }],
            attention: null,
          },
        ]}
        activeSessionId="ambient"
        onSelectTask={() => undefined}
        onSelectSession={() => undefined}
      />,
    );

    act(() => vi.advanceTimersByTime(450));
    expect(frameCount).toBeGreaterThanOrEqual(4);
  });
});
