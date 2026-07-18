/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SoundingsPanel } from "../src/hud/index.js";
import type { SoundingsView } from "../src/hud/index.js";

afterEach(cleanup);

const GROUP: SoundingsView["groups"][number] = {
  key: "codex",
  label: "codex",
  tasks: { total: 5, done: 3, failed: 1, running: 1 },
  successRate: "75%",
  successRateValue: 0.75,
  evals: "4.2 · n=3",
  tokens: { input: "12.0k", output: "3.4k", cached: "1.0k" },
  duration: { avg: "2m 10s", p95: "5m 00s" },
  evalsBySize: [
    { key: "S", avg: "4.5 · n=2", count: 2 },
    { key: "M", avg: "3.6 · n=1", count: 1 },
  ],
  evalsByDifficulty: [{ key: "easy", avg: "4.2 · n=3", count: 3 }],
};

const EMPTY_FILTERS: SoundingsView["filters"] = {
  type: "",
  vendor: "",
  model: "",
  orch_harness: "",
  orch_model: "",
  eval_harness: "",
  eval_model: "",
  rubric: "",
  firstAttemptOnly: false,
  belowBaselineOnly: false,
  active: false,
};

function baseView(overrides: Partial<SoundingsView> = {}): SoundingsView {
  return {
    status: "ready",
    error: null,
    groups: [GROUP],
    distribution: [],
    comparison: [],
    groupBy: "vendor",
    sessionLabel: "All hands",
    generatedAt: "2026-07-16T00:00:00.000Z",
    filters: EMPTY_FILTERS,
    viewTab: "groups",
    evalPresence: "ready",
    ...overrides,
  };
}

function renderPanel(
  soundings: SoundingsView,
  handlers: {
    onGroupBy?: (g: string) => void;
    onFiltersChange?: () => void;
    onFiltersClear?: () => void;
    onViewTab?: () => void;
  } = {},
) {
  return render(
    <SoundingsPanel
      soundings={soundings}
      onGroupBy={handlers.onGroupBy ?? (() => {})}
      onFiltersChange={handlers.onFiltersChange ?? (() => {})}
      onFiltersClear={handlers.onFiltersClear ?? (() => {})}
      onViewTab={handlers.onViewTab ?? (() => {})}
    />,
  );
}

describe("SoundingsPanel (#119)", () => {
  it("renders group metrics from plain props", () => {
    renderPanel(baseView());
    expect(screen.getByText("SOUNDINGS")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    // Overall eval + difficulty chip share the same formatted average.
    expect(screen.getAllByText("4.2 · n=3").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("12.0k")).toBeTruthy();
    expect(screen.getByText("2m 10s")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    // Breakdowns only when present.
    expect(screen.getByLabelText("Eval by size")).toBeTruthy();
    expect(screen.getByText("S")).toBeTruthy();
    expect(screen.getByLabelText("Eval by difficulty")).toBeTruthy();
    expect(screen.getByText("easy")).toBeTruthy();
    expect(screen.getByText("All hands")).toBeTruthy();
  });

  it("shows taking-soundings loading state with no groups yet", () => {
    renderPanel(baseView({ status: "loading", groups: [], generatedAt: null }));
    expect(screen.getByText("Taking soundings…")).toBeTruthy();
    expect(screen.getByText("listening for the fleet")).toBeTruthy();
  });

  it("shows empty hint when ready with no groups", () => {
    renderPanel(baseView({ status: "empty", groups: [], evalPresence: "empty" }));
    expect(screen.getByText("No tasks yet")).toBeTruthy();
    expect(screen.getByText(/Delegate a voyage/)).toBeTruthy();
  });

  it("shows error state when fetch failed with no prior data", () => {
    renderPanel(
      baseView({
        status: "error",
        groups: [],
        error: "daemon offline",
      }),
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Soundings failed")).toBeTruthy();
    expect(screen.getByText("daemon offline")).toBeTruthy();
  });

  it("keeps groups and banners error when revalidation fails", () => {
    renderPanel(
      baseView({
        status: "error",
        error: "stream blip",
      }),
    );
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText(/Chart may be stale/)).toBeTruthy();
    expect(screen.getByText(/stream blip/)).toBeTruthy();
  });

  it("omits size/difficulty breakdowns when empty", () => {
    renderPanel(
      baseView({
        groups: [{ ...GROUP, evalsBySize: [], evalsByDifficulty: [] }],
      }),
    );
    expect(screen.queryByLabelText("Eval by size")).toBeNull();
    expect(screen.queryByLabelText("Eval by difficulty")).toBeNull();
  });

  it("fires onGroupBy when a group-by chip is pressed", () => {
    const onGroupBy = vi.fn();
    renderPanel(baseView(), { onGroupBy });
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(onGroupBy).toHaveBeenCalledWith("model");
    fireEvent.click(screen.getByRole("button", { name: "Difficulty" }));
    expect(onGroupBy).toHaveBeenCalledWith("difficulty");
  });

  it("marks the active group-by chip as pressed", () => {
    renderPanel(baseView({ groupBy: "profile" }));
    expect(screen.getByRole("button", { name: "Profile" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Vendor" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});
