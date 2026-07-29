/**
 * Chart-space projection from {@link InspectorRun} (#253 / ADR-0021).
 *
 * Derives marks, legs, loop-backs and seal state inside the chart package —
 * never widens the inspector projection. One mark per (node, iteration);
 * fan-out width is written in a tally chip, never drawn as n marks.
 *
 * Cartography (#253 QC): serpentine multi-row trail, alternating labels
 * above/below the route, label width sized from pitch — so at realistic
 * node counts the sheet still reads as a chart (air between marks, labels
 * clear of the trail ink).
 */

import type {
  InspectorRun,
  InspectorRunNode,
  InspectorRunReady,
} from "../hud/types.js";
import { inkForNode, type ChartGlyph, type ChartInk } from "./ink.js";

/** Normalized chart coordinate space width (SVG viewBox x). Height is dynamic. */
export const CHART_VB_W = 1000;

/** @deprecated Prefer CHART_VB_W + model.vbH — kept for call sites that only need width. */
export const CHART_VB = { w: CHART_VB_W, h: 560 } as const;

export type SealState = "held" | "broken";
/**
 * Label sits below the ring. Route legs terminate at the ring edge (not the
 * centre), so the stroke never enters the label box (B1).
 */
export type LabelSide = "below";

export interface ChartMark {
  key: string;
  node: string;
  kind: "step" | "gate";
  iteration: number;
  ink: ChartInk;
  glyph: ChartGlyph;
  className: string;
  /** Operational label under/over the mark (Outfit). */
  name: string;
  /** Quiet meta under the name (Outfit body — matches inspector run table). */
  meta: string;
  /** Fan-out width for tally chip; null when single-task / gate. */
  fanoutWidth: number | null;
  /** Gate seal treatment; null for steps. */
  seal: SealState | null;
  x: number;
  y: number;
  /** Label sits above or below the trail so it never lands on the route ink. */
  labelSide: LabelSide;
  /**
   * Max label box width in viewBox units, derived from pitch.
   * CSS maps this to a percentage of the sheet.
   */
  labelWidth: number;
  live: boolean;
  onReject: string | null;
}

export interface ChartLeg {
  /** SVG path `d` in chart viewBox units. */
  d: string;
  /**
   * Pen weight only (Stroke-State Rule): chart or soft, never a state ink.
   * Soft for not-yet-entered structure and loop-backs; strong for charted trail.
   */
  pen: "chart" | "soft";
}

export interface ChartLoopBack {
  d: string;
  fromKey: string;
  toKey: string;
  /** Path endpoint in viewBox units — clear of the target mark ring. */
  end: { x: number; y: number };
  /** Target mark centre — arrowhead must not equal this. */
  targetCentre: { x: number; y: number };
}

/**
 * Decorative flavor line placed by the projector in viewBox units (#268).
 * Centre-anchored (matches CSS `translate(-50%, -50%)`). Omitted entirely
 * when no free region large enough exists, or when decorations are sparse.
 */
export interface ChartMarginalia {
  key: string;
  /** Atmospheric copy — never operational. */
  text: string;
  /** Centre x in viewBox units. */
  x: number;
  /** Centre y in viewBox units. */
  y: number;
  /** Axis-aligned hit box width (viewBox) used for clearance. */
  w: number;
  /** Axis-aligned hit box height (viewBox) used for clearance. */
  h: number;
  /** Slight handwritten tilt (CSS class). */
  tilt: boolean;
}

export interface ChartReadyModel {
  status: "ready";
  id: string;
  workflow: string;
  shortId: string;
  stateLabel: string;
  heldGate: boolean;
  marks: ChartMark[];
  legs: ChartLeg[];
  loopBacks: ChartLoopBack[];
  destination: { x: number; y: number };
  /** Dynamic viewBox height (grows with serpentine rows). */
  vbH: number;
  /**
   * Sparse decoration when the route is tiny (single node / no gates) so
   * empty-quarter ornament does not sit on the trail.
   */
  decorations: "full" | "sparse";
  /**
   * Flavor marginalia anchors in the same viewBox space as marks.
   * Empty when decorations are sparse or no free region fits a line.
   */
  marginalia: ChartMarginalia[];
  /** Operational data — Outfit, never flavor serif (duration, pass). */
  metaLine: string | null;
  /** Atmospheric clause only — IM Fell. */
  flavor: string | null;
}

export interface ChartPendingModel {
  status: "pending";
  id: string;
  shortId: string;
}

export type ChartModel = ChartReadyModel | ChartPendingModel;

/** Axis-aligned rect in viewBox units (for layout invariant tests). */
export interface ChartTextRect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// --- Layout constants (viewBox units) ---------------------------------------

