# ADR-0019: Runs in the attention inbox; exit 0 means the session is finished

**Status**: accepted · **Date**: 2026-07-26 · **Decided**: [#219](https://github.com/femoral/parley/issues/219) · **Supersedes**: ADR-0007's exit-code clause and its all-done definition

## Context

ADR-0007 built the inbox out of tasks: each task contributes at most its current
actionable state, and exit 0 means every watched task is terminal and acked. A run
breaks both halves. A gate spawns nothing, so a run waiting on a human approval is
invisible; and a run whose current step is all-terminal is *mid-pipeline*, so
`allDone` would report the session finished between two nodes — the exact failure
ADR-0007 was written to kill.

Left alone, ADR-0007 would also have handed the orchestrator twelve `completed`
events before the Research pipeline's funnel had spawned.

## Decision

- **A run is an inbox subject beside the task**, not instead of it. Both kinds of
  subject deliver through one inbox.
- **Questions pierce the run's shell; outcomes do not.** A run-owned task
  contributes only `awaiting_answer` and `stalled`, against the **task** id — the
  orchestrator is the only one who can answer a question. Its `completed` and
  `failed` are **suppressed**, because the next node is their consumer.
- **Run events fold into the existing four tiers by nature**, so no fifth tier and
  no new exit code: a **gate** is tier 1 with `awaiting_answer`, **`blocked`** is
  tier 2 beside `stalled`, a run's **`failed`** is tier 3 and its **`completed`**
  tier 4. A stall-and-block collision resolves on seq alone.
- **The exit code no longer picks the verb.** It reports the tier; the orchestrator
  reads the payload to learn whether the subject is a task or a run and which verb
  applies. Affordable because the orchestrator reads the payload anyway.
- **Exit 0 means the session is finished** — *every* subject terminal, runs
  included, and every event acked. This replaces ADR-0007's task-only all-done and
  closes a re-run of #89 in run clothing.
- **`--follow` gains a `run.*` family**, including `node_entered` per node, plus
  `run_id` / `node` / `iteration` / `slot` on every `task.*` event. Without it a
  gate — which spawns nothing — is invisible to the stream.
- **A gate is never acked, only actioned by verb** (approve / reject / redirect /
  finish; ADR-0017). Acking would let an orchestrator mark a decision handled
  without making it, which is a silent hang.
- **A delivery breaker bounds the resulting starvation.** One undecided gate
  deliberately blackholes the session inbox — that is the point of a gate — so the
  daemon counts deliveries of the same event id without ack-or-action (default 10)
  and trips a new **`panicked` session state**: *enforcing*, implemented as an
  effective concurrency cap of 0, sticky across orchestrator restarts, cleared only
  by a human.

## Consequences

- **This lands as a new ADR rather than an ADR-0007 amendment** because four of its
  decisions apply to plain `delegate` sessions too: the exit-0 redefinition, the
  payload-over-exit-code rule, the delivery breaker, and `panicked`. An existing
  `watch` loop sees those change under it.
- `panicked` is the first session state parley *enforces* rather than reports. A
  runaway orchestrator that never acks now stops spawning instead of accumulating
  cost.
- Deliberate starvation is now a feature with a fuse: a gate holds the session
  until a human decides, and the fuse trips rather than the daemon guessing.
- Cove can show a held gate live while being unable to clear it — the orchestrator
  is an agent, and a second hand on the wheel is worse than a visible block
  (ADR-0021).
