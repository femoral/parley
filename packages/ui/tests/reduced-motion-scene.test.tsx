/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scene, type IslandTask } from "../src/scene/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
