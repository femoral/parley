/**
 * Single-open invariant for hand-rolled cockpit popovers (Chart key, session
 * Find). Opening one closes the other so `hasOpenPopover()` / Esc-clear of
 * task selection never wait on two stacked wells. Native Popover API surfaces
 * are out of scope (the browser already enforces one `popover=auto` at a time).
 *
 * Invariant: `openPopover !== null` iff a hand-rolled popover is visibly open.
 * Surfaces register their root element on open; document pointerdown only
 * clears the bus when the event is outside that surface (inside clicks keep
 * the popover open and must not pretend it closed).
 */

export type HandRolledPopoverId = "chart-key" | "session-find";

const HAND_ROLLED_POPOVER_EVENT = "pc-hand-rolled-popover-open";
let openPopover: HandRolledPopoverId | null = null;
let openSurface: Element | null = null;
let dismissalListenersInstalled = false;
/** Escape events that dismissed a popover — same-tick check for useCockpitKeys. */
const popoverDismissalEvents = new WeakSet<Event>();

function isEventInsideSurface(event: Event, surface: Element | null): boolean {
  if (!surface) return false;
  if (typeof event.composedPath === "function") {
    const path = event.composedPath();
    if (path.length > 0) return path.includes(surface);
  }
  const target = event.target;
  return target instanceof Node && surface.contains(target);
}

function clearOpenState(): void {
  openPopover = null;
  openSurface = null;
}

function installDismissalListeners(): void {
  if (dismissalListenersInstalled) return;
  dismissalListenersInstalled = true;

  // Only clear when the interaction is outside the registered open surface.
  // Inside clicks do not close the popover, so the bus must stay truthful.
  const onPointer = (event: Event): void => {
    if (openPopover === null) return;
    if (isEventInsideSurface(event, openSurface)) return;
    clearOpenState();
  };

  document.addEventListener("pointerdown", onPointer);
  document.addEventListener("mousedown", onPointer);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Mark the event so hasOpenPopover(event) still returns true for this
    // same Escape tick after we clear — ChartKey / SessionSearch close on Esc
    // and useCockpitKeys must not also clear task selection.
    if (openPopover !== null) popoverDismissalEvents.add(event);
    clearOpenState();
  });
}

/**
 * Announce that a hand-rolled popover just opened (closes peers). Pass the
 * surface root so inside pointer events do not falsely clear the open bus.
 */
export function notifyHandRolledPopoverOpen(
  id: HandRolledPopoverId,
  surface?: Element | null,
): void {
  installDismissalListeners();
  openPopover = id;
  openSurface = surface ?? null;
  document.dispatchEvent(
    new CustomEvent(HAND_ROLLED_POPOVER_EVENT, { detail: { id } }),
  );
}

/**
 * Clear the bus when a popover closes for any reason other than an outside
 * pointerdown already handled above (own Esc, toggle, peer open, unmount).
 * Idempotent when `id` is not the current open popover.
 */
export function notifyHandRolledPopoverClosed(id: HandRolledPopoverId): void {
  if (openPopover === id) clearOpenState();
}

/** True when one of the bus-managed cockpit popovers is currently open. */
export function isAnyHandRolledPopoverOpen(event?: Event): boolean {
  return openPopover !== null || (event !== undefined && popoverDismissalEvents.has(event));
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
