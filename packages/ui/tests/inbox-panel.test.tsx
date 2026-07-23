/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InboxPanel } from "../src/hud/index.js";
import type { InboxTask } from "../src/hud/index.js";

afterEach(cleanup);

const AWAITING_1: InboxTask = {
  id: "t1",
  name: "chart-the-bay",
  state: "awaiting_answer",
  coat: "#10a37f",
  emblem: { kind: "svg", viewBox: "0 0 24 24", path: "M12 2 L20 7 V17 L12 22 L4 17 V7 Z" },
  faction: "Codex",
  meta: "feat/bay · t1",
  question: "Should the survey favor the northern shoal?",
  updatedAt: "2026-07-23T12:00:00.000Z",
  sessionId: "sess-abcdef12",
  sessionHandle: "chart-the-bay",
  sessionShortRef: "sess-abc",
};

const AWAITING_2: InboxTask = {
  id: "t2",
  name: "sound-the-depths",
  state: "awaiting_answer",
  coat: "#2b2b2e",
  emblem: { kind: "svg", viewBox: "0 0 24 24", path: "M5 4 L19 20 M19 4 L5 20" },
  faction: "Grok",
  meta: "feat/depth · t2",
  question: "Deep or shallow anchorage?",
  updatedAt: "2026-07-23T10:00:00.000Z",
  sessionId: null,
  sessionHandle: null,
  sessionShortRef: null,
};

