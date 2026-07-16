import { memo } from "react";
import { Plate, PlateHeader } from "../primitives/index.js";
import { InboxCard } from "./InboxCard.js";
import type { InboxTask } from "./types.js";

export interface InboxPanelProps {
  /** Tasks awaiting an answer, already sorted awaiting-first (hooks layer). */
  tasks: InboxTask[];
  /** Select a task in the roster/inspector — same callback the roster rows use. */
  onSelectTask: (id: string) => void;
}

/**
 * Layer 2 — the inbox (design-manifest §4.15/§4.16, docs/spec/ui-v1-scope.md's
 * read-only cockpit). Ember-tinted plate holding one card per task blocked
 * on an answer, a red "N NEEDS YOU" count pill in the header, and the
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
 */
export const InboxPanel = memo(function InboxPanel({ tasks, onSelectTask }: InboxPanelProps) {
  const count = tasks.length;
  const liveMessage =
    count === 0
      ? "No tasks need you"
      : count === 1
        ? "1 task needs you"
        : `${count} tasks need you`;
  return (
    <Plate variant="ember" padded={false} className="pc-inbox">
      <PlateHeader
        icon="🚩"
        title="INBOX"
        subtitle="the flags that need you"
        divider
        aside={
          count > 0 ? (
            <span className="pc-inbox__pill">{count} NEEDS YOU</span>
          ) : undefined
        }
      />
      {/* Live region outside the pill so empty→non-empty still announces. */}
      <div className="pc-visually-hidden" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </div>
      <div className="pc-inbox__list">
        {count === 0 ? (
          <p className="pc-inbox__empty">
            <span aria-hidden="true">🧭</span> All hands accounted for. No flags flying.
          </p>
        ) : (
          tasks.map((task) => (
            <InboxCard key={task.id} task={task} onSelectTask={onSelectTask} />
          ))
        )}
      </div>
      {count > 0 ? (
        <p className="pc-inbox__scope">
          Answer from your orchestrator session — the cove keeps watch.
        </p>
      ) : null}
    </Plate>
  );
});
