/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ExecutorsPanel } from "../src/hud/index.js";
import type { ExecutorCardView } from "../src/app/hooks/executors.js";
import { RosterPanel } from "../src/hud/index.js";
import type { RosterGroup, RosterSessionOption } from "../src/hud/index.js";
import { vi } from "vitest";

afterEach(cleanup);

const FLEET: ExecutorCardView[] = [
  {
    id: "local",
    label: "local",
    kind: "daemon",
    status: "online",
    vendors: ["fake", "codex"],
    inFlight: 1,
    lastSeen: null,
  },
  {
    id: "gpu",
    label: "gpu",
    kind: "runner",
    status: "online",
    vendors: ["fake"],
    inFlight: 2,
    lastSeen: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "cpu",
    label: "cpu",
    kind: "runner",
    status: "offline",
    vendors: ["codex"],
    inFlight: 0,
    lastSeen: "2026-01-01T00:00:00.000Z",
  },
];

describe("ExecutorsPanel renders fleet from plain props (#324)", () => {
  it("shows daemon + runners with status chips and in-flight counts", () => {
    render(<ExecutorsPanel executors={FLEET} />);
    expect(screen.getByText("EXECUTORS")).toBeTruthy();
    expect(screen.getByTestId("executor-card-local")).toBeTruthy();
    expect(screen.getByTestId("executor-card-gpu")).toBeTruthy();
    expect(screen.getByTestId("executor-card-cpu")).toBeTruthy();
    expect(screen.getByTestId("executor-inflight-local").textContent).toContain("1 in flight");
    expect(screen.getByTestId("executor-inflight-gpu").textContent).toContain("2 in flight");
    expect(screen.getByTestId("executor-inflight-cpu").textContent).toContain("0 in flight");
    // Status chips
    expect(screen.getAllByText("ONLINE").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("OFFLINE")).toBeTruthy();
    // Kind labels
    expect(screen.getByText("daemon")).toBeTruthy();
    expect(screen.getAllByText("runner").length).toBe(2);
  });

  it("lists vendor ids on each card", () => {
    const { container } = render(<ExecutorsPanel executors={FLEET} />);
    const local = container.querySelector('[data-testid="executor-card-local"]');
    expect(local?.textContent).toContain("fake, codex");
    const gpu = container.querySelector('[data-testid="executor-card-gpu"]');
    expect(gpu?.textContent).toContain("fake");
  });

  it("shows sounding subtitle while connecting", () => {
    render(
      <ExecutorsPanel
        executors={[
          {
            id: "local",
            label: "local",
            kind: "daemon",
            status: "connecting",
            vendors: [],
            inFlight: 0,
            lastSeen: null,
          },
        ]}
        connecting
      />,
    );
    expect(screen.getByText("sounding the fleet…")).toBeTruthy();
    expect(screen.getByText("HAILING…")).toBeTruthy();
  });

  it("marks offline cards with dim treatment", () => {
    const { container } = render(<ExecutorsPanel executors={FLEET} />);
    expect(
      container.querySelector('[data-testid="executor-card-cpu"]')?.className,
    ).toContain("pc-exec-card--dim");
    expect(
      container.querySelector('[data-testid="executor-card-local"]')?.className,
    ).not.toContain("pc-exec-card--dim");
  });
});

describe("RosterPanel task executor attribution (#324)", () => {
  const groups: RosterGroup[] = [
    {
      state: "running",
      tasks: [
        {
          id: "t-local",
          name: "chart-local",
          coat: "#10a37f",
          emblem: { kind: "glyph", char: "C" },
          faction: "Codex",
          meta: "feat/local · t-local",
          executor: "local",
        },
        {
          id: "t-gpu",
          name: "chart-remote",
          coat: "#2b2b2e",
          emblem: { kind: "glyph", char: "G" },
          faction: "Grok",
          meta: "feat/remote · t-gpu",
          executor: "gpu",
        },
      ],
    },
  ];
  const sessions: RosterSessionOption[] = [];

  it("names the executor on local and runner task rows", () => {
    render(
      <RosterPanel
        groups={groups}
        sessions={sessions}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        searchSessions={vi.fn(async () => [])}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        totalTasks={2}
        activeTasks={2}
      />,
    );
    expect(screen.getByTestId("task-executor-t-local").textContent).toBe("local");
    expect(screen.getByTestId("task-executor-t-gpu").textContent).toBe("gpu");
    // Accessible name carries executor attribution.
    expect(screen.getByRole("option", { name: /chart-local.*on local/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /chart-remote.*on gpu/i })).toBeTruthy();
  });
});
