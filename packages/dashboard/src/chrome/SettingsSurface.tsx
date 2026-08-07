/**
 * Settings dialog — genuinely modal: aria-modal=true, focus trapped, Esc
 * dismisses. Focus moves into the panel on open, restores to the trigger on
 * close. Board accelerators are suppressed while open (useAccelerators).
 */
import { useEffect, useId, useRef, type RefObject } from "react";
import type { ConsoleSettings } from "./settings.js";

export interface SettingsSurfaceProps {
  open: boolean;
  settings: ConsoleSettings;
  onChange: (next: ConsoleSettings) => void;
  onClose: () => void;
  /** Element that opened the dialog — restored on close. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

  // Esc + Tab trap (modal: focus cannot leave the panel).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
      );
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="pc-settings" data-testid="settings-surface">
      <div
        ref={panelRef}
        className="pc-settings__panel"
        role="dialog"
        aria-modal="true"
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
