import { describe, expect, it } from "vitest";
import { filterTasksByRunId } from "../../src/data/projections/runTasks.js";
import { envelope } from "../fixtures.js";

describe("filterTasksByRunId", () => {
  const tasks = [
    envelope({ task_id: "t1", state: "running", run_id: "run-a" }),
    envelope({ task_id: "t2", state: "completed", run_id: "run-b" }),
    envelope({ task_id: "t3", state: "running", run_id: "run-a" }),
    envelope({ task_id: "t4", state: "pending" }),
  ];

  it("filters the snapshot by run_id client-side", () => {
    expect(filterTasksByRunId(tasks, "run-a").map((t) => t.task_id)).toEqual(["t1", "t3"]);
  });

  it("returns empty for null/empty run id", () => {
    expect(filterTasksByRunId(tasks, null)).toEqual([]);
    expect(filterTasksByRunId(tasks, "")).toEqual([]);
  });
});
