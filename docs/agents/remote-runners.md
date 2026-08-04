# Remote runners

Remote runners (ADR-0012 / #111; distributed-execution program #311) execute
delegated tasks on another host while one daemon remains the source of truth.
The orchestrator surface (`delegate` / `watch` / `answer` / inbox) is unchanged;
remote-ness is either an automatic capability match or an explicit pin.

## Contract (end-to-end)

One consistent lifecycle for every remote-capable fleet:

1. **Register** — operator pre-declares `runners.<name>.token` on the daemon;
   the runner process dials out with that name + bearer token and
   `POST /runner/register`s a self-fingerprinted advertisement (vendors +
   model catalogs + held managed-mirror keys).
2. **Advertise** — periodic re-fingerprint refreshes capabilities (and clears
   git-auth avoidance memory) without a process restart.
3. **Route** — at task create, the daemon picks **placement once**
   (`tasks.placement` = `local` | `remote`) from vendor requirements, optional
   `--runner` pin, workspace bounds, and fleet online state (ADR-0032).
4. **Claim** — online runners long-poll `POST /runner/lease` for the oldest
   **capability-matched** pending task (vendor advertised; affinity null or
   equal to the claimer; not excluded for this `repo_key`).
5. **Sync** — at claim, the executor ensures a **managed bare mirror** (or
   optional `repos` override), fetches, verifies `base_sha`, and
   **preflight-pushes** the base sha to the task branch with the host's ambient
   git credentials (ADR-0031). Failures here never spawn a vendor.
6. **Execute** — cut worktree, spawn the vendor adapter, stream events, heartbeat.
7. **Handoff** — push the finished branch to `origin`, report branch name;
   report `worktree` is null for remote tasks.
8. **Diagnose** — claim-time git failures are categorized (`git_auth`) and
   remember executor×repo unreachability until re-register; lost-runner
   heartbeats fail with phase, branch, and last-event age (#317 / #319).

Firewall model: the daemon needs **no** credentials to any host. Runners need
exactly one outbound URL + token. Works through NAT.

## Shape

- **Daemon**: holds all task state; is itself one executor (`local`); registers
  runners under `runners.<name>.token`; optional remote clients under
  `clients.<name>.token` (ADR-0030).
- **Runner** (`parley-runner` / `@useparley/runner`): long-lived process on the
  remote host that authenticates *outbound* to the daemon, registers
  capabilities, leases pending tasks it can run, executes them locally, and
  streams results back.
- **Routing** (ADR-0032 / #315): unpinned tasks match advertised vendors; online
  runners are preferred over the daemon; among runners, **warm clone**
  (`held_mirrors` contains the task's `repo_key`) then warmest recent
  completion; `--runner <name>` remains a hard pin. Placement is persisted once
  at create and never flips a remote-routed row to local. Workspace-bound work
  (`--cwd`, local worktrees, run-owned steps, fix-of-local-parent) is always
  `local`.
- **Affinity pin**: `parley delegate --runner <name>` forces that runner when
  it advertises the vendor (or waits / fails with a diagnosis if not).

## Daemon setup

In `~/.parley/parley.json` (or `$PARLEY_HOME/parley.json`):

```json
{
  "runners": {
    "gpu": { "token": "generate-a-long-random-secret" }
  },
  "clients": {
    "laptop": { "token": "generate-another-long-random-secret" }
  },
  "daemon": {
    "bind": "0.0.0.0",
    "routing": {
      "queueTimeoutMs": 3600000
    }
  }
}
```

| Setting | Role |
| --- | --- |
| `runners.<name>.token` | Bearer for that runner (required). Name `local` is reserved. |
| `clients.<name>.token` | Bearer for a remote CLI / UI principal (ADR-0030). Separate namespace from runners. |
| `daemon.bind` | Listen address (default `127.0.0.1`). Cold — requires restart. |
| `daemon.routing.queueTimeoutMs` | Max wait when capable executors exist but none is online (or a remote-routed task is never claimed); default **1 hour**. Test override: `PARLEY_ROUTING_QUEUE_TIMEOUT_MS`. |

The daemon re-reads runner/client tokens for auth on each request (same hot
posture as profiles). Restart is not required to add a runner token, but the
runner process must be started with the matching name and token.

### Bind and auth posture (ADR-0030)

Default bind is loopback-only and tokenless for local use. For remote hosts set
e.g. `"daemon": { "bind": "0.0.0.0" }`. **Bearer auth is mandatory for every
non-loopback peer** (peer-address enforcement, not bind alone):

- `/runner/*` — runner token (also required on loopback)
- `/child/*`, `/mcp` — runner token bound to the active lease holder while the
  task executes (via the runner's hub proxy)
- Client surface (`/health`, `GET /runners`, UI API, …) — client token only
- Config writes — **forbidden** off-loopback regardless of token

Parley speaks plain HTTP. Documented postures:

1. **Private / overlay networks** (common case) — Tailscale, WireGuard, or LAN;
   tokens authorize principals on that network.
2. **TLS-terminating reverse proxy** — for public exposure; cert lifecycle stays
   outside parley.

Child contract calls from the remote child go through the **runner's local hub
proxy**, which forwards `/child/*` and `/mcp` to the daemon with the runner
bearer token — children never need direct daemon reachability.

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
  "worktreesDir": "/home/runner/.parley-runner/worktrees"
}
```

| Field | Env override | Meaning |
| --- | --- | --- |
| `daemonUrl` | `PARLEY_RUNNER_DAEMON_URL` | Daemon base URL (no trailing slash) |
| `name` | `PARLEY_RUNNER_NAME` | Must match `runners.<name>` on the daemon |
| `token` | `PARLEY_RUNNER_TOKEN` | Must match `runners.<name>.token` |
| `repos` | — | **Optional** override: repo key → operator-managed clone |
| `worktreesDir` | `PARLEY_RUNNER_WORKTREES` | Parent dir for worktrees on this host |
| (config path) | `PARLEY_RUNNER_CONFIG` | Path to `runner.json` |

```bash
parley-runner --config ./runner.json
# or
parley-runner --daemon-url https://parley.example.com --name gpu --token '…'
```

### Managed mirrors (default)

With no `repos` config the runner creates/updates a **parley-managed bare
mirror** under `$PARLEY_HOME/clones/<encoded-repo-key>/` from the lease's
`repo_fetch_url` (ADR-0031 / #316). Encoding is injective (readable slug plus a
short hash of the raw key). On claim it fetches with prune, verifies `base_sha`
(direct sha fetch as fallback), **preflight-pushes** the base sha to the task
branch (real push — so permission / hooks fail before the vendor spawns), cuts
a worktree, runs the vendor, then pushes the branch tip to origin. Concurrent
runners sharing one parley home serialize cold clones with a per-mirror lock
and clone-into-temp + rename. The host's **ambient git credentials** (SSH agent,
credential helper, deploy keys) are used throughout — parley never ships tokens.

If the task fails after a successful preflight and the branch was never
recorded as handed off, the runner best-effort deletes the remote preflight
ref (`git push origin :refs/heads/<branch>`). If that cleanup fails, a residual
zero-diff branch may remain on origin until an operator removes it.

The daemon in-process executor reuses the same mirror module for local
placement when the same-host fast path does not apply (#318). Operators reclaim
disk with `parley clones list|prune` on the daemon host (prune removes only
mirrors whose `repo_key` is not referenced by any live non-terminal task).

### Optional repo override

`repos` maps a **repo key** (e.g. `github.com/org/repo`) to an operator-managed
existing clone when you do not want parley to own the mirror. Matching is
**exact key only** (no basename fallback — `…/acme/api` must not match
`…/other/api`). Claim-time fetch / base_sha / push preflight still run against
that clone. Greenfield: pre-provisioned clones and a mandatory path map are
**not** required.

### Vendor adapters

The runner embeds the same adapter registry as the daemon (builtins plus any
`vendors.<id>.plugin` adapters configured on the runner host). On register it
advertises whatever that registry can load, with model catalogs from each
adapter's discovery hooks. Install vendor CLIs on the runner host the same way
you would for local execution. Sandbox postures apply on the runner host
exactly as they would locally.

## Registration and fleet view (ADR-0029 / #314 / #320)

On start (and every reconnect / periodic re-fingerprint) the runner probes its
host for vendor bins, adapter model catalogs, and held managed-mirror repo keys
(`held_mirrors`), then calls `POST /runner/register`. The daemon upserts a
`runners` row; lease is rejected until registration succeeds (**403**
`runner_not_registered`). Status (`online` / `offline`) is derived from open
lease long-polls plus a short grace window on `last_seen`. Rows past the stale
window (`runnerSettings.staleWindowMs`, default 14d) are **auto-deleted** on
list/show/register (config token kept so the runner can re-register).

```bash
parley runners list                  # name, status, vendors, last-seen
parley runners list --json
parley runners show <name>           # models, held mirrors, reachability, recent tasks
parley runners show <name> --json
parley runners remove <name>         # drop registration row + runners.<name> config
parley clones list                   # managed mirrors on the daemon host
parley clones prune                  # drop unreferenced mirrors
```

**Remove semantics:** `parley runners remove` / `DELETE /runners/:name` is
loopback-only (config-admin). It deletes the SQLite row and the named config
entry (credentials). The runner's next register/lease attempt is rejected as
unknown (401). Config is written before the row is deleted so a write failure
does not orphan a live credential without a listable row. Names may contain
dots (e.g. `gpu.west`).

## Routing and claim (ADR-0032 / #315 / #317 / #318)

At pre-insert `delegate` (and fix / run-step create paths), the engine chooses
placement and may fail before insert:

| Situation | Outcome |
| --- | --- |
| Workspace-bound (`--cwd`, run-owned step, …) | Always `local` |
| No executor advertises the vendor | Fail at delegate with capability diagnosis |
| Capable executors exist but all offline | `remote` wait + `queue_reason` + durable `routing_deadline_at` |
| Online runners capable | Prefer runners over `local`; warm clone then warm executor |
| `--runner <name>` hard pin | That executor only; incapable / excluded → fail; offline → wait |
| No-origin repo + remote pin or auto-remote | Fail at delegate (remote needs `repo_fetch_url`) |

Claim is **capability-matched**, not name-pinned-only: oldest pending task whose
vendor the claimer advertises, affinity null or equals the claimer, and whose
`repo_key` is not in the claimer's `unreachable_repos`. A short warm-reservation
window prefers the warmest eligible online peer for unpinned work.

Pinned tasks stay `pending` until that runner leases them (or routing times
out). After lease they go `running` and heartbeats refresh the lease (default
90s window; missed heartbeat → `failed` with an enriched runner-lost error).

### Failures

- **Claim-time git** (`git_auth` category): clone / fetch / push codes fail the
  task before the vendor spawns and record executor×repo unreachability.
  Routing and claim skip that pairing until the runner **re-registers**
  (restart or periodic re-fingerprint).
- **Lost runner** (#319): heartbeat miss fails with `runner=<name>`,
  `phase=…` (leased / worktree / events / branch_pushed), optional `branch=…`,
  and `last_event_age_ms=…`. Not auto-retried.
- **Vendor crash**: ordinary fail path; best-effort delete of orphan preflight
  branch when handoff never completed.

## Delegate and review flow

```bash
# Automatic placement (capable online runner preferred when present):
parley delegate -v codex -m … "implement feature X"

# Hard pin:
parley delegate --runner gpu -v codex -m … "implement feature X"

parley watch   # same inbox semantics
```

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

## API surface (daemon)

Bearer auth: `Authorization: Bearer <token>` checked against
`runners.<name>.token` for `/runner/*` (401 otherwise). Client tokens apply to
the client surface when the peer is off-loopback (ADR-0030).

| Route | Role |
| --- | --- |
| `POST /runner/register` | Fingerprint + upsert capabilities (vendors, models, optional `held_mirrors`); name `local` reserved; required before lease |
| `POST /runner/lease` `{runner}` | Long-poll (~25s → 204) for oldest **capability-matched** pending task; leases → `running` + full spec; doubles as presence |
| `POST /runner/tasks/:id/heartbeat` | Refresh lease |
| `POST /runner/tasks/:id/events` `{lines}` | Append vendor JSONL + usage/session extraction |
| `POST /runner/tasks/:id/branch` `{branch}` | Record branch (worktree stays null) |
| `POST /runner/tasks/:id/fail` `{error, category?}` | Runner cannot execute / child exited without report; optional `git_auth` category |
| `GET /runners` | Fleet table for `parley runners list` (lazy stale sweep) |
| `GET /runners/:name` | Full advertisement for `parley runners show` (client class) |
| `DELETE /runners/:name` | Operator remove: row + config (loopback / config-admin) |

Child contract calls use the existing `/child/*` and `/mcp` endpoints (via the
runner hub proxy).

## Related

- ADR-0012 — original remote runners decision (affinity + lease; later program
  supersedes path-map and pin-only routing — see 0031 / 0032)
- ADR-0028 — unified executor model (`local` + dispatch handoff)
- ADR-0029 — registration / advertisement / presence wire
- ADR-0030 — client tokens and opt-in bind beyond loopback
- ADR-0031 — repo identity and managed mirrors
- ADR-0032 — capability-matched routing
- ADR-0011 — child HTTP/CLI channels (what the hub proxy forwards)
- `docs/agents/adapter-authoring.md` — vendor adapter contract
