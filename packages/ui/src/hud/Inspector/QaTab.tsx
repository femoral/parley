import { Emblem } from "../../primitives/index.js";
import type { QaTurn } from "../types.js";

export interface QaTabProps {
  qa: QaTurn[];
  /** The task's faction coat/emblem — the question bubble's avatar. */
  coat: string;
  emblem: string;
}

/**
 * Layer 2 — the Q&A tab: a chat transcript (design-manifest §4.17 "Q&A"),
 * the agent's question bubble left, the operator's answer right-aligned. The
 * daemon carries no persisted Q&A history (only the task's current
 * outstanding question) — `useCockpit`/`projectInspector` build this list
 * from what's actually known, so a turn's `answer` is `null` while still
 * outstanding. No timestamps are rendered: the manifest's per-turn
 * timestamp isn't data parley exposes (docs/spec/ui-v1-scope.md — "fills
 * panels only from data parley exposes today"), so one isn't fabricated.
 */
export function QaTab({ qa, coat, emblem }: QaTabProps) {
  if (qa.length === 0) {
    return <p className="pc-qa__empty">No parley yet — this soul hasn't raised a flag.</p>;
  }
  return (
    <div className="pc-qa">
      {qa.map((turn, i) => (
        <div className="pc-qa__turn" key={`${i}-${turn.question}`}>
          <div className="pc-qa__bubble pc-qa__bubble--question">
            <Emblem coat={coat} glyph={emblem} size={20} />
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
