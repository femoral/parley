import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ParleyClient } from "@useparley/core";
import type { HealthView, InspectorTask, QaTurn } from "../../hud/types.js";
import { formatClock, formatUptime } from "./format.js";
import { useHealth } from "./useHealth.js";
import { projectInspector } from "./inspector.js";
import { useLogTail } from "./useLogTail.js";
import { useSnapshot, type SnapshotView } from "./useSnapshot.js";
import { useTaskDetail } from "./useTaskDetail.js";

/** The roster's selection state — which orchestrator session and task are
 * active (#66). Lives in the app layer: hud rows/selectors take the current
 * selection and an `onSelect*` callback as plain props and never own it.
 * Plain setter semantics — re-selecting the active session is a no-op; the
 * "All hands" chip (passing `null`) is the one deselect affordance. */
export interface RosterSelection {
  selectedSessionId: string | null;
  selectedTaskId: string | null;
  selectSession: (id: string | null) => void;
  selectTask: (id: string) => void;
}

/** Identity-stable empty history, so a task with no answered turns doesn't
 * feed the inspector memo a fresh `[]` every render. */
const EMPTY_QA: QaTurn[] = [];

export interface CockpitView {
  health: HealthView;
  snapshot: SnapshotView;
  roster: RosterSelection;
  /** Wall-clock `HH:MM` for the day chip. */
  clock: string;
  /** Days the cove has been open (flavour: real elapsed days, min 1). */
  day: number;
  /**
   * The single v1 write (#67): `POST /tasks/:ref/answer`. Rejects with the
   * daemon's error on failure — the inbox card catches it and stays put; on
   * success the state flip arrives over SSE and `useSnapshot` re-projects the
   * task out of the inbox, no reload.
   */
  answerTask: (id: string, text: string) => Promise<void>;
  /** The selected task's inspector payload (#68), or `null` with no selection. */
  inspector: InspectorTask | null;
}

/**
 * Layer 4 (app) — the single hook the cockpit shell reads. Owns the same-origin
 * `ParleyClient` and the one-second tick, composes `useHealth` + `useSnapshot`,
 * and projects everything (including browser-origin host/port and derived
 * uptime) into the plain view objects hud renders. Keeping all `@useparley/core`
 * use behind hooks means Cockpit and every layer below take plain props
 * (component-system spec contract 4).
 */
export function useCockpit(): CockpitView {
  const client = useMemo(() => new ParleyClient({ baseUrl: "" }), []);
  const health = useHealth(client);
  const snapshot = useSnapshot(client);
  const [now, setNow] = useState(() => Date.now());
  // useState setters are identity-stable, so hud components (memoized against
  // the cockpit's one-second clock re-render) can take them as props directly.
  const [selectedSessionId, selectSession] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectTask: (id: string) => void = setSelectedTaskId;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const origin = typeof window !== "undefined" ? window.location : undefined;
  const healthView: HealthView = {
    online: health.online,
    version: health.version,
    pid: health.pid,
    host: origin?.hostname || "127.0.0.1",
    port: origin?.port || "—",
    uptime: health.startedAt !== null ? formatUptime(now - health.startedAt) : "",
    activeAgents: snapshot.activeTasks,
    totalTasks: snapshot.totalTasks,
    durableSessions: snapshot.durableSessions,
  };

  const day =
    health.startedAt !== null
      ? Math.max(1, Math.floor((now - health.startedAt) / 86_400_000) + 1)
      : 1;

  const roster: RosterSelection = { selectedSessionId, selectedTaskId, selectSession, selectTask };

  // The daemon persists no Q&A transcript — only the task's *current*
  // outstanding question (`useTaskDetail`'s row/envelope). Each answered turn
  // is remembered here, client-side, for as long as the cockpit stays open,
  // keyed by task id; `projectInspector` appends the live outstanding
  // question (if any) on top of this history (#68's Q&A tab).
  const [qaHistory, setQaHistory] = useState<Map<string, QaTurn[]>>(new Map());

  // Read the inbox through a ref so `answerTask` keeps a stable identity
  // across snapshot updates — `InboxPanel` is memoized against exactly that
  // (its doc comment: "tasks/onAnswer are identity-stable between snapshot
  // updates"), and a `snapshot.inbox` dependency here would hand it a fresh
  // callback on every SSE transition anywhere in the roster.
  const inboxRef = useRef(snapshot.inbox);
  inboxRef.current = snapshot.inbox;

  const answerTask = useCallback(
    (id: string, text: string) => {
      const question = inboxRef.current.find((task) => task.id === id)?.question ?? null;
      return client.answer(id, text).then(() => {
        if (question === null) return;
        setQaHistory((prev) => {
          const next = new Map(prev);
          next.set(id, [...(next.get(id) ?? []), { question, answer: text }]);
          return next;
        });
      });
    },
    [client],
  );

  const detail = useTaskDetail(client, selectedTaskId);
  const logs = useLogTail(client, selectedTaskId);
  // Memoized so the one-second clock tick doesn't mint a fresh InspectorTask
  // (the memoized Inspector would re-render its whole tab body every second).
  // The id guard drops one frame of stale detail when the selection changes
  // (useTaskDetail resets in an effect, i.e. after this render already ran).
  const inspector: InspectorTask | null = useMemo(
    () =>
      detail && detail.task.task_id === selectedTaskId
        ? projectInspector(detail, logs, qaHistory.get(selectedTaskId) ?? EMPTY_QA)
        : null,
    [detail, logs, qaHistory, selectedTaskId],
  );

  return {
    health: healthView,
    snapshot,
    roster,
    clock: formatClock(new Date(now)),
    day,
    answerTask,
    inspector,
  };
}
