/**
 * Task inspector panels — brief, attempts, log tail, Q&A, report, eval, deliverables.
 * Presentational; data assembled by TaskScreen.
 */
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type ToggleEvent,
} from "react";
import type {
  AttemptLineageEntry,
  DeliverableRef,
  EvalDetail,
  QaTurn,
  Report,
  TaskEnvelope,
} from "@useparley/core";
import {
  formatChurn,
  projectReportFiles,
  type FileChangeView,
  type LogLine,
  type LogTailStatus,
  type PanelStatus,
} from "../../data/index.js";
import { isHelloLogLine } from "../../data/logClassify.js";
import { CopyScaffold, Panel, StateChip, stateLabel } from "../../components/index.js";
import {
  coatVar,
  evalScoreColor,
  formatAddress,
  formatAge,
  formatDuration,
  formatEvalScore,
  formatLogLineNo,
  formatPosture,
  formatQaClock,
  formatUsage,
  isLiveTail,
  isTerminalState,
  logKindColor,
  logTextColor,
  outcomeColor,
  stateColor,
  tailStatusColor,
  tailStatusLabel,
} from "./format.js";
import { answerScaffold, fixScaffold } from "./scaffolds.js";

/** Insert <wbr> after path separators so long paths wrap without mid-glyph clips. */
export function BreakablePath({ path }: { path: string }): ReactNode {
  const parts = path.split("/");
  return parts.map((seg, i) => (
    <Fragment key={`${i}-${seg}`}>
      {seg}
      {i < parts.length - 1 ? (
        <>
          /<wbr />
        </>
      ) : null}
    </Fragment>
  ));
}

export function HonestyNote({
  phase,
  message,
  testId,
}: {
  phase: "loading" | "error" | "empty" | "offline" | "stale";
  message: string;
  testId?: string;
}) {
  return (
    <p
      className={`pc-task-honesty pc-task-honesty--${phase}`}
      data-testid={testId}
      role={phase === "error" ? "alert" : "status"}
    >
      {message}
    </p>
  );
}

// ── Header ──────────────────────────────────────────────────────────────

export function TaskHeader({
  task,
  onCopyBranch,
  branchCopied,
}: {
  task: TaskEnvelope;
  onCopyBranch: () => void;
  branchCopied: boolean;
}) {
  const name = task.name || task.task_id;
  return (
    <header className="pc-task-header" data-testid="task-header">
      <div className="pc-task-header__id">
        <h1 className="pc-task-header__name" title={name}>
          {name}
        </h1>
        <span className="pc-task-header__ids" title={`${task.task_id} · ${formatAddress(task)}`}>
          {task.task_id} · {formatAddress(task)}
        </span>
        <span className="pc-task-header__sub" title={task.branch ?? undefined}>
          {[task.vendor, task.model, task.effort].filter(Boolean).join(" · ") || "—"}
          {task.branch ? ` · ${task.branch}` : ""}
        </span>
      </div>
      <div className="pc-task-header__actions">
        <StateChip
          state={task.state}
          label={stateLabel(task.state)}
          testId="task-state-chip"
        />
        {task.branch ? (
          <button
            type="button"
            className="pc-task-copybtn"
            onClick={onCopyBranch}
            data-testid="task-copy-branch"
            aria-label={branchCopied ? "Branch copied" : `Copy branch ${task.branch}`}
          >
            {branchCopied ? "copied" : "copy branch"}
          </button>
        ) : null}
        <CopyScaffold
          text={task.task_id}
          label="copy id"
          testId="task-copy-id"
          className="pc-task-header__copyid"
        />
      </div>
    </header>
  );
}

// ── Brief ───────────────────────────────────────────────────────────────

