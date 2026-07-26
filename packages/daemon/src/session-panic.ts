/**
 * Delivery breaker + `panicked` session state (ADR-0019 / #240).
 *
 * One undecided gate deliberately blackholes the session inbox — that is the
 * point of a gate. The delivery breaker bounds the resulting starvation: the
 * same event id delivered N times without ack-or-action trips `panicked`.
 *
 * `panicked` is *enforcing*, not reporting: effective concurrency cap of 0,
 * sticky across orchestrator restarts (persisted on `sessions.panicked`), and
 * cleared only by a human via {@link clearSessionPanic} /
 * `parley session --clear-panic`.
 */
import {
  clearEventDelivery,
  clearSessionPanic as clearPanicRow,
  DEFAULT_DELIVERY_BREAKER,
  getSession,
  isSessionPanicked,
  recordEventDelivery,
  setSessionPanicked,
  type DatabaseHandle,
  type InboxSubjectKind,
} from "./db.js";

export { DEFAULT_DELIVERY_BREAKER };

export interface DeliveryNote {
  eventId: number;
  subjectKind: InboxSubjectKind;
  subjectId: string;
  /** Orchestrator session to trip when the breaker fires; null = free-form. */
  sessionId: string | null;
}

/**
 * Record one inbox delivery. When the count reaches the breaker threshold and
 * a registered session id is known, trips `panicked`. Returns the new count
 * and whether the breaker fired on this delivery.
 */
export function noteInboxDelivery(
  db: DatabaseHandle,
  note: DeliveryNote,
  threshold: number = DEFAULT_DELIVERY_BREAKER,
): { count: number; tripped: boolean } {
  const count = recordEventDelivery(
    db,
    note.eventId,
    note.subjectKind,
    note.subjectId,
  );
  if (count < threshold) return { count, tripped: false };
  if (note.sessionId === null || note.sessionId === "") {
    return { count, tripped: false };
  }
  // Only trip registered sessions (free-form ids have no sessions row).
  if (getSession(db, note.sessionId) === undefined) {
    return { count, tripped: false };
  }
  if (!isSessionPanicked(db, note.sessionId)) {
    setSessionPanicked(db, note.sessionId);
  }
  return { count, tripped: true };
}

/** Clear delivery tracking after a successful ack (or when superseded). */
export function noteEventResolved(db: DatabaseHandle, eventId: number): void {
  clearEventDelivery(db, eventId);
}

/**
 * True when spawning for this orchestrator session must be refused (effective
 * concurrency cap of 0). Unknown / unbound sessions are never panicked.
 */
export function isPanickedSession(
  db: DatabaseHandle,
  sessionId: string | null | undefined,
): boolean {
  if (sessionId === null || sessionId === undefined || sessionId === "") {
    return false;
  }
  return isSessionPanicked(db, sessionId);
}

/**
 * Human clear of `panicked`. Returns false when the session is unknown.
 * Surface: `parley session --clear-panic` → `POST /sessions` with
 * `clear_panic: true`.
 */
export function clearSessionPanic(
  db: DatabaseHandle,
  sessionId: string,
): boolean {
  return clearPanicRow(db, sessionId);
}
