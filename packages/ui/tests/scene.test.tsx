/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { islandVariantFor } from "../src/scene/charted.js";
import { Island, Scene, Ship, regionWorldOffset, type IslandTask } from "../src/scene/index.js";
import type { SessionRegionData } from "../src/scene/SessionRegion.js";

/** Dispatch the camera world's transform transitionend (happy-dom does not run CSS transitions).
 * `fireEvent.transitionEnd` omits `propertyName` in this environment; define it on a native event
 * so Camera's property filter matches production TransitionEvents. Wrapped in `act` because
 * native dispatchEvent does not auto-flush React updates the way fireEvent does. */
function endCameraTravel(container: HTMLElement) {
  const world = container.querySelector(".pc-world");
  expect(world).toBeTruthy();
  act(() => {
    const ev = new Event("transitionend", { bubbles: true });
    Object.defineProperty(ev, "propertyName", { value: "transform" });
    world!.dispatchEvent(ev);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const noop = () => undefined;

function island(state: string, overrides: Partial<IslandTask> = {}): IslandTask {
  return {
    id: "t1",
    name: "chart-the-bay",
    state,
    coat: "#10a37f",
    coatDark: "#0b7359",
    emblem: { kind: "svg", viewBox: "0 0 24 24", path: "M12 2 L20 7 V17 L12 22 L4 17 V7 Z" },
    ...overrides,
  };
}

const ALL_STATES = [
  "pending",
  "running",
  "awaiting_answer",
  "stalled",
  "completed",
  "failed",
  "cancelled",
] as const;

describe("Island renders its state through a single data-state (#69)", () => {
  it("tags every island with its canonical state on data-state", () => {
    for (const state of ALL_STATES) {
      const { container } = render(<Island task={island(state)} onSelectTask={noop} />);
      expect(container.querySelector(".pc-island")?.getAttribute("data-state")).toBe(state);
      cleanup();
    }
  });

  it("pending — rising island, no ship, no terminal or attention effect", () => {
    const { container } = render(<Island task={island("pending")} onSelectTask={noop} />);
    expect(container.querySelector(".pc-island__rise")).toBeTruthy();
    expect(container.querySelector(".pc-sloop")).toBeNull();
    expect(container.querySelector(".pc-voyage")).toBeNull();
    expect(container.querySelector(".pc-flare")).toBeNull();
    expect(container.querySelector(".pc-flag")).toBeNull();
    expect(container.querySelector(".pc-wreck")).toBeNull();
  });

  it("running — a sloop under way with a wake, no attention/terminal effects", () => {
    const { container } = render(<Island task={island("running")} onSelectTask={noop} />);
    expect(container.querySelector(".pc-voyage[data-state='running']")).toBeTruthy();
    expect(container.querySelector(".pc-sloop")).toBeTruthy();
    expect(container.querySelector(".pc-wake")).toBeTruthy();
    expect(container.querySelector(".pc-flare")).toBeNull();
    expect(container.querySelector(".pc-fog")).toBeNull();
  });

  it("awaiting_answer — anchored sloop, flare, and PARLEY! ribbon", () => {
    const { container } = render(<Island task={island("awaiting_answer")} onSelectTask={noop} />);
    expect(container.querySelector(".pc-voyage[data-state='awaiting_answer']")).toBeTruthy();
    expect(container.querySelector(".pc-anchor")).toBeTruthy();
    expect(container.querySelector(".pc-flare")).toBeTruthy();
    expect(container.querySelector(".pc-parley")).toBeTruthy();
    expect(container.querySelector(".pc-parley")?.textContent).toContain("PARLEY");
  });

  it("stalled — a fog bank rolls over the adrift ship", () => {
    const { container } = render(<Island task={island("stalled")} onSelectTask={noop} />);
    expect(container.querySelector(".pc-fog")).toBeTruthy();
    expect(container.querySelector(".pc-voyage[data-state='stalled']")).toBeTruthy();
    expect(container.querySelector(".pc-flare")).toBeNull();
  });

  it("completed — a planted flag at the charted peak, ship gone", () => {
    const { container } = render(<Island task={island("completed")} onSelectTask={noop} />);
    const flag = container.querySelector(".pc-flag");
    expect(flag).toBeTruthy();
    // Peak anchor is the variant's rock apex (stable hash of task id).
    const peak = islandVariantFor("t1").peak;
    expect(flag?.querySelector("line")?.getAttribute("x2")).toBe(String(peak.x));
    expect(flag?.querySelector("line")?.getAttribute("y2")).toBe(String(peak.y));
    // Completion ceremony parts: the hoisting pennant and the masthead glint.
    expect(flag?.querySelector(".pc-flag__pennant")).toBeTruthy();
    expect(flag?.querySelector(".pc-flag__glint")).toBeTruthy();
    expect(container.querySelector(".pc-sloop")).toBeNull();
    expect(container.querySelector(".pc-wreck")).toBeNull();
  });

  it("picks a stable charted island sprite per task id (data-variant 1..3)", () => {
    const { container } = render(<Island task={island("running")} onSelectTask={noop} />);
    const root = container.querySelector(".pc-island");
    const expected = islandVariantFor("t1");
    expect(root?.getAttribute("data-variant")).toBe(String(expected.id));
    const sprite = container.querySelector(".pc-island__sprite") as HTMLImageElement | null;
    expect(sprite).toBeTruthy();
    expect(sprite?.getAttribute("src")).toBeTruthy();
    // Same id → same variant across remounts.
    cleanup();
    const again = render(<Island task={island("pending")} onSelectTask={noop} />);
    expect(again.container.querySelector(".pc-island")?.getAttribute("data-variant")).toBe(
      String(expected.id),
    );
  });

  it("failed — a shipwreck, ship gone", () => {
    const { container } = render(<Island task={island("failed")} onSelectTask={noop} />);
    expect(container.querySelector(".pc-wreck")).toBeTruthy();
    expect(container.querySelector(".pc-sloop")).toBeNull();
    expect(container.querySelector(".pc-flag")).toBeNull();
  });

  it("cancelled on mount — settled aftermath: no sloop, no sink replay (#187)", () => {
    const { container } = render(<Island task={island("cancelled")} onSelectTask={noop} />);
    const root = container.querySelector(".pc-island");
    expect(root?.getAttribute("data-state")).toBe("cancelled");
    expect(root?.getAttribute("data-death")).toBe("settled");
    // Retained cancelled: no ghost sloop, no sailoff pose to spawn near the galleon.
    expect(container.querySelector(".pc-sloop")).toBeNull();
    expect(container.querySelector(".pc-voyage")).toBeNull();
    expect(container.querySelector(".pc-flag")).toBeNull();
  });

  it("live cancel — plays sink + sailoff once, then settles without a residual sloop (#187)", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <Island task={island("running")} onSelectTask={noop} />,
    );
    expect(container.querySelector(".pc-voyage[data-state='running']")).toBeTruthy();

    rerender(<Island task={island("cancelled")} onSelectTask={noop} />);
    const root = container.querySelector(".pc-island");
    expect(root?.getAttribute("data-death")).toBe("live");
    expect(container.querySelector(".pc-sloop--sailoff")).toBeTruthy();
    expect(container.querySelector('.pc-voyage[data-sailing-pose="sailoff"]')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(root?.getAttribute("data-death")).toBe("settled");
    expect(container.querySelector(".pc-sloop")).toBeNull();
    expect(container.querySelector(".pc-voyage")).toBeNull();
    vi.useRealTimers();
  });

  it("labels the island with its name and manifest state label for AT", () => {
    const { container } = render(<Island task={island("awaiting_answer", { name: "sound-depths" })} onSelectTask={noop} />);
    expect(container.querySelector(".pc-island")?.getAttribute("aria-label")).toBe(
      "sound-depths — AWAITING",
    );
  });

  it("puts the full task name on the plank label title (truncation tooltip)", () => {
    const { container } = render(
      <Island task={island("running", { name: "a-very-long-task-name-that-truncates" })} onSelectTask={noop} />,
    );
    const plankLabel = container.querySelector(".pc-plank__label");
    expect(plankLabel?.getAttribute("title")).toBe("a-very-long-task-name-that-truncates");
  });
});

describe("Ship carries faction tint on the --coat/--coat-dark pair (#69)", () => {
  it("sets both custom properties from the faction record (new faction, zero new art)", () => {
    const { container } = render(
      <Ship
        coat="#2b2b2e"
        coatDark="#141416"
        emblem={{ kind: "svg", viewBox: "0 0 24 24", path: "M5 4 L19 20 M19 4 L5 20" }}
        state="running"
      />,
    );
    const voyage = container.querySelector(".pc-voyage") as HTMLElement;
    expect(voyage.style.getPropertyValue("--coat")).toBe("#2b2b2e");
    expect(voyage.style.getPropertyValue("--coat-dark")).toBe("#141416");
  });

  it("clips the approved sail and pennant tints without shipping a zero-opacity hull layer", () => {
    const { container } = render(
      <Ship
        coat="#10a37f"
        coatDark="#0b7359"
        emblem={{ kind: "glyph", char: "C" }}
        state="running"
      />,
    );
    expect(container.querySelector(".pc-sloop__tints")).toBeTruthy();
    expect(container.querySelector(".pc-sloop__tint--sail")).toBeTruthy();
    expect(container.querySelector(".pc-sloop__tint--pennant")).toBeTruthy();
    expect(container.querySelector(".pc-sloop__tint--hull")).toBeNull();
  });

  it("keeps the tint on the sailing-off pose too", () => {
    const { container } = render(
      <Ship
        coat="#6c5ce7"
        coatDark="#4a3db8"
        emblem={{ kind: "glyph", char: "π" }}
        state="cancelled"
      />,
    );
    const sloop = container.querySelector(".pc-sloop--sailoff") as HTMLElement;
    expect(sloop.style.getPropertyValue("--coat")).toBe("#6c5ce7");
    expect(sloop.style.getPropertyValue("--coat-dark")).toBe("#4a3db8");
  });

  it.each([
    ["running", "orbit"],
    ["awaiting_answer", "anchored"],
    ["stalled", "adrift"],
    ["cancelled", "sailoff"],
  ])("wires the %s state to the sailing driver's %s pose", (state, pose) => {
    const { container } = render(
      <Ship
        coat="#2b2b2e"
        coatDark="#141416"
        emblem={{ kind: "glyph", char: "π" }}
        state={state}
      />,
    );
    const ship = container.querySelector('[data-sailing-ship="sloop"]');
    expect(ship?.getAttribute("data-sailing-pose")).toBe(pose);
  });
});

function region(
  id: string | null,
  label: string,
  tasks: IslandTask[],
  attention: SessionRegionData["attention"] = null,
): SessionRegionData {
  return { id, label, tasks, attention };
}

const REGION: SessionRegionData = region("sess-1", "sess-1", [
  island("running", { id: "a" }),
  island("awaiting_answer", { id: "b" }),
  island("completed", { id: "c" }),
], { state: "awaiting_answer", count: 1, rank: 0 });

describe("Scene lays out the active session's cove (#69)", () => {
  it("mounts one scene-level sailing driver with a backdrop and overlay canvas", () => {
    const { container } = render(
      <Scene sessions={[REGION]} activeSessionId="sess-1" onSelectTask={noop} onSelectSession={noop} />,
    );
    expect(container.querySelectorAll(".pc-sailing-layer")).toHaveLength(1);
    expect(container.querySelectorAll("canvas.pc-sailing-sea")).toHaveLength(1);
    expect(container.querySelectorAll("canvas.pc-sailing-fx")).toHaveLength(1);
  });

  it("starts the scene clock on mount and cancels it on unmount", () => {
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(41);
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const view = render(
      <Scene sessions={[REGION]} activeSessionId="sess-1" onSelectTask={noop} onSelectSession={noop} />,
    );
    expect(request).toHaveBeenCalled();
    view.unmount();
    expect(cancel).toHaveBeenCalledWith(41);
  });

  it("seats anchored and adrift hulls close to their islands on the flagship bearing", () => {
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
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("pc-scene-view")) {
        return new DOMRect(0, 0, 800, 600);
      }
      if (this.classList.contains("pc-island")) {
        return new DOMRect(300, 200, 156, 142);
      }
      if (this.classList.contains("pc-island__sprite")) {
        return new DOMRect(304, 210, 148, 100);
      }
      return new DOMRect(0, 0, 0, 0);
    });

    const closeStations = region("close", "close", [
      island("awaiting_answer", { id: "anchored" }),
      island("stalled", { id: "adrift" }),
    ]);
    const { container } = render(
      <Scene
        sessions={[closeStations]}
        activeSessionId="close"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    act(() => frames.shift()?.(1_000));

    const islandWaterline = { x: 78, y: 78 };
    const sloopDraftPx = 90 * (539 / 640) * 0.48;
    for (const [pose, minDistance, maxDistance] of [
      ["anchored", 45, 75],
      ["adrift", 80, 115],
    ] as const) {
      const ship = container.querySelector(`[data-sailing-pose="${pose}"]`) as HTMLElement;
      const match = ship.style.transform.match(/^translate\(([-\d.]+)px, ([-\d.]+)px\)/);
      expect(match).toBeTruthy();
      const hullOffset = {
        x: Number(match![1]) - islandWaterline.x,
        y: Number(match![2]) + sloopDraftPx - islandWaterline.y,
      };
      expect(Math.hypot(hullOffset.x, hullOffset.y)).toBeGreaterThan(minDistance);
      expect(Math.hypot(hullOffset.x, hullOffset.y)).toBeLessThan(maxDistance);

      // The station lies on the island→flagship half-plane, not at a fixed
      // screen-left offset that can detach it or cross into a neighbour's cove.
      const islandX = Number(ship.dataset.islandX);
      const islandY = Number(ship.dataset.islandY);
      const towardFlagship = { x: -islandX, y: -70 - islandY };
      expect(hullOffset.x * towardFlagship.x + hullOffset.y * towardFlagship.y).toBeGreaterThan(0);
    }
  });

  it("does not mount a sailoff sloop for a retained cancelled task (#187)", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const cancelled = region("cancelled", "cancelled", [island("cancelled")]);
    const { container } = render(
      <Scene
        sessions={[cancelled]}
        activeSessionId="cancelled"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    act(() => frames.shift()?.(1_000));

    expect(container.querySelector('[data-sailing-pose="sailoff"]')).toBeNull();
    expect(container.querySelector('[data-sailing-ship="sloop"]')).toBeNull();
    expect(container.querySelector(".pc-island")?.getAttribute("data-death")).toBe("settled");
  });

  it("fades a ship out on a live cancel while keeping its on-station origin (#187)", () => {
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
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("pc-scene-view")) {
        return new DOMRect(0, 0, 800, 600);
      }
      if (this.classList.contains("pc-island")) {
        return new DOMRect(300, 200, 156, 142);
      }
      if (this.classList.contains("pc-island__sprite")) {
        return new DOMRect(304, 210, 148, 100);
      }
      return new DOMRect(0, 0, 0, 0);
    });

    const running = region("live-cancel", "live-cancel", [island("running")]);
    const { container, rerender } = render(
      <Scene
        sessions={[running]}
        activeSessionId="live-cancel"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    // Let the sloop arrive on station so sailoff starts from island coords.
    act(() => {
      for (let step = 0; step < 40; step += 1) {
        frames.shift()?.(1_000 + step * 100);
      }
    });
    expect(container.querySelector('[data-sailing-pose="orbit"]')).toBeTruthy();

    rerender(
      <Scene
        sessions={[region("live-cancel", "live-cancel", [island("cancelled")])]}
        activeSessionId="live-cancel"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(container.querySelector(".pc-island")?.getAttribute("data-death")).toBe("live");

    act(() => frames.shift()?.(5_000));
    const ship = container.querySelector('[data-sailing-pose="sailoff"]') as HTMLElement;
    expect(ship).toBeTruthy();
    expect(Number(ship.style.opacity)).toBeGreaterThan(0.99);

    act(() => {
      for (let step = 1; step <= 12; step += 1) {
        frames.shift()?.(5_000 + step * 100);
      }
    });
    expect(Number(ship.style.opacity)).toBeGreaterThan(0.4);
    expect(Number(ship.style.opacity)).toBeLessThan(0.6);
  });

  it("renders exactly one island per task of the session", () => {
    const { container } = render(
      <Scene sessions={[REGION]} activeSessionId="sess-1" onSelectTask={noop} onSelectSession={noop} />,
    );
    expect(container.querySelectorAll(".pc-island")).toHaveLength(3);
  });

  it("anchors a galleon in each session region", () => {
    const { container } = render(
      <Scene sessions={[REGION]} activeSessionId="sess-1" onSelectTask={noop} onSelectSession={noop} />,
    );
    expect(container.querySelector(".pc-galleon")).toBeTruthy();
    expect(container.querySelector(".pc-galleon__sprite")).toBeTruthy();
  });

  it("travels the camera to the selected region (a transform offset that changes)", () => {
    const second = region("sess-2", "sess-2", [island("running", { id: "z" })]);
    const first = render(
      <Scene sessions={[REGION, second]} activeSessionId="sess-1" onSelectTask={noop} onSelectSession={noop} />,
    );
    const camAt = (c: HTMLElement) => (c.querySelector(".pc-world") as HTMLElement).style.transform;
    const atFirst = camAt(first.container);
    cleanup();
    const secondRender = render(
      <Scene sessions={[REGION, second]} activeSessionId="sess-2" onSelectTask={noop} onSelectSession={noop} />,
    );
    const atSecond = camAt(secondRender.container);
    // Selecting another session shifts the world plane — the camera has sailed.
    expect(atFirst).not.toBe(atSecond);
    // Camera offset matches the active session's id-stable world position.
    const o1 = regionWorldOffset("sess-1");
    expect(atFirst).toBe(`translate(${-o1.dx}px, ${-o1.dy}px)`);
    const o2 = regionWorldOffset("sess-2");
    expect(atSecond).toBe(`translate(${-o2.dx}px, ${-o2.dy}px)`);
  });

  it("frames the first region for 'All hands' (null) rather than filtering", () => {
    const second = region("sess-2", "sess-2", [
      island("running", { id: "z", name: "distant-shoal" }),
    ]);
    const { container } = render(
      <Scene
        sessions={[REGION, second]}
        activeSessionId={null}
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    // First region (REGION) is framed — its three islands, not the second session's.
    expect(container.querySelectorAll(".pc-island")).toHaveLength(3);
    expect(container.querySelector('.pc-island[aria-label="distant-shoal — RUNNING"]')).toBeNull();
    const o = regionWorldOffset("sess-1");
    expect((container.querySelector(".pc-world") as HTMLElement).style.transform).toBe(
      `translate(${-o.dx}px, ${-o.dy}px)`,
    );
  });

  it("shows the calm-tide empty state with no sessions", () => {
    const { container } = render(
      <Scene sessions={[]} activeSessionId={null} onSelectTask={noop} onSelectSession={noop} />,
    );
    expect(container.querySelector(".pc-scene-empty")).toBeTruthy();
    expect(container.querySelector(".pc-region")).toBeNull();
    expect(screen.getByText(/The tide is calm/)).toBeTruthy();
    expect(screen.queryByText(/Taking soundings/)).toBeNull();
  });

  it("shows taking-soundings copy before the first snapshot (connecting)", () => {
    render(
      <Scene
        sessions={[]}
        activeSessionId={null}
        onSelectTask={noop}
        onSelectSession={noop}
        connecting
      />,
    );
    expect(screen.getByText(/Taking soundings/)).toBeTruthy();
    expect(screen.queryByText(/The tide is calm/)).toBeNull();
  });

  it("selects the task represented by a clicked island (#83)", () => {
    const onSelectTask = vi.fn();
    render(
      <Scene sessions={[REGION]} activeSessionId="sess-1" onSelectTask={onSelectTask} onSelectSession={noop} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "chart-the-bay — RUNNING" }));

    expect(onSelectTask).toHaveBeenCalledOnce();
    expect(onSelectTask).toHaveBeenCalledWith("a");
  });

  it("keeps a departing region's islands out of the tab order during the pan", () => {
    const far = region("sess-2", "sess-2", [
      island("running", { id: "far-1", name: "distant-shoal" }),
    ]);
    const { container, rerender } = render(
      <Scene
        sessions={[REGION, far]}
        activeSessionId="sess-1"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );

    rerender(
      <Scene
        sessions={[REGION, far]}
        activeSessionId="sess-2"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );

    const onCamera = screen.getByRole("button", { name: "distant-shoal — RUNNING" });
    expect(onCamera.getAttribute("tabindex")).toBe("0");
    expect(onCamera.closest(".pc-region")?.hasAttribute("inert")).toBe(false);

    // Outgoing region stays mounted for the pan but is inert / non-tabbable.
    const departing = container.querySelector(
      '.pc-island[aria-label="chart-the-bay — RUNNING"]',
    ) as HTMLElement;
    expect(departing).toBeTruthy();
    expect(departing.getAttribute("tabindex")).toBe("-1");
    expect(departing.closest(".pc-region")?.hasAttribute("inert")).toBe(true);
  });
});

