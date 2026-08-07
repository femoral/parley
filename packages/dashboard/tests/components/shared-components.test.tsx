/** @vitest-environment happy-dom */
/**
 * Shared Console component layer (#367) — Panel, StateChip, CopyScaffold, Field/Select.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CopyScaffold,
  Field,
  LEGEND_ORDER,
  Panel,
  Select,
  StateChip,
  chipStateKey,
  legendEntries,
  stateLabel,
} from "../../src/components/index.js";
import { FooterLegend } from "../../src/chrome/FooterLegend.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StateChip", () => {
  it("renders identical structure for wire state and token alias", () => {
    const { container: a } = render(<StateChip state="awaiting_answer" />);
    const { container: b } = render(
      <StateChip state="awaiting" label="AWAITING" live />,
    );
    const chipA = a.querySelector(".pc-chip");
    const chipB = b.querySelector(".pc-chip");
    expect(chipA?.className).toContain("pc-chip--awaiting_answer");
    expect(chipB?.className).toContain("pc-chip--awaiting_answer");
    expect(chipStateKey("awaiting")).toBe("awaiting_answer");
    expect(stateLabel("running")).toBe("RUNNING");
  });

  it("pulses running by default", () => {
    const { container } = render(<StateChip state="running" />);
    expect(container.querySelector(".pc-chip__dot--live")).toBeTruthy();
  });
});

describe("stateLabels legend/chip agreement (#366)", () => {
  it("legend entries match stateLabel for every legend state", () => {
    const entries = legendEntries();
    expect(entries.map((e) => e.state)).toEqual([...LEGEND_ORDER]);
    for (const entry of entries) {
      expect(entry.label).toBe(stateLabel(entry.state));
      expect(entry.label).toBe(entry.label.toUpperCase());
    }
    // Chip short forms that previously diverged from the footer
    expect(stateLabel("completed")).toBe("DONE");
    expect(stateLabel("cancelled")).toBe("CANCEL");
    expect(stateLabel("awaiting_answer")).toBe("AWAITING");
  });

  it("FooterLegend and StateChip render the same vocabulary", () => {
    const { container: legendRoot } = render(<FooterLegend />);
    const legendLabels = [
      ...legendRoot.querySelectorAll(".pc-shell__legend-label"),
    ].map((n) => n.textContent);
    expect(legendLabels).toEqual(legendEntries().map((e) => e.label));
    cleanup();

    for (const entry of legendEntries()) {
      const { container } = render(<StateChip state={entry.state} />);
      expect(container.querySelector(".pc-chip__label")?.textContent).toBe(
        entry.label,
      );
      cleanup();
    }
  });
});

describe("Panel", () => {
  it("renders header title + meta + body", () => {
    render(
      <Panel title="runs" meta="3 held" testId="p1">
        <div data-testid="body">rows</div>
      </Panel>,
    );
    expect(screen.getByTestId("p1").querySelector(".pc-panel__title")?.textContent).toBe(
      "runs",
    );
    expect(screen.getByTestId("p1").querySelector(".pc-panel__meta")?.textContent).toBe(
      "3 held",
    );
    expect(screen.getByTestId("body").textContent).toBe("rows");
  });

  it("shows honesty when phase is empty", () => {
    render(
      <Panel
        title="tasks"
        phase="empty"
        honestyKind="tasks"
        testId="p-empty"
        emptyAction={<button type="button">act</button>}
      />,
    );
    expect(screen.getByTestId("p-empty-honesty").textContent).toMatch(/No tasks/);
    expect(screen.getByText("act")).toBeTruthy();
  });
});

describe("CopyScaffold", () => {
  it("copies text and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<CopyScaffold text="parley delegate" testId="sc" />);
    fireEvent.click(screen.getByRole("button"));
    expect(writeText).toHaveBeenCalledWith("parley delegate");
    await vi.waitFor(() => {
      expect(screen.getByTestId("sc").textContent).toMatch(/copied/i);
    });
  });
});

describe("Field / Select", () => {
  it("Field is register-styled without appearance:auto", () => {
    render(
      <Field
        label="vendor"
        value="codex"
        onChange={() => undefined}
        testId="f-vendor"
      />,
    );
    const input = screen.getByTestId("f-vendor");
    expect(input.className).toContain("pc-field__control");
    expect(input.tagName).toBe("INPUT");
  });

  it("Select meets density floor class and has no appearance auto", () => {
    render(
      <Select
        label="session"
        value="all"
        onChange={() => undefined}
        testId="s-session"
        layout="inline"
      >
        <option value="all">all</option>
      </Select>,
    );
    const sel = screen.getByTestId("s-session");
    expect(sel.className).toContain("pc-select__control");
    expect(sel.tagName).toBe("SELECT");
  });
});
