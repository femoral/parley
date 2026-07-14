/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Island, Scene, Ship, type IslandTask } from "../src/scene/index.js";
import type { SessionRegionData } from "../src/scene/SessionRegion.js";

afterEach(cleanup);

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
      const { container } = render(<Island task={island(state)} />);
      expect(container.querySelector(".pc-island")?.getAttribute("data-state")).toBe(state);
      cleanup();
    }
  });

  it("pending — rising island, no ship, no terminal or attention effect", () => {
    const { container } = render(<Island task={island("pending")} />);
    expect(container.querySelector(".pc-island__rise")).toBeTruthy();
    expect(container.querySelector(".pc-sloop")).toBeNull();
    expect(container.querySelector(".pc-orbit")).toBeNull();
    expect(container.querySelector(".pc-flare")).toBeNull();
    expect(container.querySelector(".pc-flag")).toBeNull();
    expect(container.querySelector(".pc-wreck")).toBeNull();
  });

  it("running — a sloop under way with a wake, no attention/terminal effects", () => {
    const { container } = render(<Island task={island("running")} />);
    expect(container.querySelector(".pc-orbit[data-state='running']")).toBeTruthy();
    expect(container.querySelector(".pc-sloop")).toBeTruthy();
    expect(container.querySelector(".pc-wake")).toBeTruthy();
    expect(container.querySelector(".pc-flare")).toBeNull();
    expect(container.querySelector(".pc-fog")).toBeNull();
  });

  it("awaiting_answer — anchored sloop, flare, and PARLEY! ribbon", () => {
    const { container } = render(<Island task={island("awaiting_answer")} />);
    expect(container.querySelector(".pc-orbit[data-state='awaiting_answer']")).toBeTruthy();
    expect(container.querySelector(".pc-anchor")).toBeTruthy();
    expect(container.querySelector(".pc-flare")).toBeTruthy();
    expect(container.querySelector(".pc-parley")).toBeTruthy();
    expect(container.querySelector(".pc-parley")?.textContent).toContain("PARLEY");
  });

  it("stalled — a fog bank rolls over the adrift ship", () => {
    const { container } = render(<Island task={island("stalled")} />);
    expect(container.querySelector(".pc-fog")).toBeTruthy();
    expect(container.querySelector(".pc-orbit[data-state='stalled']")).toBeTruthy();
    expect(container.querySelector(".pc-flare")).toBeNull();
  });

  it("completed — a planted flag, ship gone", () => {
    const { container } = render(<Island task={island("completed")} />);
    expect(container.querySelector(".pc-flag")).toBeTruthy();
    expect(container.querySelector(".pc-sloop")).toBeNull();
    expect(container.querySelector(".pc-wreck")).toBeNull();
  });

  it("failed — a shipwreck, ship gone", () => {
    const { container } = render(<Island task={island("failed")} />);
    expect(container.querySelector(".pc-wreck")).toBeTruthy();
    expect(container.querySelector(".pc-sloop")).toBeNull();
    expect(container.querySelector(".pc-flag")).toBeNull();
  });

  it("cancelled — the sloop sails off as the island sinks", () => {
    const { container } = render(<Island task={island("cancelled")} />);
    expect(container.querySelector(".pc-sloop--sailoff")).toBeTruthy();
    expect(container.querySelector(".pc-orbit")).toBeNull();
    expect(container.querySelector(".pc-flag")).toBeNull();
  });

  it("labels the island with its name and manifest state label for AT", () => {
    const { container } = render(<Island task={island("awaiting_answer", { name: "sound-depths" })} />);
    expect(container.querySelector(".pc-island")?.getAttribute("aria-label")).toBe(
      "sound-depths — AWAITING",
    );
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
    const orbit = container.querySelector(".pc-orbit") as HTMLElement;
    expect(orbit.style.getPropertyValue("--coat")).toBe("#2b2b2e");
    expect(orbit.style.getPropertyValue("--coat-dark")).toBe("#141416");
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
});

const REGION: SessionRegionData = {
  id: "sess-1",
  label: "sess-1",
  tasks: [island("running", { id: "a" }), island("awaiting_answer", { id: "b" }), island("completed", { id: "c" })],
};

describe("Scene lays out the active session's cove (#69)", () => {
  it("renders exactly one island per task of the session", () => {
    const { container } = render(<Scene sessions={[REGION]} activeSessionId="sess-1" />);
    expect(container.querySelectorAll(".pc-island")).toHaveLength(3);
  });

  it("anchors a galleon in each session region", () => {
    const { container } = render(<Scene sessions={[REGION]} activeSessionId="sess-1" />);
    expect(container.querySelector(".pc-galleon")).toBeTruthy();
  });

  it("travels the camera to the selected region (a transform offset that changes)", () => {
    const second: SessionRegionData = { id: "sess-2", label: "sess-2", tasks: [island("running", { id: "z" })] };
    const first = render(<Scene sessions={[REGION, second]} activeSessionId="sess-1" />);
    const camAt = (c: HTMLElement) => (c.querySelector(".pc-world") as HTMLElement).style.transform;
    const atFirst = camAt(first.container);
    cleanup();
    const secondRender = render(<Scene sessions={[REGION, second]} activeSessionId="sess-2" />);
    const atSecond = camAt(secondRender.container);
    // Selecting the far session shifts the world plane — the camera has sailed.
    expect(atFirst).not.toBe(atSecond);
    // The first region sits at world x=0, so framing it leaves x un-shifted.
    expect(atFirst).toContain("translate(0px,");
  });

  it("frames the first region for 'All hands' (null) rather than filtering", () => {
    const { container } = render(<Scene sessions={[REGION]} activeSessionId={null} />);
    expect(container.querySelectorAll(".pc-island")).toHaveLength(3);
    expect((container.querySelector(".pc-world") as HTMLElement).style.transform).toContain("translate(0px,");
  });

  it("shows the calm-tide empty state with no sessions", () => {
    const { container } = render(<Scene sessions={[]} activeSessionId={null} />);
    expect(container.querySelector(".pc-scene-empty")).toBeTruthy();
    expect(container.querySelector(".pc-region")).toBeNull();
  });
});
