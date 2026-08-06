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

/**
 * Backoff before re-bootstrap after a bootstrap failure or SSE stream error.
 * Exported so tests can assert the reconnect path (neuter-proof for HIGH-3/4).
 */
export const STREAM_RETRY_MS = 3000;

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
 * Prefer an explicit next value (including `null`) over prior. Only fall back
 * to `prev` when the wire omitted the field entirely (`undefined`).
 * Prevents null-cleared fields from resurrecting stale values (MED-1).
 */
function pickDefined<T>(next: T | undefined, prev: T | undefined): T | undefined {
  return next !== undefined ? next : prev;
}

/**
 * Merge a live transition envelope onto the previously known task.
 * Wire values win, including explicit `null` clears. Omitted (`undefined`)
 * optional fields keep the prior value for older/partial envelopes.
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
    // Explicit null-clear semantics (do not revive via ??).
    orch_harness: pickDefined(next.orch_harness, prev.orch_harness) ?? null,
    orch_model: pickDefined(next.orch_model, prev.orch_model) ?? null,
    orch_effort: pickDefined(next.orch_effort, prev.orch_effort) ?? null,
    updated_at: next.updated_at || prev.updated_at,
    completed_at: pickDefined(next.completed_at, prev.completed_at) ?? null,
    run_id: pickDefined(next.run_id, prev.run_id),
    node: pickDefined(next.node, prev.node),
    iteration: pickDefined(next.iteration, prev.iteration),
    slot: pickDefined(next.slot, prev.slot),
    runner: pickDefined(next.runner, prev.runner),
    queue_position: pickDefined(next.queue_position, prev.queue_position),
    blocking_cap: pickDefined(next.blocking_cap, prev.blocking_cap),
    max_concurrent: pickDefined(next.max_concurrent, prev.max_concurrent),
    usage: pickDefined(next.usage, prev.usage) ?? null,
    duration_ms: pickDefined(next.duration_ms, prev.duration_ms) ?? null,
    report: pickDefined(next.report, prev.report) ?? null,
    cached_input_tokens: pickDefined(next.cached_input_tokens, prev.cached_input_tokens),
    question: pickDefined(next.question, prev.question) ?? null,
    question_id: pickDefined(next.question_id, prev.question_id) ?? null,
    error: pickDefined(next.error, prev.error) ?? null,
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
 * daemon is unreachable OR the stream drops (idle fleets never see a
 * post-reconnect event that would re-arm `connected` — HIGH-4).
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
    /** Prevents overlapping connect() attempts from error + catch paths. */
    let connecting = false;
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

    const scheduleReconnect = (): void => {
      if (cancelled) return;
      if (retry !== undefined) clearTimeout(retry);
      // STREAM_RETRY_MS backoff — must stay on the stream-error path so idle
      // fleets re-bootstrap without waiting for a task event (HIGH-4).
      retry = setTimeout(() => {
        retry = undefined;
        void connect();
      }, STREAM_RETRY_MS);
    };

    const connect = async (): Promise<void> => {
      if (cancelled || connecting) return;
      connecting = true;
      // Tear down any prior stream before opening a new one.
      if (stream) {
        stream.close();
        stream = null;
      }
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
            // Re-bootstrap on SSE drop. EventSource auto-reconnect alone does
            // not re-arm `connected` on an idle fleet (no inbound task events).
            scheduleReconnect();
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
        // Drop any pending reconnect scheduled by a prior stream error.
        if (retry !== undefined) {
          clearTimeout(retry);
          retry = undefined;
        }
        markConnected();
        if (!cancelled) setReady(true);
        emit({ immediate: true });
      } catch {
        markDisconnected();
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    };

    void connect();
    return () => {
      cancelled = true;
      cancelScheduledFlush();
      if (retry !== undefined) clearTimeout(retry);
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
