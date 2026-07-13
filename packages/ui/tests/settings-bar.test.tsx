/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsBar } from "../src/hud/index.js";

afterEach(cleanup);

describe("SettingsBar renders the three persisted toggles (#70)", () => {
  it("reflects each toggle's on/off state via aria-pressed", () => {
    render(
      <SettingsBar
        ornaments
        showKit={false}
        followLogs
        onToggleOrnaments={() => {}}
        onToggleShowKit={() => {}}
        onToggleFollowLogs={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Ornaments/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Kit band/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /Follow logs/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("is a labelled group so assistive tech announces it as cockpit settings", () => {
    render(
      <SettingsBar
        ornaments
        showKit={false}
        followLogs
        onToggleOrnaments={() => {}}
        onToggleShowKit={() => {}}
        onToggleFollowLogs={() => {}}
      />,
    );
    expect(screen.getByRole("group", { name: "Cockpit settings" })).toBeTruthy();
  });

  it("invokes exactly the callback matching the clicked toggle", () => {
    const onToggleOrnaments = vi.fn();
    const onToggleShowKit = vi.fn();
    const onToggleFollowLogs = vi.fn();
    render(
      <SettingsBar
        ornaments={false}
        showKit={false}
        followLogs={false}
        onToggleOrnaments={onToggleOrnaments}
        onToggleShowKit={onToggleShowKit}
        onToggleFollowLogs={onToggleFollowLogs}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Kit band/ }));
    expect(onToggleShowKit).toHaveBeenCalledTimes(1);
    expect(onToggleOrnaments).not.toHaveBeenCalled();
    expect(onToggleFollowLogs).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Follow logs/ }));
    expect(onToggleFollowLogs).toHaveBeenCalledTimes(1);
    expect(onToggleShowKit).toHaveBeenCalledTimes(1);
  });

  it("every toggle is a native button — free keyboard activation and the global focus ring", () => {
    render(
      <SettingsBar
        ornaments
        showKit={false}
        followLogs
        onToggleOrnaments={() => {}}
        onToggleShowKit={() => {}}
        onToggleFollowLogs={() => {}}
      />,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button.tagName).toBe("BUTTON");
      expect((button as HTMLButtonElement).type).toBe("button");
    }
  });
});
