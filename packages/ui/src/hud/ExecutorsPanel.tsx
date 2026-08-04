import type { CSSProperties } from "react";
import { Mark, Plate, PlateHeader } from "../primitives/index.js";
import { MARK_COMPASS } from "../tokens/chrome-glyphs.js";
import { executorStatusLabel, type ExecutorCardView } from "../app/hooks/executors.js";

export interface ExecutorsPanelProps {
  /**
   * Fully-projected executor cards (daemon first, then runners). Hooks layer
   * owns fleet poll + in-flight derivation; this plate is display-only.
   */
  executors: ExecutorCardView[];
  /**
   * True before the first runners poll has resolved. Distinguishes "taking
   * soundings" from a fleet with only the daemon card.
   */
  connecting?: boolean;
  /**
   * True when `GET /runners` is failing after (or without) a successful poll.
   * Last-known cards stay visible but the plate marks presence as stale —
   * never claims live ONLINE from a dead probe (#324 F2).
   */
  stale?: boolean;
}

function statusChipStyle(status: ExecutorCardView["status"]): CSSProperties {
  const color =
    status === "connecting"
      ? "var(--brass-soft)"
      : status === "online"
        ? "var(--healthy-dot)"
        : status === "stale"
          ? "var(--state-stalled)"
          : "var(--state-failed)";
  return {
    "--exec-chip-color": color,
    "--dot-color": status === "connecting" ? "var(--brass-frame)" : color,
  } as CSSProperties;
}

function ExecutorCard({ card }: { card: ExecutorCardView }) {
  const chipLabel = executorStatusLabel(card.status);
  const showVendors = card.vendors.length > 0;
  const vendorsLabel = showVendors ? card.vendors.join(", ") : "";
  const inFlightLabel =
    card.inFlight === 1 ? "1 in flight" : `${card.inFlight} in flight`;
  const kindLabel = card.kind === "daemon" ? "daemon" : "runner";

  return (
    <article
      className={`pc-exec-card pc-exec-card--${card.kind}${
        card.status === "offline" || card.status === "stale"
          ? " pc-exec-card--dim"
          : ""
      }`}
      data-executor={card.id}
      data-status={card.status}
      data-testid={`executor-card-${card.id}`}
    >
      <header className="pc-exec-card__head">
        <span className="pc-exec-card__identity">
          <span className="pc-exec-card__name">{card.label}</span>
          <span className="pc-exec-card__kind">{kindLabel}</span>
        </span>
        <span
          className={`pc-exec-chip${
            card.status === "connecting" ? " pc-exec-chip--connecting" : ""
          }`}
          style={statusChipStyle(card.status)}
          aria-label={`${card.label} ${chipLabel.toLowerCase()}`}
        >
          <span
            className={`pc-dot${card.status === "online" ? " pc-dot--beacon" : ""}`}
          />
          {chipLabel}
        </span>
      </header>
      <div className="pc-exec-card__body">
        {/* Vendors only when known — no permanent dead "—" on the daemon card (#324 F3). */}
        {showVendors && (
          <span className="pc-exec-card__row">
            <span className="pc-exec-card__k">Vendors</span>
            <span className="pc-exec-card__v" title={vendorsLabel}>
              {vendorsLabel}
            </span>
          </span>
        )}
        <span className="pc-exec-card__row">
          <span className="pc-exec-card__k">In flight</span>
          <span
            className="pc-exec-card__v pc-exec-card__v--count"
            data-testid={`executor-inflight-${card.id}`}
          >
            {inFlightLabel}
          </span>
        </span>
      </div>
    </article>
  );
}

/**
 * Layer 2 — the executors panel (#324). Plain props only: status stack plate
 * listing every physical place work can run — the daemon host (`local`) plus
 * each registered runner — with live presence, vendor ids, and in-flight
 * counts. Matches HealthPanel density so the right rail stays scannable.
 */
export function ExecutorsPanel({
  executors,
  connecting = false,
  stale = false,
}: ExecutorsPanelProps) {
  const onlineCount = executors.filter((e) => e.status === "online").length;
  const subtitle = connecting
    ? "sounding the fleet…"
    : stale
      ? "presence may be stale — reconnecting…"
      : executors.length === 1
        ? "daemon host only"
        : `${onlineCount} online · ${executors.length} total`;

  // One live region for the whole plate (not per card) — screen readers get a
  // single fleet summary when presence shifts (#324 F5).
  const liveSummary = connecting
    ? "Sounding the executor fleet"
    : stale
      ? `Executor presence may be stale. Last known: ${executors.length} executor${
          executors.length === 1 ? "" : "s"
        }.`
      : executors.length === 1
        ? "Daemon host only"
        : `${onlineCount} of ${executors.length} executors online`;

  return (
    <Plate
      padded={false}
      className={`pc-executors${stale ? " pc-executors--stale" : ""}`}
    >
      <PlateHeader
        icon={<Mark mark={MARK_COMPASS} size={14} />}
        title="EXECUTORS"
        subtitle={subtitle}
        divider
      />
      {/* Single polite live region for the fleet (not per card) — #324 F5. */}
      <div
        className="pc-visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="executors-live"
      >
        {liveSummary}
      </div>
      <div
        className="pc-plate__body pc-executors__body"
        data-testid="executors-list"
        data-stale={stale ? "true" : undefined}
      >
        {executors.length === 0 ? (
          <p className="pc-executors__empty">No executors reported.</p>
        ) : (
          <ul className="pc-executors__list">
            {executors.map((card) => (
              <li key={card.id}>
                <ExecutorCard card={card} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Plate>
  );
}
