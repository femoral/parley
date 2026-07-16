/*
 * Layer 0 — authored micro-SVG marks for panel chrome (headers, toggles,
 * empty states, avatars). Companion to `state-glyphs.ts`, which owns the
 * task-state vocabulary; these are the fixed furniture of the cove.
 *
 * Same contract: bold currentColor silhouettes in a 24×24 viewBox, sized for
 * 10–16px render — no fine detail. Rendered via {@link Mark}, so every chrome
 * icon is platform-stable authored art instead of per-platform emoji (the
 * problem the Mark system was built to solve; color emoji like 🚩 also broke
 * the brass monochrome).
 *
 * Shapes deliberately avoid the state-glyph silhouettes: the chrome banner is
 * swallow-tailed (awaiting is a triangular pennant), the chrome compass is a
 * ring-and-needle (stalled is a bare four-point diamond), so a glance never
 * reads furniture as status.
 */
import type { EmblemMark } from "./factions.js";

const VIEW = "0 0 24 24";

/** Anchor — the cove's own mark: health panel, session chips, quiet empties. */
export const MARK_ANCHOR: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  fillRule: "evenodd",
  path: [
    // Ring (with hole), shank, stock, and curved flukes as one silhouette.
    "M12 2a2.7 2.7 0 0 1 1.15 5.14V8.5h3.35v2.2h-3.35v7.4c2.62-.5 4.7-2.35 5.55-4.75l-1.95.6 3.1-4.65 1.65 5.35-1.75-.55C18.6 18.7 15.6 21.3 12 21.3s-6.6-2.6-7.75-7.2l-1.75.55 1.65-5.35 3.1 4.65-1.95-.6c.85 2.4 2.93 4.25 5.55 4.75v-7.4H7.5V8.5h3.35V7.14A2.7 2.7 0 0 1 12 2zm0 1.7a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1z",
  ],
};

/** Banner — swallow-tailed flag: inbox header, faction plates. */
export const MARK_BANNER: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    // Staff.
    "M5 2.5h2.2v19H5z",
    // Swallow-tailed fly.
    "M7.2 4H21l-4.2 4.3L21 12.6H7.2z",
  ],
};

/** Compass — ring and needle (inbox all-clear). Distinct from the stalled
 * state's bare diamond: this one wears its bezel. */
export const MARK_COMPASS: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  fillRule: "evenodd",
  path: [
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2.6a7.4 7.4 0 1 1 0 14.8 7.4 7.4 0 0 1 0-14.8z",
    // Four-point needle inside the bezel (a corner-to-corner bar reads as a
    // prohibition slash at 14px; the diamond reads as a rose).
    "M12 6.6l1.5 3.9 3.9 1.5-3.9 1.5-1.5 3.9-1.5-3.9L6.6 12l3.9-1.5z",
  ],
};

/** Scroll — rolled orders (the Brief's GOAL well). */
export const MARK_SCROLL: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    // Rolled left edge.
    "M5.4 3.8a3 3 0 0 1 3 3v10.4a3 3 0 1 1-6 0V6.8a3 3 0 0 1 3-3z",
    // Sheet, cut at the roll.
    "M9.6 3.8h11v12.4a3.4 3.4 0 0 1-3.4 3.4H8.3a4.4 4.4 0 0 0 1.3-3.2V3.8z",
  ],
};

/** Spark — concave four-point star (ornaments toggle, cartouche flanks).
 * Concave edges keep it apart from the stalled diamond's straight ones. */
export const MARK_SPARK: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: "M12 2c.65 5.9 4.1 9.35 10 10-5.9.65-9.35 4.1-10 10-.65-5.9-4.1-9.35-10-10 5.9-.65 9.35-4.1 10-10z",
};

/** Mallet — the chrome kit / dev-tools mark. */
export const MARK_MALLET: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    // Head.
    "M5.5 4h13a1.2 1.2 0 0 1 1.2 1.2v3.9a1.2 1.2 0 0 1-1.2 1.2h-13a1.2 1.2 0 0 1-1.2-1.2V5.2A1.2 1.2 0 0 1 5.5 4z",
    // Handle.
    "M10.9 11.5h2.2v8a1.1 1.1 0 0 1-2.2 0z",
  ],
};

/** Sloop — two sails and a hull: the fleet roster's mark. Fuller rig than the
 * running state's single triangle sail. */
export const MARK_SLOOP: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    // Mainsail (left of mast) and jib (right).
    "M11 3.2V14H3.8C4.6 9.2 7.3 5.3 11 3.2z",
    "M13.2 5V14h7.2c-.6-3.6-3-7-7.2-9z",
    // Hull.
    "M2.8 16.2h18.4L18.8 20H5.2z",
  ],
};

/** Spyglass — follow-the-logs toggle: kept trained on the stream. */
export const MARK_SPYGLASS: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    // Objective barrel (widest, at the top-right).
    "M14.7 3.4l5.9 5.9-2.3 2.3L12.4 5.7z",
    // Mid tube.
    "M11.2 6.9l5.9 5.9-3.4 3.4-5.9-5.9z",
    // Eyepiece.
    "M6.6 12.7l4.7 4.7-3.2 3.2a1.3 1.3 0 0 1-1.8 0l-2.9-2.9a1.3 1.3 0 0 1 0-1.8z",
  ],
};

/** Lens — the session Find toggle. */
export const MARK_LENS: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  fillRule: "evenodd",
  path: [
    "M10.4 2.8a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2zm0 2.6a5 5 0 1 1 0 10 5 5 0 0 1 0-10z",
    "M14.9 16.7l1.8-1.8 4.7 4.7-1.8 1.8z",
  ],
};

/** Ring — the chart-key toggle: a legend dot wearing its bezel. */
export const MARK_RING: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  fillRule: "evenodd",
  path: [
    "M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2zm0 2.6a7 7 0 1 1 0 14 7 7 0 0 1 0-14z",
    "M12 8.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6z",
  ],
};
