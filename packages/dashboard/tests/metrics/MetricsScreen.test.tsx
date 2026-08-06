/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsScreen } from "../../src/screens/metrics/MetricsScreen.js";
import { mockClient, populatedMetrics, populatedRunMetrics, emptyMetrics } from "./fixtures.js";

vi.mock("@useparley/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@useparley/core")>();
  return {
    ...actual,
    ParleyClient: vi.fn(),
  };
});

import { ParleyClient } from "@useparley/core";

const mountProps = {
  screen: "metrics" as const,
  navigate: () => undefined,
  selectedTaskId: null,
  setSelectedTaskId: () => undefined,
  selectedRunId: null,
  setSelectedRunId: () => undefined,
};

function installClient(impl: ReturnType<typeof mockClient>) {
  vi.mocked(ParleyClient).mockImplementation(() => impl as unknown as ParleyClient);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MetricsScreen", () => {
  it("renders empty honesty when metrics have no groups (eval-off default)", async () => {
    installClient(mockClient({ metrics: emptyMetrics() }));
    render(<MetricsScreen {...mountProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("metrics-table-empty")).toBeTruthy();
    });
    expect(screen.getByTestId("metrics-dist-empty")).toBeTruthy();
    expect(screen.getByTestId("metrics-heat-empty")).toBeTruthy();
    expect(screen.getByTestId("metrics-session-scope")).toBeTruthy();
    expect(screen.getByTestId("metrics-filter-bar")).toBeTruthy();
  });

  it("renders group table, distribution, and heatmap from populated metrics", async () => {
    installClient(mockClient({ metrics: populatedMetrics() }));
    render(<MetricsScreen {...mountProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("metrics-table")).toBeTruthy();
    });
    expect(screen.getAllByTestId("metrics-table-row").length).toBe(3);
    expect(screen.getByTestId("metrics-dist-plot")).toBeTruthy();
    expect(screen.getByTestId("metrics-dist-axis")).toBeTruthy();
    expect(screen.getByTestId("metrics-dist-a11y")).toBeTruthy();
    expect(screen.getByTestId("metrics-heat-grid")).toBeTruthy();
    expect(screen.getByTestId("metrics-heat-a11y")).toBeTruthy();
    expect(screen.getByTestId("metrics-heat-legend")).toBeTruthy();
    expect(screen.getByTestId("metrics-buckets")).toBeTruthy();
  });

  it("switches to workflow tab and shows cost-per-completed-run", async () => {
    installClient(
      mockClient({
        metrics: emptyMetrics(),
        runMetrics: populatedRunMetrics(),
      }),
    );
    render(<MetricsScreen {...mountProps} />);
    fireEvent.click(screen.getByTestId("metrics-dim-workflow"));
    await waitFor(() => {
      expect(screen.getByTestId("metrics-table")).toBeTruthy();
    });
    expect(screen.getByText("cost / done")).toBeTruthy();
    expect(screen.getAllByText("coding-1@3").length).toBeGreaterThan(0);
  });

  it("session is a scope select, not a group_by tab", async () => {
    installClient(mockClient({ metrics: emptyMetrics() }));
    render(<MetricsScreen {...mountProps} />);
    await waitFor(() => expect(screen.getByTestId("metrics-session-select")).toBeTruthy());
    expect(screen.queryByTestId("metrics-dim-session")).toBeNull();
    const tabs = screen.getByTestId("metrics-dim-tabs");
    expect(tabs.textContent).not.toMatch(/\bsession\b/);
  });

  it("comparison view shows first-attempt vs fix split", async () => {
    installClient(mockClient({ metrics: populatedMetrics() }));
    render(<MetricsScreen {...mountProps} />);
    await waitFor(() => expect(screen.getByTestId("metrics-table")).toBeTruthy());
    fireEvent.click(screen.getByTestId("metrics-view-comparison"));
    await waitFor(() => expect(screen.getByTestId("metrics-compare-body")).toBeTruthy());
    expect(screen.getByText("first attempt")).toBeTruthy();
    expect(screen.getByText("fix")).toBeTruthy();
  });

  it("shows error honesty when metrics fetch fails", async () => {
    installClient(mockClient({ metricsError: "daemon down" }));
    render(<MetricsScreen {...mountProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("metrics-error-banner")).toBeTruthy();
    });
    expect(screen.getByTestId("metrics-table-error")).toBeTruthy();
  });

  it("filter clear is disabled until a filter is set", async () => {
    installClient(mockClient({ metrics: populatedMetrics() }));
    render(<MetricsScreen {...mountProps} />);
    await waitFor(() => expect(screen.getByTestId("metrics-filter-clear")).toBeTruthy());
    const clear = screen.getByTestId("metrics-filter-clear") as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("metrics-filter-vendor"), {
      target: { value: "fake" },
    });
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    expect((screen.getByTestId("metrics-filter-vendor") as HTMLInputElement).value).toBe("");
  });
});
