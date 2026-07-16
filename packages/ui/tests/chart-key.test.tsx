/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChartKey } from "../src/hud/index.js";
import { FACTIONS } from "../src/tokens/factions.js";
import { ATTENTION_DISPLAY_ORDER, STATE_META } from "../src/tokens/state-meta.js";

afterEach(cleanup);

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

  it("lists every registered faction with its name", () => {
    render(<ChartKey />);
    fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    for (const faction of Object.values(FACTIONS)) {
      // Emblem aria-label + visible name both carry the faction label.
      expect(screen.getAllByText(faction.label).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByLabelText(faction.label)).toBeTruthy();
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
});
