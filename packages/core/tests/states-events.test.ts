/**
 * #208 — eventNameForState is the sole watch/SSE event-name authority.
 */
import { describe, expect, it } from "vitest";
import { eventNameForState } from "../src/states.js";

describe("eventNameForState", () => {
  it.each([
    ["running", "task.started"],
    ["awaiting_answer", "task.question"],
    ["completed", "task.completed"],
    ["failed", "task.failed"],
    ["cancelled", "task.cancelled"],
    ["stalled", "task.stalled"],
    ["pending", "task.pending"],
    ["queued", "task.queued"],
  ] as const)("%s → %s", (state, event) => {
    expect(eventNameForState(state)).toBe(event);
  });
});