/** Horizontal inset so labels at the first/last mark stay on the sheet. */
const EDGE_X = 80;
/** Right reserve for the destination X. */
const DEST_RESERVE = 100;
/**
 * Top band: compass clearance and air above row 0.
 *
 * Was 100 when the run title was painted over this band; the title moved into
 * the sheet's title block (#267), so only the rose and the ring's own radius
 * are left to clear.
 *
 * The floor is set by the *painted* ring, not the structural one, and row 0's
 * centre rides up to 16 units above this band (`bow` 14 + `wander` 2):
 * (84 − 16) × the 0.385 scale floor = 26.2px against a measured 23px ring
 * half-height. The plot deliberately does not clip — a mark that overflowed
 * its paper must be visible as a defect, not silently cropped.
 */
const EDGE_TOP = 84;
/**
 * Bottom band: below-labels clearance.
 *
 * No longer holds the on-paper key (#267) — but do not shrink it on that
 * account. The binding constraint is the *painted* label stack, which at the
 * 0.385 scale floor reaches 271 viewBox units below the mark centre against
 * the 222 (EDGE_BOTTOM + LABEL_H) budgeted here. The held-gate helm is not in
 * this budget at all: it sits in flow below the plot (#267).
 */
const EDGE_BOTTOM = 170;
/** Minimum centre-to-centre pitch on a row (must hold label width + gap). */
const MIN_PITCH = 130;
/** Target pitch when the sheet has room (board-1 air). */
const TARGET_PITCH = 180;
/** Vertical distance between serpentine row baselines (clears label band). */
const ROW_PITCH = 170;
/** Ring + parchment halo radius — legs and arrowheads clear this. */
export const MARK_CLEAR_R = 28;
/** Estimated label block height (name + meta + optional tally). */
const LABEL_H = 52;
/** Gap between ring edge and label block. */
const LABEL_RING_GAP = 10;
/** Horizontal gap between adjacent label boxes. */
const LABEL_X_GAP = 10;
/** Minimum label box width. */
const LABEL_W_MIN = 64;
/** Maximum label box width. */
const LABEL_W_MAX = 140;

/*
 * There is deliberately no key zone here any more (#267).
 *
 * KEY_ZONE_W/H reserved 170×110 viewBox units at the sheet's bottom-left for
 * a key that paints at a fixed 134×87 CSS px. That reserve is only correct at
 * one sheet scale: measured across the acceptance matrix the scale spans
 * 0.385–1.224 px per unit, so at the narrow end the key needed 348×226 units
 * and buried marks (60,641 px² of ink over 22 of 160 cells), while at the wide
 * end the sheet outgrew its scrollport and the key fell below the fold. The
 * key now lives in the title block, outside the projected paper entirely, so
 * no reserve — and no assumed scale — is involved.
 */

function shortRef(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function sealForGate(node: InspectorRunNode): SealState {
  return node.state === "waiting" ? "held" : "broken";
}

/**
 * Chart per-mark captions stay calm lowercase. Inspector STATE cells uppercase
 * via CSS (`.pc-runview__st`); the chart deliberately does not
 * (`.pc-chart-mark__meta` has no transform — legend chrome owns the caps).
 * Lowercasing at this boundary so a shared label source cannot shout on the
 * sheet as a plumbing side-effect (#261 QC).
 */
function chartPresentLabel(label: string): string {
  return label.toLowerCase();
}

function markMeta(node: InspectorRunNode): string {
  if (node.kind === "gate") {
    if (node.state === "waiting") {
      return node.age ? `held ${node.age}` : "held";
    }
    return chartPresentLabel(node.stateLabel);
  }
  const parts: string[] = [];
  if (node.iteration > 1) parts.push(`pass ${node.iteration}`);
  parts.push(chartPresentLabel(node.stateLabel));
  if (node.age) parts.push(node.age);
  return parts.join(" · ");
}

/**
 * How many marks fit on one row at a comfortable pitch, given usable width.
 * Caps so a long run snakes rather than compresses.
 */
function marksPerRow(count: number, usableW: number): number {
  if (count <= 1) return 1;
  const atTarget = Math.max(2, Math.floor(usableW / TARGET_PITCH) + 1);
  const atMin = Math.max(2, Math.floor(usableW / MIN_PITCH) + 1);
  // Prefer target air; never exceed what min-pitch allows; never more than count.
  const cap = Math.min(atTarget, atMin, count);
  // Prefer evenly filled rows (e.g. 8 → 4+4, not 5+3 when 5 is the cap).
  const rows = Math.ceil(count / cap);
  return Math.ceil(count / rows);
}

export interface PlaceResult {
  x: number;
  y: number;
  labelSide: LabelSide;
  labelWidth: number;
  row: number;
  col: number;
}

/**
 * Place marks on a serpentine treasure-trail. Pure function of (index, count)
 * — addressed by (node, iteration) order, never by task id.
 *
 * Labels sit below each ring; width scales with pitch so adjacent boxes never
 * overlap. Legs terminate at the ring edge (see {@link cubicLeg}), so the
 * stroke stays out of the label band.
 */
export function placeMarks(count: number): {
  positions: PlaceResult[];
  vbH: number;
} {
  if (count <= 0) {
    return { positions: [], vbH: 560 };
  }

  const usableLeft = EDGE_X;
  const usableRight = CHART_VB_W - DEST_RESERVE;
  const usableW = Math.max(TARGET_PITCH, usableRight - usableLeft);
  const perRow = marksPerRow(count, usableW);
  const rows = Math.ceil(count / perRow);
  const vbH = Math.max(
    560,
    EDGE_TOP + EDGE_BOTTOM + (rows - 1) * ROW_PITCH + LABEL_H,
  );

  const positions: PlaceResult[] = [];

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const indexInRow = i % perRow;
    const rowCount = Math.min(perRow, count - row * perRow);
    // Odd rows reverse (serpentine).
    const col = row % 2 === 0 ? indexInRow : rowCount - 1 - indexInRow;

    const pitch = rowCount <= 1 ? TARGET_PITCH : usableW / (rowCount - 1);
    // Pitch-derived width: adjacent labels must leave LABEL_X_GAP between them.
    const labelWidth = Math.min(
      LABEL_W_MAX,
      Math.max(LABEL_W_MIN, pitch - LABEL_X_GAP),
    );

    const x =
      rowCount <= 1
        ? usableLeft + usableW * 0.28
        : usableLeft + col * pitch;

    // Mild hand-drawn wander — deterministic from index, not task id.
    // Keep vertical wander small so the leg bow does not dive into labels.
    const wander = Math.sin(i * 1.7) * 10;
    const yBase = EDGE_TOP + row * ROW_PITCH;
    const along = rowCount <= 1 ? 0.5 : col / (rowCount - 1);
    // Slight *upward* bow within a row — away from the below-label band.
    const bow = Math.sin(along * Math.PI) * 14;
    const y = yBase - bow + wander * 0.2;

    positions.push({
      x,
      y,
      labelSide: "below",
      labelWidth,
      row,
      col,
    });
  }

  return { positions, vbH };
}

