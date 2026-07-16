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
  sessionId: "sess-abcdef12",
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
  sessionId: null,
};

describe("InboxPanel display-only question cards (#78)", () => {
  it("renders one card per awaiting task with its question text", () => {
    render(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={() => {}} />);
    expect(screen.getByText("chart-the-bay")).toBeTruthy();
    expect(screen.getByText(AWAITING_1.question)).toBeTruthy();
    expect(screen.getByText("sound-the-depths")).toBeTruthy();
    expect(screen.getByText(AWAITING_2.question)).toBeTruthy();
    expect(screen.getByText("feat/bay · t1")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
  });

  it("badges each card from the task's state via the shared state-meta lookup", () => {
    render(<InboxPanel tasks={[AWAITING_1]} onSelectTask={() => {}} />);
    expect(screen.getAllByText("AWAITING")).toHaveLength(1);
  });

  it("labels each card emblem with its faction/vendor name", () => {
    render(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={() => {}} />);
    expect(screen.getByLabelText("Codex")).toBeTruthy();
    expect(screen.getByLabelText("Grok")).toBeTruthy();
  });

  it("sorts awaiting-first (hooks layer order is preserved, not re-sorted)", () => {
    render(<InboxPanel tasks={[AWAITING_2, AWAITING_1]} onSelectTask={() => {}} />);
    const names = screen.getAllByText(/chart-the-bay|sound-the-depths/).map((el) => el.textContent);
    expect(names).toEqual(["sound-the-depths", "chart-the-bay"]);
  });

  it("shows a NEEDS-YOU count pill matching the number of cards", () => {
    render(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={() => {}} />);
    expect(screen.getByText("2 NEEDS YOU")).toBeTruthy();
  });

  it("renders the manifest's empty-state copy with no cards, and no count pill", () => {
    render(<InboxPanel tasks={[]} onSelectTask={() => {}} />);
    expect(screen.getByText(/All hands accounted for\. No flags flying\./)).toBeTruthy();
    expect(screen.queryByText(/NEEDS YOU/)).toBeNull();
  });

  it("calls onSelectTask with the task id when a card is clicked", () => {
    const onSelectTask = vi.fn();
    render(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} onSelectTask={onSelectTask} />);
    fireEvent.click(screen.getByText("chart-the-bay"));
    expect(onSelectTask).toHaveBeenCalledWith("t1");
  });

  it("shows the orchestrator-session scope line when flags are flying", () => {
    render(<InboxPanel tasks={[AWAITING_1]} onSelectTask={() => {}} />);
    expect(
      screen.getByText(/Answer from your orchestrator session — the cove keeps watch\./),
    ).toBeTruthy();
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
