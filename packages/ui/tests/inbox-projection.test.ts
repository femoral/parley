import { describe, expect, it } from "vitest";
import { projectInbox } from "../src/app/hooks/inbox.js";
import type { RosterTaskInput } from "../src/app/hooks/roster.js";

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

describe("projectInbox selects tasks blocked on an answer (#67)", () => {
  it("includes awaiting_answer tasks that carry a question", () => {
    const cards = projectInbox([
      task({ id: "a", state: "awaiting_answer", question: "Which port?", orchestratorSession: "sess-1" }),
    ]);
    expect(cards).toEqual([
      {
        id: "a",
        name: "a",
        state: "awaiting_answer",
        coat: "#10a37f",
        emblem: expect.objectContaining({ kind: "svg" }),
        faction: "Codex",
        meta: "feat/x · a",
        question: "Which port?",
        sessionId: "sess-1",
      },
    ]);
  });

  it("excludes running, pending, and terminal tasks even if they somehow carry a question", () => {
    const cards = projectInbox([
      task({ id: "r", state: "running", question: "stray?" }),
      task({ id: "p", state: "pending", question: "stray?" }),
      task({ id: "c", state: "completed", question: "stray?" }),
      task({ id: "f", state: "failed", question: "stray?" }),
    ]);
    expect(cards).toEqual([]);
  });

  it("excludes an awaiting_answer task with no question text (defensive — shouldn't happen on the wire)", () => {
    const cards = projectInbox([task({ id: "a", state: "awaiting_answer", question: null })]);
    expect(cards).toEqual([]);
  });

  it("excludes stalled tasks — v1 scope keeps the inbox to answer-only (docs/spec/ui-v1-scope.md)", () => {
    const cards = projectInbox([task({ id: "s", state: "stalled", question: null })]);
    expect(cards).toEqual([]);
  });

  it("sorts by the shared attention order, awaiting-first", () => {
    // Both entries qualify as "blocked with a question" here only to exercise
    // the sort itself; today only awaiting_answer ever carries a question.
    const cards = projectInbox([
      task({ id: "second", state: "stalled", question: "b" }),
      task({ id: "first", state: "awaiting_answer", question: "a" }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(["first", "second"]);
  });

  it("projects faction coat/emblem/label and a branch·id meta line, same shape as the roster", () => {
    const cards = projectInbox([
      task({ id: "abcdefghij", state: "awaiting_answer", vendor: "grok", question: "Deploy now?" }),
    ]);
    expect(cards[0]).toEqual({
      id: "abcdefghij",
      name: "abcdefghij",
      state: "awaiting_answer",
      coat: "#2b2b2e",
      emblem: expect.objectContaining({ kind: "svg" }),
      faction: "Grok",
      meta: "feat/x · abcdefgh",
      question: "Deploy now?",
      sessionId: null,
    });
  });

  it("carries the orchestrator session id through for the card footer rope", () => {
    const cards = projectInbox([
      task({
        id: "task-1",
        state: "awaiting_answer",
        question: "Ship it?",
        orchestratorSession: "orch-session-xyz",
      }),
    ]);
    expect(cards[0]?.sessionId).toBe("orch-session-xyz");
  });
});
