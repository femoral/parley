/**
 * Presentational fleet board — pure props so unit tests need no network.
 */
import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import type { RunSummary, RunnerListEntry, TaskEnvelope } from "@useparley/core";
import { normalizeUsage } from "@useparley/core";
import {
  projectQueueContext,
  projectTokenBurn,
  type FirehoseLine,
  type HonestyPhase,
  type TokenBurnView,
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
  formatTimeOfDay,
  formatTokenPair,
  formatTokens,
  shortId,
} from "./format.js";
import { firehoseTone } from "./firehoseFeed.js";
import { projectFleetKpis } from "./kpis.js";
import {
  panelPhaseFromSnapshot,
  panelPhaseFromTransport,
  type PanelPhase,
} from "./panelHonesty.js";
import { PanelShell } from "./PanelShell.js";
import {
  describePipTrack,
  pipsForRun,
  visiblePipTrack,
  PIP_VISIBLE_CAP,
} from "./pips.js";
import { runAtLine, runChipState, runStateLabel } from "./runAt.js";
import { StateChip } from "./StateChip.js";

export interface FleetBoardProps {
  tasks: readonly TaskEnvelope[];
  runs: readonly RunSummary[];
  runners: readonly RunnerListEntry[];
  runnersStatus: TransportStatus;
  runsStatus: TransportStatus;
  runsError: string | null;
  honestyPhase: HonestyPhase;
  firehose: readonly FirehoseLine[];
  selectedTaskId: string | null;
  selectedRunId: string | null;
  onSelectTask: (id: string) => void;
  onSelectRun: (id: string) => void;
  nowMs?: number;
  /** Optional precomputed burn (tests); otherwise projected from tasks. */
  tokenBurn?: TokenBurnView;
}

function runAddress(t: TaskEnvelope): string {
  if (!t.run_id) return "—";
  const id = shortId(t.run_id).slice(0, 4);
  const node = t.node ?? "?";
  const iter = t.iteration != null ? `.${t.iteration}` : "";
  const slot = t.slot ? `[${t.slot}]` : "";
  return `${id} · ${node}${iter}${slot}`;
}

