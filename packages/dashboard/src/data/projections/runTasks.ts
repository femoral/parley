/**
 * Run-tasks projections (wire-verification §2B):
 * - Per-node rows: `GET /runs/:ref/nodes/:node` (via {@link fetchNodeDetail})
 * - Whole-run list: client-side filter of the live task snapshot by `run_id`
 *   (no `?run=` query param on `/tasks`).
 */
import type { TaskEnvelope } from "@useparley/core";

/** Filter snapshot envelopes belonging to a run. */
export function filterTasksByRunId(
  tasks: readonly TaskEnvelope[],
  runId: string | null | undefined,
): TaskEnvelope[] {
  if (runId === null || runId === undefined || runId === "") return [];
  return tasks.filter((t) => t.run_id === runId);
}
