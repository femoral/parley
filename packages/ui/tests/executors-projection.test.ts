import { describe, expect, it } from "vitest";
import type { RunnerListEntry } from "@useparley/core";
import {
  countInFlightByExecutor,
  executorIdForRunner,
  executorStatusLabel,
  formatExecutorLabel,
  LOCAL_EXECUTOR_ID,
  projectExecutors,
} from "../src/app/hooks/executors.js";
import { projectRoster, type RosterTaskInput } from "../src/app/hooks/roster.js";

function runner(
  overrides: Partial<RunnerListEntry> & Pick<RunnerListEntry, "name">,
): RunnerListEntry {
  return {
    status: "online",
    vendors: ["fake"],
    last_seen: "2026-01-01T00:00:00.000Z",
    registered_at: "2026-01-01T00:00:00.000Z",
    protocol_version: 1,
    build_version: "0.0.0",
    ...overrides,
  };
}

function task(
  overrides: Partial<RosterTaskInput> & Pick<RosterTaskInput, "id" | "state">,
): RosterTaskInput {
  return {
    name: overrides.id,
    vendor: "fake",
    branch: "feat/x",
    orchestratorSession: null,
    question: null,
    updatedAt: null,
    completedAt: null,
    runner: null,
    ...overrides,
  };
}

describe("executorIdForRunner / formatExecutorLabel (#324)", () => {
  it("maps null/undefined/empty runner to local (daemon)", () => {
    expect(executorIdForRunner(null)).toBe(LOCAL_EXECUTOR_ID);
    expect(executorIdForRunner(undefined)).toBe(LOCAL_EXECUTOR_ID);
    expect(executorIdForRunner("")).toBe(LOCAL_EXECUTOR_ID);
  });

  it("hides local attribution when not multi-executor (#324 F4)", () => {
    expect(formatExecutorLabel(null)).toBeNull();
    expect(formatExecutorLabel(undefined)).toBeNull();
    expect(formatExecutorLabel(null, { multiExecutor: false })).toBeNull();
  });

  it("names local when multi-executor (#324 F4)", () => {
    expect(formatExecutorLabel(null, { multiExecutor: true })).toBe("local");
  });

  it("always names non-local runners (#324 F4)", () => {
    expect(executorIdForRunner("gpu")).toBe("gpu");
    expect(formatExecutorLabel("gpu.west")).toBe("gpu.west");
    expect(formatExecutorLabel("gpu", { multiExecutor: false })).toBe("gpu");
  });
});

describe("countInFlightByExecutor (#324)", () => {
  it("counts only running tasks, null runner → local", () => {
    const counts = countInFlightByExecutor([
      { state: "running", runner: null },
      { state: "running", runner: null },
      { state: "running", runner: "gpu" },
      { state: "pending", runner: null },
      { state: "awaiting_answer", runner: "gpu" },
      { state: "completed", runner: "gpu" },
    ]);
    expect(counts.get("local")).toBe(2);
    expect(counts.get("gpu")).toBe(1);
    expect(counts.size).toBe(2);
  });

  it("returns empty map when nothing is running", () => {
    expect(countInFlightByExecutor([{ state: "pending", runner: "gpu" }]).size).toBe(0);
  });
});

