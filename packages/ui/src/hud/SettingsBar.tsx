import { memo } from "react";

export interface SettingsBarProps {
  ornaments: boolean;
  showKit: boolean;
  followLogs: boolean;
  onToggleOrnaments: () => void;
  onToggleShowKit: () => void;
  onToggleFollowLogs: () => void;
}

/**
 * Layer 2 — the cockpit's settings strip (design-manifest §7's "Toggles ...
 * all worth keeping as settings"; component-system spec contract 5: "settings
 * toggles from day one" — ornaments, kit band, live-log follow, #70). Plain
 * booleans + callbacks (contract 2) — the app layer owns the persisted state
 * (`useSettings`), this only renders it. Each toggle is a native
 * `aria-pressed` button, same pattern as the roster's session chips, so it
 * gets free keyboard semantics and the global focus ring. Memoized like
 * `Inspector`/`RosterPanel`/`InboxPanel` — the cockpit shell re-renders every
 * second for its clock, and `useSettings`' toggle callbacks are
 * identity-stable (`useCallback`) between real preference changes.
 */
export const SettingsBar = memo(function SettingsBar({
  ornaments,
  showKit,
  followLogs,
  onToggleOrnaments,
  onToggleShowKit,
  onToggleFollowLogs,
}: SettingsBarProps) {
  return (
    <div className="pc-settings" role="group" aria-label="Cockpit settings">
      <button
        type="button"
        className={`pc-settings__toggle${ornaments ? " pc-settings__toggle--on" : ""}`}
        aria-pressed={ornaments}
        onClick={onToggleOrnaments}
      >
        <span aria-hidden="true">✦</span> Ornaments
      </button>
      {import.meta.env.DEV && (
        <button
          type="button"
          className={`pc-settings__toggle${showKit ? " pc-settings__toggle--on" : ""}`}
          aria-pressed={showKit}
          onClick={onToggleShowKit}
        >
          <span aria-hidden="true">⚒</span> Kit band <span className="pc-settings__hint">dev</span>
        </button>
      )}
      <button
        type="button"
        className={`pc-settings__toggle${followLogs ? " pc-settings__toggle--on" : ""}`}
        aria-pressed={followLogs}
        onClick={onToggleFollowLogs}
      >
        <span aria-hidden="true">⛵</span> Follow logs
      </button>
    </div>
  );
});
