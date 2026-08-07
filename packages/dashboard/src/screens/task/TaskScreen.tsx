/**
 * Task inspector screen (#357).
 * Center-only: brief, attempt chain, log tail, Q&A, report, eval, deliverables.
 * Data via useTaskDetail + useLogTail (+ useNodeTasks when run-owned).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useConsoleData,
  useLogTail,
  useNodeTasks,
  useTaskDetail,
  type PanelStatus,
} from "../../data/index.js";
import { CopyScaffold } from "../../components/index.js";
import { loadSettings, saveSettings } from "../../chrome/settings.js";
import type { ScreenMountProps } from "../types.js";
import {
  AskBand,
  AttemptChain,
  BriefPanel,
  DeliverablesPanel,
  EvalFeedback,
  LogTailPanel,
  QaPanel,
  ReportPanel,
  TaskHeader,
  WhyFailedWell,
  type DeliverableFetchState,
} from "./panels.js";
import { delegateScaffold } from "./scaffolds.js";
import "./task.css";

/** Same-tab settings sync (storage events only fire cross-tab). */
export const SETTINGS_SYNC_EVENT = "parley-console-settings";


function persistFollow(next: boolean): void {
  const cur = loadSettings();
  if (cur.followLogs === next) return;
  saveSettings({ ...cur, followLogs: next });
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(SETTINGS_SYNC_EVENT, { detail: { followLogs: next } }),
    );
  }
}

