# 12. Remote runners: lease-based executors instead of per-task sidecars

Date: 2026-07-16

## Status

Accepted

## Context

All tasks today execute on the daemon's machine: the engine cuts a worktree,
asks the vendor adapter for a `SpawnPlan`, and spawns the child locally. Users
want to run children on remote infra (bigger boxes, GPU hosts, throwaway VMs)
while keeping one daemon as the source of truth the orchestrator talks to.

Shapes considered:

1. **Per-task sidecar** — the daemon pushes each task to a remote host (ssh,
   container exec) and babysits it. Rejected: the daemon must hold reach-in
   credentials for every host, handle half-dead ssh sessions, and the model
   inverts the natural firewall direction (daemons usually can't dial into
   infra; infra can dial out).
2. **Federated daemons** — a full daemon per host, orchestrator multiplexes.
   Rejected: splits task state across databases; `watch`/inbox semantics
   (ADR-0007/0008) assume one seq stream.
3. **Persistent runner (chosen)** — a thin executor process on the remote
   host that authenticates *outbound* to the daemon, leases pending tasks
   tagged for it, executes them locally, and streams results back.

## Decision

A new package, `@useparley/runner`, installed on the remote host. One daemon,
N runners, all state in the daemon's sqlite.

- **Registration/auth**: settings gain `runners.<name>.token` on the daemon
  side; the runner is started with the daemon URL + its name + token and
  authenticates every request with the bearer token. Localhost trust never
  leaves the daemon machine.
- **Affinity**: `parley delegate --runner <name>` records the task's runner.
  Tasks without affinity keep executing in-daemon (default unchanged).
- **Lease loop**: the runner long-polls `POST /runner/lease` (name + token),
  receives one task spec (prompt, vendor, model/effort, posture, base ref,
  context files, report schema), and must heartbeat (`POST
  /runner/tasks/:id/heartbeat`); a missed heartbeat window fails the task
  with a runner-lost error — never silently stuck `running`.
- **Execution**: the runner embeds the same adapter registry and worktree
  module the daemon uses (both live in shared packages after #108): it clones
  or reuses a configured repo mapping (`runner.repos.<repo-url>: <local
  path>`), cuts the worktree there, spawns the vendor child, and relays the
  child's MCP/HTTP hub calls (`ask_orchestrator`, `submit_report`) to the
  daemon's child endpoints (ADR-0011) — the runner serves the hub URL the
  child sees, so children never need direct daemon reachability.
- **Event stream**: raw vendor JSONL is forwarded in chunks
  (`POST /runner/tasks/:id/events`) so `parley logs` and usage extraction
  behave identically for remote tasks.
- **Branch handoff**: on completion the runner pushes the task branch to the
  repo's configured git remote and reports the branch name; the report
  envelope's `worktree` is null for remote tasks (nothing local to review) —
  the orchestrator fetches the branch instead.

## Consequences

- The orchestrator surface (`delegate`/`watch`/`answer`/inbox) is unchanged;
  remote-ness is one flag plus daemon-side settings.
- The daemon needs no credentials to any host; runners need exactly one
  outbound URL + token. Works through NAT and firewalls.
- A remote task's review flow changes: fetch the pushed branch rather than
  reading a local worktree. `parley clean` is a no-op for remote tasks.
- The runner reuses adapters/worktree logic via shared packages — no forked
  execution semantics; sandbox postures apply on the runner host exactly as
  they would locally.
