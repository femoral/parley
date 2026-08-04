# ADR-0029: Runner registration and capability advertisement wire

**Status**: accepted · **Date**: 2026-08-03 · **Decided**: [#314](https://github.com/femoral/parley/issues/314) (detail [#303](https://github.com/femoral/parley/issues/303), surface [#309](https://github.com/femoral/parley/issues/309))

## Context

Remote runners (ADR-0012) already long-poll `POST /runner/lease` with a
pre-declared name + bearer token, but the daemon has no durable record of who
is connected or what vendors a host can run. Tasks can lease to a runner that
lacks the vendor and only fail after claim ("unknown vendor on runner").
Installing a vendor CLI on a live runner is invisible until process restart.
Operators have no fleet view.

Prior art (issue #302) is consistent: registration is separate from work
acquisition; capabilities live on a server-side record; the poll connection
doubles as presence; self-fingerprinting beats operator-declared tags for
detectable executors.

## Decision

### Protocol — register on connect

- New `POST /runner/register` (bearer auth against `runners.<name>.token`).
  Called when the runner starts and on every reconnect after a lease transport
  error. Payload:

  | Field | Meaning |
  | --- | --- |
  | `runner` | Pre-declared name (must match token) |
  | `protocol_version` | Integer wire version (`RUNNER_PROTOCOL_VERSION` in `@useparley/core`) |
  | `build_version` | Runner package version string |
  | `capabilities` | `{ vendors: [{ id, models: ModelEntry[] }], held_mirrors?: string[] }` — vendors required; optional `held_mirrors` is repo keys this host holds under `$PARLEY_HOME/clones/` (#318 / ADR-0031 / ADR-0032 warm-clone) |

- Lease long-poll stays identity-only (`{ runner }`) and **is the presence
  signal** — no separate idle heartbeat. In-task 90s heartbeat is unchanged.
- Leasing without a prior successful registration returns **403** with
  `code: "runner_not_registered"` and a clear message.
- Incompatible `protocol_version` on register returns **400** with
  `code: "protocol_version_mismatch"`, naming both sides' versions.
- Unknown names / wrong tokens remain **401** (auth before body semantics).

### Advertisement — self-fingerprinted vendors + models (+ held mirrors)

The runner probes its host:

1. **PATH** (and config `vendors.<id>.bin` / `PARLEY_FAKE_VENDOR_BIN`) via the
   shared `detectHarnesses` / `isExecutableOnPath` module
   (`packages/daemon/src/fingerprint.ts`) — same logic as CLI init, not forked.
2. **Model catalogs** per loaded adapter, including runner-side plugin adapters
   from `createAdapterRegistry`. Registration precedence is deliberately
   **disk (`readModels`) → shipped catalog → CLI (`listModels`) last**, with a
   hard timeout on discovery channels. Shipped is preferred over a live CLI
   probe when disk is empty so a multi-vendor host does not stall on hung
   vendor binaries at register time. Periodic re-fingerprint can deepen
   catalogs later.
3. **Held mirrors** (#318): `listHeldMirrorRepoKeys` on
   `$PARLEY_HOME/clones/` → optional `capabilities.held_mirrors` (repo keys
   this host already has as managed bare mirrors). Used by routing for
   warm-clone preference (ADR-0032); omitted when empty so older runners stay
   valid on the wire.

The daemon stores the last advertisement as JSON; routing (ADR-0032) matches
without loading plugin code. Re-registration also clears git-auth avoidance
memory on the runner row (ADR-0032 / #317).

### Persistence and status

SQLite `runners` table (append-only migration): `name` PK, `capabilities`,
`protocol_version`, `build_version`, `registered_at`, `last_seen`.

Status is **derived**, not stored. The fleet list only ever surfaces
`online` or `offline` under normal operation:

| Status | Rule |
| --- | --- |
| `online` | Open lease long-poll, **or** `last_seen` within grace (default `max(50s, 2× long-poll)`; `PARLEY_RUNNER_PRESENCE_GRACE_MS`, explicit `0` = no grace) |
| `offline` | No open poll and last contact past grace but still within the stale window |

**Stale auto-delete (#320):** when last contact is older than the stale window
(default 14 days; config `runnerSettings.staleWindowMs`, floor
`DEFAULT_RUNNER_PRESENCE_GRACE_MS`), the registration **row is deleted** on the
next lazy sweep (list / show / register). Open-poll runners are excluded from
the sweep. Config tokens (`runners.<name>.token`) are **not** revoked by the
sweep — only operator `DELETE /runners/:name` / `parley runners remove` does
that. Env `PARLEY_RUNNER_STALE_MS` is a **test override** of
`runnerSettings.staleWindowMs` (wins when set); not a production setting.

`deriveRunnerStatus` in core still has a `"stale"` branch for pure unit tests /
callers that pass an explicit `staleMs` without sweeping; the daemon list/show
path never returns `stale` because rows past the window are deleted first.

`last_seen` advances on register, lease poll enter/exit, and every runner-
authenticated task-traffic verb (heartbeat, events, branch, fail) so a runner
mid-execute (no open poll) stays online.

**Offline detection lag:** there is no client-disconnect listener on the lease
socket. Presence drops only after the long-poll resolves (or is aborted) and
the grace window on the final `last_seen` bump elapses — so worst-case offline
detection is roughly **grace + up to one long-poll window**. That is why grace
is defaulted near **2× the long-poll window**.

Rows survive daemon restart so the fleet can distinguish "never registered"
from "registered but offline."

### Freshness

Idempotent upsert on every register: `registered_at` preserved, capabilities +
`last_seen` refreshed. While up, the runner re-fingerprints on a timer
(default 60s; `PARLEY_RUNNER_REFINGERPRINT_MS`) so installing a vendor CLI needs
no runner restart.

### Operator surface (#314 / #320)

- `GET /runners` → `{ runners: RunnerListEntry[] }` (name, status, vendor ids,
  last_seen, registered_at, protocol/build versions). Lazy stale sweep first.
- `GET /runners/:name` → full advertisement (`RunnerShowResponse`: models,
  held mirrors, optional reachability / unreachable repos, `last_contact_age_ms`,
  recent tasks). Client class.
- `DELETE /runners/:name` → remove SQLite row **and** `runners.<name>` config
  (loopback / config-admin only). Config write commits before row delete.
  Re-registration then fails as unknown (401).
- CLI: `parley runners list|show|remove [--json]`.

Cove executors panel and task executor attribution landed in #324.

## Consequences

- Registration is mandatory before lease — greenfield, no shim for unregistered
  lease clients.
- Runner package loads the shared fingerprint module and may load plugin
  adapters for advertisement (reverses the earlier "plugins out of scope for
  the runner" note in remote-runners docs).
- Protocol bumps use `RUNNER_PROTOCOL_VERSION`; mismatched runners fail fast at
  register with a precise message rather than silent partial behavior.
- Presence is cheap (no new wire traffic while idle long-polling).

## Related

- ADR-0012 remote runners · [ADR-0028](0028-unified-executor-model.md) unified
  executor · [ADR-0030](0030-client-auth-and-bind-posture.md) client tokens
  (separate principal namespace from `runners.<name>.token`)
- [ADR-0031](0031-repo-identity-and-managed-mirrors.md) managed mirrors feed
  `held_mirrors` · [ADR-0032](0032-capability-matched-routing.md) consumes
  advertisements for claim and warm-clone ranking
- `docs/agents/remote-runners.md`
- Issues: [#314](https://github.com/femoral/parley/issues/314),
  [#320](https://github.com/femoral/parley/issues/320),
  [#318](https://github.com/femoral/parley/issues/318)
