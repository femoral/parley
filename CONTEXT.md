# parley — domain glossary

Parley delegates coding tasks to child agent CLIs (codex, grok), each in an
isolated git worktree, coordinated by one global daemon. The human/agent
driving parley is the **orchestrator**.

## Terms

- **Orchestrator** — the agent (or human) that writes briefs, answers child
  questions, and reviews/merges branches. Parley never merges.
- **Orchestrator session** — the grouping id (`orchestrator_session_id`,
  set via `PARLEY_SESSION_ID` env > `--session` flag > ancestry; ADR-0013)
  tying together the tasks one orchestrator run spawned. The unit of listing
  filters *and* of inbox consumption.
- **Task state** — exact vocabulary: `pending`, `running`, `awaiting_answer`,
  `stalled`, `completed`, `failed`, `cancelled`. Terminal states: `completed`,
  `failed`, `cancelled`.
- **Actionable state** — a state demanding orchestrator action:
  `awaiting_answer`, `stalled`, `failed`, `completed`. Not actionable:
  `pending`, `running` (nothing to do), `cancelled` (orchestrator caused it).
- **Pending event** — a task currently in an actionable state whose state the
  orchestrator has not yet **acked**. Identified by the transition seq that
  produced the state. At most one pending event per task (see *collapse*).
- **Inbox** — the per-orchestrator-session set of pending events, delivered
  one at a time by `parley watch` in **priority order**:
  `awaiting_answer` > `stalled` > `failed` > `completed`, FIFO (oldest seq)
  within a tier. A derived view over task states + acks, not a stored queue.
- **Ack** — the orchestrator's mark that it handled a task's current
  actionable state (`watch --ack <event-id>`). Acking a **superseded** event
  is a no-op. Delivery without ack leaves the event pending — redelivered on
  the next `watch` (at-least-once).
- **Collapse / supersession** — a task leaving an actionable state
  auto-resolves that state's pending event (e.g. answering a question consumes
  its `awaiting_answer` event); the task's *new* actionable state, if any,
  becomes its pending event. Invariant: inbox size ≤ task count.
- **All-done** — the inbox exit condition: every watched task terminal *and*
  every pending event acked. `watch` exits 0; the orchestrator loop ends.
- **Firehose** — `watch --follow`: every transition streamed as JSONL, no
  ack, no priority; for UIs and debugging, not orchestration.
- **Attention** — shorthand for the states that interrupt an orchestrator:
  `awaiting_answer` and `stalled`. Exit codes 3 and 4 on `watch`
  (the only wait primitive; ADR-0008).
- **Report envelope** — the schema-validated result object a completed task
  hands back (worktree path, branch, report body).
- **Session provenance** — the identity of the orchestrator run parley records
  for eval/traceability: session id, harness, model, effort. Injected
  deterministically by a **harness plugin** as `PARLEY_SESSION_ID` /
  `PARLEY_HARNESS` / `PARLEY_MODEL` / `PARLEY_EFFORT`; never self-reported by
  the model. Harness values use parley vendor ids; sessions without a plugin
  carry explicit *unknown* provenance and are evaluated under an unknown
  bucket (ADR-0013).
- **Harness plugin** — a per-vendor package installed into the orchestrator's
  own harness (via that harness's native hook/plugin system) that exports the
  session-provenance env vars at session start. Distinct from a parley
  vendor **adapter** (ADR-0009), which is daemon-side spawn/parse plumbing.

## Avoided synonyms

- "queue" for the inbox (it is derived, not stored; no strict FIFO overall)
- "question" as a state name (the state is `awaiting_answer`)
- "done"/"finished" for individual states (say the exact state; *all-done* is
  only the inbox exit condition)
