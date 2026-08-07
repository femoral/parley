/**
 * Attention card — DESIGN.md shape:
 * 2px state-color left rule, badge + age, title, reason, meta.
 * Rows variant is a single line. Shared layer (#363).
 */
import type { KeyboardEvent, ReactNode } from "react";
import { StateChip, chipStateKey } from "./StateChip.js";

export type AttentionCardVariant = "card" | "rows";

export interface AttentionCardProps {
  /** Wire state (awaiting_answer, stalled, failed, …) or gate alias. */
  state: string;
  /** Relative age label (e.g. "12m"). */
  age: string;
  title: string;
  reason?: string;
  meta?: string;
  /** card = multi-line stack; rows = single dense line. */
  variant?: AttentionCardVariant;
  selected?: boolean;
  onSelect?: () => void;
  /** Optional badge label override (e.g. GATE HELD). */
  badgeLabel?: string;
  className?: string;
  testId?: string;
  children?: ReactNode;
}

export function AttentionCard({
  state,
  age,
  title,
  reason,
  meta,
  variant = "card",
  selected = false,
  onSelect,
  badgeLabel,
  className = "",
  testId,
  children,
}: AttentionCardProps) {
  const key = chipStateKey(state);
  const interactive = onSelect != null;
  const classes = [
    "pc-attn",
    `pc-attn--${variant}`,
    `pc-attn--${key}`,
    selected ? "pc-attn--selected" : "",
    interactive ? "pc-attn--interactive" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (!onSelect) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <article
      className={classes}
      data-testid={testId}
      data-state={key}
      data-variant={variant}
      data-selected={selected ? "true" : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={interactive ? onKeyDown : undefined}
      aria-pressed={interactive ? selected : undefined}
    >
      <div className="pc-attn__head">
        <StateChip state={state} label={badgeLabel} className="pc-attn__badge" />
        <span className="pc-attn__age" title={age}>
          {age}
        </span>
      </div>
      <div className="pc-attn__title" title={title}>
        {title}
      </div>
      {reason ? (
        <div className="pc-attn__reason" title={reason}>
          {reason}
        </div>
      ) : null}
      {meta ? (
        <div className="pc-attn__meta" title={meta}>
          {meta}
        </div>
      ) : null}
      {children}
    </article>
  );
}
