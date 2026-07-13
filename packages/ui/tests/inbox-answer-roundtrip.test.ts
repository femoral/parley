/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ParleyClient, type TasksResponse } from "@useparley/core";
import { useSnapshot } from "../src/app/hooks/useSnapshot.js";
import { envelope, FakeEventSource, row } from "./fixtures.js";

/**
 * The round-trip this exercises (#67, "the single write of v1"): the inbox
 * posts `POST /tasks/:ref/answer` through the core SDK client (the same one
 * `useCockpit.answerTask` wraps), the fake daemon answers, and the *live*
 * state flip arrives over SSE and re-projects the task straight out of
 * `useSnapshot`'s `inbox` — no reload, no refetch of the roster. Reuses the
 * `FakeEventSource`/`envelope`/`row` fixtures from `use-snapshot-sse.test.ts`
 * (see `fixtures.ts`) since a hook-level fake daemon exercises the same HTTP +
 * SSE contract without spawning a real daemon process.
 */

/** A same-origin fetch stand-in serving `GET /tasks` and `POST /tasks/:ref/answer`. */
function fakeDaemon(snapshot: TasksResponse, opts: { answerShouldFail?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/tasks" && (!init || init.method === undefined)) {
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }
    const answerMatch = /^\/tasks\/([^/?]+)\/answer$/.exec(path);
    if (answerMatch && init?.method === "POST") {
      if (opts.answerShouldFail) {
        return new Response(JSON.stringify({ error: "task is not awaiting an answer" }), { status: 409 });
      }
      const id = decodeURIComponent(answerMatch[1]!);
      return new Response(JSON.stringify({ task_id: id, name: id, state: "running", seq: 2 }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  FakeEventSource.current = undefined;
});

describe("the inbox's answer round-trips through the daemon and SSE (#67)", () => {
  it("posting an answer, then the fake vendor's transition, flips the task out of the inbox live", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

    const snapshot: TasksResponse = {
      seq: 1,
      tasks: [
        row({
          id: "t1",
          state: "awaiting_answer",
          orchestrator_session_id: "sess-1",
          name: "chart-the-bay",
          question_id: "q1",
          question: "Which shoal?",
        }),
      ],
    };
    const fetchImpl = fakeDaemon(snapshot);
    const client = new ParleyClient({ baseUrl: "", fetch: fetchImpl });

    const { result } = renderHook(() => useSnapshot(client));

    // Bootstrap settles: the task sits in the inbox with its question.
    await waitFor(() => expect(result.current.inbox).toHaveLength(1));
    expect(result.current.inbox[0]).toMatchObject({ id: "t1", question: "Which shoal?" });
    expect(result.current.groups.map((g) => g.state)).toEqual(["awaiting_answer"]);

    // Post the answer through the same client the hooks layer wraps (#67's
    // one write) — the daemon acks synchronously...
    await act(async () => {
      await client.answer("t1", "The northern shoal.");
    });

    // ...but the view doesn't change until the fake vendor's actual state
    // transition arrives over SSE (no polling/refetch of the whole snapshot).
    expect(result.current.inbox).toHaveLength(1);

    act(() => {
      FakeEventSource.current!.emit(
        "task.started",
        2,
        envelope({ task_id: "t1", name: "chart-the-bay", state: "running", branch: "feat/x" }),
      );
    });

    // The card leaves the inbox as the state flips live — no reload.
    await waitFor(() => expect(result.current.inbox).toHaveLength(0));
    expect(result.current.groups.map((g) => g.state)).toEqual(["running"]);
  });

  it("an answer the daemon rejects throws, leaving the task in the inbox", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

    const snapshot: TasksResponse = {
      seq: 1,
      tasks: [
        row({
          id: "t1",
          state: "awaiting_answer",
          orchestrator_session_id: "sess-1",
          question_id: "q1",
          question: "Which shoal?",
        }),
      ],
    };
    const client = new ParleyClient({ baseUrl: "", fetch: fakeDaemon(snapshot, { answerShouldFail: true }) });

    const { result } = renderHook(() => useSnapshot(client));
    await waitFor(() => expect(result.current.inbox).toHaveLength(1));

    await expect(client.answer("t1", "The northern shoal.")).rejects.toThrow(
      /task is not awaiting an answer/,
    );
    // No transition happened — the task is still in the inbox.
    expect(result.current.inbox).toHaveLength(1);
  });
});
