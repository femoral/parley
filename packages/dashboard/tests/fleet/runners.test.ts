import { describe, expect, it } from "vitest";
import {
  normalizeRunnerStatus,
  runnerStatusClass,
  runnerStatusLabel,
  runnerView,
} from "../../src/screens/fleet/runners.js";
import { runner } from "./fixtures.js";

describe("runner status mapping (#315 frozen-ONLINE guard)", () => {
  it("maps online/stale/offline to distinct class suffixes and labels", () => {
    expect(normalizeRunnerStatus("online")).toBe("online");
    expect(normalizeRunnerStatus("stale")).toBe("stale");
    expect(normalizeRunnerStatus("offline")).toBe("offline");

    expect(runnerStatusClass("online")).toBe("pc-fleet-runner__status--online");
    expect(runnerStatusClass("stale")).toBe("pc-fleet-runner__status--stale");
    expect(runnerStatusClass("offline")).toBe("pc-fleet-runner__status--offline");

    expect(runnerStatusLabel("online")).toBe("online");
    expect(runnerStatusLabel("stale")).toBe("stale");
    expect(runnerStatusLabel("offline")).toBe("offline");
  });

  it("never invents online for unknown status", () => {
    expect(normalizeRunnerStatus("weird")).toBe("offline");
    expect(runnerStatusClass(undefined)).toBe("pc-fleet-runner__status--offline");
    expect(runnerStatusClass(null)).toBe("pc-fleet-runner__status--offline");
  });

  it("runnerView preserves status class+label pair (neuter-proof)", () => {
    const online = runnerView(runner({ name: "a", status: "online" }));
    const stale = runnerView(runner({ name: "b", status: "stale" }));
    const offline = runnerView(runner({ name: "c", status: "offline" }));

    expect(online.statusClass).toContain("--online");
    expect(online.statusLabel).toBe("online");
    expect(stale.statusClass).toContain("--stale");
    expect(stale.statusLabel).toBe("stale");
    expect(offline.statusClass).toContain("--offline");
    expect(offline.statusLabel).toBe("offline");

    // Neuter: if class were hard-coded --online, all three would match online.
    expect(stale.statusClass).not.toBe(online.statusClass);
    expect(offline.statusClass).not.toBe(online.statusClass);
    expect(new Set([online.statusClass, stale.statusClass, offline.statusClass]).size).toBe(3);
  });
});
