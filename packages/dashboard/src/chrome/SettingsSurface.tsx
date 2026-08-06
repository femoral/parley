/**
 * Settings surface — follow logs + shortcuts opt-out (coverage audit must-add).
 * Opened from header control or `,` accelerator; Esc closes.
 */
import type { ConsoleSettings } from "./settings.js";

export interface SettingsSurfaceProps {
  open: boolean;
  settings: ConsoleSettings;
  onChange: (next: ConsoleSettings) => void;
  onClose: () => void;
}

export function SettingsSurface({ open, settings, onChange, onClose }: SettingsSurfaceProps) {
  if (!open) return null;

  return (
    <div
      className="pc-settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pc-settings-title"
      data-testid="settings-surface"
    >
      <div className="pc-settings__panel">
        <div className="pc-settings__head">
          <h2 id="pc-settings-title" className="pc-settings__title">
            Settings
          </h2>
          <button
            type="button"
            className="pc-settings__close"
            onClick={onClose}
            data-testid="settings-close"
          >
            Close
          </button>
        </div>

        <ul className="pc-settings__list">
          <li className="pc-settings__row">
            <label className="pc-settings__label" htmlFor="pc-set-follow">
              <span className="pc-settings__name">Follow logs</span>
              <span className="pc-settings__hint">
                Stick log tails to bottom while new lines arrive
              </span>
            </label>
            <input
              id="pc-set-follow"
              className="pc-settings__check"
              type="checkbox"
              checked={settings.followLogs}
              onChange={(e) => onChange({ ...settings, followLogs: e.target.checked })}
              data-testid="settings-follow-logs"
            />
          </li>
          <li className="pc-settings__row">
            <label className="pc-settings__label" htmlFor="pc-set-keys">
              <span className="pc-settings__name">Keyboard shortcuts</span>
              <span className="pc-settings__hint">
                /, n, ⇧N, m, 1–4, Esc — off when unchecked
              </span>
            </label>
            <input
              id="pc-set-keys"
              className="pc-settings__check"
              type="checkbox"
              checked={settings.shortcutsEnabled}
              onChange={(e) => onChange({ ...settings, shortcutsEnabled: e.target.checked })}
              data-testid="settings-shortcuts"
            />
          </li>
        </ul>

        <footer className="pc-settings__foot">
          <span className="pc-settings__keys" aria-label="Accelerator legend">
            <kbd>/</kbd> find · <kbd>n</kbd>/<kbd>⇧N</kbd> attention · <kbd>m</kbd> metrics ·{" "}
            <kbd>,</kbd> settings · <kbd>Esc</kbd> close
          </span>
        </footer>
      </div>
      <button
        type="button"
        className="pc-settings__backdrop"
        aria-label="Dismiss settings"
        onClick={onClose}
        data-testid="settings-backdrop"
      />
    </div>
  );
}
