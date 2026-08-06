/**
 * Fetch `GET /tasks/:ref` for the task screen (qa/eval/attempts companions).
 * Polls while live; stops at terminal.
 */
import { useEffect, useState } from "react";
import { isTerminalState, type ParleyClient } from "@useparley/core";
import type { TaskDetailView } from "./types.js";

const DEFAULT_POLL_MS = 3000;

const INITIAL: TaskDetailView = {
  status: "idle",
  data: null,
  error: null,
};

export function useTaskDetail(
  client: ParleyClient,
  taskId: string | null,
  pollMs = DEFAULT_POLL_MS,
): TaskDetailView {
  const [state, setState] = useState<TaskDetailView>(INITIAL);

  useEffect(() => {
    if (!taskId) {
      setState(INITIAL);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ status: "loading", data: null, error: null });

    const tick = async (): Promise<void> => {
      try {
        const res = await client.getTask(taskId);
        if (cancelled) return;
        setState({ status: "ready", data: res, error: null });
        if (!isTerminalState(res.task.state)) {
          timer = setTimeout(() => void tick(), pollMs);
        }
      } catch (err) {
        if (cancelled) return;
        setState((prev) => ({
          status: "error",
          data: prev.data,
          error: err instanceof Error ? err.message : "task detail failed",
        }));
        timer = setTimeout(() => void tick(), pollMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, taskId, pollMs]);

  return state;
}
