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
needs a named local executor and a single handoff at task-create time rather
than an ad-hoc local-only start path. Full routing, registration, and mirrors
are later tickets; this ADR records the structural prefactor from #312.

## Decision

- **Naming + one concrete local executor.** `#312` introduces
  `packages/daemon/src/executor.ts` with `LOCAL_EXECUTOR_ID` (`"local"`), a
  thin `TaskExecutor` identity tag (`{ readonly id: string }` only), and
  **`InProcessExecutor`** with the real methods: `offer` (new work) and
  `drain` (concurrency queue). A polymorphic claim/execute interface shared
  with remote runners is **deferred** to routing work (#315 / #311) — not
  invented here.
- **Engine handoff at insert.** After a task row is inserted, the engine calls
  `dispatchClaim`: runner-affine → wake lease long-polls; local →
  `localExecutor.offer`. That replaces the former `scheduleLocalStart` site
  for `delegate` / `fix` / run-step spawn. Concurrency queue semantics (#171)
  are unchanged: under capacity → admit immediately; otherwise → `queued`,
  drained when slots free (`InProcessExecutor.drain`).
- **Runner wire unchanged in #312.** Remote claim remains
  `tryClaimRunnerTask` / `leaseRunnerTask` with oldest-pending-per-named-runner
  affinity. Capability matching across executors (including preferring runners
  over `local`) is follow-on work.
- **Out of scope / still direct-spawn.** Not every local spawn goes through
  the executor. In particular, **stall recovery** —
  `TaskEngine.answer` on a `stalled` task calls `resume` / `run` directly
  (bypassing `dispatchClaim`, the executor, and concurrency-cap accounting) —
  is deliberately identical to develop and untouched in #312. Routing work
  must not assume stall revive is behind `InProcessExecutor`.

## Consequences

- Local `delegate` / `fix` / run-step insert, retries into the queue,
  concurrency, and runner lease keep the same observable behavior — the
  prefactor is structural only (plus the explicit stall-path carve-out above).
- Later routing can treat `local` as one registered executor, grow a real
  claim surface on `TaskExecutor`, advertise daemon host capabilities, and
  fail or queue on no-match without rewriting the spawn stack.
- No schema migration, wire change, CLI flag, or HTTP surface change in the
  implementing ticket. Runner package and `packages/core/src/lease.ts` stay
  out of scope for the prefactor.