export function TaskScreen(props: ScreenMountProps) {
  const { client, snapshot } = useConsoleData();
  const { selectedTaskId } = props;

  const [follow, setFollow] = useState(() => loadSettings().followLogs);
  const [branchCopied, setBranchCopied] = useState(false);

  // Keep follow in sync: cross-tab storage, same-tab custom event, settings checkbox.
  useEffect(() => {
    const syncFromStore = (): void => {
      setFollow(loadSettings().followLogs);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "parley-console.settings.v1") syncFromStore();
    };
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<{ followLogs?: boolean }>).detail;
      if (typeof detail?.followLogs === "boolean") setFollow(detail.followLogs);
      else syncFromStore();
    };
    // Shell settings checkbox writes via React onChange → saveSettings; capture
    // the DOM change so same-tab updates reach the inspector without a storage event.
    const onDocChange = (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.getAttribute("data-testid") === "settings-follow-logs") {
        window.setTimeout(syncFromStore, 0);
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(SETTINGS_SYNC_EVENT, onCustom);
    document.addEventListener("change", onDocChange, true);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SETTINGS_SYNC_EVENT, onCustom);
      document.removeEventListener("change", onDocChange, true);
    };
  }, []);

  const detail = useTaskDetail(client, selectedTaskId);
  const logs = useLogTail(client, selectedTaskId, follow);

  const task = detail.data?.task ?? null;
  const runRef = task?.run_id ?? null;
  const node = task?.node ?? null;
  const nodeQuery = useMemo(
    () => ({
      iteration: task?.iteration ?? undefined,
      slot: task?.slot ?? undefined,
    }),
    [task?.iteration, task?.slot],
  );

  const nodeTasks = useNodeTasks(client, {
    runRef,
    node,
    query: nodeQuery,
    snapshotTasks: snapshot.tasks,
    enabled: Boolean(runRef && node),
  });

  const goal = useMemo(() => {
    const row = detail.data?.row;
    if (row && typeof row.prompt === "string" && row.prompt.trim()) return row.prompt;
    return null;
  }, [detail.data?.row]);

  const panelStatus: PanelStatus = detail.status;
  const detailUnavailable = detail.status === "error" && !detail.data;

  const deliverableState = useMemo((): {
    fetchState: DeliverableFetchState;
    error: string | null;
    /** null = unknown (detail fetch failed); true/false when known. */
    hasRun: boolean | null;
  } => {
    if (detailUnavailable) {
      return {
        fetchState: "error",
        error: detail.error
          ? `Deliverables unavailable — ${detail.error}`
          : "Deliverables unavailable — task detail failed to load.",
        hasRun: null,
      };
    }
    if (!runRef || !node) {
      return { fetchState: "none", error: null, hasRun: false };
    }
    if (nodeTasks.status === "idle") {
      return { fetchState: "not_fetched", error: null, hasRun: true };
    }
    if (nodeTasks.status === "loading") {
      return { fetchState: "loading", error: null, hasRun: true };
    }
    if (nodeTasks.status === "error") {
      const msg = nodeTasks.error ?? "";
      if (/worktree|workspace removed|missing/i.test(msg)) {
        return { fetchState: "missing-worktree", error: msg, hasRun: true };
      }
      return {
        fetchState: "error",
        error: msg || "deliverable fetch failed",
        hasRun: true,
      };
    }
    const items = nodeTasks.data?.deliverables ?? [];
    if (items.length === 0) {
      return { fetchState: "none", error: null, hasRun: true };
    }
    if (items.every((d) => d.purged_at != null)) {
      return { fetchState: "purged", error: null, hasRun: true };
    }
    return { fetchState: "ready", error: null, hasRun: true };
  }, [
    detailUnavailable,
    detail.error,
    runRef,
    node,
    nodeTasks.status,
    nodeTasks.error,
    nodeTasks.data,
  ]);

  const onCopyBranch = useCallback(() => {
    const branch = task?.branch;
    if (!branch) return;
    void (async () => {
      try {
        await navigator.clipboard.writeText(branch);
        setBranchCopied(true);
        window.setTimeout(() => setBranchCopied(false), 1600);
      } catch {
        /* ignore */
      }
    })();
  }, [task?.branch]);

  const onFollowChange = useCallback((next: boolean) => {
    // Persist both directions; useLogTail keeps its cursor across follow toggles.
    setFollow(next);
    persistFollow(next);
  }, []);

  // ── Empty: no task selected ──────────────────────────────────────────
  if (!selectedTaskId) {
    return (
      <div className="pc-task pc-task--empty" data-testid="screen-task" data-screen="task">
        <span className="pc-screen__eyebrow">task inspector</span>
        <h1 className="pc-task__empty-title">No task selected</h1>
        <p className="pc-task__empty-note">
          Pick a task from find or the fleet board. The console is observation-only —
          hand verbs to the orchestrating agent with a ready-to-paste scaffold.
        </p>
        <CopyScaffold
          text={delegateScaffold()}
          variant="block"
          label="copy"
          testId="task-delegate-scaffold"
        />
      </div>
    );
  }

  const showFailedWell = Boolean(task?.error);

  // Outstanding ask: full-width band outranks hello envelope and all panels.
  const outstandingTurn = useMemo(() => {
    const qa = detail.data?.qa ?? [];
    return qa.find((t) => t.answer == null) ?? null;
  }, [detail.data?.qa]);
  const askQuestion =
    outstandingTurn?.question?.trim() ||
    (task?.state === "awaiting_answer" ? task.question?.trim() : null) ||
    null;
  const showAskBand = Boolean(selectedTaskId && askQuestion);

  const connectionBand =
    detail.status === "error" && !detail.data ? (
      <div className="pc-task-band pc-task-band--error" data-testid="task-band-error" role="alert">
        Task detail failed: {detail.error ?? "unknown error"}
      </div>
    ) : detail.status === "error" && detail.data ? (
      <div className="pc-task-band pc-task-band--stale" data-testid="task-band-stale" role="status">
        Detail stale — replaying last good snapshot. {detail.error}
      </div>
    ) : logs.status === "unreachable" ? (
      <div
        className="pc-task-band pc-task-band--offline"
        data-testid="task-band-log-drop"
        role="status"
      >
        Log tail stream dropped while inspecting — status is unreachable, not frozen silent.
      </div>
    ) : null;

  return (
    <div
      className="pc-task"
      data-testid="screen-task"
      data-screen="task"
      data-task-id={selectedTaskId}
      data-detail-status={detail.status}
      data-log-status={logs.status}
    >
      {task ? (
        <TaskHeader task={task} onCopyBranch={onCopyBranch} branchCopied={branchCopied} />
      ) : (
        <header className="pc-task-header" data-testid="task-header">
          <div className="pc-task-header__id">
            <h1 className="pc-task-header__name">{selectedTaskId}</h1>
            <span className="pc-task-header__ids">
              {detail.status === "loading" ? "loading detail…" : "detail unavailable"}
            </span>
          </div>
        </header>
      )}
      {connectionBand}
      {showAskBand && selectedTaskId && askQuestion ? (
        <AskBand taskId={selectedTaskId} question={askQuestion} />
      ) : null}
      <div className="pc-task-body" data-testid="task-body">
        <div
          className="pc-task-col pc-task-col--left"
          data-testid="task-col-left"
          tabIndex={0}
          aria-label="Task brief and attempts"
        >
          {showFailedWell && task ? (
            <WhyFailedWell taskId={task.task_id} error={task.error} />
          ) : null}
          <BriefPanel
            task={task}
            goal={goal}
            status={panelStatus}
            error={detail.error}
          />
          <AttemptChain
            attempts={detail.data?.attempts ?? []}
            currentId={task?.task_id ?? selectedTaskId}
            status={panelStatus}
          />
          <EvalFeedback
            detail={detail.data?.eval_detail ?? null}
            status={panelStatus}
          />
          <DeliverablesPanel
            fetchState={deliverableState.fetchState}
            items={nodeTasks.data?.deliverables ?? []}
            error={deliverableState.error}
            hasRun={deliverableState.hasRun}
          />
        </div>

        <div
          className="pc-task-col pc-task-col--log"
          data-testid="task-col-log"
          // Log well owns scroll focus; column is a layout track only.
        >
          <LogTailPanel
            lines={logs.lines}
            status={logs.status}
            follow={follow}
            onFollowChange={onFollowChange}
            taskId={selectedTaskId}
          />
        </div>

        <div
          className="pc-task-col pc-task-col--right"
          data-testid="task-col-right"
          tabIndex={0}
          aria-label="Task Q and A and report"
        >
          <QaPanel
            taskId={selectedTaskId}
            qa={detail.data?.qa ?? []}
            status={panelStatus}
            scaffoldInBand={showAskBand}
          />
          <ReportPanel
            report={task?.report ?? null}
            status={panelStatus}
            taskState={task?.state ?? null}
          />
        </div>
      </div>
    </div>
  );
}
