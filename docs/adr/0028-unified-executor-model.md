# ADR-0028: Unified executor model

**Status**: accepted · **Date**: 2026-08-03 · **Decided**: [#312](https://github.com/femoral/parley/issues/312) (parent [#311](https://github.com/femoral/parley/issues/311), routing [#304](https://github.com/femoral/parley/issues/304))

## Context

The daemon has two ways a pending task begins execution:

1. **Local (in-daemon)** — `delegate` / `fix` / run-step insert ended with a
   direct-spawn special case (`scheduleLocalStart`): admit under concurrency
   caps or park in `queued`, then spawn inside `TaskEngine`.
2. **Remote runner** — affinity-tagged tasks stay `pending` until a runner
   long-polls `POST /runner/lease`; the engine claims them
   (`pending → running`) and the runner process executes on its host
   (ADR-0012).

Distributed execution (#311) makes the daemon one executor among many, with
capability-matched claim and fleet surfaces (info, runners list, Cove). That
requires a single claim-shaped handoff rather than a local-only direct-spawn
path. Full routing, registration, and mirrors are later tickets; this ADR
records the structural model introduced by the #312 prefactor.

## Decision

- **Claim-shaped executor surface.** An executor claims work it can run, then
  executes it. Types live in `packages/daemon/src/executor.ts`:
  `TaskExecutor`, `ExecutorClaim`, `LOCAL_EXECUTOR_ID` (`"local"`).
- **Daemon-local execution is an in-process executor.**
  `InProcessExecutor` claims non-runner-affine tasks and runs them via the
  existing spawn path (`admitAndStart` → `run` / fix / resume). Concurrency
  queue semantics (#171) are unchanged: under capacity → claim immediately;
  otherwise → `queued`, drained when slots free (`InProcessExecutor.drain`).
- **Engine claim handoff.** After a task row is inserted, the engine calls
  `dispatchClaim`: runner-affine → wake lease long-polls; local →
  `localExecutor.offer`. The engine no longer special-cases local spawn at
  the claim site.
- **Runner wire unchanged in #312.** Remote claim remains
  `tryClaimRunnerTask` / `leaseRunnerTask` with oldest-pending-per-named-runner
  affinity. Capability matching across executors (including preferring runners
  over `local`) is #311 follow-on work; this ADR only places local execution
  behind the same conceptual claim surface.

## Consequences

- Local delegation, retries, stall detection, concurrency, and runs keep the
  same observable behavior — the prefactor is structural only.
- Later routing can treat `local` as one registered executor, advertise
  daemon host capabilities, and fail or queue on no-match without rewriting
  the spawn stack.
- No schema migration, wire change, CLI flag, or HTTP surface change in the
  implementing ticket. Runner package and `packages/core/src/lease.ts` stay
  out of scope for the prefactor.