function CopyScaffold({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard may be denied in headless — leave label unchanged */
    }
  }, [command]);
  return (
    <button
      type="button"
      className="pc-fleet-scaffold"
      onClick={() => void onCopy()}
      data-testid="fleet-delegate-scaffold"
      title="Copy to clipboard"
    >
      {copied ? "copied" : command}
    </button>
  );
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
  const nowMs = props.nowMs ?? Date.now();
  const global = props.honestyPhase;

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

  const burn =
    props.tokenBurn ??
    projectTokenBurn(props.tasks, { nowMs });

  const maxBurn = useMemo(() => {
    let m = 0;
    for (const b of burn.buckets) {
      const t = b.input + b.output;
      if (t > m) m = t;
    }
    return m;
  }, [burn.buckets]);

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
  // Burn + firehose follow the task snapshot stream.
  const burnPhase: PanelPhase =
    global === "loading" || global === "connecting"
      ? "loading"
      : global === "offline"
        ? "offline"
        : global === "stale-reconnecting"
          ? "stale-reconnecting"
          : burn.totals.tasks === 0
            ? "empty"
            : "live";
  const hosePhase: PanelPhase =
    global === "loading" || global === "connecting"
      ? "loading"
      : global === "offline"
        ? "offline"
        : global === "stale-reconnecting"
          ? "stale-reconnecting"
          : props.firehose.length === 0
            ? "empty"
            : "live";

  const heldCount = props.runs.filter(
    (r) => r.state === "blocked" && r.block?.reason === "gate",
  ).length;

  const activateRow = useCallback(
    (fn: () => void) => (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn();
      }
    },
    [],
  );

  const retentionNote =
    burn.retentionSource === "default-assumed"
      ? `last 24h · sees tasks within retention (${burn.retentionDays}d assumed)`
      : `last 24h · sees tasks within retention (${burn.retentionDays}d)`;

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

  if (global === "empty" || (tasksPhase === "empty" && runsPhase === "empty")) {
    return (
      <div className="pc-fleet" data-testid="fleet-board" data-phase="empty">
        <div className="pc-fleet__global-honesty" data-testid="fleet-empty">
          <h1 className="pc-fleet__heading">Fleet board</h1>
          <p>No tasks or runs yet. Copy a scaffold and hand it to the orchestrating agent.</p>
          <CopyScaffold command="parley delegate" />
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
            <PanelShell
              title="runs"
              meta={`workflow · node · iteration — ${heldCount} held at a gate`}
              phase={runsPhase}
              kind="runs"
              testId="fleet-runs"
              className="pc-fleet-runs"
            >
              <div className="pc-fleet-table" role="table" aria-label="Runs">
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
                  <div className="pc-fleet-table__th" role="columnheader">
                    branch
                  </div>
                  <div className="pc-fleet-table__th pc-fleet-table__th--num" role="columnheader">
                    tasks
                  </div>
                  <div className="pc-fleet-table__th pc-fleet-table__th--num" role="columnheader">
                    age
                  </div>
                </div>
                {sortedRuns.map((run) => {
                  const at = runAtLine(run);
                  const chipState = runChipState(run);
                  const selected = props.selectedRunId === run.run_id;
                  return (
                    <div
                      key={run.run_id}
                      role="row"
                      tabIndex={0}
                      className={`pc-fleet-table__row${selected ? " pc-fleet-table__row--selected" : ""}`}
                      onClick={() => props.onSelectRun(run.run_id)}
                      onKeyDown={activateRow(() => props.onSelectRun(run.run_id))}
                      data-testid={`fleet-run-${run.run_id}`}
                      aria-selected={selected}
                      aria-describedby={`pip-${run.run_id}`}
                    >
                      <div className="pc-fleet-table__td" role="cell">
                        <StateChip state={chipState} label={runStateLabel(run)} />
                      </div>
                      <div className="pc-fleet-table__td" role="cell">
                        <div className="pc-fleet-table__stack">
                          <span className="pc-fleet-table__primary" title={run.workflow}>
                            {run.workflow}
                          </span>
                          <span className="pc-fleet-table__secondary">
                            run {shortId(run.run_id)} · v{run.workflow_version}
                          </span>
                        </div>
                      </div>
                      <div className="pc-fleet-table__td" role="cell">
                        <PipTrack run={run} />
                      </div>
                      <div className="pc-fleet-table__td" role="cell">
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
                      <div className="pc-fleet-table__td" role="cell">
                        <span
                          className="pc-fleet-table__link"
                          title={run.branch ?? "scratch workspace"}
                        >
                          {run.branch ?? "scratch workspace"}
                        </span>
                      </div>
                      <div className="pc-fleet-table__td pc-fleet-table__td--num" role="cell">
                        <span className="pc-fleet-table__data">
                          {run.tasks_settled}/{run.tasks_total}
                        </span>
                      </div>
                      <div className="pc-fleet-table__td pc-fleet-table__td--num" role="cell">
                        <span className="pc-fleet-table__data">
                          {formatAge(run.updated_at, nowMs)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </PanelShell>

            <PanelShell
              title="tasks"
              meta={`all · sorted by attention, then age · ${sortedTasks.length} rows`}
              phase={tasksPhase}
              kind="tasks"
              testId="fleet-tasks"
              className="pc-fleet-tasks"
              emptyAction={<CopyScaffold command="parley delegate" />}
            >
              <div className="pc-fleet-table" role="table" aria-label="Tasks">
                <div className="pc-fleet-table__head" role="row">
                  <div className="pc-fleet-table__th" role="columnheader">
                    state
                  </div>
                  <div className="pc-fleet-table__th" role="columnheader">
                    task
                  </div>
                  <div className="pc-fleet-table__th" role="columnheader">
                    harness · model
                  </div>
                  <div className="pc-fleet-table__th" role="columnheader">
                    run address
                  </div>
                  <div className="pc-fleet-table__th" role="columnheader">
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
                {sortedTasks.map((t) => {
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
                      tabIndex={0}
                      className={`pc-fleet-table__row${selected ? " pc-fleet-table__row--selected" : ""}`}
                      onClick={() => props.onSelectTask(t.task_id)}
                      onKeyDown={activateRow(() => props.onSelectTask(t.task_id))}
                      data-testid={`fleet-task-${t.task_id}`}
                      data-state={t.state}
                      aria-selected={selected}
                    >
                      <div className="pc-fleet-table__td" role="cell">
                        <StateChip state={t.state} />
                      </div>
                      <div className="pc-fleet-table__td" role="cell">
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
                      <div className="pc-fleet-table__td" role="cell">
                        <div className="pc-fleet-harness">
                          <span
                            className="pc-fleet-coat"
                            style={{ background: coatVar(t.orch_harness ?? t.vendor) }}
                            aria-hidden="true"
                          />
                          <span
                            className="pc-fleet-table__data"
                            title={harnessModelLine(t.orch_harness ?? t.vendor, t.orch_model ?? t.model)}
                          >
                            {harnessModelLine(t.orch_harness ?? t.vendor, t.orch_model ?? t.model)}
                          </span>
                        </div>
                      </div>
                      <div className="pc-fleet-table__td" role="cell">
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
                      <div className="pc-fleet-table__td" role="cell">
                        <span className="pc-fleet-table__link" title={t.branch ?? "—"}>
                          {t.branch ?? "—"}
                        </span>
                      </div>
                      <div className="pc-fleet-table__td pc-fleet-table__td--num" role="cell">
                        <span className="pc-fleet-table__data">
                          {formatTokenPair(usage?.input, usage?.output)}
                        </span>
                      </div>
                      <div className="pc-fleet-table__td pc-fleet-table__td--num" role="cell">
                        <span className="pc-fleet-table__data">
                          {formatDur(t.duration_ms)}
                        </span>
                      </div>
                      <div className="pc-fleet-table__td pc-fleet-table__td--num" role="cell">
                        <span className="pc-fleet-table__data">
                          {formatAge(t.updated_at, nowMs)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </PanelShell>
          </div>

          <aside className="pc-fleet__side" data-testid="fleet-side">
            <div
              className="pc-fleet-burn"
              data-testid="fleet-token-burn"
              data-phase={burnPhase}
            >
              <div className="pc-fleet-burn__head">
                <span className="pc-fleet-burn__title">token burn · 24h</span>
              </div>
              <span className="pc-fleet-burn__bound" data-testid="fleet-burn-bound">
                {retentionNote}
              </span>
              {burnPhase === "live" || burnPhase === "stale-reconnecting" ? (
                <>
                  <div className="pc-fleet-burn__chart">
                    <div className="pc-fleet-burn__axis" aria-hidden="true">
                      <span>{formatTokens(maxBurn || 0)}</span>
                      <span>0</span>
                    </div>
                    <div
                      className="pc-fleet-burn__bars"
                      role="img"
                      aria-label={`Token burn histogram, max ${formatTokens(maxBurn)} tokens per hour`}
                    >
                      {burn.buckets.map((b, i) => {
                        const total = b.input + b.output;
                        const pct =
                          maxBurn > 0 ? Math.max(total > 0 ? 4 : 0, (total / maxBurn) * 100) : 0;
                        const recent = i >= burn.buckets.length - 3;
                        return (
                          <div
                            key={b.hourStartMs}
                            className={`pc-fleet-burn__bar${recent && total > 0 ? " pc-fleet-burn__bar--hot" : ""}`}
                            style={{ height: `${pct}%` }}
                            title={`${new Date(b.hourStartMs).toISOString().slice(11, 16)} · in ${b.input} out ${b.output}`}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <div className="pc-fleet-burn__totals">
                    <span>in {formatTokens(burn.totals.input)}</span>
                    <span>out {formatTokens(burn.totals.output)}</span>
                    <span>cached {formatTokens(burn.totals.cached)}</span>
                  </div>
                </>
              ) : (
                <p className="pc-fleet-panel__honesty-msg">
                  {burnPhase === "empty"
                    ? "No token activity in the last 24h (within retention)."
                    : burnPhase === "loading"
                      ? "Hailing token burn…"
                      : "Token burn unavailable"}
                </p>
              )}
            </div>

            <PanelShell
              title="executors"
              meta={`${props.runners.length} runners`}
              phase={runnersPhase}
              kind="runners"
              testId="fleet-runners"
              className="pc-fleet-runners-panel"
            >
              <div className="pc-fleet-runners" data-testid="fleet-runners-list">
                {props.runners.map((r) => (
                  <div
                    key={r.name}
                    className="pc-fleet-runner"
                    data-testid={`fleet-runner-${r.name}`}
                    data-status={r.status}
                  >
                    <span className="pc-fleet-runner__name" title={r.name}>
                      {r.name}
                    </span>
                    <span
                      className={`pc-fleet-runner__status pc-fleet-runner__status--${r.status}`}
                    >
                      {r.status}
                    </span>
                    <span
                      className="pc-fleet-runner__meta"
                      title={r.vendors.join(", ") || "no vendors"}
                    >
                      {(r.vendors.length ? r.vendors.join(" · ") : "no vendors")} ·{" "}
                      {formatAge(r.last_seen, nowMs)}
                    </span>
                  </div>
                ))}
              </div>
            </PanelShell>

            <PanelShell
              title="firehose"
              meta="watch — follow"
              phase={hosePhase}
              kind="events"
              testId="fleet-firehose"
              className="pc-fleet-firehose-panel"
            >
              <div className="pc-fleet-hose" data-testid="fleet-hose-lines">
                {props.firehose.map((line) => {
                  const tone = firehoseTone(line);
                  return (
                    <div
                      key={`${line.seq}-${line.event}-${line.taskId ?? line.runId ?? ""}`}
                      className="pc-fleet-hose__line"
                      data-testid="fleet-hose-line"
                    >
                      <span className="pc-fleet-hose__time">
                        {formatTimeOfDay(line.at)}
                      </span>
                      <span
                        className={`pc-fleet-hose__text pc-fleet-hose__text--${tone}`}
                        title={line.text}
                      >
                        {line.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            </PanelShell>
          </aside>
        </div>
      </div>
    </div>
  );
}
