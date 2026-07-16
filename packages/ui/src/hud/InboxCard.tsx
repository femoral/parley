import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Emblem } from "../primitives/index.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import type { InboxTask } from "./types.js";

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

function clipboardAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
}

/**
 * Layer 2 — one ember inbox card (design-manifest §4.15, awaiting variant).
 * Display-only answers: selecting opens the inspector; the copy affordance hands
 * the user a `parley answer` scaffold for their orchestrator session. Head/body
 * is a native button so selection is honest; the footer copy control sits outside
 * it so interactive elements never nest.
 */
export function InboxCard({ task, onSelectTask }: InboxCardProps) {
  // The badge reads the same layer-0 state language `RosterPanel` does
  // (contract 6) rather than a hardcoded "AWAITING" literal, so it can't
  // silently drift if the inbox ever admits a second attention state.
  const meta = stateMetaFor(task.state);
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

  const handleCopy = useCallback(async () => {
    const text = answerScaffold(task.id);
    if (clipboardAvailable()) {
      try {
        await navigator.clipboard.writeText(text);
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
  }, [task.id, markCopied]);

  const taskRef = shortRef(task.id);
  const sessionRef = task.sessionId ? shortRef(task.sessionId) : null;

  return (
    <article className="pc-inbox-card">
      <button
        type="button"
        className="pc-inbox-card__select"
        onClick={() => onSelectTask(task.id)}
      >
        <div className="pc-inbox-card__head">
          <Emblem coat={task.coat} mark={task.emblem} size={23} label={task.faction} />
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
      </button>

      <div className="pc-inbox-card__footer">
        <span className="pc-inbox-card__refs">
          <span className="pc-inbox-card__ref" title={task.id}>
            {taskRef}
          </span>
          <span className="pc-inbox-card__ref-sep" aria-hidden="true">
            ·
          </span>
          <span
            className="pc-inbox-card__ref"
            title={task.sessionId ?? undefined}
          >
            {sessionRef ?? "no session"}
          </span>
          {/* Hidden scaffold text for select-on-click fallback when clipboard fails. */}
          <span ref={scaffoldRef} className="pc-inbox-card__scaffold" aria-hidden="true">
            {answerScaffold(task.id)}
          </span>
        </span>
        {canCopy && (
          <button
            type="button"
            className="pc-inbox-card__copy"
            onClick={handleCopy}
            aria-label={copied ? "Copied answer command" : "Copy answer command"}
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        )}
      </div>
    </article>
  );
}
