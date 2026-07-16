/*
 * Layer 0 — authored micro-SVG marks for each task state (operational chrome).
 * Bold silhouettes in a 24×24 viewBox, filled with currentColor so the state's
 * colour token tints them. Sized for 10–13px render — no fine detail.
 *
 * Companion to `STATE_META.glyph` (the accessible/text emoji string, which is
 * kept for labels and must not change). Pure path data; the primitives layer
 * renders these via {@link Mark}.
 */
import type { EmblemMark } from "./factions.js";

/** Authored SVG (or fallback glyph) mark for a task state. */
export type StateGlyphMark = EmblemMark;

const VIEW = "0 0 24 24";

/** Pending — hourglass (queued & calm). */
const MARK_PENDING: StateGlyphMark = {
  kind: "svg",
  viewBox: VIEW,
  // Filled hourglass: wide top/bottom chambers meeting at a waist.
  path: "M5 2.5h14v2.2L13.2 12 19 19.3V21.5H5v-2.2L10.8 12 5 4.7V2.5z",
};

/** Running — full sail (hard at work). */
const MARK_RUNNING: StateGlyphMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    // Mainsail triangle on a mast.
    "M10.5 3.5h2.2v12.2h-2.2z M12.7 5.2 L20.5 13.5 L12.7 15.2 Z",
    // Hull waterline.
    "M3.5 17.2 Q12 21.2 20.5 17.2 L19 19.8 H5 Z",
  ],
};

/** Awaiting answer — raised flag (needs your input). */
const MARK_AWAITING: StateGlyphMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    // Flagstaff.
    "M5.5 2.5h2.4v19H5.5z",
    // Pennant flying right.
    "M7.9 3.2 L20.5 8.2 L7.9 13.2 Z",
  ],
};

/** Stalled — compass rose (blocked / waiting). */
const MARK_STALLED: StateGlyphMark = {
  kind: "svg",
  viewBox: VIEW,
  // Ring + four-point compass diamond; evenodd keeps the centre open enough
  // to read at small size while staying a single silhouette family.
  path: [
    "M12 2.2 L14.2 9.8 L21.8 12 L14.2 14.2 L12 21.8 L9.8 14.2 L2.2 12 L9.8 9.8 Z",
  ],
};

/** Completed — planted pennant (report ready). */
const MARK_COMPLETED: StateGlyphMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    // Staff planted in a small mound.
    "M10.8 4h2.4v14.5h-2.4z",
    "M7 19.5 Q12 22.2 17 19.5 L16 21.5 H8 Z",
    // Checkered-ish pennant simplified to a solid flag.
    "M13.2 4.2 L21.2 7.5 L13.2 10.8 Z",
  ],
};

/** Failed — cross / splinter (terminal). */
const MARK_FAILED: StateGlyphMark = {
  kind: "svg",
  viewBox: VIEW,
  // Thick X — two bars as a single silhouette (matches Grok-style letterform).
  path: "M4.2 3.5h4.2L12 9.2l3.6-5.7h4.2L14.4 12l5.6 8.5h-4.2L12 14.8l-3.6 5.7H4.2L9.6 12 4.2 3.5z",
};

/** Cancelled — slashed circle (called back). */
const MARK_CANCELLED: StateGlyphMark = {
  kind: "svg",
  viewBox: VIEW,
  fillRule: "evenodd",
  // Outer disc with inner hole (ring) plus a diagonal bar through the centre.
  path: [
    "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3.2a6.8 6.8 0 1 1 0 13.6 6.8 6.8 0 0 1 0-13.6z",
    "M6.2 5.4 L18.6 17.8 16.8 19.6 4.4 7.2 Z",
  ],
};

/** Fallback mark for unknown states (small filled disc). */
export const MARK_UNKNOWN: StateGlyphMark = {
  kind: "svg",
  viewBox: VIEW,
  path: "M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z",
};

/**
 * Authored mark per known task state. Keys mirror {@link StateKey} / core
 * `TaskState` strings; declared as a const map so this file stays free of a
 * circular import with `state-meta.ts`.
 */
export const STATE_GLYPH_MARKS = {
  pending: MARK_PENDING,
  running: MARK_RUNNING,
  awaiting_answer: MARK_AWAITING,
  stalled: MARK_STALLED,
  completed: MARK_COMPLETED,
  failed: MARK_FAILED,
  cancelled: MARK_CANCELLED,
} as const satisfies Record<string, StateGlyphMark>;
