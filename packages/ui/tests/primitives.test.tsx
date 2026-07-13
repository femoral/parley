/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Badge, Button, Emblem, Plate, Stat } from "../src/primitives/index.js";

afterEach(cleanup);

describe("primitives render per manifest with plain props", () => {
  it("Plate carries its variant class and renders children", () => {
    const { container } = render(
      <Plate variant="ember">
        <span>cargo</span>
      </Plate>,
    );
    expect(container.querySelector(".pc-plate")).toBeTruthy();
    expect(container.querySelector(".pc-plate--ember")).toBeTruthy();
    expect(screen.getByText("cargo")).toBeTruthy();
  });

  it("premium Plate with ornaments draws four corner flourishes", () => {
    const { container } = render(<Plate variant="premium" ornaments />);
    expect(container.querySelectorAll(".pc-flourish")).toHaveLength(4);
  });

  it("standard Plate never draws flourishes even when ornaments is set", () => {
    const { container } = render(<Plate variant="standard" ornaments />);
    expect(container.querySelectorAll(".pc-flourish")).toHaveLength(0);
  });

  it("Badge drives its border/text colour from the passed state token", () => {
    const { container } = render(
      <Badge label="AWAITING" glyph="🚩" color="var(--state-awaiting_answer)" />,
    );
    const badge = container.querySelector(".pc-badge") as HTMLElement;
    expect(badge.textContent).toContain("AWAITING");
    expect(badge.style.getPropertyValue("--badge-color")).toBe("var(--state-awaiting_answer)");
  });

  it("Emblem tints its chip with the faction coat and shows the glyph", () => {
    const { container } = render(<Emblem coat="#2f5fb0" glyph="⚓" label="Cartographers' Guild" />);
    const chip = container.querySelector(".pc-emblem") as HTMLElement;
    expect(chip.style.getPropertyValue("--coat")).toBe("#2f5fb0");
    expect(screen.getByLabelText("Cartographers' Guild").textContent).toBe("⚓");
  });

  it("Button applies the variant class and defaults to type=button", () => {
    const { container } = render(<Button variant="secondary">RESUME</Button>);
    const btn = container.querySelector("button") as HTMLButtonElement;
    expect(btn.className).toContain("pc-btn--secondary");
    expect(btn.type).toBe("button");
  });

  it("Stat shows the numeral over its caps label", () => {
    render(<Stat value="7" label="Total tasks" color="var(--brass)" />);
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("Total tasks")).toBeTruthy();
  });
});
