import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type UIEvent,
} from "react";
import type { LogLine, LogTailHookStatus, LogTailStatus } from "./types.js";

export interface LogStreamProps {
  lines: LogLine[];
  /**
   * Truthful tail lifecycle from the hook (`useLogTail`). Scroll pause is
   * composed here into the single status line.
   */
  status: LogTailHookStatus;
  emptyMessage?: string;
}

/** Distance from the true bottom still treated as "following" the tail. */
const STICK_THRESHOLD_PX = 48;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
}

/**
 * Fold hook status + stick-to-bottom into one display status. Priority:
 * ended / unreachable / paused-by-setting win over scroll pause; scroll
 * pause only applies while the stream is genuinely tailing.
 */
export function composeLogStreamStatus(
  hookStatus: LogTailHookStatus,
  stickFollowing: boolean,
): LogTailStatus {
  if (hookStatus === "ended") return "ended";
  if (hookStatus === "unreachable") return "unreachable";
  if (hookStatus === "paused-by-setting") return "paused-by-setting";
  if (!stickFollowing) return "paused-by-scroll";
  return "tailing";
}

/**
 * Status copy for the live-tail head. Honesty over charm — every state has
 * distinct, non-decorative wording.
 */
export function logStreamStatusLabel(status: LogTailStatus): string {
  switch (status) {
    case "tailing":
      return "Live · Follow";
    case "paused-by-setting":
      return "Paused — follow off";
    case "paused-by-scroll":
      return "Paused — scrolled up";
    case "ended":
      return "Ended";
    case "unreachable":
      return "Connection lost — retrying…";
  }
}

/** Beacon colour dual-codes the status (never hue alone — label matches). */
export function logStreamDotColor(status: LogTailStatus): string {
  switch (status) {
    case "tailing":
      return "var(--healthy-dot)";
    case "unreachable":
      // Stalled-slate tone (stale-chart band idiom) — not failed coral.
      return "var(--state-stalled)";
    case "paused-by-setting":
    case "paused-by-scroll":
    case "ended":
      return "var(--ink-label)";
  }
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
 * tail status: a finished log still opens on its last line.
 *
 * Accessibility: `role="log"` stays for discoverability, but `aria-live`
 * is forced off on the body so a fast vendor stream cannot chatter. Status
 * transitions are announced from the head instead and always match the
 * visible label (never a false "Ended" / "Live").
 */
export function LogStream({
  lines,
  status: hookStatus,
  emptyMessage = "No log yet — the ship hasn't left the dock.",
}: LogStreamProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // Defaults true so first non-empty paint (and remount for a new task) lands
  // on the tail; only a deliberate scroll-up clears it.
  const stickToBottomRef = useRef(true);
  // Mirror of the ref for status label re-renders (scroll pause vs tailing).
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

  const status = composeLogStreamStatus(hookStatus, following);
  const label = logStreamStatusLabel(status);
  const pulsing = status === "tailing";
  const dotStyle = { "--dot-color": logStreamDotColor(status) } as CSSProperties;

  return (
    <div className="pc-logstream" data-log-status={status}>
      <div className="pc-logstream__head">
        <span
          className={`pc-dot${pulsing ? " pc-dot--beacon" : ""}`}
          style={dotStyle}
          aria-hidden="true"
        />
        <span
          className={`pc-logstream__status pc-logstream__status--${status}`}
          aria-live="polite"
          aria-atomic="true"
        >
          {label}
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
