/**
 * #207 — sqlite ports for the inbox module: adapters match production SQL
 * (event_acks PK on (task_id, state), getBySeq, re-entry un-acks via new seq).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePaths, type TaskState } from "@useparley/core";
import {
  bumpTaskSeq,
  insertTask,
  openDatabase,
  writeTaskState,
  type DatabaseHandle,
} from "../src/db.js";
import {
  createInbox,
  sqliteAckStore,
  sqliteTaskSnapshot,
} from "../src/inbox.js";

let home: string;
let db: DatabaseHandle;

function seedTask(id: string, state: TaskState = "pending"): void {
  insertTask(db, {
    id,
    name: id,
    vendor: "fake",
    model: null,
    effort: null,
    profile: null,
    repo: null,
    cwd: "/tmp",
    prompt: "do it",
    orchestrator_session_id: "orch",
    worktree: null,
    branch: null,
    base_sha: null,
    sandbox: "workspace",
    network: true,
    answer_timeout_ms: null,
    report_schema: null,
    size: null,
    difficulty: null,
    type: "other",
  });
  if (state !== "pending") {
    writeTaskState(db, id, state);
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-inbox-"));
  db = openDatabase(homePaths(home));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function box() {
  return createInbox(sqliteTaskSnapshot(db), sqliteAckStore(db));
}

function w(taskIds: string[], runIds: string[] = []) {
  return { taskIds, runIds };
}

describe("sqlite inbox adapters", () => {
  it("peek / ack / allDone against real event_acks + getBySeq", () => {
    seedTask("a", "awaiting_answer");
    seedTask("b", "failed");
    const seqA = bumpTaskSeq(db, "a");
    const seqB = bumpTaskSeq(db, "b");
    const inbox = box();

    expect(inbox.peek(w(["a", "b"]))?.id).toBe("a"); // priority
    inbox.ack(seqA);
    expect(inbox.peek(w(["a", "b"]))?.id).toBe("b");
    inbox.ack(seqB);
    expect(inbox.peek(w(["a", "b"]))).toBeNull();
    // still non-terminal (awaiting_answer) → not all-done
    expect(inbox.allDone(w(["a", "b"]))).toBe(false);

    writeTaskState(db, "a", "completed");
    const seqA2 = bumpTaskSeq(db, "a");
    writeTaskState(db, "b", "cancelled");
    bumpTaskSeq(db, "b");
    // completed surfaces; cancelled does not
    expect(inbox.peek(w(["a", "b"]))?.seq).toBe(seqA2);
    inbox.ack(seqA2);
    expect(inbox.allDone(w(["a", "b"]))).toBe(true);
  });

  it("re-entry into same state with new seq is un-acked", () => {
    seedTask("a", "awaiting_answer");
    const seq1 = bumpTaskSeq(db, "a");
    const inbox = box();
    inbox.ack(seq1);
    expect(inbox.peek(w(["a"]))).toBeNull();

    writeTaskState(db, "a", "running");
    bumpTaskSeq(db, "a");
    writeTaskState(db, "a", "awaiting_answer");
    const seq2 = bumpTaskSeq(db, "a");
    expect(inbox.peek(w(["a"]))?.seq).toBe(seq2);
  });

  it("ack of superseded seq is a no-op", () => {
    seedTask("a", "failed");
    const oldSeq = bumpTaskSeq(db, "a");
    writeTaskState(db, "a", "stalled");
    const newSeq = bumpTaskSeq(db, "a");
    const inbox = box();

    inbox.ack(oldSeq);
    expect(inbox.peek(w(["a"]))?.seq).toBe(newSeq);
  });
});
