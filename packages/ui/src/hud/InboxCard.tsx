import { useEffect, useState } from "react";
import { Emblem } from "../primitives/index.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import { formatRelativeAge } from "./formatRelativeAge.js";
import type { InboxTask } from "./types.js";
import { useCopyScaffold } from "./useCopyScaffold.js";

export interface InboxCardProps {
  task: InboxTask;
  onSelectTask: (id: string) => void;
}

/** Scaffold the orchestrator pastes into their session to answer this task. */
export function answerScaffold(taskId: string): string {
  return `parley answer ${taskId} "..."`;
}

function shortRef(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Layer 2 — one ember inbox card (design-manifest §4.15, awaiting variant).
 * Display-only answers: selecting opens the inspector; the copy affordance hands
 * the user a `parley answer` scaffold for their orchestrator session. Head/body
 * is a native button so selection is honest; the footer copy control sits outside
 * it so interactive elements never nest.
 *
 * No per-card state badge — the plate header already announces NEEDS YOU · N.
 * State still rides in the select control's accessible name via a visually-
 * hidden label from the shared state-meta lookup (contract 6).
 */
export function InboxCard({ task, onSelectTask }: InboxCardProps) {
  const meta = stateMetaFor(task.state);
  const [now, setNow] = useState(() => Date.now());
  const scaffoldText = answerScaffold(task.id);
  const { copied, canCopy, scaffoldRef, copy } = useCopyScaffold(scaffoldText);

  useEffect(() => {
    const ageTimer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(ageTimer);
  }, []);

  const taskRef = shortRef(task.id);
  const sessionRef = task.sessionId ? shortRef(task.sessionId) : null;
  const relativeAge = formatRelativeAge(task.updatedAt, now) ?? "—";

  return (
    <article className="pc-inbox-card">
      <button
        type="button"
        className="pc-inbox-card__select"
        onClick={() => onSelectTask(task.id)}
      >
        <span className="pc-inbox-card__head">
          <Emblem coat={task.coat} mark={task.emblem} size={23} label={task.faction} />
          <span className="pc-inbox-card__body">
            <span className="pc-inbox-card__name">{task.name}</span>
            <span className="pc-inbox-card__meta">{task.meta}</span>
          </span>
          <time
            className="pc-inbox-card__age"
            dateTime={task.updatedAt ?? undefined}
            title={task.updatedAt ?? "Update time unavailable"}
            aria-label={
              task.updatedAt === null
                ? "Update time unavailable"
                : relativeAge === "<1m"
                  ? "Updated less than a minute ago"
                  : `Updated ${relativeAge} ago`
            }
          >
            {relativeAge}
          </time>
          {/* State is redundant with the plate NEEDS YOU header visually;
              keep it in the accessible name so AT still hears attention rank. */}
          <span className="pc-visually-hidden">{meta.label}</span>
        </span>
        <span className="pc-inbox-card__question">
          <span className="pc-inbox-card__marker" aria-hidden="true">
            ⌐
          </span>
          {task.question}
        </span>
      </button>

      <div className="pc-inbox-card__footer">
        <span className="pc-inbox-card__refs">
          {/* title is mouse-only — the visually-hidden spans expose the full
              ids to keyboard/AT users too. */}
          <span className="pc-inbox-card__ref" title={task.id}>
            <span aria-hidden="true">{taskRef}</span>
            <span className="pc-visually-hidden">task id {task.id}</span>
          </span>
          <span className="pc-inbox-card__ref-sep" aria-hidden="true">
            ·
          </span>
          <span
            className="pc-inbox-card__ref"
            title={task.sessionId ?? undefined}
          >
            <span aria-hidden="true">{sessionRef ?? "no session"}</span>
            <span className="pc-visually-hidden">
              {task.sessionId ? `session id ${task.sessionId}` : "no session"}
            </span>
          </span>
          {/* Hidden scaffold text for select-on-click fallback when clipboard fails. */}
          <span ref={scaffoldRef} className="pc-inbox-card__scaffold" aria-hidden="true">
            {scaffoldText}
          </span>
        </span>
        {canCopy && (
          <button
            type="button"
            className="pc-inbox-card__copy"
            onClick={() => void copy()}
            aria-label={copied ? "Copied answer command" : "Copy answer command"}
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        )}
      </div>
    </article>
  );
}
