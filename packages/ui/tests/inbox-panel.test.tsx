/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InboxPanel } from "../src/hud/index.js";
import type { InboxTask } from "../src/hud/index.js";

afterEach(cleanup);

const AWAITING_1: InboxTask = {
  id: "t1",
  name: "chart-the-bay",
  state: "awaiting_answer",
  coat: "#2f5fb0",
  emblem: "⚓",
  meta: "feat/bay · t1",
  question: "Should the survey favor the northern shoal?",
};

const AWAITING_2: InboxTask = {
  id: "t2",
  name: "sound-the-depths",
  state: "awaiting_answer",
  coat: "#c0392b",
  emblem: "⚔",
  meta: "feat/depth · t2",
  question: "Deep or shallow anchorage?",
};

function typeAnswer(taskName: string, text: string): void {
  const textarea = screen.getByLabelText(`Your answer for ${taskName}`);
  fireEvent.change(textarea, { target: { value: text } });
}

describe("InboxPanel renders question cards (#67)", () => {
  it("renders one card per awaiting task with its question in flavor type", () => {
    render(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} onAnswer={vi.fn()} />);
    expect(screen.getByText("chart-the-bay")).toBeTruthy();
    expect(screen.getByText(AWAITING_1.question)).toBeTruthy();
    expect(screen.getByText("sound-the-depths")).toBeTruthy();
    expect(screen.getByText(AWAITING_2.question)).toBeTruthy();
  });

  it("badges each card from the task's state via the shared state-meta lookup", () => {
    render(<InboxPanel tasks={[AWAITING_1]} onAnswer={vi.fn()} />);
    expect(screen.getAllByText("AWAITING")).toHaveLength(1);
  });

  it("sorts awaiting-first (hooks layer order is preserved, not re-sorted)", () => {
    render(<InboxPanel tasks={[AWAITING_2, AWAITING_1]} onAnswer={vi.fn()} />);
    const names = screen.getAllByText(/chart-the-bay|sound-the-depths/).map((el) => el.textContent);
    expect(names).toEqual(["sound-the-depths", "chart-the-bay"]);
  });

  it("shows a NEEDS-YOU count pill matching the number of cards", () => {
    render(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} onAnswer={vi.fn()} />);
    expect(screen.getByText("2 NEEDS YOU")).toBeTruthy();
  });

  it("renders the manifest's empty-state copy with no cards, and no count pill", () => {
    render(<InboxPanel tasks={[]} onAnswer={vi.fn()} />);
    expect(screen.getByText(/All hands accounted for\. No flags flying\./)).toBeTruthy();
    expect(screen.queryByText(/NEEDS YOU/)).toBeNull();
  });
});

describe("InboxPanel inline answer (#67)", () => {
  it("posts the typed answer and clears the input on success", async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<InboxPanel tasks={[AWAITING_1]} onAnswer={onAnswer} />);

    typeAnswer("chart-the-bay", "Favor the northern shoal.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    });

    expect(onAnswer).toHaveBeenCalledWith("t1", "Favor the northern shoal.");
    expect((screen.getByLabelText("Your answer for chart-the-bay") as HTMLTextAreaElement).value).toBe("");
  });

  it("disables send until there is non-whitespace text", () => {
    render(<InboxPanel tasks={[AWAITING_1]} onAnswer={vi.fn()} />);
    const send = screen.getByRole("button", { name: /Send/ });
    expect(send).toHaveProperty("disabled", true);
    typeAnswer("chart-the-bay", "   ");
    expect(send).toHaveProperty("disabled", true);
    typeAnswer("chart-the-bay", "  go north  ");
    expect(send).toHaveProperty("disabled", false);
  });

  it("surfaces an actionable error and keeps the card when the answer fails", async () => {
    const onAnswer = vi.fn().mockRejectedValue(new Error("daemon request failed with status 409"));
    render(<InboxPanel tasks={[AWAITING_1]} onAnswer={onAnswer} />);

    typeAnswer("chart-the-bay", "Favor the northern shoal.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    });

    expect(screen.getByRole("alert").textContent).toContain("daemon request failed with status 409");
    // The card stays — the question and the task's card are still rendered.
    expect(screen.getByText("chart-the-bay")).toBeTruthy();
    expect(screen.getByText(AWAITING_1.question)).toBeTruthy();
    // The draft is preserved so the human doesn't have to retype it.
    expect((screen.getByLabelText("Your answer for chart-the-bay") as HTMLTextAreaElement).value).toBe(
      "Favor the northern shoal.",
    );
  });

  it("falls back to a generic actionable message for a non-Error rejection", async () => {
    const onAnswer = vi.fn().mockRejectedValue("boom");
    render(<InboxPanel tasks={[AWAITING_1]} onAnswer={onAnswer} />);

    typeAnswer("chart-the-bay", "Favor the northern shoal.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    });

    expect(screen.getByRole("alert").textContent).toMatch(/didn't reach the ship/);
  });
});
