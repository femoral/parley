/**
 * Keyboard accelerators — Cove-parity bar from the coverage audit:
 * `/` find, `n` / `⇧N` cycle attention, `m` metrics, `Esc` dismiss, `,` settings,
 * `1`–`4` screen tabs. Honors settings.shortcutsEnabled (Esc always works).
 * Board navigation accelerators are suppressed while settings is open.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { ScreenId } from "../screens/types.js";
import type { ConsoleSettings } from "./settings.js";

export interface AcceleratorHandlers {
  focusFind: () => void;
  cycleAttention: (dir: 1 | -1) => void;
  navigate: (screen: ScreenId) => void;
  openSettings: () => void;
  closeOverlays: () => void;
  settingsOpen: boolean;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return el.getAttribute("role") === "combobox";
}

export function useAccelerators(
  settings: ConsoleSettings,
  handlers: AcceleratorHandlers,
  findInputRef?: RefObject<HTMLInputElement | null>,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const findRef = useRef(findInputRef);
  findRef.current = findInputRef;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = handlersRef.current;
      const find = findRef.current;

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Esc always dismisses overlays (even when shortcuts are off).
      if (e.key === "Escape") {
        if (h.settingsOpen) {
          e.preventDefault();
          h.closeOverlays();
          return;
        }
        if (document.activeElement === find?.current) {
          e.preventDefault();
          find?.current?.blur();
        }
        return;
      }

      // While settings is open, suppress board navigators (popover contract).
      if (h.settingsOpen) return;

      if (!settings.shortcutsEnabled) return;

      if (e.key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault();
        h.focusFind();
        return;
      }

      if (e.key === "," && !isTypingTarget(e.target)) {
        e.preventDefault();
        h.openSettings();
        return;
      }

      if (isTypingTarget(e.target)) return;

      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        h.cycleAttention(e.shiftKey || e.key === "N" ? -1 : 1);
        return;
      }

      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        h.navigate("metrics");
        return;
      }

      const screenByDigit: Record<string, ScreenId> = {
        "1": "fleet",
        "2": "run",
        "3": "task",
        "4": "metrics",
      };
      if (screenByDigit[e.key]) {
        e.preventDefault();
        h.navigate(screenByDigit[e.key]!);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings.shortcutsEnabled]);
}
