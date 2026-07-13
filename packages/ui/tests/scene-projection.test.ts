import { describe, expect, it } from "vitest";
import { projectScene } from "../src/app/hooks/scene.js";
import { projectRoster, type RosterTaskInput } from "../src/app/hooks/roster.js";
import { projectInbox } from "../src/app/hooks/inbox.js";

function task(overrides: Partial<RosterTaskInput> & Pick<RosterTaskInput, "id" | "state">): RosterTaskInput {
  return {
    name: overrides.id,
    vendor: "codex",
    branch: "feat/x",
    orchestratorSession: null,
    question: null,
    ...overrides,
  };
}

describe("projectScene groups tasks into session regions (#69)", () => {
  it("makes one region per orchestrator session, each with an island per task", () => {
    const { sessions } = projectScene([
      task({ id: "a", state: "running", orchestratorSession: "sess-1" }),
      task({ id: "b", state: "pending", orchestratorSession: "sess-1" }),
      task({ id: "c", state: "completed", orchestratorSession: "sess-2" }),
    ]);
    expect(sessions.map((s) => s.id)).toEqual(["sess-1", "sess-2"]);
    expect(sessions[0]!.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(sessions[1]!.tasks.map((t) => t.id)).toEqual(["c"]);
  });

  it("gathers session-less tasks into an open-water region (id null), sorted last", () => {
    const { sessions } = projectScene([
      task({ id: "loose", state: "running", orchestratorSession: null }),
      task({ id: "moored", state: "running", orchestratorSession: "sess-1" }),
    ]);
    expect(sessions.map((s) => s.id)).toEqual(["sess-1", null]);
    const openWater = sessions.find((s) => s.id === null)!;
    expect(openWater.label).toBe("Open water");
    expect(openWater.tasks.map((t) => t.id)).toEqual(["loose"]);
  });

  it("orders islands by task id so geography holds still across transitions", () => {
    const before = projectScene([
      task({ id: "b", state: "pending", orchestratorSession: "s" }),
      task({ id: "a", state: "running", orchestratorSession: "s" }),
    ]);
    expect(before.sessions[0]!.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    // "a" moves to awaiting — its slot (first) is unchanged.
    const after = projectScene([
      task({ id: "b", state: "pending", orchestratorSession: "s" }),
      task({ id: "a", state: "awaiting_answer", orchestratorSession: "s" }),
    ]);
    expect(after.sessions[0]!.tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("carries the faction tint pair and emblem onto each island", () => {
    const { sessions } = projectScene([
      task({ id: "a", state: "running", vendor: "grok", orchestratorSession: "s" }),
    ]);
    const island = sessions[0]!.tasks[0]!;
    expect(island.coat).toBe("#c0392b");
    expect(island.coatDark).toBe("#8a241a");
    expect(island.emblem).toBe("⚔");
  });

  it("falls back to the unaligned tint for an unknown vendor (zero new art)", () => {
    const { sessions } = projectScene([task({ id: "a", state: "running", vendor: "brand-new" })]);
    const island = sessions[0]!.tasks[0]!;
    expect(island.coat).toBe("#8a6a34");
    expect(island.coatDark).toBe("#5b3a24");
  });
});

describe("scene / roster / inbox agree on state (shared projection, #69)", () => {
  // The one task list, projected three ways — the acceptance's "scene, roster
  // badge and inbox always agree" reduces to: all three read the same `state`.
  const tasks: RosterTaskInput[] = [
    task({ id: "ask", state: "awaiting_answer", orchestratorSession: "s", question: "Which branch?" }),
    task({ id: "work", state: "running", orchestratorSession: "s" }),
    task({ id: "done", state: "completed", orchestratorSession: "s" }),
  ];

  it("renders each task's island with the same state string the roster groups it under", () => {
    const scene = projectScene(tasks);
    const roster = projectRoster(tasks);
    const sceneStateById = new Map(scene.sessions[0]!.tasks.map((t) => [t.id, t.state]));
    for (const group of roster.groups) {
      for (const rosterTask of group.tasks) {
        expect(sceneStateById.get(rosterTask.id)).toBe(group.state);
      }
    }
  });

  it("shows the awaiting task in the inbox with the very state its island renders", () => {
    const scene = projectScene(tasks);
    const inbox = projectInbox(tasks);
    const askIsland = scene.sessions[0]!.tasks.find((t) => t.id === "ask")!;
    const askCard = inbox.find((t) => t.id === "ask")!;
    expect(askIsland.state).toBe("awaiting_answer");
    expect(askCard.state).toBe("awaiting_answer");
    // running/completed never reach the inbox — no disagreement to have.
    expect(inbox.map((t) => t.id)).toEqual(["ask"]);
  });
});
