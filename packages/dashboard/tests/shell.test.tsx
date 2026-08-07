/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/Shell.js";
import { countNeedsOrch, attentionTaskIds } from "../src/chrome/attention.js";
import { envelope } from "./fixtures.js";
import { parseScreenHash, parseScreenRoute, screenHash } from "../src/screens/types.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../src/chrome/settings.js";
import { buildTabSubs } from "../src/chrome/Header.js";
import { countNoun, countNeedVerb } from "../src/chrome/plural.js";

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
    // State never by hue alone — legend shares chip vocabulary (#366)
    expect(screen.getByText("AWAITING")).toBeTruthy();
    expect(screen.getByText("FAILED")).toBeTruthy();
    // Footer doctrine (state-vs-quality vocabulary) present in full + compact
    expect(screen.getByTestId("footer-note-full").textContent).toMatch(/what a task IS/);
    expect(screen.getByTestId("footer-note-full").textContent).toMatch(/how good work WAS/);
    expect(screen.getByTestId("footer-note-compact").textContent).toMatch(/state=IS/);
    expect(screen.getByTestId("footer-note-compact").textContent).toMatch(/quality=WAS/);
  });

  it("exposes skip links and live region; main-content is focusable", () => {
    render(<Shell />);
    expect(screen.getByTestId("skip-links")).toBeTruthy();
    expect(screen.getByRole("link", { name: /skip to navigation/i })).toBeTruthy();
    expect(screen.getByTestId("skip-main")).toBeTruthy();
    expect(screen.getByTestId("live-region")).toBeTruthy();
    const main = document.getElementById("main-content");
    expect(main).toBeTruthy();
    expect(main?.getAttribute("tabindex")).toBe("-1");
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

  it("opens settings modal (aria-modal=true) and toggles follow logs", () => {
    render(<Shell />);
    fireEvent.click(screen.getByTestId("settings-open"));
    const panel = screen.getByTestId("settings-panel");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    const follow = within(screen.getByTestId("settings-surface")).getByTestId(
      "settings-follow-logs",
    ) as HTMLInputElement;
    expect(follow.checked).toBe(true);
    fireEvent.click(follow);
    expect(follow.checked).toBe(false);
    fireEvent.click(screen.getByTestId("settings-close"));
    expect(screen.queryByTestId("settings-surface")).toBeNull();
  });

  it("arrow keys traverse the nav tablist with roving tabindex", () => {
    render(<Shell />);
    const fleet = screen.getByTestId("nav-fleet");
    const run = screen.getByTestId("nav-run");
    expect(fleet.getAttribute("tabindex")).toBe("0");
    expect(run.getAttribute("tabindex")).toBe("-1");
    fleet.focus();
    fireEvent.keyDown(fleet, { key: "ArrowRight" });
    expect(screen.getByTestId("screen-run")).toBeTruthy();
    expect(screen.getByTestId("nav-run").getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(screen.getByTestId("nav-run"), { key: "ArrowLeft" });
    expect(screen.getByTestId("screen-fleet")).toBeTruthy();
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

describe("pluralization", () => {
  it("never says 1 tasks", () => {
    expect(countNoun(1, "task")).toBe("1 task");
    expect(countNoun(0, "task")).toBe("0 tasks");
    expect(countNoun(2, "task")).toBe("2 tasks");
    expect(countNeedVerb(1, "action")).toBe("1 needs action");
    expect(countNeedVerb(3, "action")).toBe("3 need action");
    const subs = buildTabSubs({
      totalTasks: 1,
      attentionCount: 1,
      selectedRunId: null,
      selectedTaskId: null,
      firstRunLabel: null,
      firstTaskId: null,
      honestyPhase: "live",
    });
    expect(subs.fleet).toBe("1 task · 1 needs action");
    expect(subs.fleet).not.toMatch(/1 tasks/);
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

  it("carries task/run entity ids for deep links", () => {
    expect(parseScreenRoute("#/task/abc-123")).toEqual({
      screen: "task",
      entityId: "abc-123",
    });
    expect(parseScreenRoute("#/run/r1")).toEqual({ screen: "run", entityId: "r1" });
    expect(screenHash("task", "t9")).toBe("#/task/t9");
    expect(screenHash("run", "run/with/slash")).toBe(
      `#/run/${encodeURIComponent("run/with/slash")}`,
    );
    // Screen-only still works (unknown/missing id degrades here).
    expect(parseScreenRoute("#/task")).toEqual({ screen: "task", entityId: null });
    expect(screenHash("task")).toBe("#/task");
  });
});

describe("register copy", () => {
  it("metrics tab sub uses all-sessions register copy when live", () => {
    const subs = buildTabSubs({
      totalTasks: 2,
      attentionCount: 0,
      selectedRunId: null,
      selectedTaskId: null,
      firstRunLabel: null,
      firstTaskId: null,
      honestyPhase: "live",
    });
    expect(subs.metrics).toBe("all sessions");
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
