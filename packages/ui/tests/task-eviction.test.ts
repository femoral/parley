import { describe, expect, it } from "vitest";
import { evictTerminalOverflow, TERMINAL_TASK_CAP } from "../src/app/hooks/useSnapshot.js";
import type { RosterTaskInput } from "../src/app/hooks/roster.js";

function task(id: string, state: string, updatedAt: string): RosterTaskInput {
  return {
    id,
    name: id,
    vendor: "codex",
    model: null,
    orchHarness: null,
    state,
    branch: null,
    orchestratorSession: null,
    question: null,
    updatedAt,
  };
}

function stamp(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
}

describe("evictTerminalOverflow bounds the live task map (all-day sessions)", () => {
  it("leaves maps at or under the cap untouched", () => {
    const map = new Map<string, RosterTaskInput>();
    for (let i = 0; i < 10; i++) map.set(`t${i}`, task(`t${i}`, "completed", stamp(i)));
    evictTerminalOverflow(map, undefined, 10);
    expect(map.size).toBe(10);
  });

  it("never evicts active tasks, even far over the cap", () => {
    const map = new Map<string, RosterTaskInput>();
    for (let i = 0; i < 20; i++) map.set(`run${i}`, task(`run${i}`, "running", stamp(i)));
    for (let i = 0; i < 20; i++) map.set(`await${i}`, task(`await${i}`, "awaiting_answer", stamp(i)));
    evictTerminalOverflow(map, undefined, 5);
    expect(map.size).toBe(40);
  });

  it("drops the oldest terminal tasks first and keeps the freshest", () => {
    const map = new Map<string, RosterTaskInput>();
    for (let i = 0; i < 8; i++) map.set(`done${i}`, task(`done${i}`, "completed", stamp(i)));
    map.set("live", task("live", "running", stamp(0)));
    evictTerminalOverflow(map, undefined, 3);
    expect([...map.keys()]).toEqual(["done5", "done6", "done7", "live"]);
  });

  it("mixes terminal states into one age-ordered pool and prunes the fetched set", () => {
    const map = new Map<string, RosterTaskInput>();
    map.set("f0", task("f0", "failed", stamp(0)));
    map.set("c1", task("c1", "cancelled", stamp(1)));
    map.set("d2", task("d2", "completed", stamp(2)));
    const fetched = new Set(["f0", "c1", "d2"]);
    evictTerminalOverflow(map, fetched, 1);
    expect([...map.keys()]).toEqual(["d2"]);
    expect([...fetched]).toEqual(["d2"]);
  });

  it("exposes a generous production cap", () => {
    expect(TERMINAL_TASK_CAP).toBeGreaterThanOrEqual(500);
  });
});
