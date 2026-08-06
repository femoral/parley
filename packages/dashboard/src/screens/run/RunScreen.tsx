/**
 * Run detail screen (#356).
 *
 * Three views (pipeline / iteration grid / node table), fork vocabulary,
 * read-only gates, deliverables + run tasks with honesty, run workspace.
 * Observation-only: no mutating run/gate routes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ParleyClient, type DeliverableRef, type NodeProjection } from "@useparley/core";
import {
  useHealth,
  useHonesty,
  useNodeTasks,
  useRuns,
  useSnapshot,
} from "../../data/index.js";
import type { ScreenMountProps } from "../types.js";
import { useDeliverableValues } from "./useDeliverableValues.js";
import { formatDuration, formatUsage, shortId } from "./format.js";
import {
  formatBlockParenthetical,
  GATE_READONLY_NOTICE,
  GATE_VERBS,
  projectRunStateLabel,
  projectTaskStateChip,
  type StateToken,
} from "./state.js";
import { IterationGridView, NodeTableView, PipelineView } from "./views.js";
import "./run.css";

export type RunViewId = "pipeline" | "grid" | "table";

function createClient(): ParleyClient {
  return new ParleyClient({ baseUrl: "" });
}

function collectDeliverableRefs(nodes: readonly NodeProjection[]): DeliverableRef[] {
  // Detail response only carries deliverable *ids* on nodes; full refs arrive
  // via node-detail zoom. For the panel we still list ids from the detail
  // projection as stubs when node-detail has not loaded yet.
  const ids: string[] = [];
  for (const n of nodes) {
    for (const id of n.deliverables) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids.map(
    (deliverable_id): DeliverableRef => ({
      deliverable_id,
      run_id: "",
      node: "",
      port: "",
      iteration: 0,
      slot: null,
      task_id: null,
      kind: "inline",
      type: null,
      size: null,
      created_at: "",
      purged_at: null,
    }),
  );
}

export function RunScreen(props: ScreenMountProps) {
  const client = useMemo(createClient, []);
  const snapshot = useSnapshot(client);
  const health = useHealth(client);
  const runs = useRuns(client, {
    selectedRunId: props.selectedRunId,
    enabled: true,
  });
  const honesty = useHonesty({
    ready: snapshot.ready,
    streamConnected: snapshot.connected,
    healthOnline: health.online,
    streamLostSince: snapshot.streamLostSince,
    taskCount: snapshot.totalTasks,
    panelError: runs.error,
  });

  const [view, setView] = useState<RunViewId>("pipeline");
  const [copied, setCopied] = useState(false);
  const [selectedNode, setSelectedNode] = useState<{
    node: string;
    iteration: number;
  } | null>(null);

  // Auto-select first run when none selected, or when the current selection
  // is absent from the live list (e.g. verify focus-filter, or purged run).
  useEffect(() => {
    const first = runs.summaries[0];
    if (!first) return;
    if (
      props.selectedRunId &&
      runs.summaries.some((r) => r.run_id === props.selectedRunId)
    ) {
      return;
    }
    props.setSelectedRunId(first.run_id);
  }, [props, runs.summaries]);

  const detail = props.selectedRunId
    ? (runs.details.get(props.selectedRunId) ?? null)
    : null;

  // Default selected node → current_node or first waiting/running.
  useEffect(() => {
    if (!detail) {
      setSelectedNode(null);
      return;
    }
    if (selectedNode) {
      const still = detail.nodes.some(
        (n) => n.node === selectedNode.node && n.iteration === selectedNode.iteration,
      );
      if (still) return;
    }
    const cur = detail.run.current_node;
    const match =
      (cur
        ? detail.nodes.find(
            (n) =>
              n.node === cur &&
              (n.state === "waiting" || n.state === "running" || n.iteration === detail.run.iteration),
          )
        : null) ??
      detail.nodes.find((n) => n.state === "waiting" || n.state === "running") ??
      detail.nodes[detail.nodes.length - 1] ??
      null;
    if (match) setSelectedNode({ node: match.node, iteration: match.iteration });
  }, [detail, selectedNode]);

  const nodeTasks = useNodeTasks(client, {
    runRef: props.selectedRunId,
    node: selectedNode?.node ?? null,
    query: selectedNode ? { iteration: selectedNode.iteration } : undefined,
    snapshotTasks: snapshot.tasks,
    enabled: Boolean(props.selectedRunId && selectedNode),
  });

  // Prefer full DeliverableRefs from node-detail; fall back to id stubs.
  const deliverableRefs: DeliverableRef[] = useMemo(() => {
    if (nodeTasks.data?.deliverables && nodeTasks.data.deliverables.length > 0) {
      return nodeTasks.data.deliverables;
    }
    if (detail) return collectDeliverableRefs(detail.nodes);
    return [];
  }, [nodeTasks.data, detail]);

  // Also collect refs across all nodes by fetching each unique node once when
  // we only have id stubs — for the panel we fetch values by id regardless.
  const deliv = useDeliverableValues(client, deliverableRefs, {
    enabled: Boolean(detail),
  });

  const copyRunId = useCallback(async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.run.run_id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be denied in headless */
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }, [detail]);

  const onSelectNode = useCallback((n: NodeProjection) => {
    setSelectedNode({ node: n.node, iteration: n.iteration });
  }, []);

  // ── Honesty shells ──────────────────────────────────────────────────
  if (honesty.phase === "loading" || honesty.phase === "connecting") {
    return (
      <div
        className="pc-run"
        data-testid="screen-run"
        data-screen="run"
        data-honesty={honesty.phase}
      >
        <div className="pc-run__honesty" data-phase={honesty.phase}>
          <h1 className="pc-run__honesty-title">Connecting to daemon</h1>
          <p className="pc-run__honesty-note">
            Run detail waits for a live snapshot before claiming any structure.
          </p>
        </div>
      </div>
    );
  }

  if (honesty.phase === "offline" && !detail) {
    return (
      <div
        className="pc-run"
        data-testid="screen-run"
        data-screen="run"
        data-honesty="offline"
      >
        <div className="pc-run__honesty" data-phase="offline">
          <h1 className="pc-run__honesty-title">Daemon offline</h1>
          <p className="pc-run__honesty-note">
            No run data is available. Restore the daemon connection to inspect runs.
          </p>
        </div>
      </div>
    );
  }

  if (!props.selectedRunId || (!detail && runs.status === "online")) {
    // Empty: no selection and no runs, or selection missing.
    if (runs.summaries.length === 0) {
      return (
        <div
          className="pc-run"
          data-testid="screen-run"
          data-screen="run"
          data-honesty="empty"
        >
          <div className="pc-run__empty">
            <h1 className="pc-run__empty-title">No runs</h1>
            <p className="pc-run__empty-note">
              Start a workflow with <code>parley run start</code>. This surface is
              observation-only — gate verbs stay with the orchestrating agent.
            </p>
          </div>
        </div>
      );
    }
  }

  if (!detail) {
    const loading = runs.status === "connecting" || (props.selectedRunId && !runs.error);
    return (
      <div
        className="pc-run"
        data-testid="screen-run"
        data-screen="run"
        data-honesty={runs.error ? "panel-error" : "loading"}
      >
        <div className="pc-run__honesty" data-phase={runs.error ? "panel-error" : "loading"}>
          <h1 className="pc-run__honesty-title">
            {runs.error ? "Run detail error" : "Loading run"}
          </h1>
          <p className="pc-run__honesty-note">
            {runs.error ??
              (loading
                ? `Fetching ${props.selectedRunId ?? "run"}…`
                : "Select a run from the fleet board.")}
          </p>
        </div>
      </div>
    );
  }

  const run = detail.run;
  const block = detail.block ?? run.block;
  const stateChip = projectRunStateLabel(run, block);
  const workspace = run.worktree ?? (run.workspace === "scratch" ? `scratch · ${run.run_id}` : null);
  const metaParts = [
    run.current_node
      ? `${run.current_node}.${run.iteration}`
      : "no current node",
    `${run.tasks_settled}/${run.tasks_total} tasks`,
    formatUsage(run.usage),
    formatDuration(run.duration_ms, run.state === "running" || run.state === "blocked"),
  ];
  if (run.parent_run_id) {
    metaParts.unshift(`fork of ${shortId(run.parent_run_id)} · attempt ${run.attempt}`);
  }
  if (workspace) {
    metaParts.push(workspace);
  }

  const selectedKey = selectedNode
    ? `${selectedNode.node}:${selectedNode.iteration}`
    : null;

  const runsPanelStatus =
    honesty.phase === "stale-reconnecting"
      ? "stale"
      : runs.error
        ? "error"
        : runs.status === "offline"
          ? "offline"
          : "live";

  return (
    <div
      className="pc-run"
      data-testid="screen-run"
      data-screen="run"
      data-run-id={run.run_id}
      data-run-state={run.state}
      data-honesty={honesty.phase}
      data-view={view}
    >
      <header className="pc-run__header" data-testid="run-header">
        <div className="pc-run__header-main">
          <div className="pc-run__title-row">
            <h1 className="pc-run__workflow" title={run.workflow}>
              {run.workflow}
            </h1>
            <span className="pc-run__id-meta">
              run {shortId(run.run_id)} · v{run.workflow_version} · {run.workspace} workspace
              {run.type ? ` · ${run.type}` : ""}
            </span>
          </div>
          <div className="pc-run__meta-line" title={metaParts.join(" · ")}>
            {metaParts.join(" · ")}
          </div>
          {workspace ? (
            <div className="pc-run__meta-line" data-testid="run-workspace" title={workspace}>
              <span className="pc-run__workspace">{workspace}</span>
            </div>
          ) : null}
        </div>
        <div className="pc-run__header-actions">
          <StateChip token={stateChip.token} label={stateChip.label} live={stateChip.live} />
          <button
            type="button"
            className="pc-run__copy"
            data-testid="run-copy-id"
            onClick={() => void copyRunId()}
            title={`Copy ${run.run_id}`}
          >
            {copied ? "copied" : `copy ${shortId(run.run_id, 4)}`}
          </button>
        </div>
      </header>

      {block ? (
        <div className="pc-run__block" data-testid="run-block" data-reason={block.reason}>
          <span className="pc-run__block-label">blocked</span>
          <span className="pc-run__block-detail">
            {formatBlockParenthetical(block)}
            {block.detail ? ` — ${block.detail}` : ""}
            {block.node ? ` · ${block.node}` : ""}
          </span>
          <span className="pc-run__block-verbs" title={GATE_READONLY_NOTICE}>
            verbs: {GATE_VERBS.join(" · ")} (orchestrating agent only)
          </span>
        </div>
      ) : null}

      <div className="pc-run__toolbar" data-testid="run-view-switch" role="toolbar" aria-label="Run views">
        <span className="pc-run__toolbar-label">view</span>
        <ViewButton id="pipeline" current={view} onSelect={setView} label="pipeline" />
        <ViewButton id="grid" current={view} onSelect={setView} label="iteration grid" />
        <ViewButton id="table" current={view} onSelect={setView} label="node table" />
        <span className="pc-run__gate-notice" title={GATE_READONLY_NOTICE}>
          {GATE_READONLY_NOTICE}
        </span>
        <span className="pc-run__gate-notice pc-run__gate-notice--compact" title={GATE_READONLY_NOTICE}>
          read-only · {GATE_VERBS.join(" · ")}
        </span>
      </div>

      <div className="pc-run__body">
        {runsPanelStatus !== "live" ? (
          <div
            className="pc-run__panel-honesty"
            data-status={runsPanelStatus}
            data-testid="run-panel-honesty"
          >
            {runsPanelStatus === "stale"
              ? "Showing last known run — reconnecting…"
              : runsPanelStatus === "offline"
                ? "Daemon offline — last known run retained where available."
                : `Run fetch error: ${runs.error}`}
          </div>
        ) : null}

        {view === "pipeline" ? <PipelineView detail={detail} /> : null}
        {view === "grid" ? <IterationGridView detail={detail} /> : null}
        {view === "table" ? (
          <NodeTableView
            detail={detail}
            selectedKey={selectedKey}
            onSelect={onSelectNode}
          />
        ) : null}

        <div className="pc-run__panels">
          <section className="pc-run__panel" data-testid="run-deliverables" aria-label="Deliverables">
            <div className="pc-run__panel-head">
              <span className="pc-run__panel-title">deliverables</span>
              <span className="pc-run__panel-meta" data-testid="run-deliverables-status">
                {deliv.panelLabel}
              </span>
            </div>
            <div className="pc-run__panel-body">
              {deliv.rows.length === 0 ? (
                <div className="pc-run__panel-empty" data-fetch-state="none">
                  {deliv.loading
                    ? "Fetching deliverables…"
                    : deliverableRefs.length === 0
                      ? "No deliverables on this run yet."
                      : "No deliverable rows."}
                </div>
              ) : (
                deliv.rows.map((row) => (
                  <div
                    key={row.ref.deliverable_id}
                    className="pc-run__deliv-row"
                    data-fetch-state={row.fetchState}
                    data-kind={row.ref.kind}
                  >
                    <span className="pc-run__deliv-addr" title={row.address}>
                      {row.address || row.ref.deliverable_id}
                    </span>
                    <span
                      className={`pc-run__deliv-kind pc-run__deliv-kind--${
                        row.fetchState === "purged"
                          ? "purged"
                          : row.fetchState === "missing-worktree"
                            ? "missing"
                            : row.fetchState === "error"
                              ? "error"
                              : row.ref.kind
                      }`}
                    >
                      {row.fetchState === "purged"
                        ? "PURGED"
                        : row.fetchState === "missing-worktree"
                          ? "MISSING"
                          : row.fetchState === "error"
                            ? "ERROR"
                            : row.ref.kind.toUpperCase()}
                    </span>
                    <span className="pc-run__deliv-body" data-state={row.fetchState}>
                      {row.body}
                    </span>
                    <span className="pc-run__deliv-meta">{row.meta}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="pc-run__panel" data-testid="run-tasks" aria-label="Run tasks">
            <div className="pc-run__panel-head">
              <span className="pc-run__panel-title">run tasks</span>
              <span className="pc-run__panel-meta">
                {nodeTasks.status === "error"
                  ? `node error · ${nodeTasks.error}`
                  : nodeTasks.status === "loading"
                    ? "loading node…"
                    : `${nodeTasks.runTasks.length} on run${
                        nodeTasks.data
                          ? ` · ${nodeTasks.data.tasks.length} on ${selectedNode?.node ?? "node"}`
                          : ""
                      }`}
              </span>
            </div>
            <div className="pc-run__panel-body">
              {nodeTasks.status === "error" ? (
                <div className="pc-run__panel-empty" data-status="error">
                  Node tasks failed: {nodeTasks.error}
                </div>
              ) : null}
              {/* Whole-run list via client-side run_id filter */}
              {nodeTasks.runTasks.length === 0 && nodeTasks.status !== "loading" ? (
                <div className="pc-run__panel-empty">No tasks on this run yet.</div>
              ) : (
                nodeTasks.runTasks.map((t) => {
                  const chip = projectTaskStateChip(t.state);
                  const addr = [
                    t.node ?? "node",
                    t.iteration != null ? `.${t.iteration}` : "",
                    t.slot ? `[${t.slot}]` : "",
                    " · ",
                    shortId(t.task_id, 8),
                  ].join("");
                  return (
                    <div
                      key={t.task_id}
                      className="pc-run__task-row pc-run__task-row--interactive"
                      data-task-id={t.task_id}
                      data-state={t.state}
                      tabIndex={0}
                      role="button"
                      onClick={() => {
                        props.setSelectedTaskId(t.task_id);
                        props.navigate("task");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          props.setSelectedTaskId(t.task_id);
                          props.navigate("task");
                        }
                      }}
                    >
                      <span className={`pc-run__task-state pc-run__ink--${chip.token}`}>
                        {chip.label}
                      </span>
                      <span className="pc-run__task-addr" title={addr}>
                        {addr}
                      </span>
                      <span className="pc-run__task-harness">
                        {t.vendor}
                        {t.model ? ` · ${t.model}` : ""}
                      </span>
                      <span className="pc-run__task-dur">
                        {formatDuration(t.duration_ms, t.state === "running")}
                      </span>
                    </div>
                  );
                })
              )}
              {/* Per-node rows from GET /runs/:ref/nodes/:node */}
              {nodeTasks.data && nodeTasks.data.tasks.length > 0 ? (
                <>
                  <div className="pc-run__panel-head" style={{ borderTop: "1px solid var(--hairline-strong)" }}>
                    <span className="pc-run__panel-title">
                      node {selectedNode?.node}
                      {selectedNode ? `.${selectedNode.iteration}` : ""}
                    </span>
                    <span className="pc-run__panel-meta">
                      {nodeTasks.data.tasks.length} row
                      {nodeTasks.data.tasks.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {nodeTasks.data.tasks.map((row) => {
                    const chip = projectTaskStateChip(row.state);
                    return (
                      <div
                        key={row.task_id}
                        className="pc-run__task-row"
                        data-task-id={row.task_id}
                        data-slot={row.slot ?? undefined}
                        data-node-task="true"
                      >
                        <span className={`pc-run__task-state pc-run__ink--${chip.token}`}>
                          {chip.label}
                        </span>
                        <span className="pc-run__task-addr" title={row.gist || row.task_id}>
                          {row.slot ? `[${row.slot}] · ` : ""}
                          {shortId(row.task_id, 8)}
                          {row.summary ? ` · ${row.summary}` : ""}
                        </span>
                        <span className="pc-run__task-harness">{row.gist || "—"}</span>
                        <span className="pc-run__task-dur">
                          {formatDuration(row.duration_ms, row.state === "running")}
                        </span>
                      </div>
                    );
                  })}
                </>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function StateChip({
  token,
  label,
  live,
}: {
  token: StateToken;
  label: string;
  live: boolean;
}) {
  return (
    <span
      className={`pc-run__chip pc-run__chip--${token}${live ? " pc-run__chip--live" : ""}`}
      data-testid="run-state-chip"
      data-state-token={token}
    >
      <span className="pc-run__chip-dot" aria-hidden="true" />
      <span className="pc-run__chip-label">{label}</span>
    </span>
  );
}

function ViewButton({
  id,
  current,
  onSelect,
  label,
}: {
  id: RunViewId;
  current: RunViewId;
  onSelect: (id: RunViewId) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="pc-run__view-btn"
      aria-pressed={current === id}
      data-testid={`run-view-${id}`}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  );
}
