/** @vitest-environment happy-dom */
/**
 * Shared Console component layer (#367) — Panel, StateChip, CopyScaffold, Field/Select.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttentionCard,
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

describe("AttentionCard", () => {
  it("renders card shape: badge, age, title, reason, meta, state left rule", () => {
    const { container } = render(
      <AttentionCard
        state="awaiting_answer"
        age="12m"
        title="needs-answer"
        reason="Ship it?"
        meta="feat/x · fake"
        testId="attn-1"
      />,
    );
    const card = screen.getByTestId("attn-1");
    expect(card.className).toContain("pc-attn--card");
    expect(card.className).toContain("pc-attn--awaiting_answer");
    expect(card.getAttribute("data-state")).toBe("awaiting_answer");
    expect(card.textContent).toMatch(/AWAITING/);
    expect(card.textContent).toMatch(/12m/);
    expect(card.textContent).toMatch(/needs-answer/);
    expect(card.textContent).toMatch(/Ship it\?/);
    expect(card.textContent).toMatch(/feat\/x/);
    expect(container.querySelector(".pc-attn__title")).toBeTruthy();
  });

  it("rows variant is a single-line class", () => {
    render(
      <AttentionCard
        state="failed"
        age="3m"
        title="blew-up"
        reason="boom"
        variant="rows"
        testId="attn-row"
      />,
    );
    expect(screen.getByTestId("attn-row").getAttribute("data-variant")).toBe("rows");
    expect(screen.getByTestId("attn-row").className).toContain("pc-attn--rows");
  });

  it("invokes onSelect from click and keyboard", () => {
    const onSelect = vi.fn();
    render(
      <AttentionCard
        state="stalled"
        age="1h"
        title="stuck"
        onSelect={onSelect}
        testId="attn-click"
      />,
    );
    fireEvent.click(screen.getByTestId("attn-click"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId("attn-click"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("interactive uses div role=button (not article); static uses article", () => {
    const { rerender } = render(
      <AttentionCard
        state="awaiting_answer"
        age="1m"
        title="static"
        testId="attn-tag"
      />,
    );
    expect(screen.getByTestId("attn-tag").tagName).toBe("ARTICLE");
    expect(screen.getByTestId("attn-tag").getAttribute("role")).toBeNull();

    rerender(
      <AttentionCard
        state="awaiting_answer"
        age="1m"
        title="clickable"
        onSelect={() => undefined}
        testId="attn-tag"
      />,
    );
    const el = screen.getByTestId("attn-tag");
    expect(el.tagName).toBe("DIV");
    expect(el.getAttribute("role")).toBe("button");
    expect(el.getAttribute("tabindex")).toBe("0");
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
