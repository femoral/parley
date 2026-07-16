import type { EmblemMark } from "../tokens/factions.js";

export const WEATHER_BUCKET_MS = 5 * 60 * 1000;

export interface DayChipWeather {
  /** Authored micro-SVG weather mark (currentColor; DayChip tints via parent). */
  mark: EmblemMark;
  condition: string;
  wind: string;
}

const VIEW = "0 0 24 24";

/** Fair — sun peeking from behind a cloud. */
const MARK_FAIR: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    // Sun disc (upper right).
    "M16.5 5.5a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4z",
    // Cloud body.
    "M5 15.5c0-2.4 1.9-4.3 4.3-4.3 0.7 0 1.4 0.2 2 0.5 0.7-1.5 2.2-2.5 4-2.5 2.4 0 4.3 1.9 4.3 4.3 0 0.2 0 0.4-0.05 0.6H5.1c-0.05-0.2-0.1-0.4-0.1-0.6z",
  ],
};

/** Rain — cloud with rain bars. */
const MARK_RAIN: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    "M4.5 11.2c0-2.3 1.8-4.1 4.1-4.1 0.6 0 1.2 0.15 1.7 0.4 0.7-1.6 2.3-2.7 4.2-2.7 2.5 0 4.5 2 4.5 4.5 0 0.2 0 0.35-0.03 0.5H4.55c-0.03-0.15-0.05-0.3-0.05-0.5z",
    "M8 15.2h1.6v5.2H8z M12 16h1.6v5.2H12z M16 15.2h1.6v5.2H16z",
  ],
};

/** Glass calm — simple wave. */
const MARK_WAVE: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: "M2.5 13c1.8-2.2 3.6-3.3 5.5-3.3 1.9 0 3.2 1.1 4.5 2.2 1.3 1.1 2.6 2.2 4.5 2.2 1.9 0 3.7-1.1 5.5-3.3v3.2c-1.8 2.2-3.6 3.3-5.5 3.3-1.9 0-3.2-1.1-4.5-2.2-1.3-1.1-2.6-2.2-4.5-2.2-1.9 0-3.7 1.1-5.5 3.3V13z",
};

/** Fog — three soft bars. */
const MARK_FOG: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    "M3.5 8h17v2.4H3.5z",
    "M5.5 12h13v2.4h-13z",
    "M4.5 16h15v2.4h-15z",
  ],
};

/** Sun — bold disc with rays. */
const MARK_SUN: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    "M12 7.2a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6z",
    // Cardinal rays as short bars.
    "M11 2h2v3.2h-2z M11 18.8h2V22h-2z M2 11h3.2v2H2z M18.8 11H22v2h-3.2z",
  ],
};

/** Clouds over the shoals — single cloud. */
const MARK_CLOUD: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: "M6.2 15.5c-2 0-3.7-1.6-3.7-3.6 0-1.8 1.3-3.3 3-3.6 0.6-2.2 2.6-3.8 5-3.8 2.2 0 4.1 1.3 4.9 3.2 0.4-0.15 0.85-0.25 1.3-0.25 2.2 0 4 1.8 4 4 0 0.2 0 0.35-0.03 0.5H6.25c-0.03-0.15-0.05-0.3-0.05-0.5 0 0.35 0 0.7 0 1.05z",
};

/** Fresh breeze — wind lines. */
const MARK_WIND: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  path: [
    "M3 7.5h12.5c1.5 0 2.7 1.2 2.7 2.7S17 13 15.5 13H14v-2.2h1.5c0.3 0 0.5-0.2 0.5-0.5s-0.2-0.5-0.5-0.5H3V7.5z",
    "M3 14h10.5c1.2 0 2.2 1 2.2 2.2S14.7 18.4 13.5 18.4H12v-2.2h1.5c0.1 0 0.2-0.1 0.2-0.2s-0.1-0.2-0.2-0.2H3V14z",
  ],
};

/** Clear night — crescent moon. */
const MARK_MOON: EmblemMark = {
  kind: "svg",
  viewBox: VIEW,
  fillRule: "evenodd",
  // Outer disc minus offset disc → crescent.
  path: "M14.2 3.2A9 9 0 1 0 20.5 14.5 7.2 7.2 0 0 1 14.2 3.2z",
};

const WEATHER_ENTRIES: readonly DayChipWeather[] = [
  { mark: MARK_FAIR, condition: "Fair over the cove", wind: "NE 8kn" },
  { mark: MARK_RAIN, condition: "Squall rolling in", wind: "SW 14kn" },
  { mark: MARK_WAVE, condition: "Glass calm", wind: "— 0kn" },
  { mark: MARK_FOG, condition: "Fog off the point", wind: "N 3kn" },
  { mark: MARK_SUN, condition: "Sun on the harbour", wind: "E 6kn" },
  { mark: MARK_CLOUD, condition: "Clouds over the shoals", wind: "NW 10kn" },
  { mark: MARK_WIND, condition: "Fresh breeze", wind: "SE 12kn" },
  { mark: MARK_MOON, condition: "Clear beyond the reef", wind: "W 5kn" },
];

/** Return the current five-minute wall-clock bucket. */
export function weatherBucketAt(timestamp = Date.now()): number {
  return Math.floor(timestamp / WEATHER_BUCKET_MS);
}

/** Deterministically choose decorative weather using only the time bucket. */
export function weatherForBucket(bucket: number): DayChipWeather {
  let hash = bucket | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash ^= hash >>> 16;

  return WEATHER_ENTRIES[(hash >>> 0) % WEATHER_ENTRIES.length]!;
}
