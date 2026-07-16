/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HealthPanel } from "../src/hud/index.js";
import type { HealthView } from "../src/hud/index.js";

afterEach(cleanup);

const HEALTH: HealthView = {
  online: true,
  version: "0.0.0",
  pid: 4242,
  host: "127.0.0.1",
  port: "57123",
  uptime: "3m 41s",
  durableSessions: 1,
};

describe("HealthPanel renders daemon status from plain props (#65)", () => {
  it("shows daemon facts: status, version, pid, uptime, host/port, sessions", () => {
    render(<HealthPanel health={HEALTH} />);
    expect(screen.getByText("HEALTHY")).toBeTruthy();
    expect(screen.getByText("v0.0.0")).toBeTruthy();
    expect(screen.getByText("4242")).toBeTruthy();
    expect(screen.getByText("3m 41s")).toBeTruthy();
    expect(screen.getByText("57123")).toBeTruthy();
    expect(screen.getByText("127.0.0.1")).toBeTruthy();
    // Sessions is the one non-grid daemon count; fleet totals live on the roster.
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.queryByText("Total tasks")).toBeNull();
    expect(screen.queryByText("Active agents")).toBeNull();
  });

  it("reads OFFLINE when the daemon is unreachable", () => {
    render(<HealthPanel health={{ ...HEALTH, online: false }} />);
    expect(screen.getByText("OFFLINE")).toBeTruthy();
  });
});
