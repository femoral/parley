/**
 * Layer 4 (hooks) — global keyboard accelerators for the cockpit shell.
 * Power-user shortcuts (recognition over recall via ChartKey's Keys section):
 *   `/`  — open and focus the roster session search
 *   `n`  — cycle to the next `awaiting_answer` task (roster attention order)
 *   `m`  — toggle Soundings metrics board (#119)
 *   `Esc` — clear the selected task (when no popover/search is open)
 *
 * All keys are ignored while typing in an input/textarea/contenteditable or
 * when a modifier key is held. Callbacks must be identity-stable (memoized
 * components depend on them).
 */
import { useEffect, useRef, type RefObject } from "react";
import { isAnyHandRolledPopoverOpen } from "../../hud/handRolledPopover.js";
import type { RosterSearchHandle } from "../../hud/RosterPanel.js";
import type { RosterGroup } from "../../hud/types.js";

export type { RosterSearchHandle };

/** Tab landing option for {@link CockpitKeysOptions.selectTask} (mirrors SelectTaskOptions). */
export interface CockpitSelectTaskOptions {
  /** Inspector tab to land on. Defaults to `"brief"` in the cockpit shell. */
  tab?: "brief" | "logs" | "report" | "qa";
}

export interface CockpitKeysOptions {
  /** Ref to the roster's imperative search handle (may be null while mounting). */
  rosterRef: RefObject<RosterSearchHandle | null>;
  /** Projected roster groups (attention order) — used to find awaiting tasks. */
  groups: RosterGroup[];
  selectedTaskId: string | null;
  /**
   * Select a task. The `n` accelerator passes `{ tab: "qa" }` so awaiting
   * flags open on the question (same path as inbox click / selectInboxTask).
   */
  selectTask: (id: string, options?: CockpitSelectTaskOptions) => void;
  clearTask: () => void;
  /** Toggle Cove ↔ Soundings (`m` accelerator, #119). */
  toggleSoundings?: () => void;
  /**
   * Master switch for the single-character accelerators (`/`, `n`, `m`) —
   * the WCAG 2.1.4 opt-out, wired to the settings strip. `Esc` is not a
   * character key and stays active regardless.
   */
  enabled?: boolean;
}
/** True when the event target is a text-entry control (or contenteditable). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // Nested contenteditable / role=textbox
  if (target.closest("[contenteditable='true'], [contenteditable='']")) return true;
  return false;
}

/** True when a modifier that usually means "browser shortcut" is held. */
export function hasModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

/**
 * Task ids in the `awaiting_answer` group, in the roster's projected order
 * (groups already sorted by attention rank; don't re-derive states).
 */
export function awaitingTaskIds(groups: readonly RosterGroup[]): string[] {
  const group = groups.find((g) => g.state === "awaiting_answer");
  return group ? group.tasks.map((t) => t.id) : [];
}

/**
 * Next awaiting task id after `current`, cycling. When `current` is not in
 * the list (or null), returns the first. Empty list → null.
 */
export function nextAwaitingId(
  ids: readonly string[],
  current: string | null,
): string | null {
  if (ids.length === 0) return null;
  if (current === null) return ids[0]!;
  const idx = ids.indexOf(current);
  if (idx === -1) return ids[0]!;
  return ids[(idx + 1) % ids.length]!;
}

/** True when a bus-managed cockpit popover is open (Chart key, session search, …). */
export function hasOpenPopover(event?: Event): boolean {
  return isAnyHandRolledPopoverOpen(event);
}

/**
 * Attach window keydown listeners for cockpit accelerators. Tears down on
 * unmount. Options are read via a ref so the listener stays stable and does
 * not re-bind every clock tick / snapshot update.
 */
export function useCockpitKeys(options: CockpitKeysOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Never steal browser/OS chords or typing into fields.
      if (hasModifier(event)) return;
      if (isTypingTarget(event.target)) return;

      const {
        rosterRef,
        groups,
        selectedTaskId,
        selectTask,
        clearTask,
        toggleSoundings,
        enabled = true,
      } = optionsRef.current;

      // Character-key accelerators honour the settings opt-out (WCAG 2.1.4);
      // Escape below is exempt.
      if (!enabled && event.key !== "Escape") return;

      if (event.key === "/") {
        event.preventDefault();
        rosterRef.current?.openSearch();
        return;
      }

      if (event.key === "n" || event.key === "N") {
        const next = nextAwaitingId(awaitingTaskIds(groups), selectedTaskId);
        if (next !== null) {
          event.preventDefault();
          // Land on Q&A — the flag is the outstanding question, not the brief.
          selectTask(next, { tab: "qa" });
        }
        return;
      }

      if (event.key === "m" || event.key === "M") {
        if (toggleSoundings) {
          event.preventDefault();
          toggleSoundings();
        }
        return;
      }

      if (event.key === "Escape") {
        // Let open popovers consume Escape (ChartKey / SessionSearch own it).
        if (hasOpenPopover(event)) return;
        if (rosterRef.current?.isSearchOpen()) return;
        if (selectedTaskId !== null) {
          event.preventDefault();
          clearTask();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
