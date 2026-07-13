import { describe, expect, it } from "vitest";
import { projectRoster, type RosterTaskInput } from "../src/app/hooks/roster.js";

function task(overrides: Partial<RosterTaskInput> & Pick<RosterTaskInput, "id" | "state">): RosterTaskInput {
  return {
    name: overrides.id,
    vendor: "codex",
    branch: "feat/x",
    orchestratorSession: null,
    ...overrides,
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

  it("projects faction coat/emblem and a branch·id meta line per task", () => {
    const { groups } = projectRoster([task({ id: "abcdefghij", state: "running", vendor: "grok" })]);
    const rosterTask = groups[0]!.tasks[0]!;
    expect(rosterTask.coat).toBe("#c0392b");
    expect(rosterTask.emblem).toBe("⚔");
    expect(rosterTask.meta).toBe("feat/x · abcdefgh");
  });
});

describe("projectRoster session grouping (#66)", () => {
  it("derives one session option per distinct orchestrator session, with counts", () => {
    const { sessions } = projectRoster([
      task({ id: "a", state: "running", orchestratorSession: "sess-1" }),
      task({ id: "b", state: "pending", orchestratorSession: "sess-1" }),
      task({ id: "c", state: "running", orchestratorSession: "sess-2" }),
      task({ id: "d", state: "completed", orchestratorSession: null }),
    ]);
    expect(sessions).toEqual([
      { id: "sess-1", label: "sess-1", count: 2 },
      { id: "sess-2", label: "sess-2", count: 1 },
    ]);
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
