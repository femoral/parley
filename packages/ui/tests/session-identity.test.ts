import { afterEach, describe, expect, it } from "vitest";
import {
  collectSessionIdentities,
  deriveSessionIdentity,
  resetStickySessionHandles,
  type RosterTaskInput,
} from "../src/app/hooks/roster.js";

afterEach(() => {
  resetStickySessionHandles();
});

function task(
  overrides: Partial<RosterTaskInput> & Pick<RosterTaskInput, "id" | "state">,
): RosterTaskInput {
  return {
    name: overrides.id,
    vendor: "codex",
    branch: "feat/x",
    orchestratorSession: null,
    question: null,
    ...overrides,
  };
}

describe("sticky session handles (collectSessionIdentities)", () => {
  it("keeps the first derived handle after the deriving task is removed", () => {
    const sessionId = "sess-sticky-aaaa";
    const first = collectSessionIdentities([
      task({
        id: "a-first",
        name: "chart-the-bay",
        state: "running",
        orchestratorSession: sessionId,
      }),
      task({
        id: "b-later",
        name: "map-the-reef",
        state: "running",
        orchestratorSession: sessionId,
      }),
    ]);
    expect(first.get(sessionId)?.handle).toBe("chart-the-bay");

    // Lexically-first task cleaned — pure derive would rename to map-the-reef.
    const pure = deriveSessionIdentity(sessionId, [
      { id: "b-later", name: "map-the-reef" },
    ]);
    expect(pure.handle).toBe("map-the-reef");

    const sticky = collectSessionIdentities([
      task({
        id: "b-later",
        name: "map-the-reef",
        state: "running",
        orchestratorSession: sessionId,
      }),
    ]);
    expect(sticky.get(sessionId)?.handle).toBe("chart-the-bay");
    expect(sticky.get(sessionId)?.label).toBe("chart-the-bay · 1 task");
    expect(sticky.get(sessionId)?.shortRef).toBe("sess-sti");
  });

  it("does not leak sticky handles across session ids", () => {
    collectSessionIdentities([
      task({
        id: "t1",
        name: "alpha",
        state: "running",
        orchestratorSession: "sess-one-1111",
      }),
    ]);
    const other = collectSessionIdentities([
      task({
        id: "t2",
        name: "beta",
        state: "running",
        orchestratorSession: "sess-two-2222",
      }),
    ]);
    expect(other.get("sess-two-2222")?.handle).toBe("beta");
  });
});
