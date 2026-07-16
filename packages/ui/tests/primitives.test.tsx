/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Badge, Button, Divider, Emblem, Plate, Stat } from "../src/primitives/index.js";

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
    expect(badge.textContent).toContain("🚩");
    expect(badge.style.getPropertyValue("--badge-color")).toBe("var(--state-awaiting_answer)");
  });

  it("Badge accepts a ReactNode glyph (authored Mark SVG)", () => {
    const { container } = render(
      <Badge
        label="RUNNING"
        glyph={
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2 L20 12 L12 22 Z" fill="currentColor" />
          </svg>
        }
        color="var(--state-running)"
      />,
    );
    const badge = container.querySelector(".pc-badge") as HTMLElement;
    expect(badge.textContent).toContain("RUNNING");
    expect(badge.querySelector(".pc-badge__glyph svg")).toBeTruthy();
    // String emoji is not rendered when an SVG mark is passed.
    expect(badge.textContent).not.toContain("⛵");
  });

  it("Emblem tints its chip with the faction coat and shows a glyph mark", () => {
    const { container } = render(
      <Emblem coat="#10a37f" mark={{ kind: "glyph", char: "π" }} label="Pi" />,
    );
    const chip = container.querySelector(".pc-emblem") as HTMLElement;
    expect(chip.style.getPropertyValue("--coat")).toBe("#10a37f");
    expect(screen.getByLabelText("Pi").textContent).toBe("π");
    expect(chip.getAttribute("title")).toBe("Pi");
  });

  it("Emblem renders an SVG path mark inside the chip", () => {
    const { container } = render(
      <Emblem
        coat="#2b2b2e"
        mark={{ kind: "svg", viewBox: "0 0 24 24", path: "M5 5 L19 19 M19 5 L5 19" }}
        label="Grok"
      />,
    );
    const chip = container.querySelector(".pc-emblem") as HTMLElement;
    expect(chip.style.getPropertyValue("--coat")).toBe("#2b2b2e");
    expect(chip.querySelector("svg.pc-emblem__mark")).toBeTruthy();
    expect(chip.querySelector("path")).toBeTruthy();
  });

  it("Button applies the variant class and defaults to type=button", () => {
    const { container } = render(<Button variant="secondary">RESUME</Button>);
    const btn = container.querySelector("button") as HTMLButtonElement;
    expect(btn.className).toContain("pc-btn--secondary");
    expect(btn.type).toBe("button");
  });

  it("Button disabled state sets the native disabled attribute", () => {
    render(
      <Button variant="primary" disabled>
        Send
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Button loading applies busy semantics, disables, and shows a spinner", () => {
    const { container } = render(
      <Button variant="primary" loading>
        Save
      </Button>,
    );
    const btn = container.querySelector("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.classList.contains("pc-btn--loading")).toBe(true);
    expect(btn.querySelector(".pc-btn__spinner")).toBeTruthy();
    // Label stays in the tree (layout stability) under .pc-btn__label.
    expect(btn.querySelector(".pc-btn__label")?.textContent).toBe("Save");
  });

  it("Button loading works across all four variants", () => {
    for (const variant of ["primary", "secondary", "tertiary", "success"] as const) {
      const { container } = render(
        <Button variant={variant} loading>
          Go
        </Button>,
      );
      const btn = container.querySelector("button") as HTMLButtonElement;
      expect(btn.classList.contains(`pc-btn--${variant}`)).toBe(true);
      expect(btn.classList.contains("pc-btn--loading")).toBe(true);
      expect(btn.disabled).toBe(true);
      cleanup();
    }
  });

  it("Stat shows the numeral over its caps label", () => {
    render(<Stat value="7" label="Total tasks" color="var(--brass)" />);
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("Total tasks")).toBeTruthy();
  });

  it("Divider renders the horizontal rule by default", () => {
    const { container } = render(<Divider />);
    const hr = container.querySelector("hr.pc-divider");
    expect(hr).toBeTruthy();
    expect(hr!.className).not.toContain("pc-divider--v");
  });

  it("Divider's vertical variant (kit band column separators, #70) is a decorative div, not an hr", () => {
    const { container } = render(<Divider vertical />);
    expect(container.querySelector("hr")).toBeNull();
    const div = container.querySelector("div.pc-divider.pc-divider--v");
    expect(div).toBeTruthy();
    expect(div!.getAttribute("aria-hidden")).toBe("true");
  });
});
