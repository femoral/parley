/**
 * Chart ink mapping — parchment state ramp + glyphs (#253 / DESIGN.md).
 *
 * State lives only on marks, seals and tally chips (glyph + ink). Route
 * strokes never encode state (Stroke-State Rule / #259).
 */

import type { InspectorRunNode } from "../hud/types.js";

/** Chart ink classes — map 1:1 onto `--ink-*` tokens. */
export type ChartInk = "done" | "live" | "fail" | "ghost" | "pen";

/** Second-cue glyph for each chart meaning (always paired with ink). */
export type ChartGlyph = "✓" | "✦" | "?" | "✕";

export interface ChartInkStyle {
  ink: ChartInk;
  glyph: ChartGlyph;
  /** CSS class fragment: `pc-chart-mark--done` etc. */
  className: string;
}

/**
 * Map an inspector node onto parchment ink + glyph.
 *
 * Gate `waiting` is handled as a seal (not a ring mark) by the projector;
 * this still returns live-ish ink for any non-gate consumer of the same
 * vocabulary.
 *
 * `pending` and `queued` are **not yet sailed** → ghost + `?` (DESIGN.md
 * chart-ghost meaning). Only states that are actively under way use live + ✦.
 */
export function inkForNode(node: InspectorRunNode): ChartInkStyle {
  if (node.kind === "gate") {
    if (node.state === "waiting") {
      // Held gate: seal carries the held cue; ink reserved for labels.
      return { ink: "live", glyph: "✦", className: "pc-chart-mark--live" };
    }
    if (node.state === "skipped") {
      return { ink: "ghost", glyph: "?", className: "pc-chart-mark--ghost" };
    }
    // Actioned gate (approved / rejected / redirected / finished).
    return { ink: "done", glyph: "✓", className: "pc-chart-mark--done" };
  }

  switch (node.state) {
    case "completed":
    case "inherited":
      return { ink: "done", glyph: "✓", className: "pc-chart-mark--done" };
    case "failed":
    case "cancelled":
    case "purged":
      return { ink: "fail", glyph: "✕", className: "pc-chart-mark--fail" };
    case "running":
    case "awaiting_answer":
    case "stalled":
      // Actively under way (or stalled mid-route) — live vermilion + ✦.
      return { ink: "live", glyph: "✦", className: "pc-chart-mark--live" };
    case "queued":
    case "pending":
      // Not yet sailed — ghost mark, ? glyph in pen weight (AA).
      return { ink: "ghost", glyph: "?", className: "pc-chart-mark--ghost" };
    default:
      return { ink: "ghost", glyph: "?", className: "pc-chart-mark--ghost" };
  }
}

/** CSS custom property for a state ink (never used on route strokes). */
export function inkCssVar(ink: ChartInk): string {
  switch (ink) {
    case "done":
      return "var(--ink-done)";
    case "live":
      return "var(--ink-live)";
    case "fail":
      return "var(--ink-fail)";
    case "ghost":
      return "var(--ink-chart-ghost)";
    case "pen":
      return "var(--ink-chart)";
  }
}