/** Clearance past the full below-label band when a leg heads into it. */
const LABEL_BAND_CLEAR =
  MARK_CLEAR_R + LABEL_RING_GAP + LABEL_H + 12;

/**
 * Cubic leg between two marks. Terminates outside each ring — and outside
 * the below-label band when the path would otherwise run through it — so
 * the stroke never composites under mark text (B1).
 */
function cubicLeg(
  a: { x: number; y: number },
  b: { x: number; y: number },
  lift = 0.12,
): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // If the path leaves a downward into its label band, start past the labels.
  // If it arrives at b from below, end past b's label band.
  const r0 = uy > 0.2 ? LABEL_BAND_CLEAR : MARK_CLEAR_R;
  const r1 = uy < -0.2 ? LABEL_BAND_CLEAR : MARK_CLEAR_R;
  const x0 = a.x + ux * r0;
  const y0 = a.y + uy * r0;
  const x1 = b.x - ux * r1;
  const y1 = b.y - uy * r1;
  const ldx = x1 - x0;
  const ldy = y1 - y0;
  // Lift *upward* (negative y) so gentle bows stay out of the label band.
  const up = -Math.abs(lift);
  const cx1 = x0 + ldx * 0.35;
  const cy1 = y0 + ldy * 0.35 + Math.abs(ldx) * up * 0.15;
  const cx2 = x0 + ldx * 0.65;
  const cy2 = y0 + ldy * 0.65 + Math.abs(ldx) * up * 0.15;
  return `M${x0.toFixed(1)},${y0.toFixed(1)} C${cx1.toFixed(1)},${cy1.toFixed(1)} ${cx2.toFixed(1)},${cy2.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
}

/**
 * Loop-back arc. Terminates **clear of** the target mark ring so the
 * arrowhead is not painted under the mark (B4 / board 1).
 */
export function loopArc(
  from: { x: number; y: number },
  to: { x: number; y: number },
  clearR: number = MARK_CLEAR_R + 6,
): { d: string; end: { x: number; y: number } } {
  const mx = (from.x + to.x) / 2;
  const top = Math.min(from.y, to.y) - 90;
  const c2x = to.x * 0.7 + mx * 0.3;
  const c2y = top;
  // Shorten the endpoint along the approach vector so the tip sits in open paper.
  const adx = to.x - c2x;
  const ady = to.y - c2y;
  const alen = Math.hypot(adx, ady) || 1;
  const end = {
    x: to.x - (adx / alen) * clearR,
    y: to.y - (ady / alen) * clearR,
  };
  const c1x = from.x * 0.7 + mx * 0.3;
  const d = `M${from.x.toFixed(1)},${from.y.toFixed(1)} C${c1x.toFixed(1)},${top.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`;
  return { d, end };
}

/**
 * Text-block rectangles for every mark label (name+meta+tally band).
 * Ring centre is at (mark.x, mark.y); labels sit fully below the clear
 * radius. Legs end at that radius, so the stroke does not enter this box.
 */
export function markLabelRects(marks: ChartMark[]): ChartTextRect[] {
  return marks.map((m) => {
    const w = m.labelWidth;
    const h = LABEL_H;
    const x = m.x - w / 2;
    const y = m.y + MARK_CLEAR_R + LABEL_RING_GAP;
    return { key: m.key, x, y, w, h };
  });
}

/** Ring (or wax seal) hit boxes used for key-overprint checks. */
export function markRingRects(marks: ChartMark[]): ChartTextRect[] {
  return marks.map((m) => {
    const r = m.seal ? 26 : MARK_CLEAR_R;
    return {
      key: `${m.key}:ring`,
      x: m.x - r,
      y: m.y - r,
      w: r * 2,
      h: r * 2,
    };
  });
}

/** Destination ✕ + label box (approximate). */
export function destinationRect(
  dest: { x: number; y: number },
): ChartTextRect {
  return {
    key: "destination",
    x: dest.x - 60,
    y: dest.y - 28,
    w: 120,
    h: 72,
  };
}

function rectsOverlap(a: ChartTextRect, b: ChartTextRect, pad = 2): boolean {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

// --- Marginalia placement (#268) --------------------------------------------

/**
 * Cockpit layout tokens that pin the centre-stage sheet width
 * (mirrors `tokens.css` / `cockpit.css`). Do not hand-copy a scale number —
 * derive it from these.
 */
export const COCKPIT_LAYOUT = {
  /** Narrowest desktop width where the triptych still runs side-by-side. */
  desktopMinWidthPx: 1081,
  /** Stacking breakpoint — at and below, rails collapse (`max-width: 1080px`). */
  stackBreakpointPx: 1080,
  boardInsetPx: 14, // --board-inset
  gutterPx: 12, // --gutter
  regionRosterPx: 300, // --region-roster
  regionRightPx: 344, // --region-right
} as const;

/**
 * Minimum centre-stage content width at the narrowest desktop triptych.
 * `viewport − 2×inset − roster − right − 2×gutter`.
 * At 1081: 1081 − 28 − 300 − 344 − 24 = **385 px**.
 */
export function minCentreSheetWidthPx(
  viewportWidthPx: number = COCKPIT_LAYOUT.desktopMinWidthPx,
): number {
  const {
    boardInsetPx,
    gutterPx,
    regionRosterPx,
    regionRightPx,
    stackBreakpointPx,
  } = COCKPIT_LAYOUT;
  // Below the stack breakpoint rails reflow; the desktop floor is the
  // side-by-side triptych just above that breakpoint.
  const w = Math.max(viewportWidthPx, stackBreakpointPx + 1);
  return (
    w -
    2 * boardInsetPx -
    regionRosterPx -
    regionRightPx -
    2 * gutterPx
  );
}

/**
 * Binding ornament scale: sheet is `aspect-ratio: 1000/vbH` with uniform
 * scale, so `scale = sheetWidth/1000`. Horizontal is binding; the floor is
 * the narrowest desktop centre width over CHART_VB_W.
 *
 * Today: 385/1000 = **0.385**.
 */
export function ornamentScaleFloor(
  viewportWidthPx: number = COCKPIT_LAYOUT.desktopMinWidthPx,
): number {
  return minCentreSheetWidthPx(viewportWidthPx) / CHART_VB_W;
}

/** Measured painted ink (px) for catalog lines — IM Fell 12px italic, Chrome. */
export const MARGINALIA_INK_PX = {
  /** Rotated AABB for the tilted dissent line. */
  dissent: { w: 161.4, h: 31.7 },
  /** Unrotated "here be regressions". */
  regressions: { w: 75.1, h: 15.0 },
} as const;

/** Extra px margin so reserve always exceeds painted ink (fail-loud if not). */
const MARGINALIA_INK_PAD_PX = 4;

/** Min clearance from chrome plates so a line reads as paper, not a caption. */
const CHROME_CLEAR_PX = 16;

/**
 * Catalog entries. Box sizes are derived at the scale floor from measured
 * ink + pad — never a hand-copied viewBox guess that can under-cover.
 */
function marginaliaCatalog(scale: number): ReadonlyArray<{
  key: string;
  text: string;
  w: number;
  h: number;
  tilt: boolean;
  preferX: number;
  preferYFrac: number;
  inkPx: { w: number; h: number };
}> {
  const box = (ink: { w: number; h: number }) => ({
    w: (ink.w + MARGINALIA_INK_PAD_PX) / scale,
    h: (ink.h + MARGINALIA_INK_PAD_PX) / scale,
  });
  const dissent = box(MARGINALIA_INK_PX.dissent);
  const regressions = box(MARGINALIA_INK_PX.regressions);
  // Fail loud if reserve would be smaller than ink at this scale.
  if (
    dissent.w * scale < MARGINALIA_INK_PX.dissent.w ||
    dissent.h * scale < MARGINALIA_INK_PX.dissent.h ||
    regressions.w * scale < MARGINALIA_INK_PX.regressions.w ||
    regressions.h * scale < MARGINALIA_INK_PX.regressions.h
  ) {
    throw new Error(
      `marginalia reserve under-covers ink at scale ${scale} (pad=${MARGINALIA_INK_PAD_PX}px)`,
    );
  }
  return [
    {
      key: "dissent",
      text: "\u201cif the reviewers dissent, sail it back\u201d",
      w: dissent.w,
      h: dissent.h,
      tilt: true,
      // Prefer upper-right empty quarter — clear of the compass rose.
      preferX: 620,
      preferYFrac: 0.18,
      inkPx: MARGINALIA_INK_PX.dissent,
    },
    {
      key: "regressions",
      text: "here be regressions",
      w: regressions.w,
      h: regressions.h,
      tilt: false,
      // Prefer mid-left paper.
      preferX: 280,
      preferYFrac: 0.42,
      inkPx: MARGINALIA_INK_PX.regressions,
    },
  ];
}

function pxToVb(px: number, scale: number): number {
  return px / scale;
}

function clampRectToSheet(r: ChartTextRect, vbH: number): ChartTextRect {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const rgt = Math.min(CHART_VB_W, r.x + r.w);
  const bot = Math.min(vbH, r.y + r.h);
  return { key: r.key, x, y, w: Math.max(0, rgt - x), h: Math.max(0, bot - y) };
}

/**
 * Expand a viewBox rect by a CSS-pixel clearance at the given scale so
 * placed ornament does not sit flush against chrome (reads as paper air).
 */
function padRectPx(
  r: ChartTextRect,
  padPx: number,
  scale: number,
): ChartTextRect {
  const p = pxToVb(padPx, scale);
  return {
    key: r.key,
    x: r.x - p,
    y: r.y - p,
    w: r.w + 2 * p,
    h: r.h + 2 * p,
  };
}

/*
 * The legend band is gone from this obstacle set (#267): the run title moved
 * into the sheet's title block, above the plot, so it is no longer paper the
 * ornament pass has to route around. Its reserve had the same defect the key's
 * did — a fixed 88px stack converted at an assumed scale.
 */

/** Compass rose from CSS (88×88, top 18 / right 22). */
export function compassBandRectForOrnament(
  scale: number,
  sheetWidthPx: number,
  vbH: number,
): ChartTextRect {
  const size = 88;
  const top = 18;
  const right = 22;
  const raw: ChartTextRect = {
    key: "compass",
    x: pxToVb(sheetWidthPx - right - size, scale),
    y: pxToVb(top, scale),
    w: pxToVb(size, scale),
    h: pxToVb(size, scale),
  };
  return clampRectToSheet(padRectPx(raw, CHROME_CLEAR_PX, scale), vbH);
}

/**
 * Held-gate helm — opaque plate (`z-index: 4`) with Copy run id.
 * CSS: left/right 18px, bottom 14px; height 58.6–117.4px depending on wrap.
 * Use the wrap ceiling so short sheets never bury ornament under the plate.
 *
 * Since #267 the helm sits in flow *below* the plot rather than floating over
 * the paper's bottom, so this reserve is now conservative rather than load
 * bearing: it costs the ornament pass a band of paper that nothing occupies.
 * Kept as-is deliberately — reworking the ornament obstacle set belongs to
 * #268, not here.
 */
export function helmZoneRectForOrnament(
  vbH: number,
  scale: number,
  sheetWidthPx: number,
): ChartTextRect {
  const left = 18;
  const right = 18;
  const bottom = 14;
  const heightPx = 118; // wrap ceiling measured at short viewports
  const raw: ChartTextRect = {
    key: "helm",
    x: pxToVb(left, scale),
    y: vbH - pxToVb(bottom + heightPx, scale),
    w: pxToVb(sheetWidthPx - left - right, scale),
    h: pxToVb(heightPx, scale),
  };
  return clampRectToSheet(padRectPx(raw, CHROME_CLEAR_PX, scale), vbH);
}

/**
 * Label obstacles for ornament: union of structural viewBox band and the
 * fixed-px CSS `top: 28px` band at the scale floor (never max-only — that
 * left a gap above the pure viewBox box).
 */
export function markLabelRectsForOrnament(
  marks: ChartMark[],
  scale: number,
): ChartTextRect[] {
  const structuralTop = MARK_CLEAR_R + LABEL_RING_GAP;
  const structuralBot = structuralTop + LABEL_H;
  const shortTop = pxToVb(28, scale);
  // Name + meta + optional tally chip, rem stack at the scale floor.
  const shortBot = shortTop + pxToVb(52, scale);
  const topVb = Math.min(structuralTop, shortTop);
  const botVb = Math.max(structuralBot, shortBot);
  const hVb = botVb - topVb;
  return marks.map((m) => {
    // Width: structural labelWidth, expanded if rem text needs more at floor.
    const w = Math.max(m.labelWidth, pxToVb(72, scale));
    return {
      key: `${m.key}:orn-label`,
      x: m.x - w / 2,
      y: m.y + topVb,
      w,
      h: hVb,
    };
  });
}

/** Ring obstacles: union of viewBox clear radius and fixed-px ring at floor. */
export function markRingRectsForOrnament(
  marks: ChartMark[],
  scale: number,
): ChartTextRect[] {
  const minR = pxToVb(22, scale); // half of ~44 px painted ring
  return marks.map((m) => {
    const r = Math.max(m.seal ? 26 : MARK_CLEAR_R, minR);
    return {
      key: `${m.key}:orn-ring`,
      x: m.x - r,
      y: m.y - r,
      w: r * 2,
      h: r * 2,
    };
  });
}

/**
 * Full obstacle set the placer uses — exported so tests assert against the
 * same rects (not a re-derived pure-viewBox subset that misses helm/chrome).
 */
export function ornamentObstacles(args: {
  marks: ChartMark[];
  destination: { x: number; y: number };
  vbH: number;
  heldGate: boolean;
  scale?: number;
  sheetWidthPx?: number;
}): ChartTextRect[] {
  const scale = args.scale ?? ornamentScaleFloor();
  const sheetWidthPx =
    args.sheetWidthPx ?? minCentreSheetWidthPx();
  const list: ChartTextRect[] = [
    ...markRingRectsForOrnament(args.marks, scale),
    ...markLabelRectsForOrnament(args.marks, scale),
    destinationRect(args.destination),
    // Key and legend are not obstacles any more — both sit in the title
    // block, off the projected paper (#267). The compass and the held-gate
    // helm still paint on it, so they stay.
    compassBandRectForOrnament(scale, sheetWidthPx, args.vbH),
  ];
  if (args.heldGate) {
    list.push(helmZoneRectForOrnament(args.vbH, scale, sheetWidthPx));
  }
  return list;
}

/** Axis-aligned box for a centre-anchored marginalia line. */
export function marginaliaRect(m: ChartMarginalia): ChartTextRect {
  return {
    key: m.key,
    x: m.x - m.w / 2,
    y: m.y - m.h / 2,
    w: m.w,
    h: m.h,
  };
}

export function marginaliaRects(items: ChartMarginalia[]): ChartTextRect[] {
  return items.map(marginaliaRect);
}

/**
 * True when any sampled route/loop stroke point falls inside `box`
 * (stroke half-width ≈ pad viewBox units).
 */
export function anyStrokeInBox(
  paths: Array<{ d: string }>,
  box: ChartTextRect,
  pad = 6,
): boolean {
  for (const path of paths) {
    for (const p of sampleCubic(path.d)) {
      if (pointInRect(p, box, pad)) return true;
    }
  }
  return false;
}

/**
 * True when a marginalia box overlaps any obstacle or a route stroke.
 */
export function anyMarginaliaOverprint(
  box: ChartTextRect,
  obstacles: ChartTextRect[],
  strokes: Array<{ d: string }>,
  pad = 2,
): boolean {
  if (obstacles.some((o) => rectsOverlap(box, o, pad))) return true;
  return anyStrokeInBox(strokes, box, 6);
}

/**
 * Serpentine row count for `n` marks — non-decreasing in n (stable threshold).
 */
export function chartRowCount(markCount: number): number {
  if (markCount <= 0) return 0;
  const { positions } = placeMarks(markCount);
  if (positions.length === 0) return 0;
  return Math.max(...positions.map((p) => p.row)) + 1;
}

/**
 * Whole-ornament row ceiling. Multi-row trails leave empty quarters that
 * open and close non-monotonically with serpentine packing; once the route
 * snakes, omit the entire ornament (monotonic in n — row count is
 * non-decreasing). Sparse is a separate gate. Single-row charts (n ≤ ~5 at
 * current pitch) still get the full pair when free paper clears chrome.
 */
export const MARGINALIA_MAX_ROWS = 1;

/**
 * Place flavor marginalia in free paper — **all catalog lines or none**.
 * Same pass / coordinate space as marks. Omission is a whole-ornament
 * decision (sparse-route precedent): sparse decoration, too many rows, or
 * any single line failing to find a free region → `[]`.
 */
export function placeMarginalia(args: {
  decorations: "full" | "sparse";
  marks: ChartMark[];
  legs: ChartLeg[];
  loopBacks: ChartLoopBack[];
  destination: { x: number; y: number };
  vbH: number;
  heldGate: boolean;
  /** Override scale floor (tests). Default: derived cockpit floor. */
  scale?: number;
  sheetWidthPx?: number;
}): ChartMarginalia[] {
  if (args.decorations === "sparse") return [];

  // Stable threshold: row count is non-decreasing in n for fixed usable width.
  if (chartRowCount(args.marks.length) > MARGINALIA_MAX_ROWS) return [];

  const scale = args.scale ?? ornamentScaleFloor();
  const sheetWidthPx = args.sheetWidthPx ?? minCentreSheetWidthPx();
  const catalog = marginaliaCatalog(scale);

  const obstacles: ChartTextRect[] = ornamentObstacles({
    marks: args.marks,
    destination: args.destination,
    vbH: args.vbH,
    heldGate: args.heldGate,
    scale,
    sheetWidthPx,
  });
  const strokes: Array<{ d: string }> = [
    ...args.legs,
    ...args.loopBacks,
  ];

  const placed: ChartMarginalia[] = [];
  const working = obstacles.slice();

  for (const item of catalog) {
    const preferY = item.preferYFrac * args.vbH;
    const halfW = item.w / 2;
    const halfH = item.h / 2;
    const minX = halfW + 12;
    const maxX = CHART_VB_W - halfW - 12;
    const minY = halfH + 12;
    const maxY = args.vbH - halfH - 12;
    if (minX > maxX || minY > maxY) return []; // whole-ornament omit

    const seeds: Array<{ x: number; y: number }> = [];
    const clampX = (x: number) => Math.min(maxX, Math.max(minX, x));
    const clampY = (y: number) => Math.min(maxY, Math.max(minY, y));
    seeds.push({ x: clampX(item.preferX), y: clampY(preferY) });

    const step = 16;
    for (let y = minY; y <= maxY; y += step) {
      for (let x = minX; x <= maxX; x += step) {
        seeds.push({ x, y });
      }
    }
    seeds.sort((a, b) => {
      const da =
        (a.x - item.preferX) * (a.x - item.preferX) +
        (a.y - preferY) * (a.y - preferY);
      const db =
        (b.x - item.preferX) * (b.x - item.preferX) +
        (b.y - preferY) * (b.y - preferY);
      return da - db;
    });

    let found: ChartMarginalia | null = null;
    for (const c of seeds) {
      const box: ChartTextRect = {
        key: item.key,
        x: c.x - halfW,
        y: c.y - halfH,
        w: item.w,
        h: item.h,
      };
      if (anyMarginaliaOverprint(box, working, strokes)) continue;
      found = {
        key: item.key,
        text: item.text,
        x: c.x,
        y: c.y,
        w: item.w,
        h: item.h,
        tilt: item.tilt,
      };
      break;
    }

    // Whole-ornament: any single miss drops the entire set.
    if (!found) return [];
    placed.push(found);
    working.push(marginaliaRect(found));
  }

  return placed;
}

/** True when any two label rects intersect (B1 invariant). */
export function anyLabelOverlap(rects: ChartTextRect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i]!, rects[j]!)) return true;
    }
  }
  return false;
}

/**
 * Sample a cubic path (M x,y C cx1,cy1 cx2,cy2 x2,y2) into polyline points.
 */
function sampleCubic(d: string, steps = 24): Array<{ x: number; y: number }> {
  const m = d.match(
    /M([\d.-]+),([\d.-]+)\s*C([\d.-]+),([\d.-]+)\s+([\d.-]+),([\d.-]+)\s+([\d.-]+),([\d.-]+)/,
  );
  if (!m) return [];
  const [, x0, y0, cx1, cy1, cx2, cy2, x1, y1] = m.map(Number) as number[];
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x =
      u * u * u * x0! +
      3 * u * u * t * cx1! +
      3 * u * t * t * cx2! +
      t * t * t * x1!;
    const y =
      u * u * u * y0! +
      3 * u * u * t * cy1! +
      3 * u * t * t * cy2! +
      t * t * t * y1!;
    pts.push({ x, y });
  }
  return pts;
}

function pointInRect(
  p: { x: number; y: number },
  r: ChartTextRect,
  pad: number,
): boolean {
  return (
    p.x >= r.x - pad &&
    p.x <= r.x + r.w + pad &&
    p.y >= r.y - pad &&
    p.y <= r.y + r.h + pad
  );
}

/**
 * True when any route-leg sample falls inside a label rect (B1: labels must
 * not composite over the trail). Stroke half-width ≈ 3 viewBox units.
 */
export function anyLabelOnRoute(
  rects: ChartTextRect[],
  legs: ChartLeg[],
  strokePad = 4,
): boolean {
  for (const leg of legs) {
    for (const p of sampleCubic(leg.d)) {
      for (const r of rects) {
        if (pointInRect(p, r, strokePad)) return true;
      }
    }
  }
  return false;
}

/**
 * Map a CSS pixel sheet width back to viewBox scale and re-check the B1
 * invariant. Mark positions are in viewBox units; at any sheet width the
 * *relative* layout is identical (percentage placement), so non-overlap in
 * viewBox space is the invariant that holds at 1081 / 1440 / 1920.
 *
 * Sheet width is still accepted so tests document the viewport matrix the
 * reviewer measured against; the geometry does not depend on it.
 */
export function assertLabelClearance(
  marks: ChartMark[],
  legs: ChartLeg[],
  _sheetWidthPx: number,
): { overlap: boolean; onRoute: boolean; rects: ChartTextRect[] } {
  const rects = markLabelRects(marks);
  return {
    overlap: anyLabelOverlap(rects),
    onRoute: anyLabelOnRoute(rects, legs),
    rects,
  };
}

function projectReady(run: InspectorRunReady): ChartReadyModel {
  const nodes = run.nodes;
  const { positions, vbH: baseVbH } = placeMarks(nodes.length);
  // Held helm parks the key above the bottom band (BL-2). Grow the sheet so
  // the last label row stays clear of that raised key zone.
  const vbH = baseVbH + (run.heldGate ? 100 : 0);

  const marks: ChartMark[] = nodes.map((node, i) => {
    const style = inkForNode(node);
    const pos = positions[i]!;
    const seal = node.kind === "gate" ? sealForGate(node) : null;
    return {
      key: node.key,
      node: node.node,
      kind: node.kind,
      iteration: node.iteration,
      ink: style.ink,
      glyph: style.glyph,
      className: style.className,
      name: node.node,
      meta: markMeta(node),
      fanoutWidth: node.fanoutWidth,
      seal,
      x: pos.x,
      y: pos.y,
      labelSide: pos.labelSide,
      labelWidth: pos.labelWidth,
      live: node.live,
      onReject: node.onReject,
    };
  });

  // Legs: pen weight only. Soft when either endpoint is not-yet-entered
  // structure (ghost); strong for the charted trail. Never a state ink.
  const legs: ChartLeg[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i]!;
    const b = marks[i + 1]!;
    const soft = a.ink === "ghost" || b.ink === "ghost";
    legs.push({
      d: cubicLeg(a, b),
      pen: soft ? "soft" : "chart",
    });
  }

  // Destination X after the last mark (or alone when the table is empty).
  const destination =
    marks.length === 0
      ? { x: CHART_VB_W * 0.72, y: vbH * 0.48 }
      : (() => {
          const last = marks[marks.length - 1]!;
          return {
            x: Math.min(CHART_VB_W - 70, last.x + 120),
            y: last.y,
          };
        })();

  if (marks.length > 0) {
    const last = marks[marks.length - 1]!;
    legs.push({
      d: cubicLeg(last, destination, 0.12),
      pen: last.ink === "ghost" ? "soft" : "chart",
    });
  }

  // Loop-backs: gate on_reject → earlier mark of that node name (any pass).
  const loopBacks: ChartLoopBack[] = [];
  for (const mark of marks) {
    if (mark.kind !== "gate" || !mark.onReject) continue;
    const target = marks.find(
      (m) => m.node === mark.onReject && m.key !== mark.key,
    );
    if (!target) continue;
    const fromIdx = marks.indexOf(mark);
    const toIdx = marks.indexOf(target);
    if (toIdx >= fromIdx) continue;
    const arc = loopArc(mark, target);
    loopBacks.push({
      d: arc.d,
      fromKey: mark.key,
      toKey: target.key,
      end: arc.end,
      targetCentre: { x: target.x, y: target.y },
    });
  }

  // Iteration re-entries when no gate loop already covers the pair.
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    if (m.iteration <= 1) continue;
    const prev = marks.find(
      (p) => p.node === m.node && p.iteration === m.iteration - 1,
    );
    if (!prev) continue;
    if (i === 0) continue;
    const predecessor = marks[i - 1]!;
    if (predecessor.node === m.node) continue;
    const already = loopBacks.some(
      (lb) => lb.fromKey === predecessor.key && lb.toKey === prev.key,
    );
    if (already) continue;
    if (predecessor.iteration === m.iteration) continue;
    const arc = loopArc(predecessor, prev);
    loopBacks.push({
      d: arc.d,
      fromKey: predecessor.key,
      toKey: prev.key,
      end: arc.end,
      targetCentre: { x: prev.x, y: prev.y },
    });
  }

  const hasGate = marks.some((m) => m.kind === "gate");
  const decorations: "full" | "sparse" =
    marks.length <= 1 && !hasGate ? "sparse" : "full";

  // Flavor marginalia: same pass / viewBox space as marks (#268). Sparse
  // routes and charts with no free region large enough both yield [].
  const marginalia = placeMarginalia({
    decorations,
    marks,
    legs,
    loopBacks,
    destination,
    vbH,
    heldGate: run.heldGate,
  });

  // Split operational data (Outfit) from atmosphere (IM Fell).
  const dataParts: string[] = [];
  if (run.duration) dataParts.push(run.duration);
  if (run.iteration > 0) dataParts.push(`pass ${run.iteration}`);
  const metaLine = dataParts.length > 0 ? dataParts.join(" · ") : null;

  let flavor: string | null = null;
  if (run.heldGate) flavor = "one seal still unbroken";
  else if (run.runState === "completed") flavor = "the run is charted";
  else if (run.runState === "running") flavor = "the route is still wet";
  else if (!metaLine) flavor = "a route inked on aged paper";

  return {
    status: "ready",
    id: run.id,
    workflow: run.workflow,
    shortId: shortRef(run.id),
    // Same calm-case decision as mark captions — not dead-field drift if
    // a consumer later reads this for chrome.
    stateLabel: chartPresentLabel(run.stateLabel),
    heldGate: run.heldGate,
    marks,
    legs,
    loopBacks,
    destination,
    vbH,
    decorations,
    marginalia,
    metaLine,
    flavor,
  };
}

/**
 * Project the inspector run view into chart geometry. Pending stays honest —
 * no invented node counts, states, or versions.
 */
export function projectChart(run: InspectorRun): ChartModel {
  if (run.status === "pending") {
    return {
      status: "pending",
      id: run.id,
      shortId: shortRef(run.id),
    };
  }
  return projectReady(run);
}

/** Mark count equals the (node, iteration) count — load-bearing invariant. */
export function chartMarkCount(model: ChartModel): number {
  return model.status === "ready" ? model.marks.length : 0;
}
