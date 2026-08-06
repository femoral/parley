/**
 * Task inspector screen (#357).
 * Center-only: brief, attempt chain, log tail, Q&A, report, eval, deliverables.
 * Data via useTaskDetail + useLogTail (+ useNodeTasks when run-owned).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ParleyClient } from "@useparley/core";
import {
  useLogTail,
  useNodeTasks,
  useSnapshot,
  useTaskDetail,
  type PanelStatus,
} from "../../data/index.js";
import { loadSettings } from "../../chrome/settings.js";
import type { ScreenMountProps } from "../types.js";
import { CopyScaffold } from "./CopyScaffold.js";
import {
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

function createClient(): ParleyClient {
  return new ParleyClient({ baseUrl: "" });
}

export function TaskScreen(props: ScreenMountProps) {
  const client = useMemo(createClient, []);
  const { selectedTaskId } = props;

  const [follow, setFollow] = useState(() => loadSettings().followLogs);
  const [branchCopied, setBranchCopied] = useState(false);

  // Keep follow in sync when settings change in another tab / shell.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "parley-console.settings.v1" && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue) as { followLogs?: boolean };
          if (typeof parsed.followLogs === "boolean") setFollow(parsed.followLogs);
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const detail = useTaskDetail(client, selectedTaskId);
  const logs = useLogTail(client, selectedTaskId, follow);
  const snapshot = useSnapshot(client);

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

  const deliverableState = useMemo((): {
    fetchState: DeliverableFetchState;
    error: string | null;
  } => {
    if (!runRef || !node) {
      return { fetchState: "none", error: null };
    }
    if (nodeTasks.status === "idle") {
      return { fetchState: "not_fetched", error: null };
    }
    if (nodeTasks.status === "loading") {
      return { fetchState: "loading", error: null };
    }
    if (nodeTasks.status === "error") {
      const msg = nodeTasks.error ?? "";
      if (/worktree|workspace removed|missing/i.test(msg)) {
        return { fetchState: "missing-worktree", error: msg };
      }
      return { fetchState: "error", error: msg || "deliverable fetch failed" };
    }
    const items = nodeTasks.data?.deliverables ?? [];
    if (items.length === 0) {
      return { fetchState: "none", error: null };
    }
    if (items.every((d) => d.purged_at != null)) {
      return { fetchState: "purged", error: null };
    }
    if (items.some((d) => d.purged_at != null)) {
      // Mixed: still ready, rows mark purged individually.
      return { fetchState: "ready", error: null };
    }
    return { fetchState: "ready", error: null };
  }, [runRef, node, nodeTasks.status, nodeTasks.error, nodeTasks.data]);

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
    // Local follow only — does not wipe log cursor (useLogTail preserves on follow toggle).
    setFollow(next);
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

  const showFailedWell =
    Boolean(task?.error) && (task?.state === "failed" || Boolean(task?.error));

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
      <div className="pc-task-body" data-testid="task-body">
        <div className="pc-task-col pc-task-col--left" data-testid="task-col-left">
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
          <EvalFeedback detail={detail.data?.eval_detail ?? null} />
          <DeliverablesPanel
            fetchState={deliverableState.fetchState}
            items={nodeTasks.data?.deliverables ?? []}
            error={deliverableState.error}
            hasRun={Boolean(runRef)}
          />
        </div>

        <div className="pc-task-col pc-task-col--log" data-testid="task-col-log">
          <LogTailPanel
            lines={logs.lines}
            status={logs.status}
            follow={follow}
            onFollowChange={onFollowChange}
            taskId={selectedTaskId}
          />
        </div>

        <div className="pc-task-col pc-task-col--right" data-testid="task-col-right">
          <QaPanel
            taskId={selectedTaskId}
            qa={detail.data?.qa ?? []}
            status={panelStatus}
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
