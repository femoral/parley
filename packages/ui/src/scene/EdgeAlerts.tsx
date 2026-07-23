import type { CSSProperties } from "react";
import { Mark } from "../primitives/index.js";
import { stateMetaFor } from "../tokens/state-meta.js";

/** How many per-side session chips render before the overflow "+N" chip. */
export const EDGE_ALERT_STACK_CAP = 3;

export type EdgeAlertSide = "left" | "right";

/** One off-camera region surfaced at the viewport edge. */
export interface EdgeAlertItem {
  /** Named session id, or `null` for the open-water region (no roster filter). */
  sessionId: string | null;
  /** Short session label (matches the region banner). */
  label: string;
  /**
   * Loudest edge-attention state on that session (hooks rollup), or unused
   * when {@link quiet} — calm presence chips carry task count only.
   */
  state: string;
  /** Count of tasks in that loudest state, or total tasks when quiet. */
  count: number;
  /**
   * Core attention rank from the hooks rollup (lower = louder).
   * Quiet chips use a sentinel rank so they always stack after attention.
   */
  rank: number;
  /** Which horizontal edge the region lies on relative to the framed one. */
  side: EdgeAlertSide;
  /**
   * Calm off-frame presence (no attention rollup). Whisper chrome: neutral
   * ink, no state glyph/colour. Still frames the region on click.
   */
  quiet?: boolean;
}

export interface EdgeAlertsProps {
  /** Off-camera items, already ordered loudest-first per side (attention then quiet). */
  items: EdgeAlertItem[];
  /**
   * Activates the region represented by a clicked chip. Named sessions receive
   * their id (roster select + camera sail). Open water receives `null` so the
   * scene can pan without setting a roster session filter.
   */
  onSelectSession: (sessionId: string | null) => void;
}

/** Prose phrase for the accessible label — never colour alone (PRODUCT.md a11y). */
function attentionProse(state: string, count: number): string {
  switch (state) {
    case "awaiting_answer":
      return count === 1 ? "1 awaiting answer" : `${count} awaiting answer`;
    case "stalled":
      return count === 1 ? "1 stalled" : `${count} stalled`;
    case "failed":
      return count === 1 ? "1 failed" : `${count} failed`;
    default:
      return `${count} ${state}`;
  }
}

function quietProse(count: number): string {
  return count === 1 ? "1 task" : `${count} tasks`;
}

function edgeChipKey(item: EdgeAlertItem): string {
  return item.sessionId ?? "open-water";
}

function EdgeAlertButton({
  item,
  onSelectSession,
}: {
  item: EdgeAlertItem;
  onSelectSession: (sessionId: string | null) => void;
}) {
  const quiet = item.quiet === true;
  const direction = item.side === "left" ? "to the left" : "to the right";
  const chevron = item.side === "left" ? "◀" : "▶";
  // Named sessions keep the "Session …" head; open water uses its in-register label.
  const head = item.sessionId === null ? item.label : `Session ${item.label}`;
  const prose = quiet ? quietProse(item.count) : attentionProse(item.state, item.count);

  if (quiet) {
    return (
      <button
        type="button"
        className="pc-edge-alert pc-edge-alert--quiet"
        aria-label={`${head} — ${prose}, ${direction}`}
        onClick={() => onSelectSession(item.sessionId)}
      >
        {item.side === "left" && (
          <span className="pc-edge-alert__chevron" aria-hidden="true">
            {chevron}
          </span>
        )}
        {/* Visible payload: "label · count" whisper (no state glyph/colour). */}
        <span className="pc-edge-alert__label" aria-hidden="true">
          {item.label}
        </span>
        <span className="pc-edge-alert__dot" aria-hidden="true">
          ·
        </span>
        <span className="pc-edge-alert__count" aria-hidden="true">
          {item.count}
        </span>
        {item.side === "right" && (
          <span className="pc-edge-alert__chevron" aria-hidden="true">
            {chevron}
          </span>
        )}
      </button>
    );
  }

  const meta = stateMetaFor(item.state);
  const style = { "--edge-state": meta.colorVar } as CSSProperties;
  const className = [
    "pc-edge-alert",
    meta.beacon ? "pc-edge-alert--beacon" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={className}
      style={style}
      aria-label={`${head} — ${prose}, ${direction}`}
      onClick={() => onSelectSession(item.sessionId)}
    >
      {item.side === "left" && (
        <span className="pc-edge-alert__chevron" aria-hidden="true">
          {chevron}
        </span>
      )}
      <span className="pc-edge-alert__glyph" aria-hidden="true">
        <Mark mark={meta.mark} size={13} />
      </span>
      {/* Visible payload: session label + count. aria-label keeps the fuller
          prose; these must not contradict it (label and count are the same). */}
      <span className="pc-edge-alert__label" aria-hidden="true">
        {item.label}
      </span>
      <span className="pc-edge-alert__count" aria-hidden="true">
        {item.count}
      </span>
      {item.side === "right" && (
        <span className="pc-edge-alert__chevron" aria-hidden="true">
          {chevron}
        </span>
      )}
    </button>
  );
}

/**
 * Layer 3 — edge-of-frame chips (PRODUCT.md "a single glance answers:
 * is anything wrong?" + fleet presence). Attention chips for awaiting /
 * stalled / failed work stay loud; quiet chips whisper for calm off-camera
 * regions so a second coast is never invisible on the sea. Prop-driven and
 * core-free: the app projects the rollup, Scene decides side + stack order,
 * this component only paints the chrome.
 *
 * One Loud Hue: the state colour rides only on the glyph of attention chips;
 * the frame stays brass. Quiet chips use label-tier neutral ink only.
 * Base styles are the legible resting state — the awaiting beacon pulse collapses
 * under the global reduced-motion rule in tokens.css.
 */
export function EdgeAlerts({ items, onSelectSession }: EdgeAlertsProps) {
  if (items.length === 0) return null;

  const left = items.filter((i) => i.side === "left");
  const right = items.filter((i) => i.side === "right");

  return (
    <>
      {left.length > 0 && (
        <div
          className="pc-edge-alerts pc-edge-alerts--left"
          role="group"
          aria-label={
            left.some((i) => !i.quiet)
              ? "Attention to the left"
              : "Sessions to the left"
          }
        >
          {left.slice(0, EDGE_ALERT_STACK_CAP).map((item) => (
            <EdgeAlertButton key={edgeChipKey(item)} item={item} onSelectSession={onSelectSession} />
          ))}
          {left.length > EDGE_ALERT_STACK_CAP && (
            <span
              className="pc-edge-alert pc-edge-alert--more"
              role="img"
              aria-label={`${left.length - EDGE_ALERT_STACK_CAP} more sessions to the left`}
            >
              +{left.length - EDGE_ALERT_STACK_CAP}
            </span>
          )}
        </div>
      )}
      {right.length > 0 && (
        <div
          className="pc-edge-alerts pc-edge-alerts--right"
          role="group"
          aria-label={
            right.some((i) => !i.quiet)
              ? "Attention to the right"
              : "Sessions to the right"
          }
        >
          {right.slice(0, EDGE_ALERT_STACK_CAP).map((item) => (
            <EdgeAlertButton key={edgeChipKey(item)} item={item} onSelectSession={onSelectSession} />
          ))}
          {right.length > EDGE_ALERT_STACK_CAP && (
            <span
              className="pc-edge-alert pc-edge-alert--more"
              role="img"
              aria-label={`${right.length - EDGE_ALERT_STACK_CAP} more sessions to the right`}
            >
              +{right.length - EDGE_ALERT_STACK_CAP}
            </span>
          )}
        </div>
      )}
    </>
  );
}
