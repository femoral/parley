import { useEffect, useMemo, useState } from "react";
import {
  bootstrapTaskStream,
  type ParleyClient,
  type StreamEvent,
  type TaskEnvelope,
} from "@useparley/core";
import { projectInbox } from "./inbox.js";
import { projectRoster, type RosterTaskInput } from "./roster.js";
import { projectScene, type SceneView } from "./scene.js";
import type { InboxTask, RosterGroup, RosterSessionOption } from "../../hud/types.js";

/** The projected roster + inbox + scene + counts hud/scene consume. */
export interface SnapshotView {
  /**
   * Live task inputs for re-projection (e.g. session-filtered roster groups
   * in {@link useCockpit}). Identity-stable between snapshot updates.
   */
  tasks: RosterTaskInput[];
  groups: RosterGroup[];
  sessions: RosterSessionOption[];
  /** Tasks blocked on an answer, sorted awaiting-first (#67). */
  inbox: InboxTask[];
  /** The living scene's regions — one per session, each with its task-islands
   * (#69). Projected from the same task list as `groups`/`inbox`, so every
   * island's state agrees with its roster badge and inbox card. */
  scene: SceneView;
  totalTasks: number;
  activeTasks: number;
  durableSessions: number;
  /**
   * Whether the bootstrap+SSE stream is currently live. False while connecting,
   * after a bootstrap failure, or after a stream error until an event arrives
   * again (EventSource auto-reconnect) or a full re-bootstrap succeeds.
   */
  connected: boolean;
  /**
   * True once the first bootstrap snapshot has resolved successfully (even when
   * the fleet is empty). Latches for the session so roster/scene can distinguish
   * "taking soundings" from a genuinely quiet cove.
   */
  ready: boolean;
  /**
   * Epoch ms when the stream last became disconnected/erroring, or `null`
   * while {@link connected}. Surfaces "stream lost since <t>" for the shell.
   */
  streamLostSince: number | null;
}

const EMPTY_TASKS: RosterTaskInput[] = [];

const EMPTY_PROJECTION = {
  tasks: EMPTY_TASKS,
  groups: [] as RosterGroup[],
  sessions: [] as RosterSessionOption[],
  inbox: [] as InboxTask[],
  scene: { sessions: [] } as SceneView,
  totalTasks: 0,
  activeTasks: 0,
  durableSessions: 0,
};

/** Project a wire envelope into the roster input DTO (#208). */
function fromEnvelope(task: TaskEnvelope): RosterTaskInput {
  return {
    id: task.task_id,
    name: task.name ?? task.task_id,
    vendor: task.vendor,
    model: task.model,
    orchHarness: task.orch_harness ?? null,
    state: task.state,
    branch: task.branch,
    orchestratorSession: task.orchestrator_session_id,
    question: task.question,
    updatedAt: task.updated_at,
  };
}

/**
 * Merge a live transition envelope onto the previously known task. Session,
 * recency, and orch harness now ride the envelope (#208) so the common path
 * needs no row backfill. Prior values only fill gaps when an older envelope
 * omits an optional field.
 */
function mergeEnvelope(prev: RosterTaskInput | undefined, event: StreamEvent): RosterTaskInput {
  const next = fromEnvelope(event.task);
  return {
    ...next,
    orchHarness: next.orchHarness ?? prev?.orchHarness ?? null,
    orchestratorSession: next.orchestratorSession ?? prev?.orchestratorSession ?? null,
    // Prefer the wire timestamp; fall back to prior or wall clock if absent.
    updatedAt: next.updatedAt || prev?.updatedAt || new Date().toISOString(),
  };
}

const RETRY_MS = 3000;

/** States that no longer change on their own — the only eviction candidates. */
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

/**
 * How many terminal (completed/failed/cancelled) tasks the live map retains.
 * Active tasks are never evicted. Generous enough that a realistic day's
 * archive stays fully visible in the roster, while bounding the one true
 * unbounded-growth vector of an all-day session: without a cap, memory and
 * the per-SSE-event projection cost grow with every task ever seen.
 */
export const TERMINAL_TASK_CAP = 500;

/**
 * Drop the oldest terminal tasks over {@link TERMINAL_TASK_CAP}, oldest
 * `updatedAt` first (ISO strings — lexicographic order is chronological).
 * Mutates `taskMap` (and optional `fetched`, so any companion set stays bounded).
 */
