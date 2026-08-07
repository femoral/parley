/**
 * Single state label table for chips + footer legend (#366).
 * Vocabulary must match exactly in both surfaces.
 */

export interface StateLabelEntry {
  /** Wire / CSS modifier key (awaiting_answer, not awaiting). */
  state: string;
  /** Display label — uppercase mono; identical on chip and legend. */
  label: string;
  /** Status ink custom property. */
  cssVar: string;
}

/** Canonical map: wire state → label + ink. */
export const STATE_LABELS: Readonly<Record<string, StateLabelEntry>> = {
  pending: {
    state: "pending",
    label: "PENDING",
    cssVar: "var(--state-pending)",
  },
  queued: {
    state: "queued",
    label: "QUEUED",
    cssVar: "var(--state-queued)",
  },
  running: {
    state: "running",
    label: "RUNNING",
    cssVar: "var(--state-running)",
  },
  awaiting_answer: {
    state: "awaiting_answer",
    label: "AWAITING",
    cssVar: "var(--state-awaiting)",
  },
  awaiting: {
    state: "awaiting_answer",
    label: "AWAITING",
    cssVar: "var(--state-awaiting)",
  },
  stalled: {
    state: "stalled",
    label: "STALLED",
    cssVar: "var(--state-stalled)",
  },
  completed: {
    state: "completed",
    label: "DONE",
    cssVar: "var(--state-completed)",
  },
  failed: {
    state: "failed",
    label: "FAILED",
    cssVar: "var(--state-failed)",
  },
  cancelled: {
    state: "cancelled",
    label: "CANCEL",
    cssVar: "var(--state-cancelled)",
  },
  purged: {
    state: "purged",
    label: "PURGED",
    cssVar: "var(--state-cancelled)",
  },
};

/**
 * Footer legend order (DESIGN.md attention order).
 * One entry per distinct status — aliases (awaiting) are not duplicated.
 */
export const LEGEND_ORDER: readonly string[] = [
  "awaiting_answer",
  "stalled",
  "failed",
  "running",
  "queued",
  "pending",
  "completed",
  "cancelled",
] as const;

/** Normalize wire/token aliases onto the CSS modifier set. */
export function chipStateKey(state: string): string {
  if (state === "awaiting") return "awaiting_answer";
  return state;
}

export function stateLabel(state: string): string {
  const entry = STATE_LABELS[state] ?? STATE_LABELS[chipStateKey(state)];
  if (entry) return entry.label;
  return state.replace(/_/g, " ").toUpperCase();
}

export function stateCssVar(state: string): string {
  const entry = STATE_LABELS[state] ?? STATE_LABELS[chipStateKey(state)];
  return entry?.cssVar ?? "var(--text-3)";
}

/** Legend rows from the single table (same labels chips use). */
export function legendEntries(): readonly StateLabelEntry[] {
  return LEGEND_ORDER.map((key) => {
    const entry = STATE_LABELS[key];
    if (!entry) {
      throw new Error(`LEGEND_ORDER references missing STATE_LABELS key: ${key}`);
    }
    return entry;
  });
}
