import { memo } from "react";
import { Mark } from "../primitives/index.js";
import { MARK_MALLET, MARK_SCROLL, MARK_SPYGLASS } from "../tokens/chrome-glyphs.js";

export interface SettingsBarProps {
  showKit: boolean;
  followLogs: boolean;
  /** Single-key accelerators on/off (WCAG 2.1.4 opt-out). */
  shortcuts: boolean;
  onToggleShowKit: () => void;
  onToggleFollowLogs: () => void;
  onToggleShortcuts: () => void;
}

/**
 * Layer 2 — the cockpit's settings strip (design-manifest §7's "Toggles ...
 * all worth keeping as settings"; component-system spec contract 5: "settings
 * toggles from day one" — kit band, live-log follow, #70). Plain
 * booleans + callbacks (contract 2) — the app layer owns the persisted state
 * (`useSettings`), this only renders it. Each toggle is a native
 * `aria-pressed` button, same pattern as the roster's session chips, so it
 * gets free keyboard semantics and the global focus ring. Memoized like
 * `Inspector`/`RosterPanel`/`InboxPanel` — the cockpit shell re-renders every
 * second for its clock, and `useSettings`' toggle callbacks are
 * identity-stable (`useCallback`) between real preference changes.
 */
export const SettingsBar = memo(function SettingsBar({
  showKit,
  followLogs,
  shortcuts,
  onToggleShowKit,
  onToggleFollowLogs,
  onToggleShortcuts,
}: SettingsBarProps) {
  return (
    <div className="pc-settings" role="group" aria-label="Cockpit settings">
      {import.meta.env.DEV && (
        <button
          type="button"
          className={`pc-settings__toggle${showKit ? " pc-settings__toggle--on" : ""}`}
          aria-pressed={showKit}
          onClick={onToggleShowKit}
        >
          <span aria-hidden="true">
            <Mark mark={MARK_MALLET} size={11} />
          </span>{" "}
          Kit band <span className="pc-settings__hint">dev</span>
        </button>
      )}
      <button
        type="button"
        className={`pc-settings__toggle${followLogs ? " pc-settings__toggle--on" : ""}`}
        aria-pressed={followLogs}
        onClick={onToggleFollowLogs}
      >
        <span aria-hidden="true">
          <Mark mark={MARK_SPYGLASS} size={11} />
        </span>{" "}
        Follow logs
      </button>
      <button
        type="button"
        className={`pc-settings__toggle${shortcuts ? " pc-settings__toggle--on" : ""}`}
        aria-pressed={shortcuts}
        onClick={onToggleShortcuts}
      >
        <span aria-hidden="true">
          <Mark mark={MARK_SCROLL} size={11} />
        </span>{" "}
        Shortcuts
      </button>
    </div>
  );
});
