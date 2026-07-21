/*
 * Layer 0 — task identity data. Model vendor supplies the authored mark while
 * the harness supplies its colour. Keeping those lookups separate is
 * intentional: any model can sail under any adapter's colours.
 */

export type EmblemMark =
  | { kind: "glyph"; char: string }
  | {
      kind: "svg";
      viewBox: string;
      path: string | readonly string[];
      fillRule?: "evenodd" | "nonzero";
    };

export interface VendorEmblem {
  label: string;
  emblem: EmblemMark;
}

export interface HarnessColor {
  label: string;
  coat: string;
  coatDark: string;
}

const svg = (path: string, fillRule?: "evenodd" | "nonzero"): EmblemMark => ({
  kind: "svg",
  viewBox: "0 0 24 24",
  path,
  ...(fillRule ? { fillRule } : {}),
});

const MARK_CODEX = svg(
  "M12 2.2 20.8 7.3v9.4L12 21.8l-8.8-5.1V7.3zM12 6.4 7.3 9.1v5.8l4.7 2.7 4.7-2.7V9.1z",
  "evenodd",
);
const MARK_GROK = svg("M5 3.8h3.6l3.4 5.6 3.4-5.6H19L13.6 12l5.4 8.2h-3.6L12 14.6l-3.4 5.6H5l5.4-8.2z");
const MARK_CLAUDE = svg("M12 2.8l2.1 6.3 6.6-1.6-5.2 4.5 5.2 4.5-6.6-1.6L12 21.2l-2.1-6.3-6.6 1.6 5.2-4.5-5.2-4.5 6.6 1.6z");
const MARK_KIMI = svg("M5 3.5h3.2v6.8l6.5-6.8h4.1l-7.2 7.4 7.7 9.6h-4.1l-5.8-7.3-1.2 1.2v6.1H5z");
const MARK_QWEN = svg("M12 3a9 9 0 1 0 6.4 15.3l2.3 2.3 1.4-1.4-2.3-2.3A9 9 0 0 0 12 3zm0 3a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm2.2 7.2 1.6 1.6-1.4 1.4-1.6-1.6z", "evenodd");

/** Authored model-maker marks. Aliases deliberately share a mark. */
export const VENDOR_EMBLEMS: Record<string, VendorEmblem> = {
  gpt: { label: "GPT", emblem: MARK_CODEX },
  openai: { label: "OpenAI", emblem: MARK_CODEX },
  codex: { label: "Codex", emblem: MARK_CODEX },
  claude: { label: "Claude", emblem: MARK_CLAUDE },
  anthropic: { label: "Anthropic", emblem: MARK_CLAUDE },
  grok: { label: "Grok", emblem: MARK_GROK },
  kimi: { label: "Kimi", emblem: MARK_KIMI },
  moonshot: { label: "Moonshot", emblem: MARK_KIMI },
  qwen: { label: "Qwen", emblem: MARK_QWEN },
  alibaba: { label: "Alibaba", emblem: MARK_QWEN },
  pi: { label: "Pi", emblem: { kind: "glyph", char: "π" } },
};

export const UNKNOWN_VENDOR: VendorEmblem = {
  label: "Unknown vendor",
  emblem: { kind: "glyph", char: "?" },
};

/**
 * Adapter colours chosen across hue and lightness, with darker companion ink
 * for the sail mark. None reuse the reserved task-state token values.
 */
export const HARNESS_COLORS: Record<string, HarnessColor> = {
  fake: { label: "Fake", coat: "#A69B8D", coatDark: "#554D44" },
  codex: { label: "Codex", coat: "#18A886", coatDark: "#08634F" },
  grok: { label: "Grok", coat: "#59616F", coatDark: "#282D35" },
  claude: { label: "Claude", coat: "#D1784C", coatDark: "#783A21" },
  gemini: { label: "Gemini", coat: "#4D8CE8", coatDark: "#244E91" },
  kilo: { label: "Kilo", coat: "#D64E80", coatDark: "#7C2446" },
  goose: { label: "Goose", coat: "#B99435", coatDark: "#665019" },
  openclaw: { label: "OpenClaw", coat: "#D65A45", coatDark: "#7E2A20" },
  cline: { label: "Cline", coat: "#25A6B5", coatDark: "#11616B" },
  openhands: { label: "OpenHands", coat: "#A66BD0", coatDark: "#5E347C" },
  opencode: { label: "OpenCode", coat: "#80A83D", coatDark: "#465F1D" },
  hermes: { label: "Hermes", coat: "#D18B2F", coatDark: "#754912" },
  pi: { label: "Pi", coat: "#7567D8", coatDark: "#40358D" },
  kimi: { label: "Kimi", coat: "#39A06F", coatDark: "#1A5B3D" },
};

export const UNKNOWN_HARNESS: HarnessColor = {
  label: "Unknown harness",
  coat: "#FFFFFF",
  coatDark: "#5B3A24",
};

function normalized(value: string | null | undefined): string | null {
  const key = value?.trim().toLowerCase();
  return key || null;
}

export function vendorEmblemFor(vendor: string | null | undefined): VendorEmblem {
  const key = normalized(vendor);
  return key ? VENDOR_EMBLEMS[key] ?? UNKNOWN_VENDOR : UNKNOWN_VENDOR;
}

export function harnessColorFor(harness: string | null | undefined): HarnessColor {
  const key = normalized(harness);
  return key ? HARNESS_COLORS[key] ?? UNKNOWN_HARNESS : UNKNOWN_HARNESS;
}

/** @deprecated Compatibility for non-task kit/legend consumers. */
export const FACTIONS = Object.fromEntries(
  ["gpt", "claude", "grok", "kimi", "qwen", "pi"].map((key) => {
    const vendor = VENDOR_EMBLEMS[key]!;
    return [
    key,
    { ...vendor, ...UNKNOWN_HARNESS, label: vendor.label, tagline: `${vendor.label} model-maker emblem.` },
    ];
  }),
);
