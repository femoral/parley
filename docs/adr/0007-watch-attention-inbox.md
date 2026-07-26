# ADR-0007: `watch` is an acked attention inbox, not a transition watcher

**Status**: accepted; **two clauses superseded by ADR-0019** · **Date**: 2026-07-14 · **Decided**: [#91](https://github.com/femoral/parley/issues/91) (subsumes [#89](https://github.com/femoral/parley/issues/89))

> **Superseded by ADR-0019** (workflow runs in the inbox), which widens the inbox
> subject from `{ task }` to `{ task } | { gate }`:
>
> - **Exit codes.** The code no longer picks the verb — it reports the tier, and
>   the orchestrator reads the payload to learn whether the subject is a task or a
>   run. No exit code is added.
> - **All-done.** Exit 0 becomes "the **session** is finished" — every subject
>   terminal, runs included. The task-only definition below reports all-done
>   between two nodes of a live pipeline, which is #89 in run clothing.
>
> Everything else in this ADR — level-triggered delivery, the four tiers, the ack
> loop, supersession, consumption scope — stands unchanged.

## Context

`watch` was edge-triggered: snapshot a seq baseline, block until a transition
after it. Three failures observed orchestrating a 12-task fan-out: `--until
attention` hangs forever once every task is terminal (#89); a task already
`awaiting_answer` at start never triggers (edge, not level); and no single
stop condition expresses the orchestrator's real need. Correctness depended on
hand-threading `--since` seqs. The orchestrator also had no guidance on *order*
— a pending question deserves action before a completed task's review.

## Decision

- `watch` delivers **pending events** from a per-**orchestrator-session
  inbox**: each task contributes at most its *current* actionable state
  (`awaiting_answer`, `stalled`, `failed`, `completed`) if un-acked. Derived
  view over task states + acks — level-triggered by construction.
- **Priority delivery**: `awaiting_answer` > `stalled` > `failed` >
  `completed`; FIFO by seq within a tier. The daemon decides order — the skill
  tells the orchestrator to act on what it's handed (questions first by
  design), not to choose.
- **Ack loop**: `parley watch [--ack <event-id>]` acks the previous event,
  then returns the next pending one (blocking if none yet). Event id = the
  transition seq that produced the state. Ack of a superseded event is a
  no-op. Un-acked events are redelivered (at-least-once).
- **Supersession/collapse**: a task leaving an actionable state auto-resolves
  that event; `parley answer` therefore implicitly consumes the question
  event.
- **Exit codes**: 3 `awaiting_answer`, 4 `stalled`, 5 `failed`, 6 `completed`,
  0 **all-done** (all watched tasks terminal and all events acked), 2 usage.
  3/4 stay shared with `delegate --wait` / `answer --wait`.
- **Clean break**: `--until` and `--since` are removed. `--follow` survives
  unchanged as the no-ack JSONL firehose. Positional task refs survive as a
  filter narrowing the session inbox. Consumption scope resolves like
  `status`: `--session` flag, else `PARLEY_SESSION_ID`, else latest session.

## Consequences

- Canonical loop needs no flags, no seq threading, cannot hang:
  `ev=$(parley watch --json); while [ $? -ne 0 ]; do handle; ev=$(parley watch --json --ack <id>); done`
- Orchestrator crash between delivery and ack redelivers the event — safe.
- #89's hang is structurally impossible: all-terminal + all-acked is exit 0.
- Ack state persists per task/state in the daemon DB; a `completed` task stays
  in the inbox until reviewed-and-acked, making "merge the fan-out" a drain,
  not a poll.
- Breaking change for any script using `--until`/`--since`; accepted pre-1.0.
