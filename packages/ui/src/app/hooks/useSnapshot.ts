import { useEffect, useState } from "react";
import {
  attentionRank,
  bootstrapTaskStream,
  isTerminalState,
  type ParleyClient,
  type StreamEvent,
  type TaskRow,
} from "@useparley/core";
import { factionFor } from "../../tokens/factions.js";
import type { RosterGroup, RosterTask } from "../../hud/types.js";

/** The projected roster + counts hud consumes. */
export interface SnapshotView {
  groups: RosterGroup[];
  totalTasks: number;
  activeTasks: number;
  durableSessions: number;
}

/** Internal per-task slice, shared by the snapshot rows and live envelopes. */
interface TaskLite {
  id: string;
  name: string;
  vendor: string | null;
  state: string;
  session: string | null;
  branch: string | null;
}

const EMPTY: SnapshotView = { groups: [], totalTasks: 0, activeTasks: 0, durableSessions: 0 };

function fromRow(row: TaskRow): TaskLite {
  return {
    id: row.id,
    name: row.name ?? row.id,
    vendor: row.vendor,
    state: row.state,
    session: row.session_id,
    branch: row.branch,
  };
}

function fromEnvelope(event: StreamEvent): TaskLite {
  const t = event.task;
  return {
    id: t.task_id,
    name: t.name ?? t.task_id,
    vendor: t.vendor,
    state: t.state,
    session: t.session_id,
    branch: t.branch,
  };
}

function toRosterTask(task: TaskLite): RosterTask {
  const faction = factionFor(task.vendor);
  const shortId = task.id.length > 8 ? task.id.slice(0, 8) : task.id;
  return {
    id: task.id,
    name: task.name,
    coat: faction.coat,
    emblem: faction.emblem,
    meta: `${task.branch ?? "no branch"} · ${shortId}`,
  };
}

/** Project the live task map into the roster view — grouped by state, groups
 * ordered by attention rank (the only ordering authority is core's constants). */
function project(tasks: Map<string, TaskLite>): SnapshotView {
  const byState = new Map<string, RosterTask[]>();
  const sessions = new Set<string>();
  let activeTasks = 0;
  for (const task of tasks.values()) {
    if (!byState.has(task.state)) byState.set(task.state, []);
    byState.get(task.state)!.push(toRosterTask(task));
    if (!isTerminalState(task.state)) {
      activeTasks += 1;
      if (task.session) sessions.add(task.session);
    }
  }
  const groups: RosterGroup[] = [...byState.entries()]
    .map(([state, rosterTasks]) => ({ state, tasks: rosterTasks }))
    .sort((a, b) => attentionRank(a.state) - attentionRank(b.state));
  return {
    groups,
    totalTasks: tasks.size,
    activeTasks,
    durableSessions: sessions.size,
  };
}

const RETRY_MS = 3000;

/**
 * Layer 4 (hooks) — bootstrap `GET /tasks` then follow the SSE transition stream
 * (contract's bootstrap: snapshot seq → stream from that seq, no gaps). Maintains
 * a live task map and re-projects the roster view on every transition. The only
 * layer, with {@link useHealth}, importing the core SDK (contract 4). Retries the
 * bootstrap when the daemon is unreachable so the cockpit self-heals on restart.
 */
export function useSnapshot(client: ParleyClient): SnapshotView {
  const [view, setView] = useState<SnapshotView>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let stream: { close(): void } | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const tasks = new Map<string, TaskLite>();

    const connect = async (): Promise<void> => {
      try {
        const { snapshot, stream: live } = await bootstrapTaskStream({
          client,
          onEvent: (event) => {
            tasks.set(event.task.task_id, fromEnvelope(event));
            if (!cancelled) setView(project(tasks));
          },
        });
        if (cancelled) {
          live.close();
          return;
        }
        // Seed from the snapshot without clobbering any transition that already
        // arrived while we awaited: the stream opens at `snapshot.seq`, so every
        // event is newer than the snapshot. Only fill in tasks an event hasn't
        // already set (`tasks.clear()` here would regress those to stale state).
        for (const row of snapshot.tasks) {
          if (!tasks.has(row.id)) tasks.set(row.id, fromRow(row));
        }
        stream = live;
        setView(project(tasks));
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

  return view;
}
