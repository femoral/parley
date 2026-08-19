# ADR-0017: The run engine — advance, gates, bounded loops, failure, re-entry

**Status**: accepted · **Date**: 2026-07-26 · **Decided**: [#217](https://github.com/femoral/parley/issues/217), [#218](https://github.com/femoral/parley/issues/218), [#221](https://github.com/femoral/parley/issues/221) (amended by [#226](https://github.com/femoral/parley/issues/226), [#381](https://github.com/femoral/parley/issues/381), [#382](https://github.com/femoral/parley/issues/382))

## Context

ADR-0016 settles what a workflow *is*. This is what the daemon does with one: how
a run moves, where it stops, what "the step failed" means when a step owns forty
tasks, and how an orchestrator sends work backwards without corrupting the
lineage `parley fix` already owns.

## Decision

- **A run stores five states** — `running`, `blocked`, `completed`, `failed`,
  `cancelled` — plus `current_node` and `iteration`. A step stores nothing.
- **`blocked` means the run's own advance is halted**, not that a child needs
  something. A child's `awaiting_answer` never touches it: four siblings still
  working means the run is still `running`.
- **A step settles on `isSettledState`, not terminal.** `stalled` counts, or one
  child dead on an unanswered question hangs the run forever.
- **Advance order**: *settled? → ports filled? → loop? → next node.* Validation
  is deliberately absent — it lives in `submit_report` (ADR-0016). A **`from`-less
  port is exempt from the ports-filled gate**: such a port is loop-filled by
  construction, and gating on it deadlocks any workflow whose first node takes a
  loop payload.
- **Advance is a pure function**, drained off the existing `onSlotFreed` hook,
  which already fires on terminal-or-stalled. `transition.ts` and ADR-0004 are
  untouched. **Invariant:** a run must never observe a completed task whose
  deliverables have not been recorded — `onSlotFreed` is synchronous inside
  the transition, so run-owned deliverables are materialized from the accepted
  report *before* the task is marked `completed` (#264).
- **A run's definition is snapshotted at start, never re-resolved** (#381). The
  parsed definition and every prompt body it references — workflow-level, node,
  and authored slot `prompt_append` — are captured once by `run start` from the
  *client's* cwd and persisted in a run-scoped side table. Advance, status
  queries, output-port resolution and retention all read that snapshot; nothing
  on the run path touches the authoring filesystem after start. Re-resolution
  ran against the **daemon's** `process.cwd()`, which is not the caller's
  directory, and `run.repo` cannot stand in for it — it is null by construction
  for `workspace: scratch`. The snapshot makes the recorded `version`
  authoritative for the first time (a workflow edited mid-run no longer swaps
  the definition under a live run), and a **fork inherits the parent's snapshot
  by copy**, for the same reason skipped nodes are inherited by copy.
- **An unloadable definition blocks the run**, with its own `block_reason`
  (#381). It is orchestrator-fixable, so `blocked` is right and `failed` is not
  — but the previous stay-put emitted no event, no `error` and no block reason,
  which made a run wedged on a settled node indistinguishable from one still
  working.
- **A gate is a node**, not a flag on a step — a flag cannot say whether it means
  "before" or "after", and a gate's position in the sequence is its meaning. It
  spawns nothing and waits for the orchestrator. Its author declares a mandatory
  **`on_reject`** path, and it carries four verbs: **approve / reject / redirect /
  finish**. A gate is never acked, only actioned (ADR-0019).
- **Loop-budget exhaustion is an implicit gate** — neither a silent proceed nor a
  failure. The orchestrator decides.
- **An input port may `accumulate`**, collecting all completed iterations instead
  of the most recent. It is a fill rule that **never changes a type**, so it is
  legal on containers only — a scalar accumulator would have to become `T[]`, and
  is refused. Colliding dict keys resolve to the later iteration: the same key
  means the same query re-issued, so the fresher value supersedes. Loop fills
  honour the **target** port's `accumulate` flag; the loop-payload resolver does
  not override it. A `from`-less accumulating port stays exempt from the
  ports-filled gate on first entry.
- **A run never auto-fails.** Every way work goes wrong lands on `blocked`,
  including a spawn-time `DelegateError`, since every one of those is fixable
  outside the run. That gives the terminal state its definition: **`blocked` = the
  daemon cannot advance it; `failed` = nobody can** (workspace gone, definition
  unparseable).
- **`outcome: blocked` routes as a failed task** — a crashed vendor and a child
  that gave up both mean no usable work — while `partial` is a success.
- **Fan-out carries a `success` policy** — `all` | `{min}` | `{required:[slots]}`
  — defaulting to `all` for authored slots and `{min: 1}` for data, because the
  author named the three reviewers but never saw the fortieth query.
- **`retries` is opt-in per step, default 0**, fires only on task-state `failed`,
  and spawns a **fresh task**, not a fix attempt. Routing a vendor 503 through
  `attempt` would book it as rework and poison `first_attempt` in `metrics.ts`.
- **Backwards motion splits on the run's own state: `redirect` moves a live run,
  `fork` restarts a dead one.** The two never overlap, so the orchestrator never
  chooses between them. Both share the loop-back machinery; only the payload
  differs — a loop supplies `loop.with`, a redirect supplies a note.
- **A fork is a new run** (`parent_run_id` plus a run-level `attempt`) entering at
  a later node, **terminal-only** — `engine.ts:1252`'s `parley fix` guard verbatim,
  so a live run must be cancelled first. Skipped nodes are inherited **by copy at
  iteration 0**, not by reference, so run 2 survives the parent's retention clock.
  Inputs are **frozen**; the orchestrator's steer arrives as an
  `## Orchestrator note` prompt layer, not a port — untyped, aimed at one task.
- **Lineage stays at the run level.** A task-level chain could only ever be
  half-applied, and would drag fan-out siblings across runs through
  `collectAttemptChain`. A fork never resumes a vendor session, and `parley fix`
  inside a run is refused.
- **Cancelling one task inside a run** is allowed while its step is current, and
  routes as a sibling failure under the step's `success` policy.

## Consequences

- **Forking a `failed` run is the only repair `failed` has** — the state has no
  verbs of its own by design.
- A fork must distinguish **`inherited`** from **`skipped`**: a gate has no ports
  to inherit, so re-entering past an approval gate silently discards a mandatory
  human decision unless the surfaces say so loudly (ADR-0021).
- ADR-0007's inbox can no longer key on tasks alone — `allDone` would lie about a
  gated run whose tasks are all terminal. Widened in ADR-0019.
- `#215`'s declared-but-unused `reentry` field earns its meaning: the default
  `--to` for `parley run fork`.
- Runs wedged by pre-#381 daemons cannot be recovered in place — their
  authoring cwd was never persisted. They surface as `blocked` on first advance
  under the new build; `fork` or `cancel` is the repair.
- Editing a workflow or its prompts mid-run no longer affects the running run.
  Hot-editing a prompt to steer a later node is deliberately gone; the
  `## Orchestrator note` layer is the supported steer.
- Lint flags an `accumulate` declaration that cannot collect more than one
  iteration — a run-input wiring, or a source node outside every loop body —
  instead of letting it pass as a silent no-op (#382).
- **A loop blocked on budget is resumed by a verb, never by editing `loop.max`**
  (#381). A verb does not re-resolve the definition, so raising the budget on
  disk and approving no longer continues the run under the new maximum. This
  takes nothing away that the ADR offered: loop-budget exhaustion is already an
  implicit gate where the orchestrator decides, and `redirect` already moves a
  live run. Re-resolving on a verb would be the worse option — it would hand a
  run a *different* definition than it started with at the exact moment an
  operator is trying to unblock it.
- Interactive starvation stays a **configuration** question. The concurrency queue
  already skips inadmissible tasks rather than stopping at them, so thirty-eight
  queued siblings never head-of-line block a later delegate; caps are per-vendor
  *and* per-profile. No priority, no reservation.
