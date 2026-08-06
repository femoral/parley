/**
 * Effective-cap / queue context for a queued task envelope.
 * Display form: `QUEUED #3 · vendor:claude 2/2` when max_concurrent is known,
 * else `QUEUED #3 · vendor:claude`.
 *
 * Only labels when `state === "queued"` — stale queue fields on a running
 * task (merge clear semantics) must not render a false QUEUED banner (MED-1).
 */
import type { TaskEnvelope } from "@useparley/core";
import type { QueueContextView } from "../types.js";

export interface QueueFields {
  state: string;
  queue_position?: number | null;
  blocking_cap?: string | null;
  max_concurrent?: number | null;
}

const EMPTY: QueueContextView = {
  label: null,
  position: null,
  blockingCap: null,
  maxConcurrent: null,
  capLabel: null,
};

/** Project queue observability fields into a display view. */
export function projectQueueContext(task: QueueFields | TaskEnvelope): QueueContextView {
  // State is authoritative — never surface a QUEUED label on non-queued rows,
  // even if position/cap fields are still present from a stale merge.
  if (task.state !== "queued") {
    return EMPTY;
  }

  const position =
    typeof task.queue_position === "number" && Number.isFinite(task.queue_position)
      ? task.queue_position
      : null;
  const blockingCap =
    typeof task.blocking_cap === "string" && task.blocking_cap !== ""
      ? task.blocking_cap
      : null;
  const maxConcurrent =
    typeof task.max_concurrent === "number" && Number.isFinite(task.max_concurrent)
      ? task.max_concurrent
      : null;

  const capLabel =
    blockingCap !== null && maxConcurrent !== null
      ? `${blockingCap} ${maxConcurrent}/${maxConcurrent}`
      : blockingCap;

  const parts: string[] = ["QUEUED"];
  if (position !== null) parts.push(`#${position}`);
  if (capLabel !== null) {
    parts.push("·");
    parts.push(capLabel);
  }

  return {
    label: parts.join(" "),
    position,
    blockingCap,
    maxConcurrent,
    capLabel,
  };
}
