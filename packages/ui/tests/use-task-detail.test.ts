/** @vitest-environment happy-dom */
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ParleyClient, type TaskDetailResponse } from "@useparley/core";
import { useTaskDetail } from "../src/app/hooks/useTaskDetail.js";
import { envelope, row } from "./fixtures.js";

/** A same-origin fetch stand-in serving `GET /tasks/:ref` from a scripted
 * sequence of responses per task id, modeling a task's state/report landing
 * over successive polls (mirrors `use-log-tail.test.ts`'s convention). */
function scriptedDetailFetch(scriptByTask: Record<string, TaskDetailResponse[]>): typeof fetch {
  const calls: Record<string, number> = {};
  return (async (input: string | URL | Request) => {
    const match = /^\/tasks\/([^/?]+)$/.exec(String(input));
    const taskId = match && decodeURIComponent(match[1]!);
    const steps = taskId ? scriptByTask[taskId] : undefined;
    if (!steps) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const i = calls[taskId!] ?? 0;
    calls[taskId!] = i + 1;
    const step = steps[Math.min(i, steps.length - 1)]!;
    return new Response(JSON.stringify(step), { status: 200 });
  }) as typeof fetch;
}

describe("useTaskDetail fetches and polls a task's full detail (#68)", () => {
  it("fetches immediately and stops polling once the task reaches a terminal state", async () => {
    const client = new ParleyClient({
      baseUrl: "",
      fetch: scriptedDetailFetch({
        t1: [
          {
            task: envelope({ task_id: "t1", state: "running" }),
            row: row({ id: "t1", state: "running", orchestrator_session_id: null }),
            qa: [],
            attempts: [
              {
                id: "t1",
                name: null,
                attempt: 1,
                parent_task_id: null,
                state: "running",
                resumed: false,
                cached_input_tokens: null,
                cache_hit: null,
                eval_score: null,
                eval_baseline: null,
                eval_rubric: null,
                eval_rubric_version: null,
                eval_legacy: false,
              },
            ],
            session: {
              session_id: null,
              harness: null,
              model: null,
              effort: null,
            },
            eval_detail: null,
          },
          {
            task: envelope({
              task_id: "t1",
              state: "completed",
              report: { outcome: "success", summary: "Done.", files_changed: [] },
            }),
            row: row({ id: "t1", state: "completed", orchestrator_session_id: null }),
            qa: [],
            attempts: [
              {
                id: "t1",
                name: null,
                attempt: 1,
                parent_task_id: null,
                state: "completed",
                resumed: false,
                cached_input_tokens: null,
                cache_hit: null,
                eval_score: null,
                eval_baseline: null,
                eval_rubric: null,
                eval_rubric_version: null,
                eval_legacy: false,
              },
            ],
            session: {
              session_id: null,
              harness: null,
              model: null,
              effort: null,
            },
            eval_detail: null,
          },
        ],
      }),
    });

    // A poll interval comfortably wider than `waitFor`'s sampling interval
    // below, so the intermediate "running" state is reliably observed rather
    // than raced past between samples.
    const { result } = renderHook(() => useTaskDetail(client, "t1", 80));
    const opts = { interval: 10, timeout: 3000 };

    await waitFor(() => expect(result.current?.task.state).toBe("running"), opts);
    await waitFor(() => expect(result.current?.task.state).toBe("completed"), opts);
    expect(result.current?.task.report).toEqual({ outcome: "success", summary: "Done.", files_changed: [] });
  });

  it("returns null with no task selected", () => {
    const client = new ParleyClient({ baseUrl: "", fetch: scriptedDetailFetch({}) });
    const { result } = renderHook(() => useTaskDetail(client, null));
    expect(result.current).toBeNull();
  });
});
