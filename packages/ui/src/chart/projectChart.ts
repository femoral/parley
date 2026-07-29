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
 * Decorative flavor line for the sheet's foot band (#273).
 *
 * Carries no geometry. The ornament used to be placed *on the paper*, in
 * viewBox units, by a free-region search against every mark, label, plate and
 * route stroke (#268) — which meant a reserve denominated in a sheet scale
 * the projector cannot know, and an ornament that vanished from ~87% of
 * charts to stay out of the way. It now sits in flow below the plot, so it
 * has nothing to avoid and nothing to be avoided by. Same move the run title
 * and the state key made in #267, for the same reason.
 */
export interface ChartMarginalia {
  key: string;
  /** Atmospheric copy — never operational. */
  text: string;
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
/**
 * Right reserve for the destination marker, and the preferred centre-to-centre
 * offset past the final mark. Marks stop at `CHART_VB_W - DEST_RESERVE` so the
 * reserved strip can hold the ✕; the same distance is the ideal leg length to
 * it. One number — the old clamp used a hard-coded 70 and the offset a
 * hard-coded 120; both ignored this reserve (#275).
 *
 * Marks stop at `CHART_VB_W - DEST_RESERVE`. The preferred destination offset
 * is the same distance; when that seat is blocked (right-edge clamp, label
 * band, neighbour), free-region search finds the nearest clear seat.
 */
const DEST_RESERVE = 100;
/**
 * Destination ✕ + caption box half-width / top-half / total height in viewBox
 * units. {@link destinationRect} is the single source for this geometry; the
 * placement search clamps and collides against the same box.
 */
const DEST_HALF_W = 60;
const DEST_HALF_H = 28;
const DEST_H = 72;
/**
 * Minimum upward lift (viewBox) when the horizontal seat cannot clear the
 * fixed-px caption past the painted disc at the scale floor. Sized so the
 * caption band sits fully above the disc: paintedLastR + DEST_HALF_H + air.
 */
const DEST_CAPTION_LIFT = 110;
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
    x: dest.x - DEST_HALF_W,
    y: dest.y - DEST_HALF_H,
    w: DEST_HALF_W * 2,
    h: DEST_H,
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

/**
 * Place the destination marker after the final mark so it clears every mark
 * ring, wax seal and label.
 *
 * Prefer the nearest centre to `(last.x + DEST_RESERVE, last.y)` that still
 * reads as terminating the trail. When a neighbour sits to the right, sit in
 * the free mid-gap instead of overrunning it. When the horizontal seat is
 * short, a small upward lift keeps the caption off the disc (#275).
 */
export function placeDestination(
  marks: ChartMark[],
  vbH: number,
): { x: number; y: number } {
  if (marks.length === 0) {
    return { x: CHART_VB_W * 0.72, y: vbH * 0.48 };
  }

  const last = marks[marks.length - 1]!;

  // Keep destinationRect on the sheet (same numbers the export uses). Caption
  // ink may still kiss the right edge at narrow sheets — that is a #271
  // question, not a placement clamp.
  //
  // `vbH` may grow below to fit a below-the-label seat when the trail ends on
  // the right edge of a lower row — otherwise the clamp forces the search
  // backward onto free paper above earlier marks.
  const minX = DEST_HALF_W + 4;
  const maxX = CHART_VB_W - DEST_HALF_W - 4;
  const minY = DEST_HALF_H + 4;
  let maxY = vbH - (DEST_H - DEST_HALF_H) - 4;

  const clampPt = (p: { x: number; y: number }) => ({
    x: Math.min(maxX, Math.max(minX, p.x)),
    y: Math.min(maxY, Math.max(minY, p.y)),
  });

  // Scale-floor paint sizes for fixed CSS px (rings 40–46px, caption ~100px).
  const scale = sheetScaleFloor();
  const paintedLastR = Math.max(
    last.seal ? 26 : MARK_CLEAR_R,
    (last.seal ? 23 : 20) / scale,
  );
  const captionHalfVb = Math.max(DEST_HALF_W, 50 / scale);
  // Gap that clears the caption past the painted disc side-by-side.
  const sideBySideGap = paintedLastR + captionHalfVb + 6;

  // Ideal x: at least DEST_RESERVE past the final mark, or the full
  // side-by-side gap when the sheet has room (single-node trails, left-end
  // rows). Cap at the mid-gap to a same-row neighbour so we don't land on it.
  const sameRow = marks.filter(
    (m) => m.key !== last.key && Math.abs(m.y - last.y) < ROW_PITCH * 0.45,
  );
  const rightNeighbour = sameRow
    .filter((m) => m.x > last.x)
    .sort((a, b) => a.x - b.x)[0];
  let preferX = last.x + Math.max(DEST_RESERVE, sideBySideGap);
  if (rightNeighbour) {
    preferX = Math.min(preferX, (last.x + rightNeighbour.x) / 2);
  }
  const prefer = { x: preferX, y: last.y };

  // Obstacles: exported ring/label rects. Expand only the *final* mark's ring
  // and label to painted fixed-px sizes at the scale floor — that is the
  // disc/caption pair the defect is about. Other marks stay structural so a
  // dense serpentine still has free paper near the trail end.
  const labelTop = Math.min(MARK_CLEAR_R + LABEL_RING_GAP, 28 / scale);
  const labelBot = Math.max(
    MARK_CLEAR_R + LABEL_RING_GAP + LABEL_H,
    28 / scale + 48 / scale,
  );
  const obstacles: ChartTextRect[] = [
    ...markRingRects(marks).map((r) => {
      if (r.key !== `${last.key}:ring`) return r;
      return {
        key: r.key,
        x: last.x - paintedLastR,
        y: last.y - paintedLastR,
        w: paintedLastR * 2,
        h: paintedLastR * 2,
      };
    }),
    ...markLabelRects(marks).map((r) => {
      if (r.key !== last.key) return r;
      const w = Math.max(r.w, last.labelWidth);
      return {
        key: r.key,
        x: last.x - w / 2,
        y: last.y + labelTop,
        w,
        h: labelBot - labelTop,
      };
    }),
  ];

  // Centre clearance from the final mark (painted disc + ✕ glyph half).
  // Caption width is handled by the side-by-side gap / vertical offset.
  const minDist = paintedLastR + 22 / scale;

  const clears = (p: { x: number; y: number }): boolean => {
    if (Math.hypot(p.x - last.x, p.y - last.y) < minDist) return false;
    // Structural destinationRect plus pad for the fixed-rem caption stack.
    const base = destinationRect(p);
    const box: ChartTextRect = {
      key: base.key,
      x: base.x - 8,
      y: base.y - 4,
      w: base.w + 16,
      h: base.h + 8,
    };
    return !obstacles.some((o) => rectsOverlap(box, o, 4));
  };

  const clampedPrefer = clampPt(prefer);
  const gapX = clampedPrefer.x - last.x;
  // When the horizontal seat is short of side-by-side clearance, move off the
  // row: prefer above the disc, or below the painted label band when the top
  // edge clamps the lift (row-0 trails have almost no air above the mark).
  const tight = gapX < sideBySideGap;
  const liftNeeded = Math.max(
    DEST_CAPTION_LIFT,
    paintedLastR + DEST_HALF_H + 24,
  );
  // Below the painted label stack + the full destination stack. Both the
  // label `top: 28px` offset and the destination ✕/caption are fixed CSS px,
  // so size the drop at the scale floor (px → viewBox) rather than against
  // the structural DEST_H alone — a structural-only drop still kisses meta
  // at the narrowest desktop triptych.
  const destStackHalfPx = 28; // ~half of the painted 50px ✕+caption stack
  const dropNeeded =
    labelBot + destStackHalfPx / scale + 16 / scale;
  // Grow the searchable sheet so a below-label seat is not clamped short.
  const belowY = last.y + dropNeeded;
  const needMaxY = belowY + (DEST_H - DEST_HALF_H) + 4;
  if (needMaxY > maxY) maxY = needMaxY;

  let ideal = clampedPrefer;
  if (tight) {
    const above = clampPt({ x: clampedPrefer.x, y: last.y - liftNeeded });
    const below = clampPt({ x: clampedPrefer.x, y: belowY });
    // Prefer above when the top clamp leaves the lift intact and the seat is
    // still near the trail (row 0 has almost no air above). Otherwise below —
    // continuing past the final mark's labels, still "after" on x.
    ideal =
      last.y - above.y >= liftNeeded * 0.85
        ? above
        : below;
  }

  const seeds: Array<{ x: number; y: number }> = [];
  seeds.push(ideal);
  seeds.push(clampedPrefer);
  seeds.push(clampPt({ x: clampedPrefer.x, y: last.y - liftNeeded }));
  seeds.push(clampPt({ x: clampedPrefer.x, y: last.y + dropNeeded }));
  for (const dy of [
    -liftNeeded,
    -liftNeeded * 0.5,
    -20,
    -80,
    dropNeeded,
    dropNeeded + 40,
    20,
    40,
    80,
    120,
    160,
    200,
    240,
  ]) {
    seeds.push(clampPt({ x: clampedPrefer.x, y: last.y + dy }));
    seeds.push(clampPt({ x: prefer.x, y: last.y + dy }));
  }
  for (const dist of [minDist, minDist + 16, minDist + 32, DEST_RESERVE]) {
    for (let deg = -80; deg <= 80; deg += 8) {
      const rad = (deg * Math.PI) / 180;
      seeds.push(
        clampPt({
          x: last.x + Math.cos(rad) * dist,
          y: last.y + Math.sin(rad) * dist,
        }),
      );
    }
  }

  const step = 14;
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      seeds.push({ x, y });
    }
  }

  // Prefer seats at or past the final mark, then nearest to the ideal seat.
  seeds.sort((a, b) => {
    const afterA = a.x + 1 >= last.x ? 0 : 1;
    const afterB = b.x + 1 >= last.x ? 0 : 1;
    if (afterA !== afterB) return afterA - afterB;
    const da =
      (a.x - ideal.x) * (a.x - ideal.x) + (a.y - ideal.y) * (a.y - ideal.y);
    const db =
      (b.x - ideal.x) * (b.x - ideal.x) + (b.y - ideal.y) * (b.y - ideal.y);
    return da - db;
  });

  for (const c of seeds) {
    if (clears(c)) return c;
  }

  return ideal;
}

