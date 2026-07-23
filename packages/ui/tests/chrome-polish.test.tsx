/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DayChip } from "../src/hud/DayChip.js";
import {
  EDGE_ALERT_STACK_CAP,
  EdgeAlerts,
  type EdgeAlertItem,
} from "../src/scene/EdgeAlerts.js";

afterEach(cleanup);

describe("cockpit chrome polish", () => {
  it("exposes edge-alert overflow through a reliable semantic role", () => {
    const items: EdgeAlertItem[] = Array.from(
      { length: EDGE_ALERT_STACK_CAP + 2 },
      (_, index) => ({
        sessionId: `session-${index}`,
        label: `Fleet ${index}`,
        state: "running",
        count: 1,
        rank: index,
        side: "left",
        quiet: true,
      }),
    );

    render(<EdgeAlerts items={items} onSelectSession={() => undefined} />);

    expect(
      screen.getByRole("img", { name: "2 more sessions to the left" })
        .textContent,
    ).toBe("+2");
  });

  it("renders day and wind numerals in dedicated mono data tokens", () => {
    const { container } = render(
      <DayChip day={8} daemonUptimeDays={2} clock="14:32" />,
    );

    expect(container.querySelector(".pc-daychip__day-number")?.textContent).toBe(
      "8",
    );
    expect(screen.getByTitle("Daemon up 2 days")).toBeTruthy();
    expect(
      container.querySelector(".pc-daychip__wind-speed")?.textContent,
    ).toMatch(/^\d+kn$/);
  });
});