describe("projectExecutors (#324)", () => {
  it("always includes the daemon card first, even with no runners", () => {
    const cards = projectExecutors({
      runners: [],
      tasks: [],
      daemonOnline: true,
      daemonVendors: ["fake", "codex"],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "local",
      kind: "daemon",
      status: "online",
      vendors: ["fake", "codex"],
      inFlight: 0,
      lastSeen: null,
    });
  });

  it("lists runners after the daemon with status, vendors, and in-flight", () => {
    const cards = projectExecutors({
      runners: [
        runner({ name: "gpu", status: "online", vendors: ["fake"] }),
        runner({ name: "cpu", status: "offline", vendors: ["codex"] }),
      ],
      tasks: [
        task({ id: "t1", state: "running", runner: null }),
        task({ id: "t2", state: "running", runner: "gpu" }),
        task({ id: "t3", state: "running", runner: "gpu" }),
      ],
      daemonOnline: true,
    });
    expect(cards.map((c) => c.id)).toEqual(["local", "gpu", "cpu"]);
    expect(cards[0]!.inFlight).toBe(1);
    expect(cards[1]!.inFlight).toBe(2);
    expect(cards[1]!.status).toBe("online");
    expect(cards[2]!.status).toBe("offline");
    expect(cards[2]!.inFlight).toBe(0);
    expect(cards[2]!.vendors).toEqual(["codex"]);
  });

  it("marks the daemon offline when health is down", () => {
    const cards = projectExecutors({
      runners: [runner({ name: "gpu" })],
      tasks: [],
      daemonOnline: false,
    });
    expect(cards[0]!.status).toBe("offline");
    // Runner status is independent of daemon health probe.
    expect(cards[1]!.status).toBe("online");
  });

  it("surfaces connecting on the daemon card only while first poll + offline", () => {
    const cards = projectExecutors({
      runners: [],
      tasks: [],
      daemonOnline: false,
      connecting: true,
    });
    expect(cards[0]!.status).toBe("connecting");
  });

  it("preserves wire runner status including stale", () => {
    const cards = projectExecutors({
      runners: [runner({ name: "old", status: "stale" })],
      tasks: [],
      daemonOnline: true,
    });
    expect(cards[1]!.status).toBe("stale");
    expect(executorStatusLabel("stale")).toBe("STALE");
    expect(executorStatusLabel("online")).toBe("ONLINE");
  });

  /**
   * Neuter-proof: if useCockpit stops passing runnersProbe / only checks
   * connecting, this reds — last-known ONLINE must not survive a dead poll.
   */
  it("forces runner cards stale when runners probe is offline (#324 F2)", () => {
    const cards = projectExecutors({
      runners: [
        runner({ name: "gpu", status: "online", vendors: ["fake"] }),
        runner({ name: "cpu", status: "online", vendors: ["codex"] }),
      ],
      tasks: [
        task({ id: "t1", state: "running", runner: "gpu" }),
        task({ id: "t2", state: "running", runner: null }),
      ],
      daemonOnline: true,
      runnersProbe: "offline",
    });
    // Daemon still follows health (probe is runners-only).
    expect(cards[0]!.status).toBe("online");
    expect(cards[0]!.inFlight).toBe(1);
    // Last-known shape retained, presence forced stale — not ONLINE.
    expect(cards[1]!.status).toBe("stale");
    expect(cards[1]!.vendors).toEqual(["fake"]);
    expect(cards[1]!.inFlight).toBe(1);
    expect(cards[2]!.status).toBe("stale");
    expect(cards.every((c) => c.kind === "runner" ? c.status === "stale" : true)).toBe(
      true,
    );
    // Online count for subtitle math must not count forced-stale runners.
    const onlineCount = cards.filter((e) => e.status === "online").length;
    expect(onlineCount).toBe(1); // daemon only
  });

  it("does not force stale when runners probe is online", () => {
    const cards = projectExecutors({
      runners: [runner({ name: "gpu", status: "online" })],
      tasks: [],
      daemonOnline: true,
      runnersProbe: "online",
    });
    expect(cards[1]!.status).toBe("online");
  });
});

describe("roster task executor attribution (#324 F4)", () => {
  it("hides local attribution in a zero-runner (single-executor) fleet", () => {
    const { groups } = projectRoster([
      task({ id: "local-task", state: "running", runner: null }),
      task({ id: "remote-task", state: "running", runner: "gpu" }),
    ]);
    const running = groups.find((g) => g.state === "running");
    expect(running).toBeTruthy();
    const byId = Object.fromEntries(running!.tasks.map((t) => [t.id, t.executor]));
    // Local is noise when multiExecutor is off.
    expect(byId["local-task"]).toBeNull();
    // Non-local always names the host.
    expect(byId["remote-task"]).toBe("gpu");
  });

  it("names local and runner when multiExecutor is true", () => {
    const { groups } = projectRoster(
      [
        task({ id: "local-task", state: "running", runner: null }),
        task({ id: "remote-task", state: "running", runner: "gpu" }),
      ],
      null,
      null,
      [],
      { multiExecutor: true },
    );
    const running = groups.find((g) => g.state === "running");
    const byId = Object.fromEntries(running!.tasks.map((t) => [t.id, t.executor]));
    expect(byId["local-task"]).toBe("local");
    expect(byId["remote-task"]).toBe("gpu");
  });
});