// --- Sheet scale --------------------------------------------------------------

/**
 * Cockpit layout tokens that pin the centre-stage sheet width
 * (mirrors `tokens.css` / `cockpit.css`). Do not hand-copy a scale number —
 * derive it from these. Enforced by `cockpit-layout-tokens.test.ts` against
 * the live stylesheets so a token edit either flows through or fails a test.
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
 * Centre-stage content width for a given viewport.
 *
 * - **Side-by-side** (above the stack breakpoint): rails keep their token
 *   widths, so the centre is
 *   `viewport − 2×inset − roster − right − 2×gutter`.
 *   At 1081: 1081 − 28 − 300 − 344 − 24 = **385 px**.
 * - **Stacked** (at and below the breakpoint): rails collapse full-width
 *   under the centre, so the stage is `viewport − 2×inset`.
 *   At 320: 320 − 28 = **292 px**.
 *
 * The previous clamp-up to `stackBreakpoint + 1` under-reported the real
 * sheet below ~413px (and over-reported it through the rest of the stacked
 * band). Mark-geometry assertions need the worst-case scale, so this must
 * track the layout the CSS actually produces (#272).
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
  if (viewportWidthPx <= stackBreakpointPx) {
    // Rails reflow to full width; centre stage is the board minus insets only.
    return viewportWidthPx - 2 * boardInsetPx;
  }
  return (
    viewportWidthPx -
    2 * boardInsetPx -
    regionRosterPx -
    regionRightPx -
    2 * gutterPx
  );
}

/**
 * Binding sheet scale: the plot is `aspect-ratio: 1000/vbH` with uniform
 * scale, so `scale = sheetWidth/1000`. Horizontal is binding; the floor is
 * the narrowest centre width under consideration over CHART_VB_W.
 *
 * Default (narrowest desktop triptych): 385/1000 = **0.385**.
 * At a 320px stacked viewport: 292/1000 = **0.292**.
 *
 * No longer an *ornament* floor — the flavour lines left the paper in #273.
 * What still needs it is the mark geometry: a ring or a label that clears the
 * plot's edge at 1.224 can overflow it at 0.385 (or 0.292), and only the
 * floor proves it clears everywhere.
 */
