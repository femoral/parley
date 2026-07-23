import { afterEach, describe, expect, it } from "vitest";
import { attentionRank } from "@useparley/core";
import {
  projectScene,
  rollupSessionAttention,
  isSceneAttentionState,
} from "../src/app/hooks/scene.js";
import {
  projectRoster,
  resetStickySessionHandles,
  type RosterTaskInput,
} from "../src/app/hooks/roster.js";
import { projectInbox } from "../src/app/hooks/inbox.js";

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
    // Humane handle from first task name; shortRef secondary; label has unit.
    expect(sessions[0]!.handle).toBe("a");
    expect(sessions[0]!.shortRef).toBe("sess-1");
    expect(sessions[0]!.label).toBe("a · 2 tasks");
    expect(sessions[1]!.label).toBe("c · 1 task");
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

  it("resolves vendor emblem and orchestrator harness colour independently", () => {
    const { sessions } = projectScene([
      task({ id: "a", state: "running", vendor: "opencode", model: "qwen-3-max", orchHarness: "codex", orchestratorSession: "s" }),
    ]);
    const island = sessions[0]!.tasks[0]!;
    expect(island.coat).toBe("#80A83D");
    expect(island.coatDark).toBe("#465F1D");
    expect(island.emblem.kind).toBe("svg");
  });

  it("does not let the orchestrator harness recolor a task", () => {
    const first = projectScene([task({ id: "a", state: "running", vendor: "codex", model: "gpt-5.6-sol", orchHarness: "grok" })]);
    const second = projectScene([task({ id: "a", state: "running", vendor: "codex", model: "gpt-5.6-sol", orchHarness: "kimi" })]);
    expect(first.sessions[0]!.tasks[0]!.coat).toBe("#18A886");
    expect(second.sessions[0]!.tasks[0]!.coat).toBe("#18A886");
    expect(first.sessions[0]!.tasks[0]!.emblem).toEqual(second.sessions[0]!.tasks[0]!.emblem);
  });

  it("falls back to brass-frame coat for an unknown harness without changing vendor fallback", () => {
    const { sessions } = projectScene([task({ id: "a", state: "running", vendor: "brand-new" })]);
    const island = sessions[0]!.tasks[0]!;
    expect(island.coat).toBe("#8A6A34");
    expect(island.emblem).toEqual({ kind: "glyph", char: "?" });
  });
});

describe("projectScene attention rollup (edge-of-frame alerts)", () => {
  it("is null when every island is calm (running / pending / completed / cancelled)", () => {
    const { sessions } = projectScene([
      task({ id: "a", state: "running", orchestratorSession: "s" }),
      task({ id: "b", state: "completed", orchestratorSession: "s" }),
      task({ id: "c", state: "pending", orchestratorSession: "s" }),
      task({ id: "d", state: "cancelled", orchestratorSession: "s" }),
    ]);
    expect(sessions[0]!.attention).toBeNull();
  });

  it("picks awaiting_answer as louder than stalled or failed", () => {
    const { sessions } = projectScene([
      task({ id: "a", state: "failed", orchestratorSession: "s" }),
      task({ id: "b", state: "awaiting_answer", orchestratorSession: "s" }),
      task({ id: "c", state: "stalled", orchestratorSession: "s" }),
    ]);
    expect(sessions[0]!.attention).toEqual({
      state: "awaiting_answer",
      count: 1,
      rank: attentionRank("awaiting_answer"),
    });
  });

  it("picks stalled over failed when no awaiting", () => {
    const { sessions } = projectScene([
      task({ id: "a", state: "failed", orchestratorSession: "s" }),
      task({ id: "b", state: "stalled", orchestratorSession: "s" }),
      task({ id: "c", state: "failed", orchestratorSession: "s" }),
    ]);
    expect(sessions[0]!.attention).toEqual({
      state: "stalled",
      count: 1,
      rank: attentionRank("stalled"),
    });
  });

  it("counts tasks in the loudest state only", () => {
    const { sessions } = projectScene([
      task({ id: "a", state: "awaiting_answer", orchestratorSession: "s" }),
      task({ id: "b", state: "awaiting_answer", orchestratorSession: "s" }),
      task({ id: "c", state: "failed", orchestratorSession: "s" }),
    ]);
    expect(sessions[0]!.attention).toEqual({
      state: "awaiting_answer",
      count: 2,
      rank: attentionRank("awaiting_answer"),
    });
  });

  it("rolls up per session independently", () => {
    const { sessions } = projectScene([
      task({ id: "a", state: "running", orchestratorSession: "calm" }),
      task({ id: "b", state: "failed", orchestratorSession: "trouble" }),
    ]);
    const calm = sessions.find((s) => s.id === "calm")!;
    const trouble = sessions.find((s) => s.id === "trouble")!;
    expect(calm.attention).toBeNull();
    expect(trouble.attention?.state).toBe("failed");
  });

  it("rollupSessionAttention ranks via core attentionRank (never re-derived)", () => {
    const rollup = rollupSessionAttention([
      { state: "failed" },
      { state: "stalled" },
      { state: "running" },
    ]);
    expect(rollup?.rank).toBe(attentionRank("stalled"));
    expect(isSceneAttentionState("awaiting_answer")).toBe(true);
    expect(isSceneAttentionState("failed")).toBe(true);
    expect(isSceneAttentionState("running")).toBe(false);
    expect(isSceneAttentionState("completed")).toBe(false);
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
