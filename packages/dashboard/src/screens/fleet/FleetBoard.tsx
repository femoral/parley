/**
 * Presentational fleet board — pure props so unit tests need no network.
 */
import { useCallback, useMemo, useState } from "react";
import type { RunSummary, RunnerListEntry, TaskEnvelope } from "@useparley/core";
import { normalizeUsage } from "@useparley/core";
import { CopyScaffold, Panel, StateChip } from "../../components/index.js";
import {
  projectQueueContext,
  usePolling,
  type HonestyPhase,
  type TransportStatus,
} from "../../data/index.js";
import {
  isFreshFailure,
  sortRunsByAttention,
  sortTasksByAttention,
} from "./attentionSort.js";
import { coatVar, harnessModelLine } from "./coats.js";
import {
  formatAge,
  formatDur,
  formatTokenPair,
  shortId,
} from "./format.js";
import { projectFleetKpis } from "./kpis.js";
import {
  panelPhaseFromSnapshot,
  panelPhaseFromTransport,
} from "./panelHonesty.js";
import {
  describePipTrack,
  pipsForRun,
  visiblePipTrack,
  PIP_VISIBLE_CAP,
} from "./pips.js";
import { runAtLine, runChipState, runStateLabel } from "./runAt.js";
import { runnerView } from "./runners.js";
import { useRovingTabindex } from "./useRovingTabindex.js";

export interface FleetBoardProps {
  tasks: readonly TaskEnvelope[];
  runs: readonly RunSummary[];
  runners: readonly RunnerListEntry[];
  runnersStatus: TransportStatus;
  runsStatus: TransportStatus;
  runsError: string | null;
  honestyPhase: HonestyPhase;
  selectedTaskId: string | null;
  selectedRunId: string | null;
  onSelectTask: (id: string) => void;
  onSelectRun: (id: string) => void;
  nowMs?: number;
}

/** Quantize wall-clock to the minute so KPI memos are stable across polls. */
export function quantizeNowMs(ms: number, quantumMs = 60_000): number {
  return Math.floor(ms / quantumMs) * quantumMs;
}

function runAddress(t: TaskEnvelope): string {
  if (!t.run_id) return "—";
  const id = shortId(t.run_id).slice(0, 4);
  const node = t.node ?? "?";
  const iter = t.iteration != null ? `.${t.iteration}` : "";
  const slot = t.slot ? `[${t.slot}]` : "";
  return `${id} · ${node}${iter}${slot}`;
}

function PipTrack({ run }: { run: RunSummary }) {
  const full = pipsForRun(run);
  const visible = visiblePipTrack(full);
  const desc = describePipTrack(full);
  const capped = full.length > PIP_VISIBLE_CAP;
  const id = `pip-${run.run_id}`;
  return (
    <>
      <span id={id} className="pc-visually-hidden">
        {desc}
      </span>
      <div
        className="pc-fleet-pips"
        aria-hidden="true"
        data-testid={`fleet-pips-${run.run_id}`}
        data-pip-kinds={full.map((p) => p.kind).join(",")}
      >
        {visible.map((p, i) => (
          <span
            key={i}
            className={`pc-fleet-pip pc-fleet-pip--${p.kind}`}
            data-pip={p.kind}
          />
        ))}
        {capped ? <span className="pc-fleet-pips__cap" /> : null}
      </div>
    </>
  );
}

