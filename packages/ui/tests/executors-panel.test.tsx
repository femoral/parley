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

  it("lists vendor ids only when present — no dead dash (#324 F3)", () => {
    const { container } = render(<ExecutorsPanel executors={FLEET} />);
    const local = container.querySelector('[data-testid="executor-card-local"]');
    expect(local?.textContent).toContain("fake, codex");
    expect(local?.textContent).toContain("Vendors");
    const gpu = container.querySelector('[data-testid="executor-card-gpu"]');
    expect(gpu?.textContent).toContain("fake");
  });

  it("omits the vendors row when the daemon card has no vendors (#324 F3)", () => {
    const fleet: ExecutorCardView[] = [
      {
        id: "local",
        label: "local",
        kind: "daemon",
        status: "online",
        vendors: [],
        inFlight: 0,
        lastSeen: null,
      },
      {
        id: "gpu",
        label: "gpu",
        kind: "runner",
        status: "online",
        vendors: ["fake"],
        inFlight: 0,
        lastSeen: null,
      },
    ];
    const { container } = render(<ExecutorsPanel executors={fleet} />);
    const local = container.querySelector('[data-testid="executor-card-local"]');
    expect(local?.textContent).not.toContain("Vendors");
    expect(local?.textContent).not.toMatch(/—/);
    const gpu = container.querySelector('[data-testid="executor-card-gpu"]');
    expect(gpu?.textContent).toContain("Vendors");
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

  /**
   * Neuter-proof: panel must consume stale prop. Reverting consumption so
   * only connecting is wired leaves ONLINE chips + "N online" subtitle → red.
   */
  it("presents probe-failure as stale presence, not live ONLINE (#324 F2)", () => {
    const staleFleet: ExecutorCardView[] = [
      {
        id: "local",
        label: "local",
        kind: "daemon",
        status: "online",
        vendors: [],
        inFlight: 1,
        lastSeen: null,
      },
      {
        id: "gpu",
        label: "gpu",
        kind: "runner",
        status: "stale",
        vendors: ["fake"],
        inFlight: 2,
        lastSeen: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "cpu",
        label: "cpu",
        kind: "runner",
        status: "stale",
        vendors: ["codex"],
        inFlight: 0,
        lastSeen: "2026-01-01T00:00:00.000Z",
      },
    ];
    const { container } = render(
      <ExecutorsPanel executors={staleFleet} stale />,
    );

    // Subtitle must not claim "2 online · 3 total" from last-known wire.
    expect(container.querySelector(".pc-plate-header__subtitle")?.textContent).toMatch(
      /presence may be stale/i,
    );
    expect(container.querySelector(".pc-plate-header__subtitle")?.textContent).not.toMatch(
      /online ·/,
    );

    // Runner chips STALE + dim; last-known in-flight retained.
    expect(screen.getAllByText("STALE").length).toBe(2);
    expect(
      container.querySelector('[data-testid="executor-card-gpu"]')?.className,
    ).toContain("pc-exec-card--dim");
    expect(
      container.querySelector('[data-testid="executor-card-gpu"]')?.getAttribute("data-status"),
    ).toBe("stale");
    expect(screen.getByTestId("executor-inflight-gpu").textContent).toContain("2 in flight");
    expect(container.querySelector(".pc-executors--stale")).toBeTruthy();
    expect(
      container.querySelector('[data-testid="executors-list"]')?.getAttribute("data-stale"),
    ).toBe("true");

    // One live region for the panel, not per card (#324 F5).
    const liveRegions = container.querySelectorAll('[role="status"]');
    expect(liveRegions.length).toBe(1);
    expect(liveRegions[0]?.getAttribute("data-testid")).toBe("executors-live");
    expect(liveRegions[0]?.textContent).toMatch(/stale/i);
  });
});

describe("RosterPanel task executor attribution (#324 F4)", () => {
  const multiGroups: RosterGroup[] = [
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
  const singleGroups: RosterGroup[] = [
    {
      state: "running",
      tasks: [
        {
          id: "t-only",
          name: "solo-local",
          coat: "#10a37f",
          emblem: { kind: "glyph", char: "C" },
          faction: "Codex",
          meta: "feat/solo · t-only",
          executor: null,
        },
      ],
    },
  ];
  const sessions: RosterSessionOption[] = [];

  it("names the executor on local and runner task rows when multi-executor", () => {
    render(
      <RosterPanel
        groups={multiGroups}
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
    expect(screen.getByRole("option", { name: /chart-local.*on local/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /chart-remote.*on gpu/i })).toBeTruthy();
  });

  it("hides executor line when projection omits it (zero-runner noise)", () => {
    render(
      <RosterPanel
        groups={singleGroups}
        sessions={sessions}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        searchSessions={vi.fn(async () => [])}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        totalTasks={1}
        activeTasks={1}
      />,
    );
    expect(screen.queryByTestId("task-executor-t-only")).toBeNull();
    expect(screen.getByRole("option", { name: /solo-local/i }).getAttribute("aria-label")).not.toMatch(
      /on local/i,
    );
  });
});
