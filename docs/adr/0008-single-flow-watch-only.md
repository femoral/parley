# ADR-0008: one flow — `delegate` is always async, `watch` is the only wait

**Status**: accepted; **exit-0 clause amended by ADR-0019** · **Date**: 2026-07-14

> **Amended by ADR-0019**: `watch` remains the only blocking primitive and the
> single exit-code vocabulary stands, but **0 now means the session is finished**
> (every subject terminal — runs as well as tasks — and every event acked) rather
> than all-done over watched tasks. Runs add no new wait primitive and no new exit
> code.

## Context

Parley shipped two orchestration flows: a blocking single-task loop
(`delegate --wait` / `answer --wait`, exit codes 0/1/3/4/5 with `completed`
= 0) and the fan-out inbox loop (`watch`, ADR-0007, exit codes 0/2/3/4/5/6
with all-done = 0 and `completed` = 6). The flows overlap entirely — the
inbox loop handles n=1 exactly as well — but their diverging exit-code
vocabularies forced orchestrators (and the skill) to carry both contracts
and a table explaining how they differ. Two ways to wait is cognitive load
with no capability gain.

## Decision

- **`delegate` always returns immediately** with `{task_id, name, state:
  "pending", seq}`. The `--wait` flag is removed.
- **`answer <task> "<answer>"` posts the answer and returns immediately.**
  Its `--wait` flag is removed. The next `watch` call delivers whatever the
  resumed child does next.
- **`watch` is the only blocking primitive.** The single-task flow is the
  fan-out flow with one task: delegate, then run the ADR-0007 ack loop
  until exit 0.
- **One exit-code vocabulary.** State-typed exits exist only on `watch`
  (0 all-done · 3 awaiting_answer · 4 stalled · 5 failed · 6 completed ·
  2 usage). `delegate` and `answer` exit 0 (accepted) or 2 (usage).
- `--answer-timeout` (stall deadline for an unanswered question) is
  unchanged — it is daemon-side and flow-independent.
- **Clean break**: passing `--wait` is a usage error (exit 2), consistent
  with ADR-0007's removal of `--until`/`--since`. Accepted pre-1.0.

## Consequences

- Orchestrators learn one loop; the skill documents one loop; the
  "watch codes vs delegate --wait codes" divergence disappears.
- Tests and docs that used `delegate --wait` as a convenience migrate to
  delegate + watch (or poll `status` where a test needs a state mid-flight).
- The daemon's long-poll machinery for `--wait` (per-task wait on the
  delegate/answer HTTP paths) can be deleted; the inbox long-poll is the
  single wait path.
