/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsBar } from "../src/hud/index.js";

afterEach(cleanup);

describe("SettingsBar renders the persisted toggles (#70)", () => {
  it("reflects each toggle's on/off state via aria-pressed", () => {
    render(
      <SettingsBar
        showKit={false}
        followLogs
        shortcuts
        onToggleShowKit={() => {}}
        onToggleFollowLogs={() => {}}
        onToggleShortcuts={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Kit band/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /Follow logs/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("is a labelled group so assistive tech announces it as cockpit settings", () => {
    render(
      <SettingsBar
        showKit={false}
        followLogs
        shortcuts
        onToggleShowKit={() => {}}
        onToggleFollowLogs={() => {}}
        onToggleShortcuts={() => {}}
      />,
    );
    expect(screen.getByRole("group", { name: "Cockpit settings" })).toBeTruthy();
  });

  it("invokes exactly the callback matching the clicked toggle", () => {
    const onToggleShowKit = vi.fn();
    const onToggleFollowLogs = vi.fn();
    render(
      <SettingsBar
        showKit={false}
        followLogs={false}
        shortcuts={false}
        onToggleShowKit={onToggleShowKit}
        onToggleFollowLogs={onToggleFollowLogs}
        onToggleShortcuts={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Kit band/ }));
    expect(onToggleShowKit).toHaveBeenCalledTimes(1);
    expect(onToggleFollowLogs).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Follow logs/ }));
    expect(onToggleFollowLogs).toHaveBeenCalledTimes(1);
    expect(onToggleShowKit).toHaveBeenCalledTimes(1);
  });

  it("every toggle is a native button — free keyboard activation and the global focus ring", () => {
    render(
      <SettingsBar
        showKit={false}
        followLogs
        shortcuts
        onToggleShowKit={() => {}}
        onToggleFollowLogs={() => {}}
        onToggleShortcuts={() => {}}
      />,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button.tagName).toBe("BUTTON");
      expect((button as HTMLButtonElement).type).toBe("button");
    }
  });
});
