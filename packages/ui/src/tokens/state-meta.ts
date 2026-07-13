/*
 * Layer 0 — the canonical state visual language (design-manifest §2.6 / §5).
 * Glyph, label and hint per task state, plus the CSS custom property carrying
 * that state's colour. Attention *ordering* is not re-derived here — it lives in
 * `@useparley/core` (`ATTENTION_ORDER`) and reaches components through the hooks
 * layer, per component-system spec contract 6.
 *
 * Keys mirror `@useparley/core`'s `TaskState` strings but are declared locally so
 * the tokens layer stays free of the core import (contract 4).
 */
export type StateKey =
  | "pending"
  | "running"
  | "awaiting_answer"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled";

export interface StateMeta {
  /** Short caps label, e.g. "AWAITING". */
  label: string;
  /** Single-glyph state marker. */
  glyph: string;
  /** IM Fell flavour hint, e.g. "needs your input". */
  hint: string;
  /** The `var(--state-*)` custom property holding this state's colour. */
  colorVar: string;
}

export const STATE_META: Record<StateKey, StateMeta> = {
  pending: { label: "PENDING", glyph: "⏳", hint: "queued & calm", colorVar: "var(--state-pending)" },
  running: { label: "RUNNING", glyph: "⛵", hint: "hard at work", colorVar: "var(--state-running)" },
  awaiting_answer: {
    label: "AWAITING",
    glyph: "🚩",
    hint: "needs your input",
    colorVar: "var(--state-awaiting_answer)",
  },
  stalled: { label: "STALLED", glyph: "🧭", hint: "blocked / waiting", colorVar: "var(--state-stalled)" },
  completed: { label: "COMPLETED", glyph: "🏁", hint: "report ready", colorVar: "var(--state-completed)" },
  failed: { label: "FAILED", glyph: "✖", hint: "terminal state", colorVar: "var(--state-failed)" },
  cancelled: { label: "CANCELLED", glyph: "⊘", hint: "called back", colorVar: "var(--state-cancelled)" },
};

/** State colour lookup, falling back to a muted tan for unknown states. */
export function stateMetaFor(state: string): StateMeta {
  if (Object.prototype.hasOwnProperty.call(STATE_META, state)) {
    return STATE_META[state as StateKey];
  }
  return { label: state.toUpperCase(), glyph: "•", hint: "", colorVar: "var(--ink-tan)" };
}
