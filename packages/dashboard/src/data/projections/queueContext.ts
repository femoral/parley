/**
 * Effective-cap / queue context for a queued task envelope.
 * Display form: `QUEUED #3 · vendor:claude 2/2` when max_concurrent is known,
 * else `QUEUED #3 · vendor:claude`.
 */
import type { TaskEnvelope } from "@useparley/core";
import type { QueueContextView } from "../types.js";

export interface QueueFields {
  state: string;
  queue_position?: number | null;
  blocking_cap?: string | null;
  max_concurrent?: number | null;
}

/** Project queue observability fields into a display view. */
export function projectQueueContext(task: QueueFields | TaskEnvelope): QueueContextView {
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

  // Only meaningful while queued (wire sets nulls when not).
  if (task.state !== "queued" && position === null && blockingCap === null) {
    return {
      label: null,
      position: null,
      blockingCap: null,
      maxConcurrent: null,
      capLabel: null,
    };
  }

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
