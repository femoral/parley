# ADR-0030: Client auth and opt-in bind beyond loopback

**Status**: accepted · **Date**: 2026-08-03 · **Decided**: [#323](https://github.com/femoral/parley/issues/323) (detail [#308](https://github.com/femoral/parley/issues/308), parent [#311](https://github.com/femoral/parley/issues/311))

## Context

Remote clients (`daemon.url`, ADR-0010) and remote runners (ADR-0012) already
reach a daemon over the network, but only runners authenticate. A CLI pointed
at a remote daemon sent every verb unauthenticated. Binding beyond loopback
was also unsupported: the HTTP server always listened on `127.0.0.1`, so any
non-local reachability required an out-of-band reverse proxy or tunnel whose
security posture lived entirely outside parley.

Operators on private overlays (Tailscale, WireGuard, LAN) want a first-party
path: bind the daemon on a reachable address, authenticate every remote
principal, keep the single-machine loopback experience zero-config. Public
exposure is out of scope for native TLS — cert lifecycle stays elsewhere.

## Decision

### Per-client named tokens

Daemon settings gain `clients.<name>.token`, mirroring `runners.<name>.token`.
Each device or UI (laptop CLI, desktop CLI, Cove) holds its own revocable
bearer token. Tokens live in settings (not the task database); deleting a
`clients.<name>` entry revokes that principal without touching others.

On the client host, settings store identity beside the remote URL:

| Key | Role |
| --- | --- |
| `daemon.url` | Remote base URL (existing, ADR-0010) |
| `daemon.client` | This client's registered name |
| `daemon.token` | Bearer secret matching `clients.<name>.token` |

The client sends `Authorization: Bearer <token>` on every remote request
(including the health probe). The name is stored for operator clarity and
config round-trip; the wire carries only the bearer token. One bearer scheme,
two principal namespaces — client and runner maps stay separate so logs and
revocation stay attributable.

Client-side `daemon.client` / `daemon.token` are **hand-edited** for now (via
`parley config set` or direct JSON edit). There is no dedicated mint/enroll
CLI verb — the same convention as runner tokens. A future ticket may add
ergonomics; do not invent a verb here.

### Opt-in bind; peer-address enforcement

New `daemon.bind` (default `127.0.0.1`). Cold setting — requires daemon
restart. When the daemon listens beyond loopback (e.g. `0.0.0.0`), **bearer
auth is mandatory for every non-loopback peer**:

| Route class | Principal off-loopback |
| --- | --- |
| `/runner/*` | Runner token (name-matched as today; already required on loopback too) |
| `/child/*`, `/mcp` | Runner token **bound to the active lease holder while the task executes** |
| All other routes (client surface, `/health`, `GET /runners`, UI, `/xai/…`) | Client token only |
| `PUT /config`, `POST /config/set`, `POST /config/unset` | **Forbidden off-loopback** (403) regardless of any valid token |

**Enforcement keys off the peer address** (`socket.remoteAddress`), not bind
config alone. Loopback peers (`127.0.0.0/8`, `::1`, IPv4-mapped forms) keep
today's tokenless trust and the daemon-id isolation handshake (#130). A local
CLI talking to `http://127.0.0.1:<port>` is unchanged even when the process
also listens on `0.0.0.0`. Missing/`undefined` peer address fails closed
(treated as non-loopback).

Runner-hosted children never dial the daemon directly: they talk to the
runner's local hub proxy, which forwards `/child/*` and `/mcp` and attaches
the runner bearer token so non-loopback hops authenticate as that runner.
The child-channel gate pairs two checks (mirroring runner-surface handlers):

1. **Name match** — authenticated runner equals `task.runner` (submit-time
   affinity; the field is set for the task's whole life, not only while leased).
2. **Active execution** — task state is neither pre-claim (`pending`/`queued`)
   nor terminal (`completed`/`failed`/`cancelled`). Only an actively executing
   task (e.g. `running`, `awaiting_answer`) grants child-channel access.

Affinity alone is not a lease: a pending task must not accept forged
`/child/report` traffic from the affine runner, and a terminal task must not
keep indefinite `GET /child/task` envelope access. Unleased / local
(null-runner) tasks and other runners are rejected. In-daemon children still
hit loopback and stay tokenless. Client tokens are **not** admitted on the
child channel.

### Config read vs admin

- `GET /config` off-loopback requires a client token and **redacts**
  `clients.*.token` and `runners.*.token` (values become `"<redacted>"`).
  Loopback `GET /config` is unredacted.
- Config **writes** (`PUT /config`, `POST /config/set`, `POST /config/unset`)
  are loopback / host-shell only. Remote model-allowlist editing ships via
  dedicated `/models` routes (#322) — client-class, scoped to
  `vendors.<id>.models[.<modelId>]` only — not via wholesale config push.

### No native TLS

Parley speaks plain HTTP. Documented postures:

1. **Private / overlay networks** (expected common case) — Tailscale,
   WireGuard, or LAN where transport is already protected; tokens authorize
   principals on that network.
2. **TLS-terminating reverse proxy** — for genuinely public exposure; cert
   lifecycle stays out of parley. Tokens remain required for non-loopback
   peers. When the proxy connects to the daemon on loopback, the proxy is the
   security boundary for that hop (peer-address trust applies).

## Consequences

- Remote clients without a configured token fail closed against any
  non-loopback daemon (401 on every route).
- Individual client (and runner) tokens rotate independently.
- Default install remains loopback-only and tokenless for local use.
- Hub proxy always attaches the runner token on upstream child/MCP forwards
  (harmless on loopback).
- **Client tokens are deliberately not admin credentials.** Config
  administration (`PUT /config`, `POST /config/set|unset`) is a
  loopback/host-shell operation only. A remote client may `GET /config` with
  secrets redacted; it cannot mint runners, revoke peers, or change
  `vendors.*.bin/args/env` over the wire. Dedicated remote allowlist edits
  use the `/models` surface (#322), not config admin.
- **Browser UI stays loopback-oriented.** Cove (#324) ships the executors panel
  and task executor attribution against a local daemon, but a browser still
  cannot attach a bearer token to ordinary document navigation, so static
  bundle fetches and API calls from Cove fail auth when the peer is not
  loopback. Local `parley ui` against loopback is unchanged; remote browser
  auth is a separate delivery problem, not solved by the executors surface.
- No compatibility shims — greenfield wire/config change (pre-release).

## Related

- ADR-0010 settings / remote daemon URL · ADR-0012 remote runners
- [ADR-0029](0029-runner-registration-advertisement-wire.md) runner bearer
  tokens (`runners.<name>.token`) — same scheme, separate principal map from
  `clients.<name>.token` so logs and revocation stay attributable
- Spec parent [#311](https://github.com/femoral/parley/issues/311) · decision
  [#323](https://github.com/femoral/parley/issues/323)
- `docs/agents/remote-runners.md`
