/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InboxPanel } from "../src/hud/index.js";
import type { InboxTask } from "../src/hud/index.js";

afterEach(cleanup);

const AWAITING_1: InboxTask = {
  id: "t1",
  name: "chart-the-bay",
  state: "awaiting_answer",
  coat: "#10a37f",
  emblem: { kind: "svg", viewBox: "0 0 24 24", path: "M12 2 L20 7 V17 L12 22 L4 17 V7 Z" },
  meta: "feat/bay · t1",
  question: "Should the survey favor the northern shoal?",
};

const AWAITING_2: InboxTask = {
  id: "t2",
  name: "sound-the-depths",
  state: "awaiting_answer",
  coat: "#2b2b2e",
  emblem: { kind: "svg", viewBox: "0 0 24 24", path: "M5 4 L19 20 M19 4 L5 20" },
  meta: "feat/depth · t2",
  question: "Deep or shallow anchorage?",
};

describe("InboxPanel display-only question cards (#78)", () => {
  it("renders one card per awaiting task with its question text", () => {
    render(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} />);
    expect(screen.getByText("chart-the-bay")).toBeTruthy();
    expect(screen.getByText(AWAITING_1.question)).toBeTruthy();
    expect(screen.getByText("sound-the-depths")).toBeTruthy();
    expect(screen.getByText(AWAITING_2.question)).toBeTruthy();
    expect(screen.getByText("feat/bay · t1")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
  });

  it("badges each card from the task's state via the shared state-meta lookup", () => {
    render(<InboxPanel tasks={[AWAITING_1]} />);
    expect(screen.getAllByText("AWAITING")).toHaveLength(1);
  });

  it("sorts awaiting-first (hooks layer order is preserved, not re-sorted)", () => {
    render(<InboxPanel tasks={[AWAITING_2, AWAITING_1]} />);
    const names = screen.getAllByText(/chart-the-bay|sound-the-depths/).map((el) => el.textContent);
    expect(names).toEqual(["sound-the-depths", "chart-the-bay"]);
  });

  it("shows a NEEDS-YOU count pill matching the number of cards", () => {
    render(<InboxPanel tasks={[AWAITING_1, AWAITING_2]} />);
    expect(screen.getByText("2 NEEDS YOU")).toBeTruthy();
  });

  it("renders the manifest's empty-state copy with no cards, and no count pill", () => {
    render(<InboxPanel tasks={[]} />);
    expect(screen.getByText(/All hands accounted for\. No flags flying\./)).toBeTruthy();
    expect(screen.queryByText(/NEEDS YOU/)).toBeNull();
  });
});
