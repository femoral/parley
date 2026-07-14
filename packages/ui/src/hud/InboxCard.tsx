import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Badge, Button, Emblem } from "../primitives/index.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import type { InboxTask } from "./types.js";

export interface InboxCardProps {
  task: InboxTask;
  /**
   * Deliver the answer (#67's one write) — plain callback, per contract 2: this
   * component never imports the core SDK, it just awaits whatever the hooks
   * layer wired up. Rejects with an actionable message on failure; the card
   * catches it, shows it, and stays (the task is still `awaiting_answer`).
   */
  onAnswer: (id: string, text: string) => Promise<void>;
}

const FALLBACK_ERROR = "The message didn't reach the ship — try again.";

/**
 * Layer 2 — one ember inbox card (design-manifest §4.15, awaiting variant).
 * Owns only ephemeral form state (draft text, in-flight, last error) — the
 * same kind of local state a controlled `<input>` always owns; the actual
 * write goes out through `onAnswer`, and the card's own removal from the
 * inbox is driven live by the hooks layer re-projecting after the SSE
 * transition, not by anything this component decides.
 */
export function InboxCard({ task, onAnswer }: InboxCardProps) {
  // The badge reads the same layer-0 state language `RosterPanel` does
  // (contract 6) rather than a hardcoded "AWAITING" literal, so it can't
  // silently drift if the inbox ever admits a second attention state.
  const meta = stateMetaFor(task.state);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const canSend = trimmed.length > 0 && !submitting;

  const send = (): void => {
    if (!canSend) return;
    setSubmitting(true);
    setError(null);
    onAnswer(task.id, trimmed).then(
      () => {
        setSubmitting(false);
        setValue("");
      },
      (err: unknown) => {
        setSubmitting(false);
        setError(err instanceof Error && err.message ? err.message : FALLBACK_ERROR);
      },
    );
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    send();
  };

  // Enter inserts a newline (the manifest's "Markdown supported" hint implies
  // multi-line answers); ⌘/Ctrl+Enter sends, matching common chat conventions.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      send();
    }
  };

  return (
    <form className="pc-inbox-card" onSubmit={onSubmit} aria-label={`Answer ${task.name}`}>
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
      <textarea
        className="pc-inbox-card__input"
        placeholder="Your answer…"
        value={value}
        disabled={submitting}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        aria-label={`Your answer for ${task.name}`}
      />
      {error && (
        <p className="pc-inbox-card__error" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}
      <div className="pc-inbox-card__footer">
        <span className="pc-inbox-card__hint">Markdown supported</span>
        <Button type="submit" className="pc-inbox-card__send" disabled={!canSend}>
          {submitting ? "Sending…" : "➤ Send"}
        </Button>
      </div>
    </form>
  );
}
