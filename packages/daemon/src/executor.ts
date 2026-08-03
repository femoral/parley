/**
 * Unified executor model (#312 / ADR-0028).
 *
 * Prefactor for distributed execution (#311): names the daemon-local path as
 * an in-process executor and moves `delegate`/`fix`/run-step insert handoff
 * behind it. A polymorphic claim interface across local + runners is deferred
 * to routing work (#315 / #311). This ticket is a pure structural move with
 * zero behavior change.
 *
 * Remote runners still claim over the lease wire (ADR-0012 /
 * `LeaseTransport`). Their claim half stays on `TaskEngine.tryClaimRunnerTask`;
 * execute stays on the runner host. The wire is untouched here.
 */
import type { TaskRow } from "./db.js";

/** Stable id for the daemon's own in-process executor. */
export const LOCAL_EXECUTOR_ID = "local";

/**
 * Executor identity tag (#312).
 *
 * A name holder only in this prefactor (`id`). A polymorphic claim/execute
 * surface across local + runners is deferred to routing (#315 / #311).
 * The concrete local path is {@link InProcessExecutor} (`offer` / `drain`).
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
 * Daemon-local executor: offers non-runner-affine tasks to the in-process
 * spawn path via the engine host.
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
   * Offer a newly created (or re-offered) task for local claim.
   *
   * Runner-affine tasks are ignored — those stay pending until a remote runner
   * leases them. Under capacity the task is claimed and handed to
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
