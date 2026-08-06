/**
 * Settings popover — follow logs + shortcuts opt-out (coverage audit must-add).
 *
 * Implemented as a **popover** (not a modal): no full-screen scrim, no
 * aria-modal. Focus moves into the panel on open, restores to the trigger on
 * close, and Esc dismisses. Board accelerators are suppressed while open
 * (handled by useAccelerators). Tab is free to leave (popover, not trap).
 */
import { useEffect, useId, useRef, type RefObject } from "react";
import type { ConsoleSettings } from "./settings.js";

export interface SettingsSurfaceProps {
  open: boolean;
  settings: ConsoleSettings;
  onChange: (next: ConsoleSettings) => void;
  onClose: () => void;
  /** Element that opened the popover — restored on close. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function SettingsSurface({
  open,
  settings,
  onChange,
  onClose,
  returnFocusRef,
}: SettingsSurfaceProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  // Focus first control on open; restore trigger on close.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      returnFocusRef?.current?.focus();
    };
  }, [open, returnFocusRef]);

  // Esc inside the panel (in addition to accelerator handler).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const panel = panelRef.current;
    panel?.addEventListener("keydown", onKey);
    return () => panel?.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="pc-settings" data-testid="settings-surface">
      <div
        ref={panelRef}
        className="pc-settings__panel"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-testid="settings-panel"
      >
        <div className="pc-settings__head">
          <h2 id={titleId} className="pc-settings__title">
            Settings
          </h2>
          <button
            ref={closeBtnRef}
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

        {/* Not <footer> — board footer already owns contentinfo. */}
        <div className="pc-settings__foot">
          <span className="pc-settings__keys" aria-label="Accelerator legend">
            <kbd>/</kbd> find · <kbd>n</kbd>/<kbd>⇧N</kbd> attention · <kbd>m</kbd> metrics ·{" "}
            <kbd>,</kbd> settings · <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
      <button
        type="button"
        className="pc-settings__backdrop"
        aria-label="Dismiss settings"
        onClick={onClose}
        data-testid="settings-backdrop"
        tabIndex={-1}
      />
    </div>
  );
}
