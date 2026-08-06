/**
 * Fleet-board test fixtures (screen-local; do not extend tests/fixtures.ts).
 */
import type { RunSummary, RunnerListEntry, TaskEnvelope } from "@useparley/core";
import { envelope } from "../fixtures.js";

export function task(
  overrides: Partial<TaskEnvelope> & Pick<TaskEnvelope, "task_id" | "state">,
): TaskEnvelope {
  return envelope(overrides);
}

export function run(
  overrides: Partial<RunSummary> & Pick<RunSummary, "run_id" | "state">,
): RunSummary {
  return {
    workflow: "review-and-land",
    workflow_version: 1,
    orchestrator_session_id: "orch-1",
    block: null,
    current_node: "tests",
    iteration: 1,
    parent_run_id: null,
    attempt: 1,
    tasks_settled: 0,
    tasks_total: 1,
    usage: { input_tokens: 0, output_tokens: 0 },
    duration_ms: null,
    branch: "feat/fleet",
    worktree: null,
    created_at: "2026-06-15T10:00:00.000Z",
    updated_at: "2026-06-15T11:00:00.000Z",
    completed_at: null,
    purged_at: null,
    workspace: "scratch",
    type: "other",
    repo: null,
    error: null,
    track_bound: 6,
    track: null,
    ...overrides,
  };
}

export function runner(
  overrides: Partial<RunnerListEntry> & Pick<RunnerListEntry, "name">,
): RunnerListEntry {
  return {
    status: "online",
    vendors: ["fake"],
    last_seen: "2026-06-15T12:00:00.000Z",
    registered_at: "2026-06-15T08:00:00.000Z",
    protocol_version: 1,
    build_version: "0.0.0",
    ...overrides,
  };
}
