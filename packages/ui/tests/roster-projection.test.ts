import { afterEach, describe, expect, it } from "vitest";
import {
  advanceFailedObservations,
  displayAttentionRank,
  FAILED_FRESHNESS_MS,
  isFreshFailure,
  projectRoster,
  RECENT_SESSION_CHIP_CAP,
  resetStickySessionHandles,
  terminalTransitionMs,
  type FailedFreshness,
  type RosterTaskInput,
} from "../src/app/hooks/roster.js";

afterEach(() => {
  resetStickySessionHandles();
});

function task(overrides: Partial<RosterTaskInput> & Pick<RosterTaskInput, "id" | "state">): RosterTaskInput {
  return {
    name: overrides.id,
    vendor: "codex",
    branch: "feat/x",
    orchestratorSession: null,
    question: null,
    updatedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** ISO for epoch-ms relative to a fixed `now` (freshness tests). */
function isoAt(now: number, offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

function freshness(
  overrides: Partial<FailedFreshness> & Pick<FailedFreshness, "now">,
): FailedFreshness {
  return {
    observedAt: overrides.observedAt ?? new Map(),
    acknowledged: overrides.acknowledged ?? new Set(),
    selectedTaskId: overrides.selectedTaskId,
    now: overrides.now,
  };
}

describe("projectRoster groups by state in attention order (#66)", () => {
  it("orders groups awaiting > stalled > running > pending > completed > failed > cancelled", () => {
    const { groups } = projectRoster([
      task({ id: "c", state: "cancelled" }),
      task({ id: "p", state: "pending" }),
      task({ id: "r", state: "running" }),
      task({ id: "a", state: "awaiting_answer" }),
      task({ id: "s", state: "stalled" }),
      task({ id: "f", state: "failed" }),
      task({ id: "k", state: "completed" }),
    ]);
    expect(groups.map((g) => g.state)).toEqual([
      "awaiting_answer",
      "stalled",
      "running",
      "pending",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("drops groups with no tasks", () => {
    const { groups } = projectRoster([task({ id: "r", state: "running" })]);
    expect(groups).toEqual([{ state: "running", tasks: expect.any(Array) }]);
  });

  it("re-sorts as a task's state changes (the SSE re-sort case)", () => {
    const tasks = new Map<string, RosterTaskInput>();
    tasks.set("t1", task({ id: "t1", state: "running" }));
    tasks.set("t2", task({ id: "t2", state: "pending" }));
    let groups = projectRoster(tasks.values()).groups;
    expect(groups.map((g) => g.state)).toEqual(["running", "pending"]);

    // t1 moves to awaiting_answer — it should jump to the front of the order.
    tasks.set("t1", { ...tasks.get("t1")!, state: "awaiting_answer" });
    groups = projectRoster(tasks.values()).groups;
    expect(groups.map((g) => g.state)).toEqual(["awaiting_answer", "pending"]);
    expect(groups[0]!.tasks[0]!.id).toBe("t1");
  });

  it("projects harness coat and vendor emblem independently with a branch·id meta line", () => {
    const { groups } = projectRoster([
      task({ id: "abcdefghij", state: "running", vendor: "opencode", model: "qwen-3-max", orchHarness: "codex" }),
    ]);
    const rosterTask = groups[0]!.tasks[0]!;
    expect(rosterTask.coat).toBe("#80A83D");
    expect(rosterTask.emblem.kind).toBe("svg");
    expect(rosterTask.faction).toBe("Qwen via OpenCode");
    expect(rosterTask.meta).toBe("feat/x · abcdefgh");
  });
});

describe("projectRoster session grouping (#66)", () => {
  it("derives one session option per distinct orchestrator session, with counts", () => {
    const { sessions } = projectRoster([
      task({ id: "a", state: "running", orchestratorSession: "sess-1", updatedAt: "2024-01-01T00:00:00.000Z" }),
      task({ id: "b", state: "pending", orchestratorSession: "sess-1", updatedAt: "2024-01-02T00:00:00.000Z" }),
      task({ id: "c", state: "running", orchestratorSession: "sess-2", updatedAt: "2024-01-03T00:00:00.000Z" }),
      task({ id: "d", state: "completed", orchestratorSession: null }),
    ]);
    // Most-recently-active first (sess-2 newer than sess-1).
    // Handle = first task name by id order; shortRef = shortId; label includes unit.
    expect(sessions).toEqual([
      {
        id: "sess-2",
        handle: "c",
        shortRef: "sess-2",
        label: "c · 1 task",
        count: 1,
      },
      {
        id: "sess-1",
        handle: "a",
        shortRef: "sess-1",
        label: "a · 2 tasks",
        count: 2,
      },
    ]);
  });

  it("session label leads with first task name and keeps shortRef as secondary", () => {
    const { sessions } = projectRoster([
      task({
        id: "z-later",
        name: "later-task",
        state: "running",
        orchestratorSession: "abcdef0123456789",
      }),
      task({
        id: "a-first",
        name: "fix-auth-fanout",
        state: "running",
        orchestratorSession: "abcdef0123456789",
      }),
    ]);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.handle).toBe("fix-auth-fanout");
    expect(s.shortRef).toBe("abcdef01");
    expect(s.label).toBe("fix-auth-fanout · 2 tasks");
    expect(s.count).toBe(2);
  });

  it("counts durable sessions as distinct orchestrator sessions with a non-terminal task", () => {
    const { durableSessions } = projectRoster([
      task({ id: "a", state: "running", orchestratorSession: "sess-1" }),
      task({ id: "b", state: "completed", orchestratorSession: "sess-1" }),
      task({ id: "c", state: "completed", orchestratorSession: "sess-2" }),
    ]);
    expect(durableSessions).toBe(1);
  });
});

describe("projectRoster recent session chip cap (#88)", () => {
  it("caps chips to RECENT_SESSION_CHIP_CAP most-recently-active sessions", () => {
    const tasks = Array.from({ length: RECENT_SESSION_CHIP_CAP + 3 }, (_, i) =>
      task({
        id: `t${i}`,
        state: "running",
        orchestratorSession: `sess-${String(i).padStart(2, "0")}`,
        updatedAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const { sessions } = projectRoster(tasks);
    expect(sessions).toHaveLength(RECENT_SESSION_CHIP_CAP);
    // Highest timestamps first — last-seeded is most recent.
    expect(sessions[0]!.id).toBe(`sess-${String(RECENT_SESSION_CHIP_CAP + 2).padStart(2, "0")}`);
    expect(sessions.map((s) => s.id)).not.toContain("sess-00");
  });

  it("pins a selected session that falls outside the recent cap", () => {
    const tasks = Array.from({ length: RECENT_SESSION_CHIP_CAP + 2 }, (_, i) =>
      task({
        id: `t${i}`,
        state: "running",
        orchestratorSession: `sess-${String(i).padStart(2, "0")}`,
        updatedAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const { sessions } = projectRoster(tasks, "sess-00");
    expect(sessions.some((s) => s.id === "sess-00")).toBe(true);
    expect(sessions.length).toBe(RECENT_SESSION_CHIP_CAP + 1);
  });
});

describe("projectRoster totals (#66)", () => {
  it("counts total and active (non-terminal) tasks", () => {
    const { totalTasks, activeTasks } = projectRoster([
      task({ id: "a", state: "running" }),
      task({ id: "b", state: "awaiting_answer" }),
      task({ id: "c", state: "completed" }),
    ]);
    expect(totalTasks).toBe(3);
    expect(activeTasks).toBe(2);
  });
});

describe("projectRoster session filter (#76)", () => {
  const fleet = [
    task({ id: "a1", state: "running", orchestratorSession: "sess-1" }),
    task({ id: "a2", state: "completed", orchestratorSession: "sess-1" }),
    task({ id: "b1", state: "running", orchestratorSession: "sess-2" }),
    task({ id: "b2", state: "awaiting_answer", orchestratorSession: "sess-2" }),
    task({ id: "orphan", state: "completed", orchestratorSession: null }),
  ];

  it("null selection (All hands) shows every task and group counts match contents", () => {
    const { groups, totalTasks, activeTasks, sessions } = projectRoster(fleet, null);
    expect(totalTasks).toBe(5);
    expect(activeTasks).toBe(3);
    expect(groups.flatMap((g) => g.tasks.map((t) => t.id)).sort()).toEqual(
      ["a1", "a2", "b1", "b2", "orphan"].sort(),
    );
    for (const group of groups) {
      expect(group.tasks.length).toBeGreaterThan(0);
    }
    // Session chips still list the full fleet (under the recent cap).
    expect(sessions.map((s) => s.id).sort()).toEqual(["sess-1", "sess-2"]);
  });

  it("selecting a session keeps only that session's tasks in every group", () => {
    const { groups, totalTasks, activeTasks, sessions } = projectRoster(fleet, "sess-1");
    expect(totalTasks).toBe(2);
    expect(activeTasks).toBe(1);
    expect(groups.map((g) => g.state)).toEqual(["running", "completed"]);
    expect(groups.find((g) => g.state === "running")!.tasks.map((t) => t.id)).toEqual(["a1"]);
    expect(groups.find((g) => g.state === "completed")!.tasks.map((t) => t.id)).toEqual(["a2"]);
    // Group header counts == filtered contents (no empty groups left behind).
    for (const group of groups) {
      expect(group.tasks.length).toBe(1);
    }
    // Selector chips remain fleet-wide so the user can switch sessions.
    expect(sessions.map((s) => s.id).sort()).toEqual(["sess-1", "sess-2"]);
  });

  it("tasks without a session id appear only under All hands", () => {
    const allHands = projectRoster(fleet, null);
    expect(allHands.groups.flatMap((g) => g.tasks.map((t) => t.id))).toContain("orphan");

    const sess1 = projectRoster(fleet, "sess-1");
    expect(sess1.groups.flatMap((g) => g.tasks.map((t) => t.id))).not.toContain("orphan");

    const sess2 = projectRoster(fleet, "sess-2");
    expect(sess2.groups.flatMap((g) => g.tasks.map((t) => t.id))).not.toContain("orphan");
  });

  it("drops groups that become empty after filtering", () => {
    const { groups } = projectRoster(fleet, "sess-1");
    expect(groups.map((g) => g.state)).not.toContain("awaiting_answer");
  });

  it("omitting the filter argument matches null (All hands)", () => {
    const withDefault = projectRoster(fleet);
    const withNull = projectRoster(fleet, null);
    expect(withDefault.totalTasks).toBe(withNull.totalTasks);
    expect(withDefault.groups.map((g) => g.state)).toEqual(withNull.groups.map((g) => g.state));
  });

  it("selecting a session that has left the fleet yields empty groups (caller resets to All hands)", () => {
    // When the selected session is gone from the snapshot, projectRoster has
    // nothing to show; useCockpit resets selection to null so the next frame
    // re-projects unfiltered rather than leaving the user on an empty list.
    const remaining = fleet.filter((t) => t.orchestratorSession !== "sess-1");
    const { groups, sessions, totalTasks } = projectRoster(remaining, "sess-1");
    expect(sessions.map((s) => s.id)).toEqual(["sess-2"]);
    expect(sessions.some((s) => s.id === "sess-1")).toBe(false);
    expect(groups).toEqual([]);
    expect(totalTasks).toBe(0);
  });
});

describe("projectRoster failed freshness window (display layer)", () => {
  const now = 1_000_000;

  it("without freshness options, failed stays at core archive rank (below completed)", () => {
    const { groups } = projectRoster([
      task({ id: "r", state: "running" }),
      task({ id: "f", state: "failed" }),
      task({ id: "k", state: "completed" }),
    ]);
    expect(groups.map((g) => g.state)).toEqual(["running", "completed", "failed"]);
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(false);
  });

  it("a fresh failure sorts under stalled and above running, and is marked freshFailure", () => {
    const { groups } = projectRoster(
      [
        task({ id: "r", state: "running" }),
        task({ id: "s", state: "stalled" }),
        task({ id: "f", state: "failed" }),
        task({ id: "a", state: "awaiting_answer" }),
      ],
      null,
      freshness({
        now,
        observedAt: new Map([["f", now - 1_000]]),
      }),
    );
    expect(groups.map((g) => g.state)).toEqual([
      "awaiting_answer",
      "stalled",
      "failed",
      "running",
    ]);
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(true);
  });

  it("decays to archive rank after FAILED_FRESHNESS_MS without acknowledgement", () => {
    const { groups } = projectRoster(
      [task({ id: "r", state: "running" }), task({ id: "f", state: "failed" })],
      null,
      freshness({
        now,
        observedAt: new Map([["f", now - FAILED_FRESHNESS_MS]]),
      }),
    );
    expect(groups.map((g) => g.state)).toEqual(["running", "failed"]);
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(false);
  });

  it("decays when the task id is acknowledged and no longer selected", () => {
    const { groups } = projectRoster(
      [task({ id: "r", state: "running" }), task({ id: "f", state: "failed" })],
      null,
      freshness({
        now,
        observedAt: new Map([["f", now - 500]]),
        acknowledged: new Set(["f"]),
        selectedTaskId: null,
      }),
    );
    expect(groups.map((g) => g.state)).toEqual(["running", "failed"]);
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(false);
  });

  it("keeps elevated rank while an acknowledged failure stays selected (ack-on-deselect)", () => {
    // Selecting a fresh wreck marks it acknowledged, but demoting under the
    // click breaks pointer/keyboard spatial model — hold loud rank until leave.
    const { groups } = projectRoster(
      [
        task({ id: "r", state: "running" }),
        task({ id: "s", state: "stalled" }),
        task({ id: "f", state: "failed" }),
      ],
      null,
      freshness({
        now,
        observedAt: new Map([["f", now - 500]]),
        acknowledged: new Set(["f"]),
        selectedTaskId: "f",
      }),
    );
    expect(groups.map((g) => g.state)).toEqual(["stalled", "failed", "running"]);
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(true);
  });

  it("demotes the acknowledged failure once another task is selected", () => {
    const { groups } = projectRoster(
      [
        task({ id: "r", state: "running" }),
        task({ id: "f", state: "failed" }),
      ],
      null,
      freshness({
        now,
        observedAt: new Map([["f", now - 500]]),
        acknowledged: new Set(["f"]),
        selectedTaskId: "r",
      }),
    );
    expect(groups.map((g) => g.state)).toEqual(["running", "failed"]);
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(false);
  });

  it("still decays on the 5-minute timeout even while the failure is selected", () => {
    const { groups } = projectRoster(
      [task({ id: "r", state: "running" }), task({ id: "f", state: "failed" })],
      null,
      freshness({
        now,
        observedAt: new Map([["f", now - FAILED_FRESHNESS_MS]]),
        acknowledged: new Set(["f"]),
        selectedTaskId: "f",
      }),
    );
    expect(groups.map((g) => g.state)).toEqual(["running", "failed"]);
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(false);
  });

  it("sorts fresh failed tasks above archived ones within the failed group", () => {
    const { groups } = projectRoster(
      [
        task({ id: "old", state: "failed" }),
        task({ id: "new", state: "failed" }),
      ],
      null,
      freshness({
        now,
        observedAt: new Map([
          ["old", now - FAILED_FRESHNESS_MS],
          ["new", now - 100],
        ]),
      }),
    );
    const failed = groups.find((g) => g.state === "failed")!;
    expect(failed.tasks.map((t) => t.id)).toEqual(["new", "old"]);
    expect(failed.tasks[0]!.freshFailure).toBe(true);
    expect(failed.tasks[1]!.freshFailure).toBe(false);
  });
});

describe("failed freshness helpers", () => {
  it("isFreshFailure is false for non-failed states and without a freshness bag", () => {
    expect(isFreshFailure("t", "running", freshness({ now: 0 }))).toBe(false);
    expect(isFreshFailure("t", "failed", null)).toBe(false);
  });

  it("isFreshFailure stays true for an acknowledged task while it remains selected", () => {
    expect(
      isFreshFailure(
        "f",
        "failed",
        freshness({
          now: 1_000,
          observedAt: new Map([["f", 500]]),
          acknowledged: new Set(["f"]),
          selectedTaskId: "f",
        }),
      ),
    ).toBe(true);
    expect(
      isFreshFailure(
        "f",
        "failed",
        freshness({
          now: 1_000,
          observedAt: new Map([["f", 500]]),
          acknowledged: new Set(["f"]),
          selectedTaskId: null,
        }),
      ),
    ).toBe(false);
  });

  it("displayAttentionRank lifts fresh failed just under stalled", () => {
    expect(displayAttentionRank("failed", true)).toBeGreaterThan(displayAttentionRank("stalled", false));
    expect(displayAttentionRank("failed", true)).toBeLessThan(displayAttentionRank("running", false));
    expect(displayAttentionRank("failed", false)).toBeGreaterThan(displayAttentionRank("completed", false));
  });

  it("advanceFailedObservations stamps new failures and drops recovered ones", () => {
    const prev = new Map([["a", 100], ["gone", 50]]);
    const next = advanceFailedObservations(
      [task({ id: "a", state: "failed" }), task({ id: "b", state: "failed" }), task({ id: "r", state: "running" })],
      prev,
      999,
    );
    expect(next.get("a")).toBe(100);
    // No prior known state + no wire terminal time → fall back to now.
    expect(next.get("b")).toBe(999);
    expect(next.has("gone")).toBe(false);
  });

  it("isFreshFailure is false when the observation stamp is missing", () => {
    expect(
      isFreshFailure("f", "failed", freshness({ now: 1_000, observedAt: new Map() })),
    ).toBe(false);
  });

  it("terminalTransitionMs prefers completedAt over updatedAt", () => {
    const t = task({
      id: "f",
      state: "failed",
      completedAt: "2026-01-01T00:00:10.000Z",
      updatedAt: "2026-01-01T00:00:20.000Z",
    });
    expect(terminalTransitionMs(t)).toBe(Date.parse("2026-01-01T00:00:10.000Z"));
    expect(
      terminalTransitionMs(
        task({ id: "f", state: "failed", completedAt: null, updatedAt: "2026-01-01T00:00:20.000Z" }),
      ),
    ).toBe(Date.parse("2026-01-01T00:00:20.000Z"));
    expect(terminalTransitionMs(task({ id: "f", state: "failed" }))).toBeUndefined();
  });
});

describe("failed freshness honesty — cold load vs live transition", () => {
  const now = 1_700_000_000_000; // fixed epoch for deterministic ISO stamps

  it("(a) cold-load with an old failure is NOT fresh and does not lift FAILED above RUNNING", () => {
    // Hard reload: empty observation map + empty known states; wire says 26h ago.
    const oldIso = isoAt(now, -26 * 60 * 60 * 1000);
    const failed = task({
      id: "old-wreck",
      state: "failed",
      completedAt: oldIso,
      updatedAt: oldIso,
    });
    const observedAt = advanceFailedObservations([failed], new Map(), now, new Map());
    expect(observedAt.get("old-wreck")).toBe(Date.parse(oldIso));

    const { groups } = projectRoster(
      [task({ id: "r", state: "running" }), failed],
      null,
      freshness({ now, observedAt }),
    );
    expect(groups.map((g) => g.state)).toEqual(["running", "failed"]);
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(false);
  });

  it("(b) cold-load with a failure 2 minutes old is fresh and lifts FAILED under stalled", () => {
    const recentIso = isoAt(now, -2 * 60 * 1000);
    const failed = task({
      id: "fresh-wreck",
      state: "failed",
      completedAt: recentIso,
      updatedAt: recentIso,
    });
    const observedAt = advanceFailedObservations([failed], new Map(), now, new Map());
    expect(observedAt.get("fresh-wreck")).toBe(Date.parse(recentIso));

    const { groups } = projectRoster(
      [
        task({ id: "r", state: "running" }),
        task({ id: "s", state: "stalled" }),
        failed,
      ],
      null,
      freshness({ now, observedAt }),
    );
    expect(groups.map((g) => g.state)).toEqual(["stalled", "failed", "running"]);
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(true);
  });

  it("(c) live non-failed→failed transition stamps now (fresh from transition moment)", () => {
    // Operator saw it running; SSE delivers failed. Wire may lag; stamp is wall clock.
    const wireSlightlyEarlier = isoAt(now, -500);
    const failed = task({
      id: "live",
      state: "failed",
      completedAt: wireSlightlyEarlier,
      updatedAt: wireSlightlyEarlier,
    });
    const prevKnown = new Map([["live", "running"]]);
    const observedAt = advanceFailedObservations([failed], new Map(), now, prevKnown);
    expect(observedAt.get("live")).toBe(now);

    const { groups } = projectRoster(
      [task({ id: "r", state: "running" }), failed],
      null,
      freshness({ now, observedAt }),
    );
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(true);
  });

  it("(d) reload after a live fail within the window stays fresh via wire timestamp", () => {
    // Browser lost the observation map; cold seed from completed_at still inside window.
    const failIso = isoAt(now, -90_000); // 90s ago — within 5 min
    const failed = task({
      id: "live",
      state: "failed",
      completedAt: failIso,
      updatedAt: failIso,
    });
    // No prevKnownStates (reload) → wire seed, not wall-clock now.
    const observedAt = advanceFailedObservations([failed], new Map(), now, new Map());
    expect(observedAt.get("live")).toBe(Date.parse(failIso));
    expect(observedAt.get("live")).not.toBe(now);

    const { groups } = projectRoster(
      [task({ id: "r", state: "running" }), failed],
      null,
      freshness({ now, observedAt }),
    );
    expect(groups.map((g) => g.state)).toEqual(["failed", "running"]);
    expect(groups.find((g) => g.state === "failed")!.tasks[0]!.freshFailure).toBe(true);
  });

  it("cold-load falls back to updatedAt when completedAt is missing", () => {
    const recentIso = isoAt(now, -60_000);
    const failed = task({
      id: "f",
      state: "failed",
      completedAt: null,
      updatedAt: recentIso,
    });
    const observedAt = advanceFailedObservations([failed], new Map(), now);
    expect(observedAt.get("f")).toBe(Date.parse(recentIso));
  });

  it("keeps an existing stamp across re-advances (live clock does not reset)", () => {
    const failed = task({ id: "f", state: "failed", completedAt: isoAt(now, -1_000) });
    const first = advanceFailedObservations([failed], new Map(), now, new Map([["f", "running"]]));
    expect(first.get("f")).toBe(now);
    const second = advanceFailedObservations([failed], first, now + 30_000, new Map([["f", "failed"]]));
    expect(second.get("f")).toBe(now);
    expect(second).toBe(first); // identity-stable when unchanged
  });
});
