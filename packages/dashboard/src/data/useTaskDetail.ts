/**
 * Fetch `GET /tasks/:ref` for the task screen (qa/eval/attempts companions).
 * Polls while live; stops at terminal. Visibility-gated via usePolling.
 */
import { useCallback, useEffect, useState } from "react";
import { isTerminalState, type ParleyClient } from "@useparley/core";
import type { TaskDetailView } from "./types.js";
import { usePolling } from "./usePolling.js";

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
  const [pollEnabled, setPollEnabled] = useState(false);

  useEffect(() => {
    if (!taskId) {
      setState(INITIAL);
      setPollEnabled(false);
      return;
    }
    setState({ status: "loading", data: null, error: null });
    setPollEnabled(true);
  }, [taskId]);

  const tick = useCallback(async (): Promise<void> => {
    if (!taskId) return;
    try {
      const res = await client.getTask(taskId);
      setState({ status: "ready", data: res, error: null });
      if (isTerminalState(res.task.state)) {
        setPollEnabled(false);
      }
    } catch (err) {
      setState((prev) => ({
        status: "error",
        data: prev.data,
        error: err instanceof Error ? err.message : "task detail failed",
      }));
    }
  }, [client, taskId]);

  usePolling(tick, { intervalMs: pollMs, enabled: pollEnabled && Boolean(taskId) });

  return state;
}
