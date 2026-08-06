/**
 * #360 — gate-verb events on the run stream.
 *
 * When an orchestrator executes approve / reject / redirect / finish on a held
 * run, the daemon emits `run.verb` (payload: {@link RunGateVerbEvent}) before
 * the consequent state-transition edges, with monotonic seq. Invalid verbs
 * emit nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  homePaths,
  RUN_GATE_VERB_EVENT,
  type RunBlockVerb,
  type RunGateVerbEvent,
} from "@useparley/core";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import {
  insertRun,
  nextRunId,
  openDatabase,
  type DatabaseHandle,
} from "../src/db.js";
import { DelegateError, TaskEngine } from "../src/engine.js";
import type { Transition } from "../src/transition.js";
import { withFakeAllowlist } from "./helpers.js";

const WORKFLOW_ID = "gate-verb-events";
const ORCH_SESSION = "orch-gate-verb-sess";
const GATE_NODE = "approve-plan";
const HOLD_ITERATION = 1;

const WORKFLOW_BODY = {
  id: WORKFLOW_ID,
  version: 1,
  type: "other",
  workspace: "scratch",
  inputs: { brief: { type: "text" } },
  outputs: { out: { type: "text", from: "end.report" } },
  nodes: [
    {
      id: "plan",
      kind: "step",
      prompt: "p.md",
      in: { brief: { type: "text", from: "run.brief" } },
      out: { plan: { type: "text" } },
    },
    {
      id: GATE_NODE,
      kind: "gate",
      question: "Ship the plan?",
      shows: { plan: { from: "plan.plan" } },
      on_reject: "finish",
    },
    {
      id: "implement",
      kind: "step",
      prompt: "i.md",
      in: { plan: { type: "text", from: "plan.plan" } },
      out: { report: { type: "text" } },
    },
    {
      id: "end",
      kind: "step",
      prompt: "e.md",
      in: { report: { type: "text", from: "implement.report" } },
      out: { report: { type: "text" } },
    },
  ],
};

let home: string;
let db: DatabaseHandle;
let engine: TaskEngine;

function writeWorkflow(): void {
  const dir = path.join(home, "workflows", WORKFLOW_ID);
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(WORKFLOW_BODY, null, 2));
  for (const name of ["p.md", "i.md", "e.md"]) {
    fs.writeFileSync(path.join(dir, "prompts", name), `${name}\n`);
  }
}

/**
 * Seed a blocked gate run *before* constructing the engine so runSnapshots
 * capture the hold site (otherwise the first sync treats the run as brand-new).
 */
function seedBlockedGate(): string {
  const id = nextRunId(db);
  insertRun(db, {
    id,
    workflow: WORKFLOW_ID,
    version: 1,
    type: "other",
    workspace: "scratch",
    repo: null,
    current_node: GATE_NODE,
    iteration: HOLD_ITERATION,
    state: "blocked",
    error: `blocked (gate ${GATE_NODE})`,
    orchestrator_session_id: ORCH_SESSION,
  });
  return id;
}

function collectRunTransitions(runId: string, since: number): Transition[] {
  const out: Transition[] = [];
  let cursor = since;
  for (;;) {
    const t = engine.peekEvent([runId], cursor);
    if (!t) break;
    out.push(t);
    cursor = t.seq;
  }
  return out;
}

function asGateVerbEvent(t: Transition): RunGateVerbEvent {
  expect(t.event).toBe(RUN_GATE_VERB_EVENT);
  expect(t.kind).toBe("run");
  expect(t.verb).toBeDefined();
  return {
    verb: t.verb!,
    run_id: t.run_id ?? "",
    node: t.node ?? null,
    iteration: t.iteration ?? 0,
    orchestrator_session_id: t.orchestrator_session_id ?? null,
    seq: t.seq,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-gate-verb-ev-"));
  fs.writeFileSync(
    path.join(home, "parley.json"),
    JSON.stringify(
      withFakeAllowlist({
        defaults: { vendor: "fake", model: "fake-model", effort: "medium" },
      }),
    ),
  );
  writeWorkflow();
  process.env.PARLEY_HOME = home;
  db = openDatabase(homePaths(home));
});

afterEach(() => {
  try {
    engine?.killChildren();
  } catch {
    /* not started */
  }
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.PARLEY_HOME;
});

describe("gate-verb run stream events (#360)", () => {
  const cases: Array<{
    verb: RunBlockVerb;
    body?: { to?: string; note?: string };
  }> = [
    { verb: "approve" },
    { verb: "reject" },
    { verb: "redirect", body: { to: "implement", note: "retry from implement" } },
    { verb: "finish" },
  ];

  for (const { verb, body } of cases) {
    it(`emits run.verb for ${verb} with hold-site fields and seq before state edges`, () => {
      const runId = seedBlockedGate();
      engine = new TaskEngine(
        db,
        homePaths(home),
        createAdapterRegistrySync(process.env),
      );

      const since = engine.currentSeq();
      engine.actionRun(runId, {
        verb,
        to: body?.to ?? null,
        note: body?.note ?? null,
      });

      const transitions = collectRunTransitions(runId, since);
      expect(transitions.length).toBeGreaterThanOrEqual(1);

      // Verb event is first — cause before effect (documented order).
      const verbEdge = transitions[0]!;
      const payload = asGateVerbEvent(verbEdge);
      expect(payload).toMatchObject({
        verb,
        run_id: runId,
        node: GATE_NODE,
        iteration: HOLD_ITERATION,
        orchestrator_session_id: ORCH_SESSION,
      } satisfies Omit<RunGateVerbEvent, "seq">);
      expect(payload.seq).toBeGreaterThan(since);

      // Consequent state-transition edges follow with strictly increasing seq.
      const after = transitions.slice(1);
      expect(after.length).toBeGreaterThanOrEqual(1);
      let prevSeq = payload.seq;
      for (const t of after) {
        expect(t.seq).toBeGreaterThan(prevSeq);
        expect(t.kind).toBe("run");
        expect(t.event).not.toBe(RUN_GATE_VERB_EVENT);
        expect(t.verb).toBeUndefined();
        prevSeq = t.seq;
      }
    });
  }

  it("emits no event when the verb is invalid (run not blocked)", () => {
    const id = nextRunId(db);
    insertRun(db, {
      id,
      workflow: WORKFLOW_ID,
      version: 1,
      type: "other",
      workspace: "scratch",
      repo: null,
      current_node: "plan",
      iteration: 1,
      state: "running",
      orchestrator_session_id: ORCH_SESSION,
    });
    engine = new TaskEngine(
      db,
      homePaths(home),
      createAdapterRegistrySync(process.env),
    );

    const since = engine.currentSeq();
    expect(() =>
      engine.actionRun(id, { verb: "approve", to: null, note: null }),
    ).toThrow(DelegateError);

    expect(collectRunTransitions(id, since)).toEqual([]);
    // Also: no global firehose edge for this run after the failure.
    expect(engine.peekAnyEvent(since)).toBeNull();
  });

  it("emits no event for an unknown run id", () => {
    engine = new TaskEngine(
      db,
      homePaths(home),
      createAdapterRegistrySync(process.env),
    );
    const since = engine.currentSeq();
    expect(() =>
      engine.actionRun("r999999", { verb: "finish", to: null, note: null }),
    ).toThrow(/no such run/);
    expect(engine.peekAnyEvent(since)).toBeNull();
  });
});
