export const WEATHER_BUCKET_MS = 5 * 60 * 1000;

export interface DayChipWeather {
  icon: string;
  condition: string;
  wind: string;
}

const WEATHER_ENTRIES: readonly DayChipWeather[] = [
  { icon: "🌤️", condition: "Fair over the cove", wind: "NE 8kn" },
  { icon: "🌧️", condition: "Squall rolling in", wind: "SW 14kn" },
  { icon: "🌊", condition: "Glass calm", wind: "— 0kn" },
  { icon: "🌫️", condition: "Fog off the point", wind: "N 3kn" },
  { icon: "☀️", condition: "Sun on the harbour", wind: "E 6kn" },
  { icon: "⛅", condition: "Clouds over the shoals", wind: "NW 10kn" },
  { icon: "🌬️", condition: "Fresh breeze", wind: "SE 12kn" },
  { icon: "🌙", condition: "Clear beyond the reef", wind: "W 5kn" },
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
