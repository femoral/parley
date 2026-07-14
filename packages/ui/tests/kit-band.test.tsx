/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { KitBand } from "../src/hud/KitBand.js";
import { FACTIONS } from "../src/tokens/factions.js";
import { STATE_META } from "../src/tokens/state-meta.js";

afterEach(cleanup);

describe("KitBand — the dev style-guide strip (#70)", () => {
  it("lists every registered faction with its label and tagline", () => {
    render(<KitBand />);
    for (const faction of Object.values(FACTIONS)) {
      expect(screen.getByText(faction.label)).toBeTruthy();
      expect(screen.getByText(faction.tagline)).toBeTruthy();
    }
  });

  it("lists all seven states, each with its manifest label and hint", () => {
    render(<KitBand />);
    for (const meta of Object.values(STATE_META)) {
      expect(screen.getByText(meta.label)).toBeTruthy();
      expect(screen.getByText(meta.hint)).toBeTruthy();
    }
  });

  it("shows a chrome-kit sample of every button variant", () => {
    render(<KitBand />);
    expect(screen.getByRole("button", { name: "Primary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Secondary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tertiary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Success" })).toBeTruthy();
  });
});
