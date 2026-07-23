import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type UIEvent,
} from "react";
import type { LogLine } from "./types.js";

export interface LogStreamProps {
  lines: LogLine[];
  /** Whether the tail is still following (false once the daemon reports `eof`). */
  live: boolean;
  emptyMessage?: string;
}

/** Distance from the true bottom still treated as "following" the tail. */
const STICK_THRESHOLD_PX = 48;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
}

/**
 * Status copy for the live-tail head. Honesty over charm:
 * - live + following → "Live · Follow"
 * - live + scrolled up → "Paused" (user/scroll pause; stream still open)
 * - not live → "Ended" (eof / terminal tail — not a temporary pause)
 */
export function logStreamStatus(live: boolean, following: boolean): string {
  if (!live) return "Ended";
  if (!following) return "Paused";
  return "Live · Follow";
}

/**
 * Layer 2 — the raw vendor log well (design-manifest §4.17 "Logs" / §2.8's
 * per-kind colours). Plain props, no polling here (contract 2) —
 * `Inspector`'s Logs tab is the only current caller, but this stays a
 * standalone hud component (component-system spec's Inspector/LogStream
 * split) so a future merged global stream (design-manifest §4.12, out of
 * scope for #68) can reuse the same line rendering.
 *
 * Stick-to-bottom: the well pins to the tail when the user is at (or within
 * {@link STICK_THRESHOLD_PX} of) the bottom, and stops yanking once they
 * scroll up to read history — then re-pins when they return. Implemented
 * with a body ref + scroll handler rather than `column-reverse`, so DOM
 * order stays chronological (select/copy, screen readers) and the empty
 * state can keep using the same flex column. Pinning is independent of
 * `live`: a finished log still opens on its last line.
 *
 * Accessibility: `role="log"` stays for discoverability, but `aria-live`
 * is forced off while the tail is live so a fast vendor stream cannot
 * chatter. Status transitions (Live / Paused / Ended) are announced from
 * the head instead.
 */
export function LogStream({
  lines,
  live,
  emptyMessage = "No log yet — the ship hasn't left the dock.",
}: LogStreamProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // Defaults true so first non-empty paint (and remount for a new task) lands
  // on the tail; only a deliberate scroll-up clears it.
  const stickToBottomRef = useRef(true);
  // Mirror of the ref for status label re-renders (Paused vs Live · Follow).
  const [following, setFollowing] = useState(true);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const near = isNearBottom(event.currentTarget);
    stickToBottomRef.current = near;
    setFollowing(near);
  }, []);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const status = logStreamStatus(live, following);
  const dotStyle = { "--dot-color": live ? "var(--healthy-dot)" : "var(--ink-label)" } as CSSProperties;
  return (
    <div className="pc-logstream">
      <div className="pc-logstream__head">
        <span className={`pc-dot${live ? " pc-dot--beacon" : ""}`} style={dotStyle} aria-hidden="true" />
        <span className="pc-logstream__status" aria-live="polite" aria-atomic="true">
          {status}
        </span>
      </div>
      <div
        className="pc-logstream__body"
        role="log"
        aria-live="off"
        ref={bodyRef}
        onScroll={onScroll}
      >
        {lines.length === 0 ? (
          <p className="pc-logstream__empty">{emptyMessage}</p>
        ) : (
          lines.map((line) => (
            <div key={line.key} className={`pc-logstream__line pc-logstream__line--${line.kind}`}>
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
