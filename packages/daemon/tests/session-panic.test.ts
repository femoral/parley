/**
 * #240 / ADR-0019 — delivery breaker and enforcing `panicked` session state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths } from "@useparley/core";
import {
  getEventDeliveryCount,
  insertSession,
  isSessionPanicked,
  openDatabase,
  type DatabaseHandle,
} from "../src/db.js";
import {
  clearSessionPanic,
  DEFAULT_DELIVERY_BREAKER,
  isPanickedSession,
  noteEventResolved,
  noteInboxDelivery,
} from "../src/session-panic.js";

let home: string;
let db: DatabaseHandle;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-panic-"));
  db = openDatabase(homePaths(home));
  insertSession(db, {
    id: "sess-1",
    harness: "test",
    model: "m",
    effort: null,
    workspace_root: "/tmp",
    anchor: { machine_id: "m", pid: 1, start_time: "0" },
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("delivery breaker", () => {
  it(`trips panicked after ${DEFAULT_DELIVERY_BREAKER} deliveries without ack`, () => {
    for (let i = 1; i < DEFAULT_DELIVERY_BREAKER; i++) {
      const r = noteInboxDelivery(db, {
        eventId: 42,
        subjectKind: "run",
        subjectId: "r1",
        sessionId: "sess-1",
      });
      expect(r.count).toBe(i);
      expect(r.tripped).toBe(false);
      expect(isSessionPanicked(db, "sess-1")).toBe(false);
    }
    const last = noteInboxDelivery(db, {
      eventId: 42,
      subjectKind: "run",
      subjectId: "r1",
      sessionId: "sess-1",
    });
    expect(last.count).toBe(DEFAULT_DELIVERY_BREAKER);
    expect(last.tripped).toBe(true);
    expect(isSessionPanicked(db, "sess-1")).toBe(true);
    expect(isPanickedSession(db, "sess-1")).toBe(true);
  });

  it("is sticky across clear-of-counter only until human clears panic", () => {
    for (let i = 0; i < DEFAULT_DELIVERY_BREAKER; i++) {
      noteInboxDelivery(db, {
        eventId: 7,
        subjectKind: "task",
        subjectId: "t1",
        sessionId: "sess-1",
      });
    }
    expect(isSessionPanicked(db, "sess-1")).toBe(true);
    noteEventResolved(db, 7);
    expect(getEventDeliveryCount(db, 7)).toBe(0);
    // Panic remains until human clear.
    expect(isSessionPanicked(db, "sess-1")).toBe(true);
    expect(clearSessionPanic(db, "sess-1")).toBe(true);
    expect(isSessionPanicked(db, "sess-1")).toBe(false);
  });

  it("does not trip free-form (unregistered) session ids", () => {
    for (let i = 0; i < DEFAULT_DELIVERY_BREAKER + 2; i++) {
      const r = noteInboxDelivery(db, {
        eventId: 9,
        subjectKind: "run",
        subjectId: "r1",
        sessionId: "freeform-unknown",
      });
      expect(r.tripped).toBe(false);
    }
  });

  it("ack-path resolve resets the counter so a later re-entry starts fresh", () => {
    for (let i = 0; i < 5; i++) {
      noteInboxDelivery(db, {
        eventId: 3,
        subjectKind: "task",
        subjectId: "t1",
        sessionId: "sess-1",
      });
    }
    expect(getEventDeliveryCount(db, 3)).toBe(5);
    noteEventResolved(db, 3);
    expect(getEventDeliveryCount(db, 3)).toBe(0);
    const again = noteInboxDelivery(db, {
      eventId: 3,
      subjectKind: "task",
      subjectId: "t1",
      sessionId: "sess-1",
    });
    expect(again.count).toBe(1);
    expect(isSessionPanicked(db, "sess-1")).toBe(false);
  });
});
