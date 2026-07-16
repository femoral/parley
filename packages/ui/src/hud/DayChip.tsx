import { useEffect, useState } from "react";

import { Plate } from "../primitives/index.js";
import { weatherBucketAt, weatherForBucket } from "./day-chip-weather.js";

const WEATHER_CHECK_INTERVAL_MS = 30 * 1000;

export interface DayChipProps {
  /**
   * Daemon uptime in whole days (min 1), projected from `/health` `started_at`
   * in `useCockpit` — flavour "days at sea", not a calendar session day.
   */
  day: number;
  /** Wall-clock string, e.g. "14:32". */
  clock: string;
}

/**
 * Layer 2 — the day/weather chip (design-manifest §4.4). Daemon-uptime "days
 * at sea" beside a real clock; the decorative weather rotates deterministically
 * every five minutes.
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

  const dayTitle = day === 1 ? "Daemon up 1 day" : `Daemon up ${day} days`;

  return (
    <Plate padded={false}>
      <div className="pc-daychip">
        <div className="pc-daychip__row">
          <span className="pc-daychip__day" title={dayTitle}>
            Day {day} at sea
          </span>
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
