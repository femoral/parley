import { Plate } from "../primitives/index.js";

export interface DayChipProps {
  /** Flavour "day number" the cove has been open (real elapsed days is fine). */
  day: number;
  /** Wall-clock string, e.g. "14:32". */
  clock: string;
}

/**
 * Layer 2 — the day/weather chip (design-manifest §4.4). Pure flavour beside a
 * real clock; the weather line is decorative and fixed for v1.
 */
export function DayChip({ day, clock }: DayChipProps) {
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
          <span aria-hidden="true">🌤️</span>
          <span>Fair over the cove</span>
          <span className="pc-daychip__wind">· NE 8kn</span>
        </div>
      </div>
    </Plate>
  );
}
