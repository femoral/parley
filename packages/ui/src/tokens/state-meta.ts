/*
 * Layer 0 — the canonical state visual language (design-manifest §2.6 / §5).
 * Glyph, label and hint per task state, plus the CSS custom property carrying
 * that state's colour. Attention *ordering* is not re-derived here — it lives in
 * `@useparley/core` (`ATTENTION_ORDER`) and reaches components through the hooks
 * layer, per component-system spec contract 6.
 *
 * Keys mirror `@useparley/core`'s `TaskState` strings but are declared locally so
 * the tokens layer stays free of the core import (contract 4).
 *
 * `glyph` is the accessible/text emoji string (stable for labels/tests);
 * `mark` is the authored SVG silhouette rendered in operational chrome.
 */
import { MARK_UNKNOWN, STATE_GLYPH_MARKS, type StateGlyphMark } from "./state-glyphs.js";

export type StateKey =
  | "pending"
  | "queued"
  | "running"
  | "awaiting_answer"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled";

export interface StateMeta {
  /** Short caps label, e.g. "AWAITING". */
  label: string;
  /**
   * Single-glyph state marker (emoji/unicode). Kept for accessible text and
   * any string-based consumers — the *rendered* chrome uses {@link mark}.
   */
  glyph: string;
  /** Authored micro-SVG mark for operational chrome (currentColor fill). */
  mark: StateGlyphMark;
  /** Decorative flavour hint (kit legend), e.g. "needs your input". */
  hint: string;
  /** The `var(--state-*)` custom property holding this state's colour. */
  colorVar: string;
  /** Whether the state carries the beacon flag treatment (manifest §5 —
   * "loudest thing on screen"; the roster row's pulsing beacon). */
  beacon?: boolean;
  /**
   * Quiet-history treatment (manifest §5 — terminals recede so history never
   * competes with live work). Applied as a roster CSS class that switches text
   * to quieter AA ink tokens — NOT whole-row opacity. Opacity composites every
   * child against plate wood and drops body contrast below WCAG AA 4.5:1
   * (prior `dim: 0.62` took --ink-faint ≈2.7:1 and coral failed ≈3.5:1;
   * `dim: 0.9` took --ink-faint ≈4.2:1). Absent beacon + lower list rank still
   * carry "archive recedes".
   *
   * Token steps on plate wood (#1d140c), all ≥4.5:1 AA:
   * - soft (completed): name → --ink-soft #d8c39a ≈10.5:1; meta stays
   *   --ink-faint #9c8154 ≈4.9:1
   * - archive (failed/cancelled): name → --ink-muted #c9b184 ≈8.7:1; meta →
   *   --ink-label #967c54 ≈4.6:1 (quietest functional tier)
   */
  quiet?: "soft" | "archive";
}

export const STATE_META: Record<StateKey, StateMeta> = {
  pending: {
    label: "PENDING",
    glyph: "⏳",
    mark: STATE_GLYPH_MARKS.pending,
    hint: "not yet started",
    colorVar: "var(--state-pending)",
  },
  queued: {
    label: "QUEUED",
    glyph: "☰",
    mark: STATE_GLYPH_MARKS.queued,
    hint: "waiting for a slot",
    colorVar: "var(--state-queued)",
  },
  running: {
    label: "RUNNING",
    glyph: "⛵",
    mark: STATE_GLYPH_MARKS.running,
    hint: "hard at work",
    colorVar: "var(--state-running)",
  },
  awaiting_answer: {
    label: "AWAITING",
    glyph: "🚩",
    mark: STATE_GLYPH_MARKS.awaiting_answer,
    hint: "needs your input",
    colorVar: "var(--state-awaiting_answer)",
    beacon: true,
  },
  stalled: {
    label: "STALLED",
    glyph: "🧭",
    mark: STATE_GLYPH_MARKS.stalled,
    hint: "blocked / waiting",
    colorVar: "var(--state-stalled)",
  },
  completed: {
    label: "COMPLETED",
    glyph: "🏁",
    mark: STATE_GLYPH_MARKS.completed,
    hint: "report ready",
    colorVar: "var(--state-completed)",
    quiet: "soft",
  },
  failed: {
    label: "FAILED",
    glyph: "✖",
    mark: STATE_GLYPH_MARKS.failed,
    hint: "terminal state",
    colorVar: "var(--state-failed)",
    quiet: "archive",
  },
  cancelled: {
    label: "CANCELLED",
    glyph: "⊘",
    mark: STATE_GLYPH_MARKS.cancelled,
    hint: "called back",
    colorVar: "var(--state-cancelled)",
    quiet: "archive",
  },
};

/** State colour lookup, falling back to a muted tan for unknown states. */
export function stateMetaFor(state: string): StateMeta {
  if (Object.prototype.hasOwnProperty.call(STATE_META, state)) {
    return STATE_META[state as StateKey];
  }
  return {
    label: state.toUpperCase(),
    glyph: "•",
    mark: MARK_UNKNOWN,
    hint: "",
    colorVar: "var(--ink-tan)",
  };
}

/**
 * The attention hierarchy's display order, mirroring `@useparley/core`'s
 * `ATTENTION_ORDER` (design-manifest §5). A literal, not an import: this
 * tokens-layer file must stay free of the core dependency (component-system
 * spec contract 4 — only the hooks layer imports `@useparley/core`), and the
 * roster/inbox/scene already get their *functional* grouping order from core
 * via the hooks layer (contract 6) — this constant only feeds the kit band's
 * static legend (#70), which lists every state, always, and has nothing to
 * fetch. `tests/reduced-motion.test.ts`'s sibling,
 * `tests/state-legend-order.test.ts`, asserts this literal stays equal to
 * core's real `ATTENTION_ORDER` — a test may import core freely, so drift
 * (a reordered/renamed/added state) fails loudly there instead of silently
 * stale-ing this legend.
 */
export const ATTENTION_DISPLAY_ORDER: readonly StateKey[] = [
  "awaiting_answer",
  "stalled",
  "running",
  "queued",
  "pending",
  "completed",
  "failed",
  "cancelled",
];