export function evictTerminalOverflow(
  taskMap: Map<string, RosterTaskInput>,
  fetched?: Set<string>,
  cap: number = TERMINAL_TASK_CAP,
): void {
  const terminals: RosterTaskInput[] = [];
  for (const task of taskMap.values()) {
    if (TERMINAL_STATES.has(task.state)) terminals.push(task);
  }
  if (terminals.length <= cap) return;
  // updatedAt may be null on freshly-merged rows — treat missing as oldest.
  const key = (t: RosterTaskInput): string => t.updatedAt ?? "";
  terminals.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const drop = terminals.length - cap;
  for (let i = 0; i < drop; i++) {
    const id = terminals[i]!.id;
    taskMap.delete(id);
    fetched?.delete(id);
  }
}

/**
 * Layer 4 (hooks) — bootstrap `GET /tasks` then follow the SSE transition stream
 * (contract's bootstrap: snapshot seq → stream from that seq, no gaps). Maintains
 * a live task map and re-projects the roster view on every transition. The only
 * layer, with {@link useHealth}, importing the core SDK (contract 4). Retries the
 * bootstrap when the daemon is unreachable so the cockpit self-heals on restart.
 *
 * List and stream both ship {@link TaskEnvelope} (#208), so session grouping
 * and recency come straight off the wire — no per-task detail fetch on the
 * live path. Detail inspector still uses `GET /tasks/:ref` for qa/eval/attempts.
 */
export function useSnapshot(client: ParleyClient): SnapshotView {
  // Live task list — projected into groups/inbox/scene below. Exposed so
  // `useCockpit` can re-project groups under the selected session filter (#76)
  // without forking the SSE merge logic.
  const [tasks, setTasks] = useState<RosterTaskInput[]>(EMPTY_TASKS);
  // Transport liveness — separate from the projected task list so a disconnect
  // can flip honesty signals without inventing empty-fleet snapshots.
  const [connected, setConnected] = useState(false);
  // Latches true after the first successful bootstrap so empty-fleet and
  // pre-snapshot UIs never share copy.
  const [ready, setReady] = useState(false);
  const [streamLostSince, setStreamLostSince] = useState<number | null>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    let stream: { close(): void } | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const taskMap = new Map<string, RosterTaskInput>();
    // A `Map`'s `.values()` iterator is single-use — materialize it once so
    // both projections (each a full pass) see every task. Eviction runs here —
    // the one funnel every mutation passes through — so the map can never
    // grow past the cap between emits.
    const emit = (): void => {
      if (cancelled) return;
      evictTerminalOverflow(taskMap);
      setTasks([...taskMap.values()]);
    };

    /** Mark the stream live (bootstrap success or post-error event after reconnect). */
    const markConnected = (): void => {
      if (cancelled) return;
      setConnected(true);
      setStreamLostSince(null);
    };

    /** Mark the stream lost; keep the first lost-at timestamp across repeated errors. */
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
            // An event after an error means EventSource auto-reconnected — chart is live again.
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
        // Seed from the snapshot without clobbering any transition that already
        // arrived while we awaited: the stream opens at `snapshot.seq`, so every
        // event is newer than the snapshot. Only fill in tasks an event hasn't
        // already set (`taskMap.clear()` here would regress those to stale state).
        for (const task of snapshot.tasks) {
          if (!taskMap.has(task.task_id)) taskMap.set(task.task_id, fromEnvelope(task));
        }
        stream = live;
        markConnected();
        if (!cancelled) setReady(true);
        emit();
      } catch {
        markDisconnected();
        if (!cancelled) retry = setTimeout(() => void connect(), RETRY_MS);
      }
    };

    void connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      stream?.close();
    };
  }, [client]);

  // Unfiltered projection — health/scene/inbox and the base roster. Session
  // filtering for the roster list is applied in `useCockpit` via a second
  // `projectRoster(tasks, selectedSessionId)` so selection stays cockpit-owned.
  // Transport fields ride along so the shell can compose chart-staleness without
  // a second subscription to the same client.
  return useMemo(() => {
    const projected =
      tasks.length === 0
        ? EMPTY_PROJECTION
        : {
            tasks,
            ...projectRoster(tasks),
            inbox: projectInbox(tasks),
            scene: projectScene(tasks),
          };
    return {
      ...projected,
      connected,
      ready,
      streamLostSince,
    };
  }, [tasks, connected, ready, streamLostSince]);
}
