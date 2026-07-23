/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChartKey, RosterPanel } from "../src/hud/index.js";
import {
  isAnyHandRolledPopoverOpen,
  notifyHandRolledPopoverClosed,
} from "../src/hud/handRolledPopover.js";
import { HARNESS_COLORS, MODEL_VENDORS } from "../src/tokens/factions.js";
import { ATTENTION_DISPLAY_ORDER, STATE_META } from "../src/tokens/state-meta.js";

afterEach(() => {
  cleanup();
  // Ensure module bus is idle between tests (unmount may already have closed).
  notifyHandRolledPopoverClosed("chart-key");
  notifyHandRolledPopoverClosed("session-find");
});

describe("ChartKey production legend (recognition over recall)", () => {
  it("starts collapsed — no legend panel until the toggle is opened", () => {
    render(<ChartKey />);
    const toggle = screen.getByRole("button", { name: /Chart key/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Chart key" })).toBeNull();
  });

  it("opens on click and lists every state in ATTENTION_DISPLAY_ORDER", () => {
    render(<ChartKey />);
    fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    expect(screen.getByRole("button", { name: /Chart key/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const panel = screen.getByRole("region", { name: "Chart key" });
    expect(panel).toBeTruthy();
    for (const key of ATTENTION_DISPLAY_ORDER) {
      const meta = STATE_META[key];
      expect(screen.getByText(meta.label)).toBeTruthy();
      expect(screen.getByText(meta.hint)).toBeTruthy();
    }
  });

  it("lists every model-maker mark and harness coat", () => {
    render(<ChartKey />);
    fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    for (const vendor of Object.values(MODEL_VENDORS)) {
      expect(screen.getAllByText(vendor.label).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByLabelText(vendor.label)).toBeTruthy();
    }
    for (const harness of Object.values(HARNESS_COLORS)) {
      expect(screen.getAllByText(harness.label).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByLabelText(`${harness.label} harness`)).toBeTruthy();
    }
  });

  it("closes on a second click of the toggle", () => {
    render(<ChartKey />);
    const toggle = screen.getByRole("button", { name: /Chart key/ });
    fireEvent.click(toggle);
    expect(screen.getByRole("region", { name: "Chart key" })).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Chart key" })).toBeNull();
  });

  it("closes on Escape", () => {
    render(<ChartKey />);
    fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    expect(screen.getByRole("region", { name: "Chart key" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Chart key" })).toBeNull();
  });

  it("uses a native button with aria-expanded (keyboard + AT free)", () => {
    render(<ChartKey />);
    const toggle = screen.getByRole("button", { name: /Chart key/ });
    expect(toggle.tagName).toBe("BUTTON");
    expect((toggle as HTMLButtonElement).type).toBe("button");
    expect(toggle.hasAttribute("aria-expanded")).toBe(true);
    expect(toggle.hasAttribute("aria-controls")).toBe(true);
  });

  it("documents keyboard accelerators in a Keys section (recognition over recall)", () => {
    render(<ChartKey />);
    fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    expect(screen.getByText("Keys")).toBeTruthy();
    expect(screen.getByText("/")).toBeTruthy();
    expect(screen.getByText("find session")).toBeTruthy();
    expect(screen.getByText("n")).toBeTruthy();
    expect(screen.getByText("next flag that needs you")).toBeTruthy();
    expect(screen.getByText("m")).toBeTruthy();
    expect(screen.getByText("toggle Soundings")).toBeTruthy();
    expect(screen.getByText("Esc")).toBeTruthy();
    expect(screen.getByText("clear task selection")).toBeTruthy();
  });

  it("renders a more-below scroll cue that hides when content fits or is scrolled to end", () => {
    render(<ChartKey />);
    fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    const panel = screen.getByRole("region", { name: "Chart key" });
    const cue = panel.querySelector(".pc-chart-key__scroll-cue");
    expect(cue).toBeTruthy();
    // happy-dom has no real overflow geometry — content "fits", so the cue
    // starts hidden. Mock overflow and re-fire scroll to show/hide it.
    expect(cue?.classList.contains("pc-chart-key__scroll-cue--hidden")).toBe(true);

    Object.defineProperty(panel, "scrollHeight", { configurable: true, get: () => 800 });
    Object.defineProperty(panel, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(panel, "scrollTop", { configurable: true, get: () => 0, set: () => {} });
    fireEvent.scroll(panel);
    expect(cue?.classList.contains("pc-chart-key__scroll-cue--hidden")).toBe(false);
    expect(cue?.textContent).toContain("More below");

    Object.defineProperty(panel, "scrollTop", { configurable: true, get: () => 600, set: () => {} });
    fireEvent.scroll(panel);
    expect(cue?.classList.contains("pc-chart-key__scroll-cue--hidden")).toBe(true);
  });
});

describe("hand-rolled popover single-open invariant", () => {
  it("opening Chart key closes session Find, and vice versa", () => {
    const groups = [
      {
        state: "running" as const,
        tasks: [
          {
            id: "t1",
            name: "chart-the-bay",
            coat: "#10a37f",
            emblem: { kind: "glyph" as const, char: "π" },
            faction: "Codex",
            meta: "feat/bay · t1",
          },
        ],
      },
    ];
    render(
      <>
        <ChartKey />
        <RosterPanel
          groups={groups}
          sessions={[{ id: "sess-abc12345", label: "sess-abc1", count: 1 }]}
          selectedSessionId={null}
          onSelectSession={() => {}}
          searchSessions={async () => []}
          selectedTaskId={null}
          onSelectTask={() => {}}
          totalTasks={1}
          activeTasks={1}
        />
      </>,
    );

    // Open Find first.
    fireEvent.click(screen.getByRole("button", { name: "Search sessions" }));
    expect(screen.getByLabelText("Session id")).toBeTruthy();
    expect(document.querySelector(".pc-roster__search-pop")).toBeTruthy();

    // Opening Chart key must close Find (single-open).
    fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    expect(screen.getByRole("region", { name: "Chart key" })).toBeTruthy();
    expect(screen.queryByLabelText("Session id")).toBeNull();
    expect(document.querySelector(".pc-roster__search-pop")).toBeNull();

    // Re-open Find — Chart key must close.
    fireEvent.click(screen.getByRole("button", { name: "Search sessions" }));
    expect(screen.getByLabelText("Session id")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Chart key" })).toBeNull();
  });
});

describe("hand-rolled popover bus truthfulness", () => {
  it("click inside open ChartKey keeps the bus open; Esc then closes it", () => {
    render(<ChartKey />);
    fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    expect(isAnyHandRolledPopoverOpen()).toBe(true);

    const panel = screen.getByRole("region", { name: "Chart key" });
    // Inside pointer must not clear the bus (regression: was nulling on any mousedown).
    fireEvent.pointerDown(panel);
    fireEvent.mouseDown(panel);
    expect(isAnyHandRolledPopoverOpen()).toBe(true);
    expect(screen.getByRole("region", { name: "Chart key" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Chart key" })).toBeNull();
    expect(isAnyHandRolledPopoverOpen()).toBe(false);
  });

  it("click outside closes the popover and the bus reports closed", () => {
    render(
      <div>
        <ChartKey />
        <button type="button">outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    expect(isAnyHandRolledPopoverOpen()).toBe(true);
    expect(screen.getByRole("region", { name: "Chart key" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("region", { name: "Chart key" })).toBeNull();
    expect(isAnyHandRolledPopoverOpen()).toBe(false);
  });

  it("open/close via keyboard keeps the bus truthful", () => {
    const groups = [
      {
        state: "running" as const,
        tasks: [
          {
            id: "t1",
            name: "chart-the-bay",
            coat: "#10a37f",
            emblem: { kind: "glyph" as const, char: "π" },
            faction: "Codex",
            meta: "feat/bay · t1",
          },
        ],
      },
    ];
    render(
      <>
        <ChartKey />
        <RosterPanel
          groups={groups}
          sessions={[{ id: "sess-abc12345", label: "sess-abc1", count: 1 }]}
          selectedSessionId={null}
          onSelectSession={() => {}}
          searchSessions={async () => []}
          selectedTaskId={null}
          onSelectTask={() => {}}
          totalTasks={1}
          activeTasks={1}
        />
      </>,
    );

    // Chart key: open with Space/Enter on the toggle, close with Escape.
    const chartToggle = screen.getByRole("button", { name: /Chart key/ });
    fireEvent.keyDown(chartToggle, { key: " " });
    fireEvent.click(chartToggle); // native button activation
    expect(isAnyHandRolledPopoverOpen()).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(isAnyHandRolledPopoverOpen()).toBe(false);
    expect(screen.queryByRole("region", { name: "Chart key" })).toBeNull();

    // Session Find: open via click ( / is useCockpitKeys), Esc closes + bus clears.
    fireEvent.click(screen.getByRole("button", { name: "Search sessions" }));
    expect(isAnyHandRolledPopoverOpen()).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(isAnyHandRolledPopoverOpen()).toBe(false);
    expect(screen.queryByLabelText("Session id")).toBeNull();
  });
});
