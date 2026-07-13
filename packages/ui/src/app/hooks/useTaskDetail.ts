import { useEffect, useState } from "react";
import { isTerminalState, type ParleyClient, type TaskDetailResponse } from "@useparley/core";

const DEFAULT_POLL_MS = 3000;

/**
 * Layer 4 (hooks) — fetch a task's full detail (envelope + row) for the
 * inspector. The envelope `useSnapshot` already tracks is missing the
 * row-only fields the Brief/Report tabs need (prompt, eval score/feedback —
 * `TaskRow`'s doc comment: "the row exposes the raw persisted columns a UI's
 * inspector may want"), so the inspector fetches its own copy via
 * `GET /tasks/:ref` rather than reaching into `useSnapshot`'s internals.
 * Polls while the task is still live so token usage, duration, and the
 * eventual report/eval land without a reselect; stops once the task reaches
 * a terminal state. Resets to `null` whenever the selection changes.
 */
export function useTaskDetail(
  client: ParleyClient,
  taskId: string | null,
  pollMs = DEFAULT_POLL_MS,
): TaskDetailResponse | null {
  const [detail, setDetail] = useState<TaskDetailResponse | null>(null);

  useEffect(() => {
    if (!taskId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDetail(null);

    const tick = async (): Promise<void> => {
      try {
        const res = await client.getTask(taskId);
        if (cancelled) return;
        setDetail(res);
        if (!isTerminalState(res.task.state)) timer = setTimeout(() => void tick(), pollMs);
      } catch {
        if (!cancelled) timer = setTimeout(() => void tick(), pollMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, taskId, pollMs]);

  return detail;
}
