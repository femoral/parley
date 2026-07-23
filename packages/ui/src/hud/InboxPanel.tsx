import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type UIEvent,
} from "react";
import { Mark, Plate, PlateHeader } from "../primitives/index.js";
import { MARK_BANNER, MARK_COMPASS } from "../tokens/chrome-glyphs.js";
import { InboxCard } from "./InboxCard.js";
import type { InboxTask } from "./types.js";

export interface InboxPanelProps {
  /** Tasks awaiting an answer, already sorted awaiting-first (hooks layer). */
  tasks: InboxTask[];
  /** Select a task in the roster/inspector — same callback the roster rows use. */
  onSelectTask: (id: string) => void;
  /**
   * True when the roster is scoped to one orchestrator session. Inbox counts
   * stay fleet-wide; when set, a quiet "fleet-wide" qualifier explains the
   * mismatch with a session-filtered roster that may show no awaiting group.
   */
  sessionFilterActive?: boolean;
}

/** Distance from the true bottom still treated as "scrolled to end". */
const INBOX_SCROLL_END_PX = 8;

function isNearScrollEnd(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= INBOX_SCROLL_END_PX;
}

/**
 * Layer 2 — the inbox (design-manifest §4.15/§4.16, docs/spec/ui-v1-scope.md's
 * read-only cockpit). Ember-tinted plate holding one card per task blocked
 * on an answer, a red "NEEDS YOU · N" count pill in the header, and the
 * manifest's quiet-cove empty state when nothing needs a flag raised. Plain
 * props throughout — the hooks layer sorts/filters the tasks. Memoized like
 * `RosterPanel` because the cockpit shell re-renders every second for its
 * clock, while `tasks` is identity-stable between snapshot updates.
 * `onSelectTask` must stay identity-stable (useCockpit's roster.selectTask).
 *
 * An `aria-live="polite"` region announces count changes ("2 tasks need you")
 * so a PARLEY! event is not silent to AT. Polite (not assertive); content only
 * changes when `count` changes, so memoized re-renders with the same tasks
 * identity do not spam announcements.
 *
 * Scope caption sits *above* the card list so the inspector-open height clamp
 * never paints it across a mid-card cut edge. When the list overflows, a
 * sticky bottom fade ("More below") mirrors the chart-key scroll cue.
 */
export const InboxPanel = memo(function InboxPanel({
  tasks,
  onSelectTask,
  sessionFilterActive = false,
}: InboxPanelProps) {
  const count = tasks.length;
  // Count after the words so the tiny pill never scans as "I NEEDS YOU".
  const liveMessage =
    count === 0
      ? "No tasks need you"
      : count === 1
        ? "1 task needs you"
        : `${count} tasks need you`;
  // When the roster is session-scoped, inbox counts remain fleet-wide — say so.
  const pillLabel =
    sessionFilterActive && count > 0 ? `${liveMessage}, fleet-wide` : liveMessage;
  const subtitle =
    sessionFilterActive && count > 0
      ? "the flags that need you · fleet-wide"
      : "the flags that need you";

  /** True while overflow content remains below the fold (fade / "more" cue). */
  const [moreBelow, setMoreBelow] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const measureMoreBelow = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      setMoreBelow(false);
      return;
    }
    const overflows = el.scrollHeight > el.clientHeight + 1;
    setMoreBelow(overflows && !isNearScrollEnd(el));
  }, []);

  const onListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const overflows = el.scrollHeight > el.clientHeight + 1;
    setMoreBelow(overflows && !isNearScrollEnd(el));
  }, []);

  // Re-measure when card count changes or the inspector clamp resizes the list.
  useLayoutEffect(() => {
    if (count === 0) {
      setMoreBelow(false);
      return;
    }
    measureMoreBelow();
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureMoreBelow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [count, measureMoreBelow]);

  return (
    <Plate variant="ember" padded={false} className="pc-inbox">
      <PlateHeader
        icon={<Mark mark={MARK_BANNER} size={14} />}
        title="INBOX"
        subtitle={subtitle}
        divider
        aside={
          count > 0 ? (
            <span className="pc-inbox__aside">
              {sessionFilterActive ? (
                <span className="pc-inbox__fleet-wide" aria-hidden="true">
                  fleet-wide
                </span>
              ) : null}
              <span className="pc-inbox__pill" aria-label={pillLabel}>
                NEEDS YOU · {count}
              </span>
            </span>
          ) : undefined
        }
      />
      {/* Live region outside the pill so empty→non-empty still announces. */}
      <div className="pc-visually-hidden" aria-live="polite" aria-atomic="true">
        {pillLabel}
      </div>
      {/* Scope above the list so the inspector-open clamp never cuts through it. */}
      {count > 0 ? (
        <p className="pc-inbox__scope">
          Answer from your orchestrator session — the cove keeps watch.
        </p>
      ) : null}
      <div
        ref={listRef}
        className="pc-inbox__list"
        onScroll={onListScroll}
      >
        {count === 0 ? (
          <p className="pc-inbox__empty">
            <span aria-hidden="true">
              <Mark mark={MARK_COMPASS} size={14} />
            </span>{" "}
            All hands accounted for. No flags flying.
          </p>
        ) : (
          <>
            {tasks.map((task) => (
              <InboxCard key={task.id} task={task} onSelectTask={onSelectTask} />
            ))}
            {/* Sticky bottom fade + "more below" — pattern matches chart-key cue. */}
            <div
              className={`pc-inbox__scroll-cue${moreBelow ? "" : " pc-inbox__scroll-cue--hidden"}`}
              aria-hidden="true"
            >
              <span className="pc-inbox__scroll-cue-label">More below</span>
            </div>
          </>
        )}
      </div>
    </Plate>
  );
});
