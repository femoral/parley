/**
 * Single-open invariant for hand-rolled cockpit popovers (Chart key, session
 * Find). Opening one closes the other so `hasOpenPopover()` / Esc-clear of
 * task selection never wait on two stacked wells. Native Popover API surfaces
 * are out of scope (the browser already enforces one `popover=auto` at a time).
 */

export type HandRolledPopoverId = "chart-key" | "session-find";

const HAND_ROLLED_POPOVER_EVENT = "pc-hand-rolled-popover-open";

/** Announce that a hand-rolled popover just opened (closes peers). */
export function notifyHandRolledPopoverOpen(id: HandRolledPopoverId): void {
  document.dispatchEvent(
    new CustomEvent(HAND_ROLLED_POPOVER_EVENT, { detail: { id } }),
  );
}

/**
 * Subscribe to peer hand-rolled popover opens. Calls `onOtherOpen` when a
 * different id opens. Returns an unsubscribe function.
 */
export function subscribeHandRolledPopoverOpen(
  id: HandRolledPopoverId,
  onOtherOpen: () => void,
): () => void {
  const handler = (event: Event): void => {
    const opened = (event as CustomEvent<{ id?: HandRolledPopoverId }>).detail?.id;
    if (opened && opened !== id) onOtherOpen();
  };
  document.addEventListener(HAND_ROLLED_POPOVER_EVENT, handler);
  return () => document.removeEventListener(HAND_ROLLED_POPOVER_EVENT, handler);
}
