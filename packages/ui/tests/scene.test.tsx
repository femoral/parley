/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Island, Scene, Ship, type IslandTask } from "../src/scene/index.js";
import type { SessionRegionData } from "../src/scene/SessionRegion.js";

afterEach(cleanup);

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
    expect(container.querySelector(".pc-orbit")).toBeNull();
    expect(container.querySelector(".pc-flare")).toBeNull();
    expect(container.querySelector(".pc-flag")).toBeNull();
    expect(container.querySelector(".pc-wreck")).toBeNull();
  });

  it("running — a sloop under way with a wake, no attention/terminal effects", () => {
    const { container } = render(<Island task={island("running")} onSelectTask={noop} />);
    expect(container.querySelector(".pc-orbit[data-state='running']")).toBeTruthy();
    expect(container.querySelector(".pc-sloop")).toBeTruthy();
    expect(container.querySelector(".pc-wake")).toBeTruthy();
    expect(container.querySelector(".pc-flare")).toBeNull();
    expect(container.querySelector(".pc-fog")).toBeNull();
  });

  it("awaiting_answer — anchored sloop, flare, and PARLEY! ribbon", () => {
    const { container } = render(<Island task={island("awaiting_answer")} onSelectTask={noop} />);
    expect(container.querySelector(".pc-orbit[data-state='awaiting_answer']")).toBeTruthy();
    expect(container.querySelector(".pc-anchor")).toBeTruthy();
    expect(container.querySelector(".pc-flare")).toBeTruthy();
    expect(container.querySelector(".pc-parley")).toBeTruthy();
    expect(container.querySelector(".pc-parley")?.textContent).toContain("PARLEY");
  });

  it("stalled — a fog bank rolls over the adrift ship", () => {
    const { container } = render(<Island task={island("stalled")} onSelectTask={noop} />);
    expect(container.querySelector(".pc-fog")).toBeTruthy();
    expect(container.querySelector(".pc-orbit[data-state='stalled']")).toBeTruthy();
    expect(container.querySelector(".pc-flare")).toBeNull();
  });

  it("completed — a planted flag, ship gone", () => {
    const { container } = render(<Island task={island("completed")} onSelectTask={noop} />);
    const flag = container.querySelector(".pc-flag");
    expect(flag).toBeTruthy();
    expect(flag?.querySelector("line")?.getAttribute("x2")).toBe("70");
    expect(flag?.querySelector("line")?.getAttribute("y2")).toBe("32");
    expect(container.querySelector(".pc-sloop")).toBeNull();
    expect(container.querySelector(".pc-wreck")).toBeNull();
  });

  it("failed — a shipwreck, ship gone", () => {
    const { container } = render(<Island task={island("failed")} onSelectTask={noop} />);
    expect(container.querySelector(".pc-wreck")).toBeTruthy();
    expect(container.querySelector(".pc-sloop")).toBeNull();
    expect(container.querySelector(".pc-flag")).toBeNull();
  });

  it("cancelled — the sloop sails off as the island sinks", () => {
    const { container } = render(<Island task={island("cancelled")} onSelectTask={noop} />);
    expect(container.querySelector(".pc-sloop--sailoff")).toBeTruthy();
    expect(container.querySelector(".pc-orbit")).toBeNull();
    expect(container.querySelector(".pc-flag")).toBeNull();
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
    // Selecting the far session shifts the world plane — the camera has sailed.
    expect(atFirst).not.toBe(atSecond);
    // The first region sits at world x=0, so framing it leaves x un-shifted.
    expect(atFirst).toContain("translate(0px,");
  });

  it("frames the first region for 'All hands' (null) rather than filtering", () => {
    const { container } = render(
      <Scene sessions={[REGION]} activeSessionId={null} onSelectTask={noop} onSelectSession={noop} />,
    );
    expect(container.querySelectorAll(".pc-island")).toHaveLength(3);
    expect((container.querySelector(".pc-world") as HTMLElement).style.transform).toContain("translate(0px,");
  });

  it("shows the calm-tide empty state with no sessions", () => {
    const { container } = render(
      <Scene sessions={[]} activeSessionId={null} onSelectTask={noop} onSelectSession={noop} />,
    );
    expect(container.querySelector(".pc-scene-empty")).toBeTruthy();
    expect(container.querySelector(".pc-region")).toBeNull();
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

  it("renders a right-edge indicator for an off-camera awaiting session", () => {
    const { container } = render(
      <Scene
        sessions={[calmLeft, awaitingRight]}
        activeSessionId="sess-a"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    const btn = screen.getByRole("button", {
      name: "Session sess-b — 1 awaiting answer, to the right",
    });
    expect(btn).toBeTruthy();
    expect(btn.classList.contains("pc-edge-alert--beacon")).toBe(true);
    expect(btn.textContent).toContain("▶");
    expect(container.querySelector(".pc-edge-alerts--right")).toBeTruthy();
    expect(container.querySelector(".pc-edge-alerts--left")).toBeNull();
  });

  it("points left when the attention session sits west of the frame", () => {
    render(
      <Scene
        sessions={[awaitingRight, calmLeft]}
        activeSessionId="sess-a"
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    // calmLeft is second (east); awaitingRight is first (west of frame).
    // Wait — sessions order is [awaitingRight, calmLeft], active is sess-a which is calmLeft at index 1.
    const btn = screen.getByRole("button", {
      name: "Session sess-b — 1 awaiting answer, to the left",
    });
    expect(btn.textContent).toContain("◀");
  });

  it("selects the session when an edge indicator is clicked", () => {
    const onSelectSession = vi.fn();
    render(
      <Scene
        sessions={[calmLeft, awaitingRight]}
        activeSessionId="sess-a"
        onSelectTask={noop}
        onSelectSession={onSelectSession}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Session sess-b — 1 awaiting answer, to the right" }),
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
    const more = container.querySelector(".pc-edge-alert--more");
    expect(more?.textContent).toBe("+1");
  });

  it("under All hands, treats the first region as framed (indicators for the rest)", () => {
    render(
      <Scene
        sessions={[calmLeft, awaitingRight, failedFar]}
        activeSessionId={null}
        onSelectTask={noop}
        onSelectSession={noop}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Session sess-b — 1 awaiting answer, to the right" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Session sess-c — 1 failed, to the right" })).toBeTruthy();
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
