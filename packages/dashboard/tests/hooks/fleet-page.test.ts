/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ParleyClient } from "@useparley/core";
import { useFleetPage } from "../../src/data/useFleetPage.js";
import { envelope } from "../fixtures.js";

afterEach(cleanup);

it("resets page on scope changes and discards late responses from the previous scope", async () => {
  const requests: URL[] = [];
  let release: ((value: Response) => void) | undefined;
  const client = new ParleyClient({ fetch: (async (input) => {
    const url = new URL(String(input), "http://localhost"); requests.push(url);
    if (url.searchParams.get("cursor")) return new Promise<Response>((resolve) => { release = resolve; });
    const state = url.searchParams.get("state") || "running";
    return new Response(JSON.stringify({ items: [envelope({ task_id: state, state: state === "failed" ? "failed" : "running" })], total: 150, seq: 1, next_cursor: "next" }));
  }) as typeof fetch });
  const { result, rerender } = renderHook(({ state }) => useFleetPage(client, "tasks", { state }), { initialProps: { state: "running" } });
  await waitFor(() => expect(result.current.items[0]?.task_id).toBe("running"));
  act(() => result.current.next());
  await waitFor(() => expect(release).toBeDefined());
  expect(result.current.number).toBe(2);
  rerender({ state: "failed" });
  await waitFor(() => expect(result.current.items[0]?.task_id).toBe("failed"));
  await act(async () => release!(new Response(JSON.stringify({ items: [envelope({ task_id: "obsolete", state: "running" })], total: 100, seq: 1, next_cursor: null }))));
  expect(result.current.number).toBe(1);
  expect(result.current.items[0]?.task_id).toBe("failed");
  expect(requests.at(-1)?.searchParams.get("cursor")).toBeNull();
  rerender({ state: "running" });
  await waitFor(() => expect(result.current.items[0]?.task_id).toBe("running"));
  expect(result.current.number).toBe(1);
});

it("keeps task and run page navigation independent and exposes retriable errors", async () => {
  let fail = false;
  const client = new ParleyClient({ fetch: (async () => fail ? new Response('{"error":"temporary"}', { status: 500 }) : new Response(JSON.stringify({ items: [], total: 120, seq: 1, next_cursor: "next" }))) as typeof fetch });
  const { result } = renderHook(() => ({ tasks: useFleetPage(client, "tasks"), runs: useFleetPage(client, "runs") }));
  await waitFor(() => expect(result.current.tasks.hasNext).toBe(true));
  act(() => result.current.tasks.next());
  await waitFor(() => expect(result.current.tasks.loading).toBe(false));
  expect(result.current.tasks.number).toBe(2);
  expect(result.current.runs.number).toBe(1);
  fail = true;
  await act(() => result.current.tasks.refresh());
  expect(result.current.tasks.error).toContain("temporary");
  expect(result.current.tasks.total).toBe(120);
  fail = false;
  await act(() => result.current.tasks.refresh());
  expect(result.current.tasks.error).toBeNull();
});
