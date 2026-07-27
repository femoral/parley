import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Badge, Divider, Emblem, Mark, Plate, PlateHeader } from "../../primitives/index.js";
import { MARK_ANCHOR } from "../../tokens/chrome-glyphs.js";
import { stateMetaFor } from "../../tokens/state-meta.js";
import { KEYBOARD_SHORTCUTS } from "../keyboardShortcuts.js";
import { useCopyScaffold } from "../useCopyScaffold.js";
import { BriefTab } from "./BriefTab.js";
import { LogsTab } from "./LogsTab.js";
import { ReportTab } from "./ReportTab.js";
import { QaTab } from "./QaTab.js";
import { RunView } from "./RunView.js";
import type {
  InspectorRun,
  InspectorTask,
  LogbookDigest,
  LogbookDigestItem,
} from "../types.js";

const TABS = [
  { key: "brief", label: "BRIEF" },
  { key: "logs", label: "LOGS" },
  { key: "report", label: "REPORT" },
  { key: "qa", label: "Q&A" },
] as const;

/** 8-char short ref — same truncation as roster meta / InboxCard. */
function shortRef(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Task-id copy on the LOGBOOK head (not inside roster options — ARIA options
 * must not nest interactive descendants). Shared scaffold: clipboard.writeText
 * with select-on-click fallback.
 */
function TaskIdCopy({ taskId }: { taskId: string }) {
  const { copied, canCopy, scaffoldRef, copy } = useCopyScaffold(taskId);

  if (!canCopy) return null;

  const handleCopy = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void copy();
  };

  return (
    <>
      {/* Hidden scaffold text for select-on-click fallback when clipboard fails. */}
      <span ref={scaffoldRef} className="pc-inspector__id-scaffold" aria-hidden="true">
        {taskId}
      </span>
      <button
        type="button"
        className="pc-inspector__id-copy"
        title={copied ? "Copied task id" : `Copy task id ${taskId}`}
        aria-label={copied ? "Copied task id" : "Copy task id"}
        onClick={handleCopy}
      >
        {copied ? "copied ✓" : "copy"}
      </button>
    </>
  );
}

export type InspectorTabKey = (typeof TABS)[number]["key"];

export interface InspectorProps {
  /** The selected task's full inspector payload, or `null` when the roster
   * has no task selection — renders a quiet placeholder rather than empty tabs. */
  task: InspectorTask | null;
  /**
   * Selected run payload (#254). When set, the plate shows the CLI node table
   * instead of task tabs. Mutually exclusive with {@link task} at the shell.
   */
  run?: InspectorRun | null;
  /**
   * Explicit tab intent for a selection. `"qa"` is re-applied whenever
   * {@link openSeq} advances; the ordinary `"brief"` default leaves a user's
   * current tab sticky across task switches.
   */
  initialTab?: InspectorTabKey;
  /**
   * Monotonic counter bumped on every selection so re-opening the same task
   * (e.g. inbox → Q&A again) re-applies {@link initialTab}.
   */
  openSeq?: number;
  /**
   * Quiet fleet digest for the resting (no-selection) plate. Projected from
   * the roster snapshot in the cockpit shell; ignored while a task or run is open.
   * Omit or pass a no-fleet digest for the hint-centric empty state.
   */
  digest?: LogbookDigest | null;
}

/** One quiet dual-coded tally chip (glyph + colour + label; never hue alone). */
function DigestTally({
  count,
  state,
  shortLabel,
}: {
  count: number;
  state: "completed" | "failed" | "running";
  shortLabel: string;
}) {
  const meta = stateMetaFor(state);
  const style = { "--digest-tally-color": meta.colorVar } as CSSProperties;
  return (
    <div className="pc-inspector__digest-tally" style={style}>
      <span className="pc-inspector__digest-tally-glyph" aria-hidden="true">
        <Mark mark={meta.mark} size={11} />
      </span>
      <span className="pc-inspector__digest-tally-value">{count}</span>
      <span className="pc-inspector__digest-tally-label">{shortLabel}</span>
    </div>
  );
}

