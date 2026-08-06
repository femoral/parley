/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/Shell.js";
import { countNeedsOrch, attentionTaskIds } from "../src/chrome/attention.js";
import { envelope } from "./fixtures.js";
import { parseScreenHash, screenHash } from "../src/screens/types.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../src/chrome/settings.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Shell frame", () => {
  it("renders chrome board with brand, nav, find, rails, footer legend", () => {
    render(<Shell />);
    expect(screen.getByTestId("shell")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Parley" })).toBeTruthy();
    expect(screen.getByTestId("shell-nav")).toBeTruthy();
    expect(screen.getByTestId("find-combobox")).toBeTruthy();
    expect(screen.getByTestId("rail-left")).toBeTruthy();
    expect(screen.getByTestId("rail-right")).toBeTruthy();
    expect(screen.getByTestId("shell-footer")).toBeTruthy();
    expect(screen.getByTestId("screen-fleet")).toBeTruthy();
    // State never by hue alone — legend labels present
    expect(screen.getByText("awaiting")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("exposes skip links and live region", () => {
    render(<Shell />);
    expect(screen.getByTestId("skip-links")).toBeTruthy();
    expect(screen.getByRole("link", { name: /skip to navigation/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /skip to main content/i })).toBeTruthy();
    expect(screen.getByTestId("live-region")).toBeTruthy();
  });

  it("navigates between the four screen mounts via tabs", () => {
    render(<Shell />);
    fireEvent.click(screen.getByTestId("nav-run"));
    expect(screen.getByTestId("screen-run")).toBeTruthy();
    fireEvent.click(screen.getByTestId("nav-task"));
    expect(screen.getByTestId("screen-task")).toBeTruthy();
    fireEvent.click(screen.getByTestId("nav-metrics"));
    expect(screen.getByTestId("screen-metrics")).toBeTruthy();
    fireEvent.click(screen.getByTestId("nav-fleet"));
    expect(screen.getByTestId("screen-fleet")).toBeTruthy();
  });

  it("opens settings surface and toggles follow logs", () => {
    render(<Shell />);
    fireEvent.click(screen.getByTestId("settings-open"));
    const panel = screen.getByTestId("settings-surface");
    expect(panel).toBeTruthy();
    const follow = within(panel).getByTestId("settings-follow-logs") as HTMLInputElement;
    expect(follow.checked).toBe(true);
    fireEvent.click(follow);
    expect(follow.checked).toBe(false);
    fireEvent.click(screen.getByTestId("settings-close"));
    expect(screen.queryByTestId("settings-surface")).toBeNull();
  });

  it("find input is an ARIA combobox", () => {
    render(<Shell />);
    const input = screen.getByTestId("find-input");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-haspopup")).toBe("listbox");
  });
});

describe("attention counting", () => {
  it("counts awaiting, stalled, failed and held gates", () => {
    const tasks = [
      envelope({ task_id: "a", state: "awaiting_answer" }),
      envelope({ task_id: "b", state: "running" }),
      envelope({ task_id: "c", state: "failed" }),
      envelope({ task_id: "d", state: "stalled" }),
    ];
    expect(countNeedsOrch(tasks)).toBe(3);
    expect(attentionTaskIds(tasks)).toEqual(["a", "d", "c"]);
  });
});

describe("screen hash", () => {
  it("parses and formats hash routes", () => {
    expect(parseScreenHash("#/run")).toBe("run");
    expect(parseScreenHash("#/overview")).toBe("fleet");
    expect(parseScreenHash("")).toBe("fleet");
    expect(screenHash("metrics")).toBe("#/metrics");
  });
});

describe("settings persistence", () => {
  it("round-trips localStorage", () => {
    saveSettings({ followLogs: false, shortcutsEnabled: false });
    expect(loadSettings()).toEqual({ followLogs: false, shortcutsEnabled: false });
    localStorage.clear();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
