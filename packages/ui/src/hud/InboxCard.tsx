import { Badge, Emblem } from "../primitives/index.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import type { InboxTask } from "./types.js";

export interface InboxCardProps {
  task: InboxTask;
}

/**
 * Layer 2 — one ember inbox card (design-manifest §4.15, awaiting variant).
 * Display-only: the orchestrator that delegated the task answers its question,
 * while the cockpit keeps the outstanding question visible to the human.
 */
export function InboxCard({ task }: InboxCardProps) {
  // The badge reads the same layer-0 state language `RosterPanel` does
  // (contract 6) rather than a hardcoded "AWAITING" literal, so it can't
  // silently drift if the inbox ever admits a second attention state.
  const meta = stateMetaFor(task.state);

  return (
    <article className="pc-inbox-card">
      <div className="pc-inbox-card__head">
        <Emblem coat={task.coat} mark={task.emblem} size={23} />
        <span className="pc-inbox-card__body">
          <span className="pc-inbox-card__name">{task.name}</span>
          <span className="pc-inbox-card__meta">{task.meta}</span>
        </span>
        <Badge label={meta.label} glyph={meta.glyph} color={meta.colorVar} />
      </div>
      <p className="pc-inbox-card__question">
        <span className="pc-inbox-card__marker" aria-hidden="true">
          ⌐
        </span>
        {task.question}
      </p>
    </article>
  );
}