export function BriefPanel({
  task,
  goal,
  status,
  error,
}: {
  task: TaskEnvelope | null;
  goal: string | null;
  status: PanelStatus;
  error: string | null;
}) {
  const goalId = useId();

  if (status === "loading" && !task) {
    return (
      <Panel title="brief" testId="task-brief">
        <HonestyNote phase="loading" message="Loading brief…" testId="task-brief-loading" />
      </Panel>
    );
  }
  if (status === "error" && !task) {
    return (
      <Panel title="brief" testId="task-brief">
        <HonestyNote
          phase="error"
          message={error ?? "Brief unavailable."}
          testId="task-brief-error"
        />
      </Panel>
    );
  }
  if (!task) {
    return (
      <Panel title="brief" testId="task-brief">
        <HonestyNote phase="empty" message="No task selected." testId="task-brief-empty" />
      </Panel>
    );
  }

  const queueNote =
    task.state === "queued" && task.queue_position != null
      ? ` · position ${task.queue_position}${
          task.blocking_cap
            ? ` · cap ${task.blocking_cap}${
                task.max_concurrent != null ? ` ${task.max_concurrent}/${task.max_concurrent}` : ""
              }`
            : ""
        }`
      : "";

  const rows: { label: string; value: ReactNode; color?: string; wrap?: boolean }[] = [
    {
      label: "goal",
      value: goal?.trim() ? goal : "— no brief on file",
      color: goal?.trim() ? "var(--text-strong-2)" : "var(--text-4)",
      wrap: true,
    },
    {
      label: "state",
      value: `${stateLabel(task.state)}${queueNote}`,
      color: stateColor(task.state),
    },
    {
      label: "branch",
      value: task.branch ? <BreakablePath path={task.branch} /> : "— none",
      color: task.branch ? "var(--link)" : "var(--text-4)",
      wrap: true,
    },
    {
      label: "worktree",
      value: task.worktree ? (
        <BreakablePath path={task.worktree} />
      ) : (
        <span data-testid="task-worktree-absent">— none</span>
      ),
      color: "var(--text-2)",
      wrap: true,
    },
    {
      label: "harness",
      value: (
        <span className="pc-task-harness">
          <span
            className="pc-task-harness__coat"
            style={{ background: coatVar(task.vendor) }}
            aria-hidden="true"
          />
          {[task.vendor ?? "—", task.model ?? "—", task.effort ? `effort ${task.effort}` : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      ),
    },
    {
      label: "posture",
      value: formatPosture(task.posture),
      color: "var(--text-2)",
    },
    {
      label: "address",
      value: formatAddress(task),
    },
    {
      label: "duration",
      value: task.started_at
        ? formatDuration(task.duration_ms)
        : "— not spawned yet",
    },
    {
      label: "usage",
      value: task.started_at ? formatUsage(task.usage) : "— not spawned yet",
      color: "var(--text-2)",
    },
  ];

  return (
    <Panel title="brief" testId="task-brief">
      {status === "error" && error ? (
        <HonestyNote phase="error" message={`Stale brief — ${error}`} testId="task-brief-stale" />
      ) : null}
      <dl className="pc-task-brief">
        {rows.map((r) => (
          <div className="pc-task-brief__row" key={r.label}>
            <dt className="pc-task-brief__label">{r.label}</dt>
            <dd
              className={`pc-task-brief__value${r.wrap ? " pc-task-brief__value--wrap" : ""}`}
              style={r.color ? { color: r.color } : undefined}
              title={typeof r.value === "string" ? r.value : undefined}
            >
              {r.label === "goal" && goal && goal.trim().length > 180 ? (
                <>
                  <span className="pc-task-brief__goal-excerpt">{goal}</span>
                  <button
                    type="button"
                    className="pc-task-brief__readfull"
                    popoverTarget={goalId}
                  >
                    read full
                  </button>
                  <div
                    id={goalId}
                    popover="auto"
                    className="pc-task-popover"
                    tabIndex={-1}
                    onToggle={(e: ToggleEvent<HTMLDivElement>) => {
                      if (e.newState === "open") e.currentTarget.focus();
                    }}
                  >
                    <div className="pc-task-popover__head">
                      <span>Full brief</span>
                      <button
                        type="button"
                        className="pc-task-popover__close"
                        popoverTarget={goalId}
                        popoverTargetAction="hide"
                        aria-label="Close full brief"
                      >
                        close
                      </button>
                    </div>
                    <p className="pc-task-popover__body" role="region" aria-label="Full brief">
                      {goal}
                    </p>
                  </div>
                </>
              ) : (
                r.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

// ── Why it failed ───────────────────────────────────────────────────────

export function WhyFailedWell({
  taskId,
  error,
}: {
  taskId: string;
  error: string | null | undefined;
}) {
  if (!error) return null;
  return (
    <div className="pc-task-failed" data-testid="task-why-failed" role="region" aria-label="Why it failed">
      <span className="pc-task-failed__label">why it failed</span>
      <p className="pc-task-failed__body">{error}</p>
      <CopyScaffold
        text={fixScaffold(taskId)}
        variant="block"
        label="copy"
        testId="task-fix-scaffold"
      />
    </div>
  );
}

// ── Eval feedback ───────────────────────────────────────────────────────

export function EvalFeedback({
  detail,
  status = "ready",
}: {
  detail: EvalDetail | null;
  status?: PanelStatus;
}) {
  if (status === "error" && !detail) {
    return (
      <Panel title="eval" testId="task-eval" meta={<span>unavailable</span>}>
        <HonestyNote
          phase="error"
          message="Eval unavailable — task detail failed to load."
          testId="task-eval-error"
        />
      </Panel>
    );
  }
  if (status === "loading" && !detail) {
    return (
      <Panel title="eval" testId="task-eval">
        <HonestyNote phase="loading" message="Loading eval…" />
      </Panel>
    );
  }
  if (!detail) {
    return (
      <Panel title="eval" testId="task-eval" meta={<span>absent</span>}>
        <HonestyNote
          phase="empty"
          message="No eval on file — this task has never been scored."
          testId="task-eval-empty"
        />
      </Panel>
    );
  }

  const scoreColor = evalScoreColor(detail.score, detail.baseline);
  const scoreText = formatEvalScore(detail.score, detail.baseline);
  const delta =
    detail.delta != null && Number.isFinite(detail.delta)
      ? `${detail.delta >= 0 ? "+" : ""}${detail.delta.toFixed(1)}`
      : null;

  return (
    <Panel
      title="eval"
      testId="task-eval"
      meta={
        <span style={{ color: scoreColor }} data-testid="task-eval-score">
          {scoreText}
          {detail.legacy ? " · legacy" : ""}
          {delta ? ` · Δ ${delta}` : ""}
        </span>
      }
    >
      {detail.feedback?.trim() ? (
        <p className="pc-task-eval__feedback" data-testid="task-eval-feedback">
          {detail.feedback}
        </p>
      ) : (
        <HonestyNote
          phase="empty"
          message="Scored, but no feedback text on file."
          testId="task-eval-no-feedback"
        />
      )}
      {detail.rubric ? (
        <p className="pc-task-eval__rubric">
          rubric {detail.rubric}
          {detail.rubric_version != null ? ` v${detail.rubric_version}` : ""}
          {detail.judge?.harness
            ? ` · judge ${[detail.judge.harness, detail.judge.model].filter(Boolean).join(" · ")}`
            : ""}
        </p>
      ) : null}
      {detail.criteria && detail.criteria.length > 0 ? (
        <ul className="pc-task-eval__criteria" data-testid="task-eval-criteria">
          {detail.criteria.map((c) => (
            <li
              key={c.id}
              className={`pc-task-eval__criterion${c.pass ? "" : " pc-task-eval__criterion--fail"}`}
            >
              <span className="pc-task-eval__criterion-id">{c.id}</span>
              <span className="pc-task-eval__criterion-pass">{c.pass ? "pass" : "fail"}</span>
              <span className="pc-task-eval__criterion-text" title={c.text}>
                {c.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

// ── Attempt chain ───────────────────────────────────────────────────────

export function AttemptChain({
  attempts,
  currentId,
  status,
}: {
  attempts: AttemptLineageEntry[];
  currentId: string | null;
  status: PanelStatus;
}) {
  if (status === "loading" && attempts.length === 0) {
    return (
      <Panel title="attempt chain" meta={<span>parley fix</span>} testId="task-attempts">
        <HonestyNote phase="loading" message="Loading attempts…" />
      </Panel>
    );
  }

  if (status === "error" && attempts.length === 0) {
    return (
      <Panel title="attempt chain" meta={<span>unavailable</span>} testId="task-attempts">
        <HonestyNote
          phase="error"
          message="Attempt chain unavailable — task detail failed to load."
          testId="task-attempts-error"
        />
      </Panel>
    );
  }

  if (attempts.length === 0) {
    return (
      <Panel title="attempt chain" meta={<span>parley fix</span>} testId="task-attempts">
        <HonestyNote
          phase="empty"
          message="No attempts yet — task not in a fix chain."
          testId="task-attempts-empty"
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="attempt chain"
      meta={<span>parley fix · {attempts.length}</span>}
      testId="task-attempts"
    >
      <ol className="pc-task-attempts" data-testid="task-attempt-list">
        {attempts.map((a) => {
          const current = a.id === currentId;
          const badges: string[] = [];
          if (a.cache_hit === true) badges.push("cache");
          else if (a.cache_hit === false) badges.push("no-cache");
          if (a.resumed) badges.push("resumed");
          if (a.eval_legacy) badges.push("legacy");
          return (
            <li
              key={a.id}
              className={`pc-task-attempt${current ? " pc-task-attempt--current" : ""}`}
              data-testid="task-attempt"
              data-current={current ? "true" : "false"}
              aria-current={current ? "true" : undefined}
            >
              <span className="pc-task-attempt__n">#{a.attempt}</span>
              <span
                className="pc-task-attempt__state"
                style={{ color: stateColor(a.state) }}
              >
                {stateLabel(a.state)}
                {badges.length > 0 ? (
                  <span className="pc-task-attempt__badges"> {badges.join(" · ")}</span>
                ) : null}
              </span>
              <span
                className="pc-task-attempt__score"
                style={{ color: evalScoreColor(a.eval_score, a.eval_baseline) }}
              >
                {formatEvalScore(a.eval_score, a.eval_baseline)}
              </span>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

// ── Log tail ────────────────────────────────────────────────────────────

function LogLineRow({ line, index }: { line: LogLine; index: number }) {
  const hello = isHelloLogLine(line);
  const [expanded, setExpanded] = useState(false);
  const kindColor = logKindColor(line.kind);
  const textColor = logTextColor(line.kind);

  if (hello) {
    return (
      <div
        className="pc-task-log__line pc-task-log__line--hello"
        data-kind={line.kind}
        data-hello="true"
        data-testid="task-log-hello"
      >
        <span className="pc-task-log__ln" aria-hidden="true">
          {formatLogLineNo(index)}
        </span>
        <div className="pc-task-log__hello">
          <button
            type="button"
            className="pc-task-log__hello-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            data-testid="task-log-hello-toggle"
          >
            <span className="pc-task-log__kind" style={{ color: "var(--text-4)" }}>
              hello
            </span>{" "}
            <span className="pc-task-log__hello-summary">
              {line.text.startsWith("session hello")
                ? line.text
                : "session hello · expand for envelope"}
            </span>
            <span className="pc-task-log__hello-cue" aria-hidden="true">
              {expanded ? "▾" : "▸"}
            </span>
          </button>
          {expanded ? (
            <pre className="pc-task-log__hello-body" data-testid="task-log-hello-body">
              {line.raw}
            </pre>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`pc-task-log__line${line.kind === "error" ? " pc-task-log__line--error" : ""}`}
      data-kind={line.kind}
    >
      <span className="pc-task-log__ln" aria-hidden="true">
        {formatLogLineNo(index)}
      </span>
      <span className="pc-task-log__text" style={{ color: textColor }}>
        <span className="pc-task-log__kind" style={{ color: kindColor }}>
          {line.kind === "error" ? "error" : line.kind}
        </span>{" "}
        {line.text}
      </span>
    </div>
  );
}

export function LogTailPanel({
  lines,
  status,
  follow,
  onFollowChange,
  taskId,
}: {
  lines: LogLine[];
  status: LogTailStatus;
  follow: boolean;
  onFollowChange: (next: boolean) => void;
  taskId: string | null;
}) {
  const wellRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const color = tailStatusColor(status);
  const live = isLiveTail(status) && follow;

  useEffect(() => {
    if (!follow || !stickRef.current) return;
    const el = wellRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, follow, status]);

  const onScroll = () => {
    const el = wellRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = dist < 48;
  };

  return (
    <section className="pc-task-log" data-testid="task-log" aria-label="Log tail">
      <header className="pc-task-panel__head pc-task-log__head">
        <h2 className="pc-task-panel__title">log tail</h2>
        <div className="pc-task-log__status">
          <span
            className={`pc-task-log__dot${live ? " pc-task-log__dot--live" : ""}`}
            style={{ background: color }}
            aria-hidden="true"
            data-testid="task-log-dot"
          />
          <span
            className="pc-task-log__status-text"
            style={{ color }}
            data-testid="task-log-status"
            data-status={status}
          >
            {taskId ? tailStatusLabel(status, follow) : "no task"}
          </span>
          <label className="pc-task-log__follow">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => onFollowChange(e.target.checked)}
              data-testid="task-log-follow"
            />
            follow
          </label>
        </div>
      </header>
      <div
        ref={wellRef}
        className="pc-task-log__well"
        data-testid="task-log-well"
        onScroll={onScroll}
        role="log"
        tabIndex={0}
        aria-label="Vendor log output"
        aria-live={live ? "polite" : "off"}
        aria-relevant="additions"
      >
        {!taskId ? (
          <HonestyNote phase="empty" message="Select a task to tail its vendor log." />
        ) : status === "unreachable" ? (
          <HonestyNote
            phase="error"
            message="Log stream unreachable — daemon may be down. Last lines kept when present."
            testId="task-log-unreachable"
          />
        ) : null}
        {taskId && lines.length === 0 && status !== "unreachable" ? (
          <HonestyNote
            phase={status === "connecting" ? "loading" : "empty"}
            message={
              status === "connecting"
                ? "Connecting to log tail…"
                : status === "ended"
                  ? "No log lines on file."
                  : "No log lines yet."
            }
            testId="task-log-empty"
          />
        ) : null}
        {lines.map((line, i) => (
          <LogLineRow key={`${i}-${line.raw.slice(0, 24)}`} line={line} index={i} />
        ))}
      </div>
    </section>
  );
}

// ── Outstanding ask band (full-width, hierarchy #1) ──────────────────

/**
 * Full-width outstanding-question band — largest text block on the task
 * screen when a question is pending. Answer scaffold rides here.
 */
export function AskBand({
  taskId,
  question,
}: {
  taskId: string;
  question: string;
}) {
  return (
    <section
      className="pc-task-ask-band"
      data-testid="task-ask-band"
      aria-label="Outstanding question"
    >
      <div className="pc-task-ask-band__head">
        <span className="pc-task-ask-band__tag">OUTSTANDING ASK</span>
        <span className="pc-task-ask-band__cue">needs the orchestrating agent</span>
      </div>
      <p className="pc-task-ask-band__question" data-testid="task-ask-band-question">
        {question}
      </p>
      <CopyScaffold
        text={answerScaffold(taskId)}
        variant="block"
        label="copy"
        testId="task-answer-scaffold"
      />
    </section>
  );
}

// ── Q&A ─────────────────────────────────────────────────────────────────

export function QaPanel({
  taskId,
  qa,
  status,
  /** When true, the outstanding scaffold already lives in the full-width ask band. */
  scaffoldInBand = false,
}: {
  taskId: string | null;
  qa: QaTurn[];
  status: PanelStatus;
  scaffoldInBand?: boolean;
}) {
  const outstanding = qa.filter((t) => t.answer == null).length;
  const meta =
    qa.length === 0
      ? "none"
      : outstanding > 0
        ? `${outstanding} outstanding`
        : `${qa.length} turn${qa.length === 1 ? "" : "s"}`;

  return (
    <Panel title="q&a — orchestrator answers" meta={<span>{meta}</span>} testId="task-qa">
      {status === "loading" && qa.length === 0 ? (
        <HonestyNote phase="loading" message="Loading Q&A…" />
      ) : null}
      {status === "error" && qa.length === 0 ? (
        <HonestyNote phase="error" message="Q&A unavailable." testId="task-qa-error" />
      ) : null}
      {!taskId ? (
        <HonestyNote phase="empty" message="No task selected." />
      ) : qa.length === 0 && status === "ready" ? (
        <HonestyNote
          phase="empty"
          message="No parley yet — this task has not raised a question."
          testId="task-qa-empty"
        />
      ) : null}
      {qa.length > 0 ? (
        <ul className="pc-task-qa" data-testid="task-qa-list" aria-label="Q&A transcript">
          {qa.map((turn) => {
            const pending = turn.answer == null;
            return (
              <li
                key={turn.question_id}
                className={`pc-task-qa__turn${pending ? " pc-task-qa__turn--pending" : ""}`}
                data-testid="task-qa-turn"
                data-pending={pending ? "true" : "false"}
              >
                <div className="pc-task-qa__row">
                  <span className="pc-task-qa__tag pc-task-qa__tag--ask">ASK</span>
                  <span className="pc-task-qa__question">{turn.question}</span>
                </div>
                <div className="pc-task-qa__row">
                  <span
                    className={`pc-task-qa__tag${
                      pending ? " pc-task-qa__tag--out" : " pc-task-qa__tag--orch"
                    }`}
                  >
                    {pending ? "OUTSTANDING" : "ORCH"}
                  </span>
                  <span
                    className={`pc-task-qa__answer${pending ? " pc-task-qa__answer--pending" : ""}`}
                  >
                    {pending
                      ? scaffoldInBand
                        ? "see ask band above — waiting on the orchestrating agent"
                        : "waiting on the orchestrating agent — humans do not answer here"
                      : turn.answer}
                  </span>
                </div>
                <div className="pc-task-qa__meta">
                  asked {formatAge(turn.asked_at)} ago
                  {turn.answered_at
                    ? ` · answered ${formatAge(turn.answered_at)} ago`
                    : " · event pending"}
                  {" · "}
                  <time dateTime={turn.asked_at}>{formatQaClock(turn.asked_at)}</time>
                </div>
                {pending && taskId && !scaffoldInBand ? (
                  <CopyScaffold
                    text={answerScaffold(taskId)}
                    variant="block"
                    label="copy"
                    testId="task-answer-scaffold"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Panel>
  );
}

// ── Report + file churn ─────────────────────────────────────────────────

export function ReportPanel({
  report,
  status,
  taskState,
}: {
  report: Report | null;
  status: PanelStatus;
  taskState: string | null;
}) {
  const filesView = projectReportFiles(report);
  const outcome = report?.outcome ?? null;
  const summaryId = useId();
  const summary = report?.summary?.trim() ?? "";
  const longSummary = summary.length > 180;

  return (
    <Panel
      title="report"
      testId="task-report"
      meta={
        outcome ? (
          <span
            style={{ color: outcomeColor(outcome) }}
            data-testid="task-report-outcome"
            data-outcome={outcome}
          >
            {outcome.toUpperCase()}
          </span>
        ) : (
          <span>none</span>
        )
      }
    >
      {status === "loading" && !report ? (
        <HonestyNote phase="loading" message="Loading report…" />
      ) : null}
      {status === "error" && !report ? (
        <HonestyNote
          phase="error"
          message="Report unavailable — task detail failed to load."
          testId="task-report-error"
        />
      ) : null}
      {!report && status !== "error" && status !== "loading" ? (
        <HonestyNote
          phase="empty"
          message={
            taskState && isTerminalState(taskState)
              ? "Terminal task with no report on file."
              : "No report yet — the task has not submitted one."
          }
          testId="task-report-empty"
        />
      ) : null}
      {report ? (
        <>
          <div className="pc-task-report__summary-wrap" data-testid="task-report-summary">
            <p
              className={`pc-task-report__summary${longSummary ? " pc-task-report__summary--clamp" : ""}`}
            >
              {summary || "— empty summary"}
            </p>
            {longSummary ? (
              <>
                <button
                  type="button"
                  className="pc-task-brief__readfull"
                  popoverTarget={summaryId}
                >
                  read full
                </button>
                <div
                  id={summaryId}
                  popover="auto"
                  className="pc-task-popover"
                  tabIndex={-1}
                  onToggle={(e: ToggleEvent<HTMLDivElement>) => {
                    if (e.newState === "open") e.currentTarget.focus();
                  }}
                >
                  <div className="pc-task-popover__head">
                    <span>Full report</span>
                    <button
                      type="button"
                      className="pc-task-popover__close"
                      popoverTarget={summaryId}
                      popoverTargetAction="hide"
                      aria-label="Close full report"
                    >
                      close
                    </button>
                  </div>
                  <p className="pc-task-popover__body" role="region" aria-label="Full report">
                    {summary}
                  </p>
                </div>
              </>
            ) : null}
          </div>
          {filesView.files.length === 0 ? (
            <HonestyNote
              phase="empty"
              message="No files_changed entries."
              testId="task-report-nofiles"
            />
          ) : (
            <ul className="pc-task-files" data-testid="task-report-files" aria-label="Files changed">
              {filesView.files.map((f) => (
                <FileRow key={f.path} file={f} reportHasChurn={filesView.hasChurn} />
              ))}
            </ul>
          )}
          {!filesView.hasChurn && filesView.files.length > 0 ? (
            <p className="pc-task-files__note" data-testid="task-report-nochurn">
              Path list only — no +/− churn on file (pre-churn report or unknown counts).
            </p>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

function FileRow({
  file,
  reportHasChurn,
}: {
  file: FileChangeView;
  reportHasChurn: boolean;
}) {
  const churn = formatChurn(file);
  const hasCounts = file.added !== null || file.removed !== null;
  // Path-only rows always show an explicit absence cue (not blank, not 0/0):
  // an empty generic span may not carry aria-label (aria-prohibited-attr).
  void reportHasChurn;
  const absentCue = "—";
  return (
    <li className="pc-task-files__row" data-testid="task-file-row" data-has-churn={hasCounts}>
      <span className="pc-task-files__path" title={file.path}>
        <BreakablePath path={file.path} />
      </span>
      <span
        className={`pc-task-files__churn${hasCounts ? "" : " pc-task-files__churn--absent"}`}
        data-testid="task-file-churn"
        aria-label={hasCounts ? `churn ${churn}` : "churn unknown"}
      >
        {hasCounts ? churn : absentCue}
      </span>
    </li>
  );
}

// ── Deliverables honesty ────────────────────────────────────────────────

export type DeliverableFetchState =
  | "not_fetched"
  | "none"
  | "ready"
  | "error"
  | "purged"
  | "missing-worktree"
  | "loading";

export function DeliverablesPanel({
  fetchState,
  items,
  error,
  hasRun,
}: {
  fetchState: DeliverableFetchState;
  items: DeliverableRef[];
  error: string | null;
  /** true = run-owned; false = solo; null = unknown (detail failed). */
  hasRun: boolean | null;
}) {
  const metaLabel =
    hasRun === null
      ? "unavailable"
      : fetchState === "not_fetched"
        ? "not_fetched"
        : fetchState === "loading"
          ? "loading"
          : fetchState === "error"
            ? "error"
            : fetchState === "none"
              ? "none"
              : fetchState === "missing-worktree"
                ? "missing-worktree"
                : fetchState === "purged"
                  ? "purged"
                  : `${items.length}`;

  return (
    <Panel
      title="deliverables"
      testId="task-deliverables"
      meta={
        <span data-testid="task-dlv-state" data-state={hasRun === null ? "unavailable" : fetchState}>
          {metaLabel}
        </span>
      }
    >
      {hasRun === null ? (
        <HonestyNote
          phase="error"
          message={error ?? "Deliverables unavailable — task detail failed to load."}
          testId="task-dlv-unavailable"
        />
      ) : hasRun === false ? (
        <HonestyNote
          phase="empty"
          message="Solo task — no run deliverables."
          testId="task-dlv-solo"
        />
      ) : fetchState === "not_fetched" || fetchState === "loading" ? (
        <HonestyNote
          phase="loading"
          message={
            fetchState === "not_fetched"
              ? "Deliverables not fetched yet."
              : "Fetching deliverables…"
          }
          testId="task-dlv-loading"
        />
      ) : fetchState === "error" ? (
        <HonestyNote
          phase="error"
          message={error ?? "Could not load deliverables."}
          testId="task-dlv-error"
        />
      ) : fetchState === "none" ? (
        <HonestyNote
          phase="empty"
          message="No deliverables on this node."
          testId="task-dlv-none"
        />
      ) : fetchState === "missing-worktree" ? (
        <HonestyNote
          phase="error"
          message="Worktree missing — file/dir deliverables do not outlive their workspace."
          testId="task-dlv-missing-wt"
        />
      ) : (
        <ul className="pc-task-dlv" data-testid="task-dlv-list">
          {items.map((d) => {
            const purged = d.purged_at != null;
            return (
              <li
                key={d.deliverable_id}
                className={`pc-task-dlv__row${purged ? " pc-task-dlv__row--purged" : ""}`}
                data-testid="task-dlv-row"
                data-purged={purged ? "true" : "false"}
              >
                <span className="pc-task-dlv__kind">{d.kind.toUpperCase()}</span>
                <span className="pc-task-dlv__port" title={`${d.node}.${d.port}`}>
                  {d.node}.{d.port}
                  {d.slot ? `[${d.slot}]` : ""}
                </span>
                <span className="pc-task-dlv__meta">
                  {purged
                    ? `purged ${formatAge(d.purged_at)} ago`
                    : d.size?.bytes != null
                      ? `${d.size.bytes} B`
                      : d.size?.elements != null
                        ? `${d.size.elements} els`
                        : "ready"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
