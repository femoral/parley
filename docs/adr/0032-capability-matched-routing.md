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

At pre-insert `delegate` (and the equivalent create paths for fix / run steps),
the engine chooses **placement once** and persists it on `tasks.placement`
(`local` | `remote`). `dispatchClaim` **honors** that column and never
re-derives a different side:

- `placement = local` → only `InProcessExecutor.offer` (clear any wait fields).
- `placement = remote` → only runner wake / routing-wait machinery. When no
  capable runner remains online, the row stays in wait until
  `routing_deadline_at` fails it with the capability diagnosis — **never**
  falls back to local (even if the daemon advertises the vendor). Fix
  reattempts inherit the parent's placement.

Decision order among the fleet (after placement is set / at re-dispatch):

1. **Repo-reachability exclusion** (#317): drop any runner with a recorded
   claim-time git failure for this task's `repo_key` (`runners.unreachable_repos`).
   Excluded runners are named in no-match / wait diagnoses
   (`gpu excluded: cannot reach host/path (push denied)`).
2. **Hard pin** (`runner` set): only that executor among the eligible pool;
   pin excluded or incapable → fail with diagnosis.
3. **Warm clone** (#318): among capable online runners, prefer those that
   advertise the task's `repo_key` in `held_mirrors` (managed bare under
   `$PARLEY_HOME/clones/`). The daemon's own clones count for `local`.
4. **Warm executor** (#315): among remaining online capable runners (or among
   warm-clone holders when any exist), prefer most recent `last_completed_at`,
   then name ASC. Unpinned claim uses a short reservation window for that
   preferred peer.

Delegate-time decision that *sets* placement:

1. **Workspace-bound → local**: run-owned steps, `--cwd` / `use_worktree:false`,
   launch-template free-form vendors (#195) unpinned, and local-only capability.
2. **Hard pin** (`runner` set): only that executor; incapable → fail with
   diagnosis; online/offline capable → `remote` (wait + deadline).
3. **Unpinned**: among capable executors, **online runners preferred over
   local** → `remote`; else local if capable → `local`; else capable-but-offline
   → `remote` wait; else fail before insert.
4. The pin name `local` is rejected at delegate (reserved for the in-process
   executor; omit `--runner` to run locally).

No-origin repos (`repo_fetch_url` null) reject both hard pins and automatic
remote decisions at delegate with a clear diagnosis.

Legacy rows with `placement` null keep the old workspace-bound heuristics on
re-dispatch only.

### Claim (pull)

`selectClaimablePendingTask` replaces name-pinned claim:

- `pending` + vendor advertised by the claimer + affinity null or equals claimer
- **Fail-once-then-avoid** (#317): candidates whose `repo_key` is in the
  claimer's `unreachable_repos` are skipped. Warm ranking also drops peers
  that cannot reach the candidate's `repo_key`, so an excluded-but-warm
  runner does not hold the reservation for a task it will never claim.
- **Warm reservation** (#315): for unpinned tasks, within
  `WARM_CLAIM_RESERVATION_MS` (5s) of `created_at`, only the warm-preferred
  *eligible* online peer (most recent `last_completed_at`, then name ASC) may
  claim; after the window any capable online claimer may take the task. If the
  preferred peer is not online (or is excluded), any capable claimer may take
  it immediately.
- On claim: set `runner` to the claimer; clear `queue_reason` and
  `routing_deadline_at`.

### Git-auth memory and self-clear (#317)

A claim-time git failure (`git_auth` category on the fail wire) fails that
task and records `executor × repo_key` unreachability on the runner row
(`runners.unreachable_repos` JSON map). Routing and claim skip the pairing
until the runner **re-registers** — which clears the map. Re-registration
happens on:

- runner **restart** (cold start always calls `/runner/register`), and
- **periodic re-fingerprint** (default every 60s via
  `PARLEY_RUNNER_REFINGERPRINT_MS` / `DEFAULT_RUNNER_REFINGERPRINT_MS`), which
  hits the same upsert path and restores eligibility without a process restart.

The fail wire accepts only closed-set `operation` (`clone`|`fetch`|`push`) and
`code` (the seven claim-time git codes); invalid enums are rejected with 400.
Wire `repo_key` / `runner` are ignored — the daemon always uses the task row's
`repo_key` and the authenticated runner name.

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
- ADR-0031 repo identity and managed mirrors (claim-time git codes)
- `docs/agents/remote-runners.md`
- Issues: [#315](https://github.com/femoral/parley/issues/315),
  [#317](https://github.com/femoral/parley/issues/317)
