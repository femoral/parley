import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Badge, Divider, Emblem, Mark, Plate } from "../../primitives/index.js";
import { MARK_ANCHOR } from "../../tokens/chrome-glyphs.js";
import { stateMetaFor } from "../../tokens/state-meta.js";
import { KEYBOARD_SHORTCUTS } from "../keyboardShortcuts.js";
import { BriefTab } from "./BriefTab.js";
import { LogsTab } from "./LogsTab.js";
import { ReportTab } from "./ReportTab.js";
import { QaTab } from "./QaTab.js";
import type { InspectorTask } from "../types.js";

const TABS = [
  { key: "brief", label: "BRIEF" },
  { key: "logs", label: "LOGS" },
  { key: "report", label: "REPORT" },
  { key: "qa", label: "Q&A" },
] as const;

function clipboardAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
}

/**
 * Task-id copy on the LOGBOOK head (not inside roster options — ARIA options
 * must not nest interactive descendants). Mirrors InboxCard / BriefTab:
 * clipboard.writeText with select-on-click fallback.
 */
function TaskIdCopy({ taskId }: { taskId: string }) {
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(true);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scaffoldRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setCanCopy(clipboardAvailable());
    return () => {
      if (revertTimer.current) clearTimeout(revertTimer.current);
    };
  }, []);

  const markCopied = useCallback(() => {
    setCopied(true);
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  const handleCopy = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (clipboardAvailable()) {
        try {
          await navigator.clipboard.writeText(taskId);
          markCopied();
          return;
        } catch {
          // Fall through to select-on-click fallback.
        }
      }
      const el = scaffoldRef.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        markCopied();
      } else {
        setCanCopy(false);
      }
    },
    [taskId, markCopied],
  );

  if (!canCopy) return null;

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
   * has no selection — renders a quiet placeholder rather than empty tabs. */
  task: InspectorTask | null;
  /**
   * Tab to land on when a selection is opened. Defaults to `"brief"`.
   * Re-applied whenever {@link openSeq} advances (each selection), so the user
   * can still switch tabs freely after landing.
   */
  initialTab?: InspectorTabKey;
  /**
   * Monotonic counter bumped on every selection so re-opening the same task
   * (e.g. inbox → Q&A again) re-applies {@link initialTab}.
   */
  openSeq?: number;
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
  initialTab = "brief",
  openSeq = 0,
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

  // Apply the open intent on every selection (openSeq), not only when the task
  // id changes — so inbox re-click of the same awaiting task still lands on Q&A.
  useEffect(() => {
    setActive(initialTab);
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
  // `hasTask` (not the task object) keeps the effect free of projection churn.
  const hasTask = task !== null;
  useEffect(() => {
    if (!hasTask) return;
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
  }, [openSeq, hasTask]);

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

  if (!task) {
    return (
      <Plate variant="premium" className="pc-inspector pc-inspector--empty">
        <div ref={scrollAnchorRef} className="pc-inspector__scroll-anchor" aria-hidden="true" />
        <p className="pc-inspector__placeholder">
          <span aria-hidden="true">
            <Mark mark={MARK_ANCHOR} size={13} />
          </span>{" "}
          Select a soul from the roster to open the logbook.
        </p>
        {/* Quiet resting content — earns the empty plate's footprint without noise. */}
        <ul className="pc-inspector__rest-keys" aria-label="Keyboard shortcuts">
          {KEYBOARD_SHORTCUTS.map((row) => (
            <li className="pc-inspector__rest-key" key={row.key}>
              <kbd className="pc-inspector__rest-kbd">{row.key}</kbd>
              <span className="pc-inspector__rest-hint">{row.hint}</span>
            </li>
          ))}
        </ul>
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
            <span className="pc-inspector__name-sub-text">
              {task.name} · {task.id}
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
          <QaTab qa={task.qa} coat={task.coat} emblem={task.emblem} faction={task.faction} />
        )}
      </div>
    </Plate>
  );
});