export function FleetBoard(props: FleetBoardProps) {
  const global = props.honestyPhase;

  // Stable now: tests pass explicit nowMs; live path quantizes to the minute
  // and ticks once a minute so KPI/burn memos do not thrash every poll.
  const [minuteTick, setMinuteTick] = useState(() =>
    quantizeNowMs(Date.now()),
  );
  usePolling(
    useCallback(() => {
      setMinuteTick(quantizeNowMs(Date.now()));
    }, []),
    { intervalMs: 60_000, enabled: props.nowMs == null, immediate: false },
  );
  const nowMs = props.nowMs != null ? props.nowMs : minuteTick;

  const kpis = useMemo(
    () =>
      projectFleetKpis({
        tasks: props.tasks,
        runs: props.runs,
        nowMs,
      }),
    [props.tasks, props.runs, nowMs],
  );

  const sortedTasks = useMemo(
    () => sortTasksByAttention(props.tasks),
    [props.tasks],
  );
  const sortedRuns = useMemo(
    () => sortRunsByAttention(props.runs),
    [props.runs],
  );

  const tasksPhase = panelPhaseFromSnapshot(global, props.tasks.length);
  const runsPhase = panelPhaseFromTransport(
    props.runsStatus,
    props.runs.length,
    props.runsError,
    global,
  );
  const runnersPhase = panelPhaseFromTransport(
    props.runnersStatus,
    props.runners.length,
    null,
    global,
  );

  const heldCount = props.runs.filter(
    (r) => r.state === "blocked" && r.block?.reason === "gate",
  ).length;

  const taskRoving = useRovingTabindex(sortedTasks.length, "tasks");
  const runRoving = useRovingTabindex(sortedRuns.length, "runs");

  // Full-board loading / offline with no data yet.
  if (
    (global === "loading" || global === "connecting") &&
    props.tasks.length === 0 &&
    props.runs.length === 0
  ) {
    return (
      <div className="pc-fleet" data-testid="fleet-board" data-phase={global}>
        <div className="pc-fleet__global-honesty" data-testid="fleet-hailing">
          <h1 className="pc-fleet__heading">Fleet board</h1>
          <p>Hailing the fleet…</p>
        </div>
      </div>
    );
  }

  if (global === "offline" && props.tasks.length === 0) {
    return (
      <div className="pc-fleet" data-testid="fleet-board" data-phase="offline">
        <div className="pc-fleet__global-honesty" data-testid="fleet-offline">
          <h1 className="pc-fleet__heading">Fleet board</h1>
          <p>Daemon offline. Last contact lost — reconnect when the daemon is back.</p>
        </div>
      </div>
    );
  }

  // Empty fleet: prefer empty over stale when there is nothing to show.
  // Intercepted-empty + closed SSE often lands as stale-reconnecting with
  // zero tasks; that is still an empty fleet, not "last known data".
  const nothingToShow = props.tasks.length === 0 && props.runs.length === 0;
  const emptyPhase =
    global === "empty" ||
    (nothingToShow &&
      (global === "live" ||
        global === "stale-reconnecting" ||
        global === "panel-error" ||
        (tasksPhase === "empty" && runsPhase === "empty")));

  if (emptyPhase && nothingToShow) {
    return (
      <div className="pc-fleet" data-testid="fleet-board" data-phase="empty">
        <div className="pc-fleet__global-honesty" data-testid="fleet-empty">
          <h1 className="pc-fleet__heading">Fleet board</h1>
          <p>No tasks or runs yet. Copy a scaffold and hand it to the orchestrating agent.</p>
          <CopyScaffold text="parley delegate" testId="fleet-delegate-scaffold" />
        </div>
      </div>
    );
  }

  return (
    <div
      className="pc-fleet"
      data-testid="fleet-board"
      data-phase={global}
    >
      <h1 className="pc-visually-hidden">Fleet board</h1>
      <div className="pc-fleet__board" data-testid="fleet-board-scroll">
        <div className="pc-fleet-kpis" data-testid="fleet-kpis" role="group" aria-label="Fleet KPIs">
          {kpis.map((k) => (
            <div
              key={k.id}
              className={`pc-fleet-kpi pc-fleet-kpi--${k.tone}`}
              data-testid={`fleet-kpi-${k.id}`}
            >
              <span className="pc-fleet-kpi__label">{k.label}</span>
              <div className="pc-fleet-kpi__value-row">
                <span className="pc-fleet-kpi__value">{k.value}</span>
                {k.unit ? <span className="pc-fleet-kpi__unit">{k.unit}</span> : null}
              </div>
              <span className="pc-fleet-kpi__note" title={k.note}>
                {k.note}
              </span>
            </div>
          ))}
        </div>

        <div className="pc-fleet__body">
          <div className="pc-fleet__main">
            <Panel
              title="runs"
              meta={`${heldCount} held · track = nodes × loop`}
              phase={runsPhase}
              honestyKind="runs"
              testId="fleet-runs"
              className="pc-fleet-runs"
            >
              <div
                className="pc-fleet-table-scroll"
                data-testid="fleet-runs-scroll"
              >
                <div
                  className="pc-fleet-table"
                  role="grid"
                  aria-label="Runs"
                  aria-rowcount={sortedRuns.length + 1}
                >
                  <div className="pc-fleet-table__head" role="row">
                    <div className="pc-fleet-table__th" role="columnheader">
                      state
                    </div>
                    <div className="pc-fleet-table__th" role="columnheader">
                      run
                    </div>
                    <div className="pc-fleet-table__th" role="columnheader">
                      track
                    </div>
                    <div className="pc-fleet-table__th" role="columnheader">
                      at
                    </div>
                    <div
                      className="pc-fleet-table__th pc-fleet-col--branch"
                      role="columnheader"
                    >
                      branch
                    </div>
                    <div className="pc-fleet-table__th pc-fleet-table__th--num" role="columnheader">
                      tasks
                    </div>
                    <div className="pc-fleet-table__th pc-fleet-table__th--num" role="columnheader">
                      age
                    </div>
                  </div>
                  {sortedRuns.map((run, index) => {
                    const at = runAtLine(run);
                    const chipState = runChipState(run);
                    const selected = props.selectedRunId === run.run_id;
                    return (
                      <div
                        key={run.run_id}
                        role="row"
                        ref={(el) => runRoving.setRowRef(index, el)}
                        tabIndex={runRoving.tabIndexFor(index)}
                        className={`pc-fleet-table__row${selected ? " pc-fleet-table__row--selected" : ""}`}
                        onClick={() => props.onSelectRun(run.run_id)}
                        onKeyDown={runRoving.onRowKeyDown(index, () =>
                          props.onSelectRun(run.run_id),
                        )}
                        data-testid={`fleet-run-${run.run_id}`}
                        aria-selected={selected}
                        aria-describedby={`pip-${run.run_id}`}
                        aria-rowindex={index + 2}
                      >
                        <div className="pc-fleet-table__td" role="gridcell">
                          <StateChip state={chipState} label={runStateLabel(run)} />
                        </div>
                        <div className="pc-fleet-table__td" role="gridcell">
                          <div className="pc-fleet-table__stack">
                            <span className="pc-fleet-table__primary" title={run.workflow}>
                              {run.workflow}
                            </span>
                            <span className="pc-fleet-table__secondary">
                              run {shortId(run.run_id)} · v{run.workflow_version}
                            </span>
                          </div>
                        </div>
                        <div className="pc-fleet-table__td" role="gridcell">
                          <PipTrack run={run} />
                        </div>
                        <div className="pc-fleet-table__td" role="gridcell">
                          <span
                            className="pc-fleet-table__data"
                            style={
                              at.held
                                ? { color: "var(--state-awaiting)" }
                                : undefined
                            }
                            title={at.text}
                          >
                            {at.text}
                          </span>
                        </div>
                        <div
                          className="pc-fleet-table__td pc-fleet-col--branch"
                          role="gridcell"
                        >
                          <span
                            className="pc-fleet-table__link"
                            title={run.branch ?? "scratch workspace"}
                          >
                            {run.branch ?? "scratch workspace"}
                          </span>
                        </div>
                        <div className="pc-fleet-table__td pc-fleet-table__td--num" role="gridcell">
                          <span className="pc-fleet-table__data">
                            {run.tasks_settled}/{run.tasks_total}
                          </span>
                        </div>
                        <div className="pc-fleet-table__td pc-fleet-table__td--num" role="gridcell">
                          <span className="pc-fleet-table__data">
                            {formatAge(run.updated_at, nowMs)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Panel>

            <Panel
              title="tasks"
              meta={`attention · age · ${sortedTasks.length}`}
              phase={tasksPhase}
              honestyKind="tasks"
              testId="fleet-tasks"
              className="pc-fleet-tasks"
              emptyAction={
                <CopyScaffold text="parley delegate" testId="fleet-delegate-scaffold" />
              }
            >
              <div
                className="pc-fleet-table-scroll"
                data-testid="fleet-tasks-scroll"
              >
                <div
                  className="pc-fleet-table"
                  role="grid"
                  aria-label="Tasks"
                  aria-rowcount={sortedTasks.length + 1}
                >
                  <div className="pc-fleet-table__head" role="row">
                    <div className="pc-fleet-table__th" role="columnheader">
                      state
                    </div>
                    <div className="pc-fleet-table__th" role="columnheader">
                      task
                    </div>
                    <div className="pc-fleet-table__th" role="columnheader">
                      harness
                    </div>
                    <div
                      className="pc-fleet-table__th pc-fleet-col--addr"
                      role="columnheader"
                    >
                      run address
                    </div>
                    <div
                      className="pc-fleet-table__th pc-fleet-col--branch"
                      role="columnheader"
                    >
                      branch
                    </div>
                    <div className="pc-fleet-table__th pc-fleet-table__th--num" role="columnheader">
                      tokens
                    </div>
                    <div className="pc-fleet-table__th pc-fleet-table__th--num" role="columnheader">
                      dur
                    </div>
                    <div className="pc-fleet-table__th pc-fleet-table__th--num" role="columnheader">
                      age
                    </div>
                  </div>
                  {sortedTasks.map((t, index) => {
                    const usage = t.usage ? normalizeUsage(t.usage) : null;
                    const selected = props.selectedTaskId === t.task_id;
                    const fresh = isFreshFailure(t, nowMs);
                    const q = projectQueueContext(t);
                    const note =
                      fresh
                        ? "fresh failure"
                        : t.state === "queued" && q.label
                          ? q.label
                          : t.runner
                            ? `on ${t.runner}`
                            : "";
                    return (
                      <div
                        key={t.task_id}
                        role="row"
                        ref={(el) => taskRoving.setRowRef(index, el)}
                        tabIndex={taskRoving.tabIndexFor(index)}
                        className={`pc-fleet-table__row${selected ? " pc-fleet-table__row--selected" : ""}`}
                        onClick={() => props.onSelectTask(t.task_id)}
                        onKeyDown={taskRoving.onRowKeyDown(index, () =>
                          props.onSelectTask(t.task_id),
                        )}
                        data-testid={`fleet-task-${t.task_id}`}
                        data-state={t.state}
                        aria-selected={selected}
                        aria-rowindex={index + 2}
                      >
                        <div className="pc-fleet-table__td" role="gridcell">
                          <StateChip state={t.state} />
                        </div>
                        <div className="pc-fleet-table__td" role="gridcell">
                          <div className="pc-fleet-table__inline">
                            <span
                              className={`pc-fleet-table__primary${t.state === "cancelled" ? " pc-fleet-table__primary--muted" : ""}`}
                              title={t.name ?? t.task_id}
                            >
                              {t.name ?? t.task_id}
                            </span>
                            <span className="pc-fleet-table__id">{shortId(t.task_id)}</span>
                            {note ? (
                              <span
                                className={`pc-fleet-table__note${fresh ? " pc-fleet-table__note--fail" : ""}`}
                                title={note}
                              >
                                {note}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="pc-fleet-table__td" role="gridcell">
                          <div className="pc-fleet-harness">
                            <span
                              className="pc-fleet-coat"
                              style={{ background: coatVar(t.orch_harness ?? t.vendor) }}
                              aria-hidden="true"
                            />
                            <span
                              className="pc-fleet-table__data"
                              title={harnessModelLine(
                                t.orch_harness ?? t.vendor,
                                t.orch_model ?? t.model,
                              )}
                            >
                              {harnessModelLine(
                                t.orch_harness ?? t.vendor,
                                t.orch_model ?? t.model,
                              )}
                            </span>
                          </div>
                        </div>
                        <div
                          className="pc-fleet-table__td pc-fleet-col--addr"
                          role="gridcell"
                        >
                          <span
                            className="pc-fleet-table__data"
                            title={runAddress(t)}
                            style={
                              t.run_id
                                ? undefined
                                : { color: "var(--text-time)" }
                            }
                          >
                            {runAddress(t)}
                          </span>
                        </div>
                        <div
                          className="pc-fleet-table__td pc-fleet-col--branch"
                          role="gridcell"
                        >
                          <span className="pc-fleet-table__link" title={t.branch ?? "—"}>
                            {t.branch ?? "—"}
                          </span>
                        </div>
                        <div className="pc-fleet-table__td pc-fleet-table__td--num" role="gridcell">
                          <span className="pc-fleet-table__data">
                            {formatTokenPair(usage?.input, usage?.output)}
                          </span>
                        </div>
                        <div className="pc-fleet-table__td pc-fleet-table__td--num" role="gridcell">
                          <span className="pc-fleet-table__data">
                            {formatDur(t.duration_ms)}
                          </span>
                        </div>
                        <div className="pc-fleet-table__td pc-fleet-table__td--num" role="gridcell">
                          <span className="pc-fleet-table__data">
                            {formatAge(t.updated_at, nowMs)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Panel>
          </div>

          <aside className="pc-fleet__side" data-testid="fleet-side">
            <Panel
              title="executors"
              meta={`${props.runners.length} runners`}
              phase={runnersPhase}
              honestyKind="runners"
              testId="fleet-runners"
              className="pc-fleet-runners-panel"
            >
              <div
                className="pc-fleet-runners"
                data-testid="fleet-runners-list"
                tabIndex={0}
                role="group"
                aria-label="Executor runners"
              >
                {props.runners.map((r) => {
                  const view = runnerView(r);
                  return (
                    <div
                      key={r.name}
                      className="pc-fleet-runner"
                      data-testid={`fleet-runner-${r.name}`}
                      data-status={view.status}
                    >
                      <span className="pc-fleet-runner__name" title={r.name}>
                        {r.name}
                      </span>
                      <span className={`pc-fleet-runner__status ${view.statusClass}`}>
                        {view.statusLabel}
                      </span>
                      <span
                        className="pc-fleet-runner__meta"
                        title={r.vendors.join(", ") || "no vendors"}
                      >
                        {(r.vendors.length ? r.vendors.join(" · ") : "no vendors")} ·{" "}
                        {formatAge(r.last_seen, nowMs)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </aside>
        </div>
      </div>
    </div>
  );
}
