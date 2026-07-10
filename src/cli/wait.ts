import type { Discovery } from "../daemon/discovery.js";
import type { Envelope } from "../daemon/report.js";
import { daemonGet } from "./client.js";
import { type CliContext, printJson } from "./context.js";

/** The blocking contract's exit codes (spec §5). */
export const EXIT_CODES: Record<string, number> = {
  completed: 0,
  failed: 1,
  awaiting_answer: 3,
  stalled: 4,
  cancelled: 5,
};

interface EventsResponse {
  event: string | null;
  task: Envelope;
}

/** How long each long-poll request may take; must exceed the daemon's window. */
const LONG_POLL_TIMEOUT_MS = 60_000;

/**
 * The shared blocking contract for `delegate --wait` and `answer --wait`: long-poll
 * the task's event stream until it produces an event, print the outcome, and
 * return the typed exit code (spec §5). On a question, print `{task_id, name,
 * question_id, question}` and return 3; on a terminal state, print the report
 * envelope and return its code. The orchestrator branches on `$?` without parsing.
 */
export async function waitForOutcome(
  ctx: CliContext,
  discovery: Discovery,
  taskId: string,
): Promise<number> {
  for (;;) {
    const { event, task } = await daemonGet<EventsResponse>(
      discovery,
      `/tasks/${encodeURIComponent(taskId)}/events?wait=true`,
      LONG_POLL_TIMEOUT_MS,
    );
    if (event === null) continue; // poll window elapsed, task still live
    if (event === "task.question") {
      printJson(ctx, {
        task_id: task.task_id,
        name: task.name,
        question_id: task.question_id,
        question: task.question,
      });
      return EXIT_CODES.awaiting_answer ?? 3;
    }
    printJson(ctx, task);
    return EXIT_CODES[task.state] ?? 1;
  }
}
