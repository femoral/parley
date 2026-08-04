# Remote runners

Remote runners (ADR-0012 / #111, routing ADR-0032 / #315) execute delegated
tasks on another host while one daemon remains the source of truth. The
orchestrator surface (`delegate` / `watch` / `answer` / inbox) is unchanged;
remote-ness is either an automatic capability match or an explicit pin.

## Shape

- **Daemon**: holds all task state; registers runners under `runners.<name>.token`.
- **Runner** (`parley-runner` / `@useparley/runner`): long-lived process on the
  remote host that authenticates *outbound* to the daemon, registers
  capabilities, leases pending tasks it can run, executes them locally, and
  streams results back.
- **Routing** (ADR-0032 / #315): unpinned tasks match advertised vendors;
  online runners are preferred over the daemon; `--runner <name>` remains a
  hard pin. Workspace-bound work (`--cwd`, local worktrees, run-owned steps,
  fix-of-local-parent) always stays in-daemon.
- **Affinity pin**: `parley delegate --runner <name>` forces that runner when
  it advertises the vendor.

Firewall model: the daemon needs **no** credentials to any host. Runners need
exactly one outbound URL + token. Works through NAT.

## Daemon setup

In `~/.parley/parley.json` (or `$PARLEY_HOME/parley.json`):

```json
{
  "runners": {
    "gpu": { "token": "generate-a-long-random-secret" }
  },
  "daemon": {
    "routing": {
      "queueTimeoutMs": 3600000
    }
  }
}
```

- `runners.<name>.token` — bearer for that runner (required).
- `daemon.routing.queueTimeoutMs` — max wait when capable executors exist but
  none is online (or a remote-routed task is never claimed); default **1 hour**.
  Overridable in tests via `PARLEY_ROUTING_QUEUE_TIMEOUT_MS`.

The daemon re-reads this file for auth on each runner request (same hot posture
as profiles). Restart is not required to add a runner token, but the runner
process must be started with the matching name and token. The name `local` is
reserved for the daemon in-process executor and is rejected at register.

Expose the daemon so runners can reach it. Default bind is loopback-only
(`daemon.bind` defaults to `127.0.0.1`). For remote hosts set e.g.
`"daemon": { "bind": "0.0.0.0" }` on the daemon; bearer auth is then mandatory
for every non-loopback peer (runner token on `/runner/*` and on hub-proxied
child traffic). Parley does not implement TLS — use a private/overlay network
(Tailscale, WireGuard, LAN) or a TLS-terminating reverse proxy in front; see
[ADR-0030](../adr/0030-client-auth-and-bind-posture.md). Child contract calls
from the remote child go through the **runner's local hub proxy**, which
forwards `/child/*` and `/mcp` to the daemon with the runner bearer token —
children never need direct daemon reachability.

## Runner install and config

On the remote host:

```bash
# From a published install (or workspace link):
pnpm add -g @useparley/runner
# or run from the monorepo: pnpm exec parley-runner
```

Create `runner.json` (or pass flags / env):

```json
{
  "daemonUrl": "https://parley.example.com",
  "name": "gpu",
  "token": "generate-a-long-random-secret",
  "repos": {
    "/home/orch/src/myrepo": "/home/runner/src/myrepo"
  },
  "worktreesDir": "/home/runner/.parley-runner/worktrees"
}
```

| Field | Env override | Meaning |
| --- | --- | --- |
| `daemonUrl` | `PARLEY_RUNNER_DAEMON_URL` | Daemon base URL (no trailing slash) |
| `name` | `PARLEY_RUNNER_NAME` | Must match `runners.<name>` on the daemon |
| `token` | `PARLEY_RUNNER_TOKEN` | Must match `runners.<name>.token` |
| `repos` | — | Map of daemon-recorded repo path → local clone |
| `worktreesDir` | `PARLEY_RUNNER_WORKTREES` | Parent dir for worktrees on this host |
| (config path) | `PARLEY_RUNNER_CONFIG` | Path to `runner.json` |

```bash
parley-runner --config ./runner.json
# or
parley-runner --daemon-url https://parley.example.com --name gpu --token '…'
```

### Repo mapping

At `delegate` time the daemon records the orchestrator's repo path (absolute)
on the task. The runner maps that identifier to a **local clone** via `repos`.
Matching is exact key first, then basename. Keep clones on the runner host
updated (fetch regularly); the runner cuts a worktree from the recorded
`base_sha` / `base_ref`.

### Vendor adapters

The runner embeds the same adapter registry as the daemon (builtins plus any
`vendors.<id>.plugin` adapters configured on the runner host). On register it
advertises whatever that registry can load, with model catalogs from each
adapter's discovery hooks. Install vendor CLIs on the runner host the same way
you would for local execution. Sandbox postures apply on the runner host
exactly as they would locally.

## Delegate and review flow

```bash
# On the orchestrator host (daemon machine or CLI pointed at it):
parley delegate --runner gpu -v codex -m … "implement feature X"
parley watch   # same inbox semantics
```

Runner-affine tasks stay `pending` until the named runner leases them — they are
**never** picked up by the local engine spawn path. After lease they go
`running` and heartbeats refresh the lease (default 90s window; missed heartbeat
→ `failed` with a runner-lost error).

### Branch handoff

On completion the runner:

1. Pushes the task branch (`parley/<id>-…`) to the repo's `origin`
2. Reports the branch name to the daemon

**The runner host needs push access to `origin`.** Configure git credentials
(SSH deploy key, HTTPS token, etc.) for the runner user.

The report envelope's `worktree` is **null** for remote tasks (nothing local to
review). Fetch and review the pushed branch:

```bash
git fetch origin parley/t42-feature
git checkout parley/t42-feature
# or open a PR from that branch
```

`parley clean` is a no-op for remote tasks (no local worktree). Logs and the
report remain on the daemon (`parley logs`, `parley status`).

### Graceful shutdown

`SIGINT` / `SIGTERM` stop leasing new tasks and fail or finish the in-flight
task (heartbeat-fail if the child is aborted mid-run).

## Registration and fleet view (ADR-0029 / #314)

On start (and every reconnect / periodic re-fingerprint) the runner probes its
host for vendor bins and adapter model catalogs, then calls
`POST /runner/register`. The daemon upserts a `runners` row; lease is rejected
until registration succeeds. Status (online / offline / stale) is derived from
open lease long-polls plus a short grace window on `last_seen`.

```bash
parley runners list          # name, status, vendors, last-seen
parley runners list --json
```

## API surface (daemon)

Bearer auth: `Authorization: Bearer <token>` checked against
`runners.<name>.token` (401 otherwise).

| Route | Role |
| --- | --- |
| `POST /runner/register` | Fingerprint + upsert capabilities (required before lease); name `local` reserved |
| `POST /runner/lease` `{runner}` | Long-poll (~25s → 204) for oldest **capability-matched** pending task (vendor + affinity); leases → `running` + full spec; doubles as presence |
| `POST /runner/tasks/:id/heartbeat` | Refresh lease |
| `POST /runner/tasks/:id/events` `{lines}` | Append vendor JSONL + usage/session extraction |
| `POST /runner/tasks/:id/branch` `{branch}` | Record branch (worktree stays null) |
| `POST /runner/tasks/:id/fail` `{error}` | Runner cannot execute / child exited without report |
| `GET /runners` | Fleet table for `parley runners list` |

Child contract calls use the existing `/child/*` and `/mcp` endpoints (via the
runner hub proxy).

## Related

- ADR-0012 — remote runners decision record
- ADR-0029 — registration / advertisement wire
- ADR-0032 — capability-matched routing
- ADR-0011 — child HTTP/CLI channels (what the hub proxy forwards)
- `docs/agents/adapter-authoring.md` — vendor adapter contract