describe("Scene mounts only the active region after the pan (#129)", () => {
  const near = region("sess-1", "sess-1", [
    island("running", { id: "a", name: "near-reef" }),
  ]);
  const far = region("sess-2", "sess-2", [
    island("running", { id: "z", name: "distant-shoal" }),
  ]);

  it("renders island content for only the active session once settled", () => {
    const { container } = render(
      <Scene
        sessions={[near, far]}
        activeSessionId="sess-1"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(container.querySelectorAll(".pc-island")).toHaveLength(1);
    expect(container.querySelector('.pc-island[aria-label="near-reef — RUNNING"]')).toBeTruthy();
    expect(container.querySelector('.pc-island[aria-label="distant-shoal — RUNNING"]')).toBeNull();
    expect(container.querySelectorAll(".pc-region")).toHaveLength(1);
  });

  it("keeps the outgoing region mounted during the pan, then unmounts on travel end", () => {
    const { container, rerender } = render(
      <Scene
        sessions={[near, far]}
        activeSessionId="sess-1"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(container.querySelectorAll(".pc-region")).toHaveLength(1);

    rerender(
      <Scene
        sessions={[near, far]}
        activeSessionId="sess-2"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    // Both regions visible while the camera sails.
    expect(container.querySelectorAll(".pc-region")).toHaveLength(2);
    expect(container.querySelector('.pc-island[aria-label="near-reef — RUNNING"]')).toBeTruthy();
    expect(container.querySelector('.pc-island[aria-label="distant-shoal — RUNNING"]')).toBeTruthy();

    endCameraTravel(container);

    // Only the newly framed session remains.
    expect(container.querySelectorAll(".pc-region")).toHaveLength(1);
    expect(container.querySelectorAll(".pc-island")).toHaveLength(1);
    expect(container.querySelector('.pc-island[aria-label="distant-shoal — RUNNING"]')).toBeTruthy();
    expect(container.querySelector('.pc-island[aria-label="near-reef — RUNNING"]')).toBeNull();
  });

  it("keeps a session's world position stable across array reorder and re-switches", () => {
    const o1 = regionWorldOffset("sess-1");
    const o2 = regionWorldOffset("sess-2");
    expect(o1).not.toEqual(o2);

    const { container, rerender } = render(
      <Scene
        sessions={[near, far]}
        activeSessionId="sess-1"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    const cam = () => (container.querySelector(".pc-world") as HTMLElement).style.transform;
    expect(cam()).toBe(`translate(${-o1.dx}px, ${-o1.dy}px)`);

    // Reorder the sessions array — framing sess-1 must not jump.
    rerender(
      <Scene
        sessions={[far, near]}
        activeSessionId="sess-1"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(cam()).toBe(`translate(${-o1.dx}px, ${-o1.dy}px)`);

    rerender(
      <Scene
        sessions={[far, near]}
        activeSessionId="sess-2"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(cam()).toBe(`translate(${-o2.dx}px, ${-o2.dy}px)`);

    endCameraTravel(container);

    // Switch back — same offset as the first frame of sess-1.
    rerender(
      <Scene
        sessions={[near, far]}
        activeSessionId="sess-1"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(cam()).toBe(`translate(${-o1.dx}px, ${-o1.dy}px)`);
  });

  it("regionWorldOffset is a pure function of session id", () => {
    expect(regionWorldOffset("sess-1")).toEqual(regionWorldOffset("sess-1"));
    expect(regionWorldOffset(null)).toEqual({ dx: 0, dy: -74 });
    expect(regionWorldOffset("alpha")).not.toEqual(regionWorldOffset("beta"));
  });
});

describe("Flagship dresses ship when all voyages are home", () => {
  it("hoists the signal-flag string when every task is completed", () => {
    const allHome = region("sess-h", "sess-h", [
      island("completed", { id: "h1" }),
      island("completed", { id: "h2" }),
    ]);
    const { container } = render(
      <Scene sessions={[allHome]} activeSessionId="sess-h" onSelectTask={noop} onSelectSession={noop} />,
    );
    expect(container.querySelector(".pc-dress")).toBeTruthy();
    expect(
      container.querySelector(".pc-galleon")?.getAttribute("aria-label"),
    ).toBe("Orchestrator sess-h — all voyages home");
  });

  it("stays undressed while any voyage is still out", () => {
    const { container } = render(
      <Scene sessions={[REGION]} activeSessionId="sess-1" onSelectTask={noop} onSelectSession={noop} />,
    );
    expect(container.querySelector(".pc-dress")).toBeNull();
    expect(
      container.querySelector(".pc-galleon")?.getAttribute("aria-label"),
    ).toBe("Orchestrator sess-1");
  });

  it("never dresses an empty region (no tasks is not a milestone)", () => {
    const empty = region("sess-e", "sess-e", []);
    const { container } = render(
      <Scene sessions={[empty]} activeSessionId="sess-e" onSelectTask={noop} onSelectSession={noop} />,
    );
    expect(container.querySelector(".pc-dress")).toBeNull();
  });
});

describe("Scene edge-of-frame attention indicators", () => {
  const calmLeft = region("sess-a", "sess-a", [island("running", { id: "a1" })]);
  const awaitingRight = region(
    "sess-b",
    "sess-b",
    [island("awaiting_answer", { id: "b1" })],
    { state: "awaiting_answer", count: 1, rank: 0 },
  );
  const failedFar = region(
    "sess-c",
    "sess-c",
    [island("failed", { id: "c1" })],
    { state: "failed", count: 1, rank: 5 },
  );
  const stalledMid = region(
    "sess-d",
    "sess-d",
    [island("stalled", { id: "d1" })],
    { state: "stalled", count: 1, rank: 1 },
  );

  it("shows no indicator for the framed session, even when it has attention", () => {
    const { container } = render(
      <Scene
        sessions={[REGION]}
        activeSessionId="sess-1"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(container.querySelector(".pc-edge-alert")).toBeNull();
  });

  it("shows no indicator for an off-camera calm session", () => {
    const calm = region("sess-2", "sess-2", [island("running", { id: "z" })]);
    const { container } = render(
      <Scene
        sessions={[REGION, calm]}
        activeSessionId="sess-1"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    // REGION is framed (has attention but on-camera); calm is off-camera with null attention.
    expect(container.querySelector(".pc-edge-alert")).toBeNull();
  });

  it("renders an edge indicator on the side of the off-camera awaiting session", () => {
    // Side is derived from id-stable world offsets, not array order.
    const side = regionWorldOffset("sess-b").dx < regionWorldOffset("sess-a").dx ? "left" : "right";
    const arrow = side === "left" ? "◀" : "▶";
    const { container } = render(
      <Scene
        sessions={[calmLeft, awaitingRight]}
        activeSessionId="sess-a"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    const btn = screen.getByRole("button", {
      name: `Session sess-b — 1 awaiting answer, to the ${side}`,
    });
    expect(btn).toBeTruthy();
    expect(btn.classList.contains("pc-edge-alert--beacon")).toBe(true);
    expect(btn.textContent).toContain(arrow);
    // Visible payload for sighted operators (not only aria-label).
    expect(btn.querySelector(".pc-edge-alert__label")?.textContent).toBe("sess-b");
    expect(btn.querySelector(".pc-edge-alert__count")?.textContent).toBe("1");
    expect(container.querySelector(`.pc-edge-alerts--${side}`)).toBeTruthy();
    expect(container.querySelector(`.pc-edge-alerts--${side === "left" ? "right" : "left"}`)).toBeNull();
  });

  it("keeps edge-alert side stable when the sessions array is reordered", () => {
    const side = regionWorldOffset("sess-b").dx < regionWorldOffset("sess-a").dx ? "left" : "right";
    const { rerender } = render(
      <Scene
        sessions={[calmLeft, awaitingRight]}
        activeSessionId="sess-a"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(
      screen.getByRole("button", { name: `Session sess-b — 1 awaiting answer, to the ${side}` }),
    ).toBeTruthy();

    // Array order flipped — chip side must not flip (id-stable placement).
    rerender(
      <Scene
        sessions={[awaitingRight, calmLeft]}
        activeSessionId="sess-a"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(
      screen.getByRole("button", { name: `Session sess-b — 1 awaiting answer, to the ${side}` }),
    ).toBeTruthy();
  });

  it("selects the session when an edge indicator is clicked", () => {
    const onSelectSession = vi.fn();
    const side = regionWorldOffset("sess-b").dx < regionWorldOffset("sess-a").dx ? "left" : "right";
    render(
      <Scene
        sessions={[calmLeft, awaitingRight]}
        activeSessionId="sess-a"
        onSelectTask={noop}
        onSelectSession={onSelectSession}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Session sess-b — 1 awaiting answer, to the ${side}` }),
    );
    expect(onSelectSession).toHaveBeenCalledOnce();
    expect(onSelectSession).toHaveBeenCalledWith("sess-b");
  });

  it("stacks up to 3 indicators loudest-first and collapses the rest into +N", () => {
    // Four sessions to the right of the framed calm one, mixed attention ranks.
    const s1 = region("s1", "s1", [island("failed", { id: "f1" })], { state: "failed", count: 1, rank: 5 });
    const s2 = region("s2", "s2", [island("stalled", { id: "st1" })], { state: "stalled", count: 1, rank: 1 });
    const s3 = region("s3", "s3", [island("awaiting_answer", { id: "aw1" })], {
      state: "awaiting_answer",
      count: 2,
      rank: 0,
    });
    const s4 = region("s4", "s4", [island("failed", { id: "f2" })], { state: "failed", count: 1, rank: 5 });
    const { container } = render(
      <Scene
        sessions={[calmLeft, s1, s2, s3, s4]}
        activeSessionId="sess-a"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    const buttons = container.querySelectorAll("button.pc-edge-alert");
    expect(buttons).toHaveLength(3);
    // Loudest first: awaiting, stalled, then failed (s1 before s4 by id).
    expect(buttons[0]!.getAttribute("aria-label")).toContain("s3");
    expect(buttons[1]!.getAttribute("aria-label")).toContain("s2");
    expect(buttons[2]!.getAttribute("aria-label")).toContain("s1");
    // Visible count matches the attention rollup (s3 has count 2).
    expect(buttons[0]!.querySelector(".pc-edge-alert__count")?.textContent).toBe("2");
    expect(buttons[0]!.querySelector(".pc-edge-alert__label")?.textContent).toBe("s3");
    const more = container.querySelector(".pc-edge-alert--more");
    expect(more?.textContent).toBe("+1");
  });

  it("under All hands, treats the first region as framed (indicators for the rest)", () => {
    const framedDx = regionWorldOffset("sess-a").dx;
    const sideB = regionWorldOffset("sess-b").dx < framedDx ? "left" : "right";
    const sideC = regionWorldOffset("sess-c").dx < framedDx ? "left" : "right";
    render(
      <Scene
        sessions={[calmLeft, awaitingRight, failedFar]}
        activeSessionId={null}
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(
      screen.getByRole("button", { name: `Session sess-b — 1 awaiting answer, to the ${sideB}` }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Session sess-c — 1 failed, to the ${sideC}` }),
    ).toBeTruthy();
    // No indicator for the framed calm first region.
    expect(screen.queryByRole("button", { name: /Session sess-a/ })).toBeNull();
  });

  it("does not invent indicators for stalledMid when framed on that session", () => {
    const { container } = render(
      <Scene
        sessions={[stalledMid, calmLeft]}
        activeSessionId="sess-d"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(container.querySelector(".pc-edge-alert")).toBeNull();
  });
});