/** Quiet digest row — emblem + name + relative age (roster idioms, no click). */
function DigestRow({
  item,
  state,
  failed,
}: {
  item: LogbookDigestItem;
  state: "completed" | "failed";
  failed?: boolean;
}) {
  const meta = stateMetaFor(state);
  return (
    <li
      className={`pc-inspector__digest-row${failed ? " pc-inspector__digest-row--failed" : ""}`}
    >
      <Emblem coat={item.coat} mark={item.emblem} size={20} label={item.faction} />
      <span className="pc-inspector__digest-row-body">
        <span className="pc-inspector__digest-row-name">{item.name}</span>
      </span>
      {item.age && (
        <span className="pc-inspector__digest-row-age" aria-hidden="true">
          {item.age}
        </span>
      )}
      <span
        className="pc-inspector__digest-row-state"
        style={{ color: meta.colorVar }}
        title={meta.label}
        aria-label={meta.label}
      >
        <Mark mark={meta.mark} size={11} />
      </span>
    </li>
  );
}

/**
 * Layer 2 — the active task inspector (design-manifest §4.17, #68). Premium
 * plate; header (faction emblem, engraved LOGBOOK title + name·id subtitle —
 * a peer of the other plates' PlateHeader titles; state badge, eval score
 * badge when present); a four-tab bar (Brief | Logs | Report | Q&A) with local
 * tab-selection state (ephemeral UI state owned here, same as `InboxCard`'s
 * draft text — not a fetch, contract 2 is about data, not interaction state);
 * a scrollable body per tab. Plain props throughout — the hooks layer
 * (`useTaskDetail`, `useLogTail`, `projectInspector`) does every fetch and
 * projection. Memoized like `RosterPanel`/`InboxPanel` — the cockpit shell
 * re-renders every second for its clock, and `task` is identity-stable between
 * real data changes (the hooks layer memoizes the projection).
 */
