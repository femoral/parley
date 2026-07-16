import { Emblem } from "../../primitives/index.js";
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

/**
 * Layer 2 — the Q&A tab: a chat transcript (design-manifest §4.17 "Q&A"),
 * the agent's question bubble left, the operator's answer right-aligned.
 * History is rehydrated from `GET /tasks/:ref`'s durable `qa` field (#79);
 * a turn's `answer` is `null` while still outstanding. Timestamps ride the
 * wire but aren't rendered here (manifest layout is question/answer only).
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
            <p>{turn.question}</p>
          </div>
          {turn.answer !== null && (
            <div className="pc-qa__bubble pc-qa__bubble--answer">
              <span className="pc-qa__avatar" aria-hidden="true">
                ⚓
              </span>
              <p>{turn.answer}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
