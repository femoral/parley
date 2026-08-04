# ADR-0032: Capability-matched routing

**Status**: accepted · **Date**: 2026-08-03 · **Decided**: [#315](https://github.com/femoral/parley/issues/315) (parent [#311](https://github.com/femoral/parley/issues/311), policy [#304](https://github.com/femoral/parley/issues/304))

## Context

After runner registration (#314) and the unified executor handoff (#312), tasks
still needed either an explicit `--runner` pin or in-daemon execution. That
missed automatic placement, fail-fast when no executor can run a vendor, and a
visible wait when capable runners exist but are offline.

## Decision

### Requirements and affinity

Tasks keep **requirements** as the existing `vendor` / `model` columns and
optional **hard affinity** as `tasks.runner` from `--runner`. Unpinned tasks
leave `runner` null until a remote claimer is recorded at lease time.

### Matching order (dispatch)

At `dispatchClaim` (and pre-insert at `delegate`):

1. **Workspace-bound → always local** (never remote):
   - run-owned step tasks (`run_id` set; pre-materialized workspaces)
   - tasks with a local worktree already cut
   - fix reattempts of a local parent (`parent.runner` null)
   - `--cwd` / `use_worktree: false` (forced local at delegate)
2. **Hard pin** (`runner` set): only that executor; incapable → fail with
   diagnosis; online → remote wait; offline capable → queue-with-reason.
3. **Unpinned**: among capable executors, **online runners preferred over
   local**; else local if capable; else capable-but-offline → wait; else fail.
4. **Launch-template free-form vendors** (#195): unpinned always local.

No-origin repos (`repo_fetch_url` null) reject both hard pins and automatic
remote decisions at delegate with a clear diagnosis.

### Claim (pull)

`selectClaimablePendingTask` replaces name-pinned claim:

- `pending` + vendor advertised by the claimer + affinity null or equals claimer
- **Warm reservation** (#315): for unpinned tasks, within
  `WARM_CLAIM_RESERVATION_MS` (5s) of `created_at`, only the warm-preferred
  online peer (most recent `last_completed_at`, then name ASC) may claim; after
  the window any capable online claimer may take the task. If the preferred
  peer is not online, any capable claimer may take it immediately.
- On claim: set `runner` to the claimer; clear `queue_reason` and
  `routing_deadline_at`.

### Timeout durability

Every remote-routed pending task carries a durable
`routing_deadline_at` (ISO). Capable-but-offline also sets `queue_reason`
(`waiting for capable runner: … (offline)`). Timeout =
`daemon.routing.queueTimeoutMs` / `PARLEY_ROUTING_QUEUE_TIMEOUT_MS` (default 1 h).

On engine construction, overdue deadlines fail with the timeout diagnosis;
unexpired deadlines re-arm in-memory timers. Register / lease-poll enter
re-evaluate waits and wake claimers.

### Daemon capabilities

Local vendors: `detectHarnesses` — config `vendors.<id>.bin`, then
`PARLEY_<VENDOR>_BIN` env (same as adapters), then default binary on PATH;
plus non-builtin plugin adapters in the registry. Fleet inventory is
short-TTL cached on the engine.

The name `local` is reserved; `POST /runner/register` rejects it.

### Crash sweep

Only local `running` / `awaiting_answer` tasks are stalled on restart.
Pending (including routing waits) and concurrency-queued tasks survive.

## Consequences

- Unpinned work can land on a capable remote runner without `--runner`.
- Workspace-bound paths never orphan a local worktree onto a remote claim.
- Offline / never-polling runners cannot strand tasks forever.
- Operators configure wait with `daemon.routing.queueTimeoutMs`.

## Related

- ADR-0012 remote runners · ADR-0028 unified executor · ADR-0029 registration
- `docs/agents/remote-runners.md`
