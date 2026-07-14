import { useEffect, useState } from "react";

import { Plate } from "../primitives/index.js";
import { weatherBucketAt, weatherForBucket } from "./day-chip-weather.js";

const WEATHER_CHECK_INTERVAL_MS = 30 * 1000;

export interface DayChipProps {
  /** Flavour "day number" the cove has been open (real elapsed days is fine). */
  day: number;
  /** Wall-clock string, e.g. "14:32". */
  clock: string;
}

/**
 * Layer 2 — the day/weather chip (design-manifest §4.4). Pure flavour beside a
 * real clock; the decorative weather rotates deterministically every five minutes.
 */
export function DayChip({ day, clock }: DayChipProps) {
  const [weatherBucket, setWeatherBucket] = useState(weatherBucketAt);
  const weather = weatherForBucket(weatherBucket);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setWeatherBucket((currentBucket) => {
        const nextBucket = weatherBucketAt();
        return nextBucket === currentBucket ? currentBucket : nextBucket;
      });
    }, WEATHER_CHECK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <Plate padded={false}>
      <div className="pc-daychip">
        <div className="pc-daychip__row">
          <span className="pc-daychip__day">Day {day}</span>
          <span aria-hidden="true" style={{ color: "var(--ink-dot)" }}>
            ·
          </span>
          <span className="pc-daychip__clock">{clock}</span>
        </div>
        <div className="pc-daychip__weather">
          <span aria-hidden="true">{weather.icon}</span>
          <span>{weather.condition}</span>
          <span className="pc-daychip__wind">· {weather.wind}</span>
        </div>
      </div>
    </Plate>
  );
}
