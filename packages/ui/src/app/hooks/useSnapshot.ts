import { useEffect, useMemo, useState } from "react";
import { bootstrapTaskStream, type ParleyClient, type StreamEvent, type TaskRow } from "@useparley/core";
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
}

const EMPTY_TASKS: RosterTaskInput[] = [];

const EMPTY: SnapshotView = {
  tasks: EMPTY_TASKS,
  groups: [],
  sessions: [],
  inbox: [],
  scene: { sessions: [] },
  totalTasks: 0,
  activeTasks: 0,
  durableSessions: 0,
};

function fromRow(row: TaskRow): RosterTaskInput {
  return {
    id: row.id,
    name: row.name ?? row.id,
    vendor: row.vendor,
    state: row.state,
    branch: row.branch,
    orchestratorSession: row.orchestrator_session_id,
    question: row.question,
    updatedAt: row.updated_at,
  };
}

/**
 * Merge a live transition envelope onto the previously known task. The wire
 * envelope (unlike `GET /tasks`'s row) carries no `orchestrator_session_id`
 * (docs/spec/ui-interface-contract.md's SSE payload is the pinned envelope,
 * not the row), so a plain overwrite would blank the session grouping on
 * every transition. Carrying the prior value forward keeps a bootstrap-seeded
 * session stable; a task first observed via SSE starts at `null` and is
 * repaired by the row fetch in {@link useSnapshot}.
 */
function mergeEnvelope(prev: RosterTaskInput | undefined, event: StreamEvent): RosterTaskInput {
  const t = event.task;
  return {
    id: t.task_id,
    name: t.name ?? t.task_id,
    vendor: t.vendor,
    state: t.state,
    branch: t.branch,
    orchestratorSession: prev?.orchestratorSession ?? null,
    question: t.question,
    // A transition is activity — stamp now so session chips re-rank by recency
    // (#88). The wire envelope has no `updated_at`.
    updatedAt: new Date().toISOString(),
  };
}

const RETRY_MS = 3000;

/**
 * Layer 4 (hooks) — bootstrap `GET /tasks` then follow the SSE transition stream
 * (contract's bootstrap: snapshot seq → stream from that seq, no gaps). Maintains
 * a live task map and re-projects the roster view on every transition. The only
 * layer, with {@link useHealth}, importing the core SDK (contract 4). Retries the
 * bootstrap when the daemon is unreachable so the cockpit self-heals on restart.
 *
 * Session attribution: only `GET /tasks` rows carry `orchestrator_session_id`,
 * so a task born after bootstrap (first seen as an SSE envelope) fetches its
 * row once via `GET /tasks/:ref` to join its session group — otherwise every
 * task delegated while the cockpit is open would sit outside the session
 * selector until a reload.
 */
export function useSnapshot(client: ParleyClient): SnapshotView {
  // Live task list — projected into groups/inbox/scene below. Exposed so
  // `useCockpit` can re-project groups under the selected session filter (#76)
  // without forking the SSE merge logic.
  const [tasks, setTasks] = useState<RosterTaskInput[]>(EMPTY_TASKS);

  useEffect(() => {
    let cancelled = false;
    let stream: { close(): void } | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const taskMap = new Map<string, RosterTaskInput>();
    // Task ids whose row we've already asked for (a row may legitimately have
    // no orchestrator session — e.g. CLI-delegated — so "asked" not "found"
    // is what stops the refetching; a failed fetch retries on the next event).
    const sessionFetched = new Set<string>();
    // A `Map`'s `.values()` iterator is single-use — materialize it once so
    // both projections (each a full pass) see every task.
    const emit = (): void => {
      if (!cancelled) setTasks([...taskMap.values()]);
    };

    /** Adopt `session` for `id` when the task is still session-less. */
    const adoptSession = (id: string, session: string | null): void => {
      const current = taskMap.get(id);
      if (!session || !current || current.orchestratorSession !== null) return;
      taskMap.set(id, { ...current, orchestratorSession: session });
      emit();
    };

    /** Fetch the row of a task first seen over SSE, once, for its session. */
    const fetchSession = (id: string): void => {
      if (sessionFetched.has(id)) return;
      sessionFetched.add(id);
      client
        .getTask(id)
        .then(({ row }) => adoptSession(id, row.orchestrator_session_id))
        .catch(() => sessionFetched.delete(id));
    };

    const connect = async (): Promise<void> => {
      try {
        const { snapshot, stream: live } = await bootstrapTaskStream({
          client,
          onEvent: (event) => {
            const merged = mergeEnvelope(taskMap.get(event.task.task_id), event);
            taskMap.set(event.task.task_id, merged);
            if (merged.orchestratorSession === null) fetchSession(merged.id);
            emit();
          },
        });
        if (cancelled) {
          live.close();
          return;
        }
        // Seed from the snapshot without clobbering any transition that already
        // arrived while we awaited: the stream opens at `snapshot.seq`, so every
        // event is newer than the snapshot. Only fill in tasks an event hasn't
        // already set (`taskMap.clear()` here would regress those to stale state)
        // — but do backfill the session, which only rows carry.
        for (const row of snapshot.tasks) {
          sessionFetched.add(row.id);
          if (!taskMap.has(row.id)) taskMap.set(row.id, fromRow(row));
          else adoptSession(row.id, row.orchestrator_session_id);
        }
        stream = live;
        emit();
      } catch {
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
  return useMemo(() => {
    if (tasks.length === 0) return EMPTY;
    return {
      tasks,
      ...projectRoster(tasks),
      inbox: projectInbox(tasks),
      scene: projectScene(tasks),
    };
  }, [tasks]);
}