export const Inspector = memo(function Inspector({
  task,
  run = null,
  initialTab = "brief",
  openSeq = 0,
  digest = null,
}: InspectorProps) {
  const [active, setActive] = useState<InspectorTabKey>(initialTab);
  const [evalExpanded, setEvalExpanded] = useState(false);
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Anchor at the top of the plate so scrollIntoView brings the LOGBOOK into
   * the right rail without wrapping the plate (Cockpit flex targets
   * `.pc-region--right > .pc-inspector` as a direct child). */
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  /** Focus target when a selection opens — announces LOGBOOK to AT without
   * nesting a second tab stop in the tablist (tabIndex=-1 programatic only). */
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const panelId = `${baseId}-panel`;
  const evalFeedbackId = `${baseId}-eval-feedback`;
  const tabId = (key: InspectorTabKey): string => `${baseId}-tab-${key}`;

  // The selection layer represents "no explicit tab intent" as its historical
  // `brief` default. Preserve the locally chosen tab in that case. Non-default
  // intents still win on every selection, including inbox re-clicks of the same
  // awaiting task.
  useEffect(() => {
    if (initialTab !== "brief") setActive(initialTab);
    setEvalExpanded(false);
  }, [initialTab, openSeq]);

  // When a selection opens (openSeq advances), scroll the inspector plate into
  // view within the right rail so WHY IT FAILED / logs aren't left below the
  // fold. block:"start" pins the plate header/tab strip at the top of the rail
  // viewport (block:"nearest" was satisfied by a ~90px sliver at the bottom).
  // Respect prefers-reduced-motion: smooth only when motion is allowed.
  //
  // Focus moves to the LOGBOOK heading only on openSeq (explicit activation:
  // click / Enter / inbox / scene / n-key) — never on snapshot-driven task
  // identity churn, which would yank focus out of the roster while arrowing.
  // Also never steal focus from a text field the user is typing in, or from
  // an unselected roster option (browse without activate).
  // `hasSelection` (not the task object) keeps the effect free of projection churn.
  const hasTask = task !== null;
  const hasRun = run !== null;
  const hasSelection = hasTask || hasRun;
  useEffect(() => {
    if (!hasSelection) return;
    const el = scrollAnchorRef.current;
    if (!el) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({
      block: "start",
      behavior: reduceMotion ? "auto" : "smooth",
    });

    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const tag = active.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        active.isContentEditable
      ) {
        return;
      }
      // Roving listbox browse: focus is on an option that is not the active
      // selection — leave the user in the fleet list.
      if (
        active.getAttribute("role") === "option" &&
        active.getAttribute("aria-selected") !== "true" &&
        active.closest('[aria-label="Fleet tasks"]')
      ) {
        return;
      }
    }
    // Defer so scrollIntoView and tab state settle first.
    requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
  }, [openSeq, hasSelection]);

  const focusTabAt = (index: number): void => {
    tabRefs.current[index]?.focus();
  };

  // Manual-activation tabs (WAI-ARIA APG): arrows/Home/End only move focus;
  // Enter/Space activate via the button's native click. Do not call setActive
  // here or Space would double-fire (keydown handler + click).
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = TABS.length - 1;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusTabAt(next);
  };

  // Run view takes the plate when a run is selected (#254). No task tabs.
  if (run) {
    return (
      <Plate variant="premium" padded={false} className="pc-inspector pc-inspector--run">
        <div ref={scrollAnchorRef} className="pc-inspector__scroll-anchor" aria-hidden="true" />
        <PlateHeader
          icon={<Mark mark={MARK_ANCHOR} size={14} />}
          title="LOGBOOK"
          divider
        />
        <div className="pc-inspector__body">
          <RunView run={run} />
        </div>
      </Plate>
    );
  }

  if (!task) {
    const showDigest = Boolean(digest?.hasFleet);
    return (
      <Plate
        variant="premium"
        padded={false}
        className={`pc-inspector pc-inspector--empty${showDigest ? " pc-inspector--digest" : ""}`}
      >
        <div ref={scrollAnchorRef} className="pc-inspector__scroll-anchor" aria-hidden="true" />
        <PlateHeader
          icon={<Mark mark={MARK_ANCHOR} size={14} />}
          title="LOGBOOK"
          divider
        />
        <div className="pc-inspector__rest">
          {showDigest && digest ? (
            <div
              className="pc-inspector__digest"
              data-testid="logbook-digest"
              role="region"
              aria-label="Fleet digest"
              tabIndex={0}
            >
              <p className="pc-inspector__digest-flavor">
                The log rests. The fleet is still out.
              </p>
              <section
                className="pc-inspector__digest-group"
                aria-label="Fleet tallies"
              >
                <h3 className="pc-inspector__digest-label">TODAY</h3>
                <div className="pc-inspector__digest-tallies">
                  <DigestTally
                    count={digest.completed}
                    state="completed"
                    shortLabel="done"
                  />
                  <DigestTally
                    count={digest.failed}
                    state="failed"
                    shortLabel="failed"
                  />
                  <DigestTally
                    count={digest.running}
                    state="running"
                    shortLabel="at sea"
                  />
                </div>
              </section>
              {digest.recentCompletions.length > 0 && (
                <section
                  className="pc-inspector__digest-group"
                  aria-label="Last reports in"
                >
                  <h3 className="pc-inspector__digest-label">LAST REPORTS IN</h3>
                  <ul className="pc-inspector__digest-list">
                    {digest.recentCompletions.map((item) => (
                      <DigestRow key={item.id} item={item} state="completed" />
                    ))}
                  </ul>
                </section>
              )}
              {digest.latestFailure && (
                <section
                  className="pc-inspector__digest-group"
                  aria-label="Latest failure"
                >
                  <h3 className="pc-inspector__digest-label">LATEST FAILURE</h3>
                  <ul className="pc-inspector__digest-list">
                    <DigestRow
                      item={digest.latestFailure}
                      state="failed"
                      failed
                    />
                  </ul>
                </section>
              )}
            </div>
          ) : (
            <p className="pc-inspector__placeholder">
              <span aria-hidden="true">
                <Mark mark={MARK_ANCHOR} size={13} />
              </span>{" "}
              Select a soul from the roster to open the logbook.
            </p>
          )}
          {/* Quiet resting content — earns the empty plate's footprint without noise. */}
          <ul className="pc-inspector__rest-keys" aria-label="Keyboard shortcuts">
            {KEYBOARD_SHORTCUTS.map((row) => (
              <li className="pc-inspector__rest-key" key={row.key}>
                <kbd className="pc-inspector__rest-kbd">{row.key}</kbd>
                <span className="pc-inspector__rest-hint">{row.hint}</span>
              </li>
            ))}
          </ul>
        </div>
      </Plate>
    );
  }

  const meta = stateMetaFor(task.state);

  return (
    <Plate variant="premium" padded={false} className="pc-inspector">
      <div ref={scrollAnchorRef} className="pc-inspector__scroll-anchor" aria-hidden="true" />
      <div className="pc-inspector__head">
        <Emblem coat={task.coat} mark={task.emblem} size={28} label={task.faction} />
        <div className="pc-inspector__head-titles">
          <h2
            ref={headingRef}
            className="pc-inspector__title"
            tabIndex={-1}
          >
            LOGBOOK
          </h2>
          <span className="pc-inspector__name-sub">
            {/* Name may ellipsize; short ref + copy stay flex:0 so the id tail
                is never cut off before the copy button (roster meta pattern). */}
            <span className="pc-inspector__name-sub-text">{task.name}</span>
            <span className="pc-inspector__name-sub-sep" aria-hidden="true">
              {" "}
              ·{" "}
            </span>
            <span className="pc-inspector__name-sub-id" title={task.id}>
              <span aria-hidden="true">{shortRef(task.id)}</span>
              <span className="pc-visually-hidden">task id {task.id}</span>
            </span>
            <TaskIdCopy taskId={task.id} />
          </span>
        </div>
        <div className="pc-inspector__head-aside">
          {task.evalScore !== null && (
            <Badge label={`★ ${task.evalScore}/10`} color="var(--brass)" />
          )}
          <Badge
            label={
              task.state === "queued" && task.queuePosition !== null
                ? task.blockingCap
                  ? `${meta.label} #${task.queuePosition} · ${task.blockingCap}`
                  : `${meta.label} #${task.queuePosition}`
                : meta.label
            }
            glyph={<Mark mark={meta.mark} size={10} />}
            color={meta.colorVar}
          />
        </div>
      </div>
      {task.evalFeedback !== null && (
        <div className="pc-inspector__eval-feedback">
          <span className="pc-inspector__eval-feedback-label">EVALUATION</span>
          <div className="pc-inspector__eval-feedback-body">
            <p
              id={evalFeedbackId}
              className={
                evalExpanded
                  ? "pc-inspector__eval-feedback-text pc-inspector__eval-feedback-text--open"
                  : "pc-inspector__eval-feedback-text"
              }
            >
              {task.evalFeedback}
            </p>
            <button
              type="button"
              className="pc-inspector__eval-feedback-toggle"
              aria-expanded={evalExpanded}
              aria-controls={evalFeedbackId}
              onClick={() => setEvalExpanded((open) => !open)}
            >
              {evalExpanded ? "less" : "more"}
            </button>
          </div>
        </div>
      )}
      <Divider />
      <div className="pc-inspector__tabs" role="tablist" aria-label="Task inspector">
        {TABS.map((tab, index) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            id={tabId(tab.key)}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            aria-controls={panelId}
            tabIndex={active === tab.key ? 0 : -1}
            className={`pc-inspector__tab${active === tab.key ? " pc-inspector__tab--active" : ""}`}
            onClick={() => setActive(tab.key)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={panelId}
        className="pc-inspector__body"
        role="tabpanel"
        aria-labelledby={tabId(active)}
      >
        {active === "brief" && (
          <BriefTab
            brief={task.brief}
            taskId={task.id}
            error={task.state === "failed" ? task.error : null}
            attempts={task.attempts}
            onOpenLogs={() => setActive("logs")}
          />
        )}
        {active === "logs" && <LogsTab logs={task.logs} />}
        {active === "report" && <ReportTab report={task.report} />}
        {active === "qa" && (
          <QaTab
            taskId={task.id}
            qa={task.qa}
            coat={task.coat}
            emblem={task.emblem}
            faction={task.faction}
          />
        )}
      </div>
    </Plate>
  );
});
