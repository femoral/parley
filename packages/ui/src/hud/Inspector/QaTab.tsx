import { Emblem, Mark } from "../../primitives/index.js";
import { MARK_ANCHOR } from "../../tokens/chrome-glyphs.js";
import type { EmblemMark } from "../../tokens/factions.js";
import type { QaTurn } from "../types.js";
import { useCopyScaffold } from "../useCopyScaffold.js";

export interface QaTabProps {
  taskId: string;
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

function AnswerScaffold({ taskId }: { taskId: string }) {
  const scaffoldText = `parley answer ${taskId} "..."`;
  const { copied, canCopy, scaffoldRef, copy } = useCopyScaffold(scaffoldText);

  return (
    <div className="pc-qa__answer-scaffold">
      <span ref={scaffoldRef} className="pc-qa__scaffold">
        {scaffoldText}
      </span>
      {canCopy && (
        <button
          type="button"
          className="pc-qa__copy"
          onClick={() => void copy()}
          aria-label={copied ? "Copied answer command" : "Copy answer command"}
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      )}
    </div>
  );
}

/**
 * Layer 2 — the Q&A tab: a chat transcript (design-manifest §4.17 "Q&A"),
 * the agent's question bubble left, the operator's answer right-aligned.
 * History is rehydrated from `GET /tasks/:ref`'s durable `qa` field (#79);
 * a turn's `answer` is `null` while still outstanding. Quiet absolute
 * timestamps (HH:MM, matching the day-chip clock) sit on each bubble so an
 * operator diagnosing a stall can see when the exchange happened.
 *
 * The transcript is a semantic list so screen-reader users can skim entries;
 * each bubble carries an accessible name of speaker + wall-clock time.
 */
export function QaTab({ taskId, qa, coat, emblem, faction }: QaTabProps) {
  if (qa.length === 0) {
    return <p className="pc-qa__empty">No parley yet — this soul hasn't raised a flag.</p>;
  }
  return (
    <div className="pc-qa" role="list" aria-label="Q&A transcript">
      {qa.map((turn) => (
        // id is wire question_id — stable across rehydrate; never key on question text (duplicates collide).
        // Turn is a layout group only; each bubble is a listitem so SRs can skim speaker+time.
        <div className="pc-qa__turn" role="presentation" key={turn.id}>
          <div
            className="pc-qa__bubble pc-qa__bubble--question"
            role="listitem"
            aria-label={`Agent, ${formatQaTitle(turn.askedAt)}`}
          >
            <Emblem coat={coat} mark={emblem} size={20} label={faction} />
            <div className="pc-qa__body">
              <p>{turn.question}</p>
              <QaTime iso={turn.askedAt} label="Asked" />
            </div>
          </div>
          {turn.answer === null && <AnswerScaffold taskId={taskId} />}
          {turn.answer !== null && (
            <div
              className="pc-qa__bubble pc-qa__bubble--answer"
              role="listitem"
              aria-label={
                turn.answeredAt !== null
                  ? `You, ${formatQaTitle(turn.answeredAt)}`
                  : "You"
              }
            >
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
