/**
 * Unified executor model (#312 / ADR-0028, routing #315).
 *
 * Names the daemon-local path as an in-process executor and moves
 * `delegate`/`fix`/run-step insert handoff behind it. Capability-matched
 * claim across local + runners lives in the engine (`dispatchClaim` /
 * `tryClaimRunnerTask`); this module owns the local offer/drain loop.
 *
 * Remote runners still claim over the lease wire (ADR-0012 /
 * `LeaseTransport`). Their claim half stays on `TaskEngine.tryClaimRunnerTask`;
 * execute stays on the runner host.
 */
import { LOCAL_EXECUTOR_ID } from "@useparley/core";
import type { TaskRow } from "./db.js";

export { LOCAL_EXECUTOR_ID };

/**
 * Executor identity tag (#312 / #315).
 *
 * `id` is `local` or a registered runner name. The concrete local path is
 * {@link InProcessExecutor} (`offer` / `drain`).
 */
export interface TaskExecutor {
  /** Stable executor identity (`local` or a registered runner name). */
  readonly id: string;
}

/**
 * Host callbacks the in-process executor needs from {@link TaskEngine}.
 *
 * Concurrency caps, durable queue transitions, and the actual spawn path
 * remain on the engine; this host is the seam that lets the claim loop live
 * behind {@link InProcessExecutor} without moving sqlite or child process
 * ownership.
 */
export interface InProcessExecutorHost {
  /** True once the daemon is shutting down (drain must not admit new work). */
  isShuttingDown(): boolean;
  /** True when the task has no runner affinity (local executor's work). */
  isLocalTask(task: TaskRow): boolean;
  /** Whether every configured concurrency cap has a free slot for `task`. */
  canAdmit(task: TaskRow): boolean;
  /** Park a pending task in `queued` when caps are full. */
  enqueue(taskId: string): void;
  /**
   * Accept a claim: reserve the in-memory admit slot and kick off the existing
   * spawn path (`run` / fix resume / fresh fix). Same behavior as the former
   * `admitAndStart`.
   */
  executeClaimed(task: TaskRow): void;
  /** Durable FIFO of `queued` tasks for concurrency drain. */
  listQueued(): TaskRow[];
  /** True when the task is already admitted (prepare in flight). */
  isAlreadyAdmitted(taskId: string): boolean;
}

/**
 * Daemon-local executor: offers tasks the engine decided should run in-process
 * (capability match with no preferred online runner, #315).
 *
 * Concurrency queue semantics (#171) are preserved: under capacity →
 * `executeClaimed` immediately; otherwise → `queued`, drained when slots free.
 * `offer` does not consult shutdown (same as pre-#312 `scheduleLocalStart`);
 * only {@link drain} refuses new admits while the daemon is going down.
 */
export class InProcessExecutor implements TaskExecutor {
  readonly id = LOCAL_EXECUTOR_ID;

  constructor(private readonly host: InProcessExecutorHost) {}

  /**
   * Offer a task for local claim. The engine only calls this when routing
   * selected the local executor (#315). Runner-affine / remote-routed tasks
   * never reach here. Under capacity the task is claimed and handed to
   * {@link InProcessExecutorHost.executeClaimed}; otherwise it is parked in
   * `queued`. Intentionally ignores shutdown so a mid-shutdown delegate at the
   * concurrency cap still becomes durable `queued` (survives the next daemon's
   * crash sweep and is re-drained on startup).
   */
  offer(task: TaskRow): void {
    if (!this.host.isLocalTask(task)) return;
    if (this.host.canAdmit(task)) {
      this.host.executeClaimed(task);
      return;
    }
    this.host.enqueue(task.id);
  }

  /**
   * Drain the durable concurrency queue: claim and start any queued task that
   * now fits under its caps. Re-lists after each admit so slot counts stay
   * accurate. Caller supplies re-entrancy guarding if needed.
   */
  drain(): void {
    if (this.host.isShuttingDown()) return;
    let progressed = true;
    while (progressed) {
      progressed = false;
      let queued: TaskRow[];
      try {
        queued = this.host.listQueued();
      } catch {
        // DB may already be closed (tests / shutdown race).
        return;
      }
      for (const task of queued) {
        if (this.host.isAlreadyAdmitted(task.id)) continue;
        if (!this.host.canAdmit(task)) continue;
        this.host.executeClaimed(task);
        progressed = true;
        // Re-list after each admit so slot counts stay accurate.
        break;
      }
    }
  }
}

/** True when a task is runner-affine (remote lease path). */
export function hasRunnerAffinity(task: Pick<TaskRow, "runner">): boolean {
  return task.runner !== null && task.runner !== "";
}
