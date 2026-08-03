/**
 * Unified executor model (#312 / ADR-0028).
 *
 * Prefactor for distributed execution (#311): daemon-local spawn and remote
 * runners share a claim-shaped handoff. This module defines the interface and
 * the in-process (daemon-local) executor. Capability-matched routing across a
 * fleet of executors is later work — this ticket is a pure structural move
 * with zero behavior change.
 *
 * Remote runners already implement the same *shape* over the lease wire
 * (ADR-0012 / `LeaseTransport`): claim → execute → heartbeat/events/fail.
 * Their claim half stays on `TaskEngine.tryClaimRunnerTask`; their execute
 * half stays on the runner host. The wire is untouched here.
 */
import type { TaskRow } from "./db.js";

/** Stable id for the daemon's own in-process executor. */
export const LOCAL_EXECUTOR_ID = "local";

/**
 * A task claimed by an executor and ready to run.
 *
 * Remote runners receive an equivalent payload as `RunnerLeaseSpec` over HTTP.
 * Local claims stay in-process and carry the task row snapshot.
 */
export interface ExecutorClaim {
  /** Executor that holds the claim (`local` or a runner name). */
  executorId: string;
  /** Task snapshot at claim time. */
  task: TaskRow;
}

/**
 * Claim-shaped executor surface (#312).
 *
 * An executor claims work it can run, then executes it. The engine's job at
 * the claim site is only: hand a pending task to the right executor (or wake
 * the waiter that will claim it). It does not special-case local spawn.
 *
 * - **In-process**: {@link InProcessExecutor} implements claim + execute
 *   inside the daemon process.
 * - **Remote runner**: claim is `tryClaimRunnerTask` / `leaseRunnerTask`;
 *   execute is the runner process (out of band of this interface today).
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
  /** True once the daemon is shutting down (no new claims). */
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
 * Daemon-local executor: claims non-runner-affine tasks and executes them
 * in-process via the engine host.
 *
 * Mirrors what a runner does over the lease wire (claim then execute) without
 * an HTTP hop. Concurrency queue semantics (#171) are preserved: under capacity
 * → claim immediately; otherwise → `queued`, drained when slots free.
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
   * `queued`.
   */
  offer(task: TaskRow): void {
    if (this.host.isShuttingDown()) return;
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
