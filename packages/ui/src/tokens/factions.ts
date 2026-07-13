/*
 * Layer 0 — the faction registry (component-system spec §Layers). A vendor is a
 * faction: `{ label, coat, coatDark, emblem, tagline }` (design-manifest §2.7).
 * Adding a vendor is one record here and zero new art — emblems are glyphs.
 *
 * This layer holds design data only; it never imports `@useparley/core` (that is
 * the hooks layer's job). The hooks layer maps a task's `vendor` string through
 * `factionFor` and hands the plate a plain faction record.
 */
export interface Faction {
  /** Human faction name, e.g. "Cartographers' Guild". */
  label: string;
  /** Coat colour — the one loud hue per element (hex). */
  coat: string;
  /** Darker coat, for waterlines / hulls / dark tints (hex). */
  coatDark: string;
  /** Single-glyph emblem worn on the chip. */
  emblem: string;
  /** IM Fell italic flavour line. */
  tagline: string;
}

/** The seeded vendors (design-manifest §2.7). Extend by adding a record. */
export const FACTIONS: Record<string, Faction> = {
  codex: {
    label: "Cartographers' Guild",
    coat: "#2f5fb0",
    coatDark: "#20437e",
    emblem: "⚓", // ⚓
    tagline: "Chart the unknown.",
  },
  grok: {
    label: "Crimson Company",
    coat: "#c0392b",
    coatDark: "#8a241a",
    emblem: "⚔", // ⚔
    tagline: "Solve it with steel.",
  },
  pi: {
    label: "Tidewatch",
    coat: "#1f9e7d",
    coatDark: "#137a5f",
    emblem: "☾", // ☾
    tagline: "Guardians of the current.",
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
  emblem: "⚐", // ⚐ white flag
  tagline: "Sailing under no colours yet.",
};

/** Resolve a vendor id to its faction, falling back to {@link UNALIGNED}. */
export function factionFor(vendor: string | null | undefined): Faction {
  if (vendor && Object.prototype.hasOwnProperty.call(FACTIONS, vendor)) {
    return FACTIONS[vendor] as Faction;
  }
  return UNALIGNED;
}
