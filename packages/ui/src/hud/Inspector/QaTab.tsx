import { Emblem, Mark } from "../../primitives/index.js";
import { MARK_ANCHOR } from "../../tokens/chrome-glyphs.js";
import type { EmblemMark } from "../../tokens/factions.js";
import type { QaTurn } from "../types.js";

export interface QaTabProps {
  qa: QaTurn[];
  /** The task's faction coat/emblem — the question bubble's avatar. */
  coat: string;
  emblem: EmblemMark;
  /** Faction/vendor display name for the emblem's accessible label + tooltip. */
  faction?: string;
}

/** Two-digit zero pad — mirrors hooks `formatClock` (hud stays free of app imports). */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Wall-clock `HH:MM` in local time — same absolute form as the day-chip clock.
 * Full ISO rides on `<time dateTime>` + `title` for accessibility.
 */
function formatQaClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Human-readable full datetime for `title` (operators diagnosing a stall). */
function formatQaTitle(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function QaTime({ iso, label }: { iso: string; label: string }) {
  return (
    <time
      className="pc-qa__time"
      dateTime={iso}
      title={formatQaTitle(iso)}
      aria-label={`${label} ${formatQaTitle(iso)}`}
    >
      {formatQaClock(iso)}
    </time>
  );
}

/**
 * Layer 2 — the Q&A tab: a chat transcript (design-manifest §4.17 "Q&A"),
 * the agent's question bubble left, the operator's answer right-aligned.
 * History is rehydrated from `GET /tasks/:ref`'s durable `qa` field (#79);
 * a turn's `answer` is `null` while still outstanding. Quiet absolute
 * timestamps (HH:MM, matching the day-chip clock) sit on each bubble so an
 * operator diagnosing a stall can see when the exchange happened.
 */
export function QaTab({ qa, coat, emblem, faction }: QaTabProps) {
  if (qa.length === 0) {
    return <p className="pc-qa__empty">No parley yet — this soul hasn't raised a flag.</p>;
  }
  return (
    <div className="pc-qa">
      {qa.map((turn) => (
        // id is wire question_id — stable across rehydrate; never key on question text (duplicates collide).
        <div className="pc-qa__turn" key={turn.id}>
          <div className="pc-qa__bubble pc-qa__bubble--question">
            <Emblem coat={coat} mark={emblem} size={20} label={faction} />
            <div className="pc-qa__body">
              <p>{turn.question}</p>
              <QaTime iso={turn.askedAt} label="Asked" />
            </div>
          </div>
          {turn.answer !== null && (
            <div className="pc-qa__bubble pc-qa__bubble--answer">
              <span className="pc-qa__avatar" aria-hidden="true">
                <Mark mark={MARK_ANCHOR} size={11} />
              </span>
              <div className="pc-qa__body">
                <p>{turn.answer}</p>
                {turn.answeredAt !== null && (
                  <QaTime iso={turn.answeredAt} label="Answered" />
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
