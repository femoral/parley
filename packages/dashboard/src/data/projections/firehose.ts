/**
 * Firehose projection: task SSE events carry full envelopes; run events carry
 * a thin payload (`run_id`, `state`, `current_node`, `iteration`, `seq`) with
 * no workflow name — join against the client's `/runs` cache (wire-verification §2B).
 */
import type { RunSummary, TaskEnvelope } from "@useparley/core";
import type { FirehoseLine } from "../types.js";

/** Thin run event payload on `GET /events/stream` (see daemon sseMessageFor). */
export interface RunStreamPayload {
  run_id: string | null;
  state: string;
  current_node?: string | null;
  iteration?: number;
  seq: number;
}

export type FirehoseInput =
  | { subject: "task"; event: string; seq: number; task: TaskEnvelope; at?: string }
  | { subject: "run"; event: string; seq: number; run: RunStreamPayload; at?: string };

/** Build a workflow lookup from the runs list cache. */
export function workflowByRunId(
  runs: readonly Pick<RunSummary, "run_id" | "workflow">[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of runs) {
    if (r.run_id) map.set(r.run_id, r.workflow ?? "");
  }
  return map;
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

/**
 * Project one stream event into a firehose line, joining run events to a
 * workflow name from the runs cache when available.
 */
export function projectFirehoseLine(
  input: FirehoseInput,
  runsById: ReadonlyMap<string, string> = new Map(),
): FirehoseLine {
  const at = input.at ?? new Date().toISOString();

  if (input.subject === "task") {
    const t = input.task;
    const name = t.name ?? t.task_id;
    const runBit =
      t.run_id !== null && t.run_id !== undefined && t.run_id !== ""
        ? ` · run ${shortId(t.run_id)}${t.node ? `/${t.node}` : ""}`
        : "";
    return {
      seq: input.seq,
      event: input.event,
      subject: "task",
      text: `${input.event} ${name} (${t.state})${runBit}`,
      taskId: t.task_id,
      runId: t.run_id ?? null,
      workflow: t.run_id ? (runsById.get(t.run_id) ?? null) : null,
      state: t.state,
      at,
    };
  }

  const runId = input.run.run_id ?? "";
  const workflow = runId ? (runsById.get(runId) ?? null) : null;
  const workflowBit = workflow ? ` ${workflow}` : "";
  const nodeBit = input.run.current_node ? ` @ ${input.run.current_node}` : "";
  return {
    seq: input.seq,
    event: input.event,
    subject: "run",
    text: `${input.event}${workflowBit} ${shortId(runId) || "?"} (${input.run.state})${nodeBit}`,
    taskId: null,
    runId: runId || null,
    workflow,
    state: input.run.state,
    at,
  };
}

/** Project a batch of stream events newest-last (chronological). */
export function projectFirehose(
  events: readonly FirehoseInput[],
  runs: readonly Pick<RunSummary, "run_id" | "workflow">[],
): FirehoseLine[] {
  const map = workflowByRunId(runs);
  return events.map((e) => projectFirehoseLine(e, map));
}

/** Known run SSE event names on `/events/stream`. */
export const RUN_EVENT_NAMES = [
  "run.started",
  "run.blocked",
  "run.node_entered",
  "run.running",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.gate",
] as const;