export function sheetScaleFloor(
  viewportWidthPx: number = COCKPIT_LAYOUT.desktopMinWidthPx,
): number {
  return minCentreSheetWidthPx(viewportWidthPx) / CHART_VB_W;
}

// --- Flavour marginalia (#273) ----------------------------------------------

/**
 * The flavour catalog. Two lines, always both or neither — they read as a
 * pair. No sizes, no anchors, no scale: the foot band lays them out (#273).
 */
const MARGINALIA_CATALOG: ReadonlyArray<{ key: string; text: string }> = [
  { key: "dissent", text: "\u201cif the reviewers dissent, sail it back\u201d" },
  { key: "regressions", text: "here be regressions" },
];

/**
 * Flavour lines for the sheet's foot band. Sparse routes get none — a
 * single-node chart is too slight to carry atmosphere without looking like
 * the atmosphere is the point.
 */
export function marginaliaFor(decorations: "full" | "sparse"): ChartMarginalia[] {
  return decorations === "sparse" ? [] : MARGINALIA_CATALOG.map((line) => ({ ...line }));
}

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
  // Free-region seat: clears rings/labels, prefers last + DEST_RESERVE (#275).
  // May sit below the final label band; grow vbH so that seat stays on paper.
  const destination = placeDestination(marks, vbH);
  const vbHWithDest = Math.max(
    vbH,
    destination.y + (DEST_H - DEST_HALF_H) + 24,
  );

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

  // Flavour lines for the foot band — no placement pass (#273).
  const marginalia = marginaliaFor(decorations);

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
    vbH: vbHWithDest,
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
