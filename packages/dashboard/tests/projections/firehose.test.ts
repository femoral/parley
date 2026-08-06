import { describe, expect, it } from "vitest";
import {
  projectFirehose,
  projectFirehoseLine,
} from "../../src/data/projections/firehose.js";
import { envelope } from "../fixtures.js";

describe("projectFirehose", () => {
  it("joins run events to workflow name from the runs cache", () => {
    const line = projectFirehoseLine(
      {
        subject: "run",
        event: "run.started",
        seq: 5,
        run: {
          run_id: "run-abcdef12",
          state: "running",
          current_node: "review",
          iteration: 0,
          seq: 5,
        },
      },
      new Map([["run-abcdef12", "ship-it"]]),
    );
    expect(line.workflow).toBe("ship-it");
    expect(line.text).toContain("ship-it");
    expect(line.text).toContain("run.started");
    expect(line.text).toContain("@ review");
  });

  it("renders task events from the full envelope", () => {
    const line = projectFirehoseLine({
      subject: "task",
      event: "task.completed",
      seq: 3,
      task: envelope({
        task_id: "t1",
        name: "chart-bay",
        state: "completed",
        run_id: "run-1",
        node: "tests",
      }),
    });
    expect(line.taskId).toBe("t1");
    expect(line.text).toContain("chart-bay");
    expect(line.text).toContain("task.completed");
  });

  it("batch projects with runs list lookup", () => {
    const lines = projectFirehose(
      [
        {
          subject: "run",
          event: "run.completed",
          seq: 9,
          run: { run_id: "r1", state: "completed", seq: 9 },
        },
      ],
      [{ run_id: "r1", workflow: "wf-a" }],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.workflow).toBe("wf-a");
  });
});
