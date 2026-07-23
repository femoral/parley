import { useEffect, useState } from "react";

import { Mark, Plate } from "../primitives/index.js";
import { weatherBucketAt, weatherForBucket } from "./day-chip-weather.js";

const WEATHER_CHECK_INTERVAL_MS = 30 * 1000;

export interface DayChipProps {
  /**
   * Browser-local Cove tenure in whole days (min 1).
   */
  day: number;
  /** Daemon process uptime in whole days (min 1), shown honestly in the title. */
  daemonUptimeDays: number;
  /** Wall-clock string, e.g. "14:32". */
  clock: string;
}

/**
 * Layer 2 — the day/weather chip (design-manifest §4.4). Cove-tenure "days at
 * sea" beside a real clock; the decorative weather rotates deterministically
 * every five minutes.
 */
export function DayChip({ day, daemonUptimeDays, clock }: DayChipProps) {
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

  const dayTitle =
    daemonUptimeDays === 1
      ? "Daemon up 1 day"
      : `Daemon up ${daemonUptimeDays} days`;
  // Optional bearing ("NE 8kn") or bare speed ("0kn") — always mono the kn token.
  const windParts = weather.wind.match(/^(?:(.+)\s)?(\d+kn)$/);

  return (
    <Plate padded={false}>
      <div className="pc-daychip">
        <div className="pc-daychip__row">
          <span className="pc-daychip__day" title={dayTitle}>
            Day <span className="pc-daychip__day-number">{day}</span> at sea
          </span>
          <span aria-hidden="true" style={{ color: "var(--ink-dot)" }}>
            ·
          </span>
          <span className="pc-daychip__clock">{clock}</span>
        </div>
        <div className="pc-daychip__weather">
          <span className="pc-daychip__weather-icon" aria-hidden="true">
            <Mark mark={weather.mark} size={12} />
          </span>
          <span>{weather.condition}</span>
          <span className="pc-daychip__wind">
            ·{" "}
            {windParts?.[1] ? `${windParts[1]} ` : null}
            {windParts ? (
              <span className="pc-daychip__wind-speed">{windParts[2]}</span>
            ) : (
              weather.wind
            )}
          </span>
        </div>
      </div>
    </Plate>
  );
}
