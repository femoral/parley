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

const svg = (
  path: string | readonly string[],
  fillRule?: "evenodd" | "nonzero",
  viewBox = "0 0 24 24",
): EmblemMark => ({
  kind: "svg",
  viewBox,
  path,
  ...(fillRule ? { fillRule } : {}),
});

/** Authored maker marks trace the vendors' own logos (via simple-icons /
 * Wikimedia Commons SVGs) rather than invented glyphs, so the sail is
 * recognisable at a glance. */
const MARK_CODEX = svg(
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
);
const MARK_GROK = svg(
  [
    "M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436",
    "M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341",
  ],
  undefined,
  "0 0 34 33",
);
const MARK_CLAUDE = svg(
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
);
// The authored path's own bbox runs edge-to-edge on a 24x24 canvas, but its
// ink is lopsided: the "K" body carries the visual weight bottom-left while
// the accent dot is a small counterweight top-right, so a raw 0-24 viewBox
// reads as bottom-left-heavy. This viewBox is offset/enlarged to center the
// ink's visual mass instead of its coordinate bounds.
const MARK_KIMI = svg(
  "M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441",
  undefined,
  "-4.1 0.35 28.1 26.3",
);
const MARK_QWEN = svg(
  "M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z",
);

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

/**
 * Neutral privateer coat for adapters not in {@link HARNESS_COLORS}.
 * Brass-frame (not white): white-on-white used to blank the emblem mark
 * (`--ink-on-coat` is white) and flash the loudest chip on the dark plate.
 * Same family as ChartKey's model-mark chips / faction-unaligned.
 */
export const UNKNOWN_HARNESS: HarnessColor = {
  label: "Unknown harness",
  coat: "#8A6A34",
  coatDark: "#5B3A24",
};

/** Canonical model-maker records for legends and model-name classification. */
export const MODEL_VENDORS = {
  gpt: VENDOR_EMBLEMS.gpt!,
  claude: VENDOR_EMBLEMS.claude!,
  grok: VENDOR_EMBLEMS.grok!,
  kimi: VENDOR_EMBLEMS.kimi!,
  qwen: VENDOR_EMBLEMS.qwen!,
} as const;

const MODEL_MAKER_HINTS: readonly [VendorEmblem, readonly string[]][] = [
  [MODEL_VENDORS.gpt, ["gpt", "chatgpt", "openai", "codex", "o1", "o3", "o4"]],
  [MODEL_VENDORS.claude, ["claude", "anthropic"]],
  [MODEL_VENDORS.grok, ["grok", "xai"]],
  [MODEL_VENDORS.kimi, ["kimi", "moonshot"]],
  [MODEL_VENDORS.qwen, ["qwen", "alibaba", "dashscope"]],
];

function normalized(value: string | null | undefined): string | null {
  const key = value?.trim().toLowerCase();
  return key || null;
}

export function vendorEmblemFor(vendor: string | null | undefined): VendorEmblem {
  const key = normalized(vendor);
  return key ? VENDOR_EMBLEMS[key] ?? UNKNOWN_VENDOR : UNKNOWN_VENDOR;
}

/**
 * Resolve the maker from a model id, then fall back to an adapter alias when
 * the model is absent or opaque. The latter keeps direct Grok/Claude adapters
 * useful without pretending a generic adapter such as OpenCode is a maker.
 */
export function modelVendorFor(
  model: string | null | undefined,
  fallbackVendor?: string | null,
): VendorEmblem {
  const key = normalized(model);
  if (key) {
    for (const [vendor, hints] of MODEL_MAKER_HINTS) {
      if (hints.some((hint) => key.includes(hint))) return vendor;
    }
  }
  return vendorEmblemFor(fallbackVendor);
}

export function harnessColorFor(harness: string | null | undefined): HarnessColor {
  const key = normalized(harness);
  return key ? HARNESS_COLORS[key] ?? UNKNOWN_HARNESS : UNKNOWN_HARNESS;
}
