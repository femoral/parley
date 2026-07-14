/*
 * Layer 0 — the faction registry (component-system spec §Layers). A vendor is a
 * faction: `{ label, coat, coatDark, emblem, tagline }` (design-manifest §2.7).
 * Adding a vendor is one record here and zero new art — emblems are original
 * marks (unicode glyphs or authored SVG path data), never fetched brand assets.
 *
 * This layer holds design data only; it never imports `@useparley/core` (that is
 * the hooks layer's job). The hooks layer maps a task's `vendor` string through
 * `factionFor` and hands the plate a plain faction record.
 */

/**
 * A faction mark worn on the emblem chip and the sloop sail.
 * - `glyph` — a single unicode character (fallback / simple letterforms).
 * - `svg` — original path data in a square viewBox (evocative, not trademark art).
 */
export type EmblemMark =
  | { kind: "glyph"; char: string }
  | {
      kind: "svg";
      /** Square viewBox, e.g. "0 0 24 24". */
      viewBox: string;
      /** Path `d` attribute(s) — filled with the chip's light mark color. */
      path: string | readonly string[];
      fillRule?: "evenodd" | "nonzero";
    };

export interface Faction {
  /** Human faction name, e.g. "Codex". */
  label: string;
  /** Coat colour — the one loud hue per element (hex). */
  coat: string;
  /** Darker coat, for waterlines / hulls / dark tints (hex). */
  coatDark: string;
  /** Emblem mark worn on the chip (glyph or original SVG path data). */
  emblem: EmblemMark;
  /** IM Fell italic flavour line. */
  tagline: string;
}

/**
 * Original marks — deliberately evocative of each vendor, not pixel-perfect
 * logos. Authored in-repo; never fetched or copied from brand kits.
 *
 * - Codex: hexagonal knot ring (OpenAI-ish geometry, simplified).
 * - Grok: bold X letterform (xAI-ish).
 * - Pi: the π letterform as a glyph (Inflection Pi).
 */
const MARK_CODEX: EmblemMark = {
  kind: "svg",
  viewBox: "0 0 24 24",
  // Outer hex + inner hex → ring via evenodd. Original hexagonal knot motif.
  path: "M12 2.2 L20.8 7.3 V16.7 L12 21.8 L3.2 16.7 V7.3 Z M12 6.4 L16.7 9.1 V14.9 L12 17.6 L7.3 14.9 V9.1 Z",
  fillRule: "evenodd",
};

const MARK_GROK: EmblemMark = {
  kind: "svg",
  viewBox: "0 0 24 24",
  // Stylized X — two thick diagonals as a single letterform silhouette.
  path: "M5 3.8h3.6L12 9.4l3.4-5.6H19L13.6 12 19 20.2h-3.6L12 14.6l-3.4 5.6H5L10.4 12 5 3.8z",
};

const MARK_PI: EmblemMark = {
  kind: "glyph",
  char: "π",
};

/** The seeded vendors (design-manifest §2.7). Extend by adding a record. */
export const FACTIONS: Record<string, Faction> = {
  codex: {
    label: "Codex",
    // OpenAI-characteristic green (coat) + deeper hull tint.
    coat: "#10a37f",
    coatDark: "#0b7359",
    emblem: MARK_CODEX,
    tagline: "Green helm. Open charts.",
  },
  grok: {
    label: "Grok",
    // Lifted near-black so the chip still reads on dark sea backgrounds.
    coat: "#2b2b2e",
    coatDark: "#141416",
    emblem: MARK_GROK,
    tagline: "Truth under black canvas.",
  },
  pi: {
    label: "Pi",
    // Inflection Pi purple — distinct from Codex green and Grok charcoal.
    coat: "#6c5ce7",
    coatDark: "#4a3db8",
    emblem: MARK_PI,
    tagline: "A personal current.",
  },
};

/**
 * The faction for an unrecognised (or absent) vendor: a neutral brass privateer,
 * so a brand-new vendor still renders sensibly before it earns a record.
 */
export const UNALIGNED: Faction = {
  label: "Unaligned",
  coat: "#8a6a34",
  coatDark: "#5b3a24",
  emblem: { kind: "glyph", char: "⚐" },
  tagline: "Sailing under no colours yet.",
};

/** Resolve a vendor id to its faction, falling back to {@link UNALIGNED}. */
export function factionFor(vendor: string | null | undefined): Faction {
  if (vendor && Object.prototype.hasOwnProperty.call(FACTIONS, vendor)) {
    return FACTIONS[vendor] as Faction;
  }
  return UNALIGNED;
}
