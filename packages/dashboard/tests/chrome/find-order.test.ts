/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { matchTasks } from "../../src/chrome/FindCombobox.js";
import { envelope } from "../fixtures.js";

describe("find matchTasks attention order", () => {
  it("orders hits by attention rank so awaiting is never omitted by the cap", () => {
    // 13 completed matches + 1 awaiting, all share needle "stage".
    // Cap is 12 — without attention order the awaiting task at the end of
    // wire order would be dropped.
    const tasks = [
      ...Array.from({ length: 13 }, (_, i) =>
        envelope({
          task_id: `stage-done-${i}`,
          name: `stage done ${i}`,
          state: "completed",
          updated_at: `2026-06-15T1${String(i).padStart(2, "0")}:00:00.000Z`,
        }),
      ),
      envelope({
        task_id: "stage-awaiting-only",
        name: "stage awaiting only",
        state: "awaiting_answer",
        updated_at: "2026-06-15T23:00:00.000Z",
      }),
    ];

    const hits = matchTasks(tasks, "stage");
    expect(hits.length).toBe(12);
    expect(hits[0]!.id).toBe("stage-awaiting-only");
    expect(hits[0]!.state).toBe("awaiting_answer");
    expect(hits.some((h) => h.id === "stage-awaiting-only")).toBe(true);
  });

  it("places stalled ahead of completed when both match", () => {
    const hits = matchTasks(
      [
        envelope({ task_id: "c", name: "needle c", state: "completed" }),
        envelope({ task_id: "s", name: "needle s", state: "stalled" }),
        envelope({ task_id: "r", name: "needle r", state: "running" }),
      ],
      "needle",
    );
    expect(hits.map((h) => h.id)).toEqual(["s", "r", "c"]);
  });
});
