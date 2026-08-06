/**
 * Bootstrap `GET /tasks` + SSE transition stream. Keeps full {@link TaskEnvelope}
 * values (tokens, duration, usage, report, queue fields) so fleet / task /
 * firehose projections read wire data without a second fetch on the live path.
 */
import { useEffect, useMemo, useState } from "react";
import {
  bootstrapTaskStream,
  isTerminalState,
  type ParleyClient,
  type StreamEvent,
  type TaskEnvelope,
} from "@useparley/core";
import type { SnapshotView } from "./types.js";

const EMPTY_TASKS: TaskEnvelope[] = [];
const RETRY_MS = 3000;

/**
 * How many terminal tasks the live map retains. Active tasks are never
 * evicted. Bounds unbounded growth of an all-day session.
 */
export const TERMINAL_TASK_CAP = 500;

/**
 * Drop the oldest terminal tasks over the cap (oldest `updated_at` first).
 * Mutates `taskMap`.
 */
export function evictTerminalOverflow(
  taskMap: Map<string, TaskEnvelope>,
  cap: number = TERMINAL_TASK_CAP,
): void {
  const terminals: TaskEnvelope[] = [];
  for (const task of taskMap.values()) {
    if (isTerminalState(task.state)) terminals.push(task);
  }
  if (terminals.length <= cap) return;
  const key = (t: TaskEnvelope): string => t.updated_at ?? "";
  terminals.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const drop = terminals.length - cap;
  for (let i = 0; i < drop; i++) {
    taskMap.delete(terminals[i]!.task_id);
  }
}

/**
 * Merge a live transition envelope onto the previously known task. Prefer
 * wire values; fill optional gaps from prior when a partial envelope omits them.
 */
export function mergeEnvelope(
  prev: TaskEnvelope | undefined,
  event: StreamEvent,
): TaskEnvelope {
  const next = event.task;
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    // Prefer wire; fall back to prior for optional fields older envelopes omit.
    orch_harness: next.orch_harness ?? prev.orch_harness ?? null,
    orch_model: next.orch_model ?? prev.orch_model ?? null,
    orch_effort: next.orch_effort ?? prev.orch_effort ?? null,
    updated_at: next.updated_at || prev.updated_at,
    completed_at: next.completed_at ?? prev.completed_at ?? null,
    run_id: next.run_id !== undefined ? next.run_id : prev.run_id,
    node: next.node !== undefined ? next.node : prev.node,
    iteration: next.iteration !== undefined ? next.iteration : prev.iteration,
    slot: next.slot !== undefined ? next.slot : prev.slot,
    runner: next.runner !== undefined ? next.runner : prev.runner,
    queue_position:
      next.queue_position !== undefined ? next.queue_position : prev.queue_position,
    blocking_cap: next.blocking_cap !== undefined ? next.blocking_cap : prev.blocking_cap,
    max_concurrent:
      next.max_concurrent !== undefined ? next.max_concurrent : prev.max_concurrent,
    usage: next.usage ?? prev.usage,
    duration_ms: next.duration_ms ?? prev.duration_ms,
    report: next.report ?? prev.report,
    cached_input_tokens:
      next.cached_input_tokens !== undefined
        ? next.cached_input_tokens
        : prev.cached_input_tokens,
  };
}

function countActive(tasks: readonly TaskEnvelope[]): number {
  let n = 0;
  for (const t of tasks) {
    if (!isTerminalState(t.state)) n += 1;
  }
  return n;
}

/**
 * Layer 4 — live task map from bootstrap + SSE. Retries bootstrap when the
 * daemon is unreachable so the console self-heals on restart.
 */
export function useSnapshot(client: ParleyClient): SnapshotView {
  const [tasks, setTasks] = useState<TaskEnvelope[]>(EMPTY_TASKS);
  const [seq, setSeq] = useState(0);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [streamLostSince, setStreamLostSince] = useState<number | null>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    let stream: { close(): void } | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let emitRafId: number | null = null;
    let emitTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const taskMap = new Map<string, TaskEnvelope>();

    const flush = (): void => {
      if (cancelled) return;
      setTasks([...taskMap.values()]);
    };

    const cancelScheduledFlush = (): void => {
      if (emitRafId !== null) {
        cancelAnimationFrame(emitRafId);
        emitRafId = null;
      }
      if (emitTimeoutId !== null) {
        clearTimeout(emitTimeoutId);
        emitTimeoutId = null;
      }
    };

    const scheduleFlush = (): void => {
      if (cancelled || emitRafId !== null || emitTimeoutId !== null) return;
      if (typeof requestAnimationFrame === "function") {
        emitRafId = requestAnimationFrame(() => {
          emitRafId = null;
          flush();
        });
      } else {
        emitTimeoutId = setTimeout(() => {
          emitTimeoutId = null;
          flush();
        }, 0);
      }
    };

    const emit = (opts?: { immediate?: boolean }): void => {
      evictTerminalOverflow(taskMap);
      if (opts?.immediate) {
        cancelScheduledFlush();
        flush();
      } else {
        scheduleFlush();
      }
    };

    const markConnected = (): void => {
      if (cancelled) return;
      setConnected(true);
      setStreamLostSince(null);
    };

    const markDisconnected = (): void => {
      if (cancelled) return;
      setConnected(false);
      setStreamLostSince((prev) => prev ?? Date.now());
    };

    const connect = async (): Promise<void> => {
      try {
        const { snapshot, stream: live } = await bootstrapTaskStream({
          client,
          onEvent: (event) => {
            markConnected();
            const merged = mergeEnvelope(taskMap.get(event.task.task_id), event);
            taskMap.set(event.task.task_id, merged);
            emit();
          },
          onError: () => {
            markDisconnected();
          },
        });
        if (cancelled) {
          live.close();
          return;
        }
        for (const task of snapshot.tasks) {
          if (!taskMap.has(task.task_id)) taskMap.set(task.task_id, task);
        }
        stream = live;
        setSeq(snapshot.seq);
        markConnected();
        if (!cancelled) setReady(true);
        emit({ immediate: true });
      } catch {
        markDisconnected();
        if (!cancelled) retry = setTimeout(() => void connect(), RETRY_MS);
      }
    };

    void connect();
    return () => {
      cancelled = true;
      cancelScheduledFlush();
      if (retry) clearTimeout(retry);
      stream?.close();
    };
  }, [client]);

  return useMemo(
    () => ({
      tasks,
      seq,
      connected,
      ready,
      streamLostSince,
      totalTasks: tasks.length,
      activeTasks: countActive(tasks),
    }),
    [tasks, seq, connected, ready, streamLostSince],
  );
}