describe("InboxPanel display-only question cards (#78)", () => {
  it("renders one card per awaiting task with its question text", () => {
    const { container } = render(
      <InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={() => {}} />,
    );
    const names = [...container.querySelectorAll(".pc-inbox-card__name")].map((el) => el.textContent);
    expect(names).toEqual(["chart-the-bay", "sound-the-depths"]);
    expect(screen.getByText(AWAITING_1.question)).toBeTruthy();
    expect(screen.getByText(AWAITING_2.question)).toBeTruthy();
    expect(screen.getByText("feat/bay · t1")).toBeTruthy();
    // Session rope: humane handle + mono short ref.
    expect(container.querySelector(".pc-inbox-card__session-handle")?.textContent).toBe(
      "chart-the-bay",
    );
    expect(container.querySelector(".pc-inbox-card__session-ref")?.textContent).toMatch(/sess-abc/);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
  });

  it("uses phrasing content in the select button and shows a quiet relative age", () => {
    const updatedAt = new Date(Date.now() - 12 * 60_000).toISOString();
    const { container } = render(
      <InboxPanel
        tasks={[{ ...AWAITING_1, updatedAt }]}
        onSelectTask={() => {}}
      />,
    );
    const select = container.querySelector(".pc-inbox-card__select");
    expect(select?.querySelector(":scope > div, :scope > p")).toBeNull();
    const age = select?.querySelector("time.pc-inbox-card__age");
    expect(age?.textContent).toBe("12m");
    expect(age?.getAttribute("datetime")).toBe(updatedAt);
  });

  it("includes state in the card accessible name without a redundant AWAITING badge", () => {
    render(<InboxPanel tasks={[AWAITING_1]} onSelectTask={() => {}} />);
    // Plate header already announces NEEDS YOU · N — no per-card badge.
    expect(document.querySelector(".pc-inbox-card .pc-badge")).toBeNull();
    // State still rides in the select control's accessible name (state-meta).
    expect(screen.getByRole("button", { name: /AWAITING/ })).toBeTruthy();
  });

  it("labels each card emblem with its faction/vendor name", () => {
    render(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={() => {}} />);
    expect(screen.getByLabelText("Codex")).toBeTruthy();
    expect(screen.getByLabelText("Grok")).toBeTruthy();
  });

  it("sorts awaiting-first (hooks layer order is preserved, not re-sorted)", () => {
    const { container } = render(
      <InboxPanel tasks={[AWAITING_2, AWAITING_1]} onSelectTask={() => {}} />,
    );
    const names = [...container.querySelectorAll(".pc-inbox-card__name")].map((el) => el.textContent);
    expect(names).toEqual(["sound-the-depths", "chart-the-bay"]);
  });

  it("shows a NEEDS-YOU count pill matching the number of cards", () => {
    render(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={() => {}} />);
    // Count after the words so tiny type never scans as "I NEEDS YOU".
    expect(screen.getByText("NEEDS YOU · 2")).toBeTruthy();
    expect(screen.getByLabelText("2 tasks need you")).toBeTruthy();
  });

  it("adds a quiet fleet-wide qualifier only when a session filter is active", () => {
    const { rerender } = render(
      <InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={() => {}} />,
    );
    expect(screen.queryByText("fleet-wide")).toBeNull();
    expect(screen.getByLabelText("2 tasks need you")).toBeTruthy();
    expect(screen.getByText("the flags that need you")).toBeTruthy();

    rerender(
      <InboxPanel
        tasks={[AWAITING_1, AWAITING_2]}
        onSelectTask={() => {}}
        sessionFilterActive
      />,
    );
    expect(screen.getByText("fleet-wide")).toBeTruthy();
    expect(screen.getByLabelText("2 tasks need you, fleet-wide")).toBeTruthy();
    expect(screen.getByText("the flags that need you · fleet-wide")).toBeTruthy();
  });

  it("does not show fleet-wide in the empty state even with a session filter", () => {
    render(<InboxPanel tasks={[]} onSelectTask={() => {}} sessionFilterActive />);
    expect(screen.queryByText("fleet-wide")).toBeNull();
    expect(screen.getByText("the flags that need you")).toBeTruthy();
  });

  it("renders the manifest's empty-state copy with no cards, and no count pill", () => {
    render(<InboxPanel tasks={[]} onSelectTask={() => {}} />);
    expect(screen.getByText(/All hands accounted for\. No flags flying\./)).toBeTruthy();
    expect(screen.queryByText(/NEEDS YOU/)).toBeNull();
  });

  it("calls onSelectTask with the task id when a card is clicked", () => {
    const onSelectTask = vi.fn();
    const { container } = render(
      <InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={onSelectTask} />,
    );
    fireEvent.click(container.querySelector(".pc-inbox-card__name")!);
    expect(onSelectTask).toHaveBeenCalledWith("t1");
  });

  it("shows the orchestrator-session scope line when flags are flying", () => {
    render(<InboxPanel tasks={[AWAITING_1]} onSelectTask={() => {}} />);
    expect(
      screen.getByText(/Answer from your orchestrator session — the cove keeps watch\./),
    ).toBeTruthy();
  });

  it("places the scope caption above the card list (not on the clamp cut edge)", () => {
    const { container } = render(
      <InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={() => {}} />,
    );
    const scope = container.querySelector(".pc-inbox__scope");
    const list = container.querySelector(".pc-inbox__list");
    expect(scope).toBeTruthy();
    expect(list).toBeTruthy();
    // Scope must precede the list so the inspector-open max-height clamp
    // never paints the caption across a mid-card cut.
    expect(
      scope!.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("mounts a hidden-by-default scroll cue inside the list (chart-key pattern)", () => {
    const { container } = render(
      <InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={() => {}} />,
    );
    const cue = container.querySelector(".pc-inbox__scroll-cue");
    expect(cue).toBeTruthy();
    expect(cue?.classList.contains("pc-inbox__scroll-cue--hidden")).toBe(true);
    expect(container.querySelector(".pc-inbox__scroll-cue-label")?.textContent).toBe(
      "More below",
    );
    // Cue lives inside the scroll container so sticky bottom fade works.
    expect(container.querySelector(".pc-inbox__list .pc-inbox__scroll-cue")).toBeTruthy();
  });

  it("hides the scope line in the empty state", () => {
    render(<InboxPanel tasks={[]} onSelectTask={() => {}} />);
    expect(screen.queryByText(/orchestrator session/)).toBeNull();
  });

  it("renders task ref and session id on the card footer", () => {
    render(<InboxPanel tasks={[AWAITING_1]} onSelectTask={() => {}} />);
    expect(screen.getByText("t1")).toBeTruthy();
    expect(screen.getByText("sess-abc")).toBeTruthy();
  });
});

describe("InboxPanel announces attention count changes (aria-live)", () => {
  it("exposes a polite live region whose text tracks the needs-you count", () => {
    const { rerender } = render(<InboxPanel tasks={[]} onSelectTask={() => {}} />);
    const live = document.querySelector("[aria-live='polite']");
    expect(live).toBeTruthy();
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toBe("No tasks need you");

    rerender(<InboxPanel tasks={[AWAITING_1]} onSelectTask={() => {}} />);
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe("1 task needs you");

    rerender(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={() => {}} />);
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe("2 tasks need you");
  });

  it("does not use assertive politeness (calm, not spammy)", () => {
    render(<InboxPanel tasks={[AWAITING_1]} onSelectTask={() => {}} />);
    expect(document.querySelector("[aria-live='assertive']")).toBeNull();
    expect(document.querySelector("[aria-live='polite']")).toBeTruthy();
  });
});

describe("InboxCard copy answer scaffold", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("copies a parley answer scaffold and shows confirmation text", async () => {
    render(<InboxPanel tasks={[AWAITING_1]} onSelectTask={() => {}} />);
    const copyBtn = screen.getByRole("button", { name: /Copy answer command/i });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('parley answer t1 "..."');
    });
    expect(screen.getByText("copied ✓")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copied answer command/i })).toBeTruthy();
  });
});
