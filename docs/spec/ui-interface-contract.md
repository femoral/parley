# UI interface contract

Decided on wayfinder map #47 (ticket #51). Defines what a UI — `@useparley/ui`
or any custom one — builds against, and how the daemon hosts it. Companion to
`docs/spec/monorepo-layout.md`.

## Shape of the contract

Two layers, no JS plugin interface — third-party code never executes inside the
daemon process:

1. **Data contract** — the daemon's documented HTTP + SSE API, plus the typed
   client and state types exported from `@useparley/core`. A UI is any web app
   that consumes this API.
2. **Serving convention** — a UI package ships a static bundle the daemon
   serves. Implementing the convention is all it takes to be installable.

## Data contract

### Existing surface (public contract)

- `GET /health` — `{ status, pid, version, started_at }`.
- `GET /tasks` — `{ tasks, seq }` where **`tasks` is an array of
  `TaskEnvelope`** (not storage rows; #208) and `seq` is the atomic "start
  from now" baseline for SSE / long-poll bootstrap.
- `GET /tasks/:ref` — `{ task, qa, attempts, session, eval_detail, row? }`:
  the envelope plus decoded detail companions. `row` is a deprecated
  storage-shaped mirror; prefer the decoded sections and the envelope.
- `GET /tasks/inbox?ids=…&ack=<seq>&wait=true` — acked attention inbox
  long-poll (`InboxEventResponse`).
- `GET /tasks/events?ids=…&since=<seq>&wait=true` — multi-task transition
  firehose long-poll (`FollowEventResponse`; the CLI keeps using it).
- `POST /tasks`, `POST /tasks/:ref/answer`, `POST /tasks/:ref/eval`,
  `POST /tasks/:ref/cancel`, `POST /clean` — writes a UI may issue.

### Task envelope (primary wire shape)

`TaskEnvelope` in `@useparley/core` is the **only** task shape on list, watch,
and SSE. Notable fields beyond identity/lifecycle:

- Presentation encodings: `posture.network` boolean, parsed `usage` / `report`,
  `duration_ms`, `logs_dir`, queue fields (`queue_position`, `blocking_cap`).
- Session / recency (#208): `orchestrator_session_id`, `updated_at`,
  `created_at`, `started_at`, `completed_at`, plus optional `orch_harness` /
  `orch_model` / `orch_effort`.
- On transition streams, `state` and `seq` are **pinned** to the transition
  (even if the row has moved on); `updated_at` reflects the row's last write
  and is not pinned backwards.

### SSE event stream

- `GET /events/stream` — Server-Sent Events over the same transition feed the
  long-poll reads. Browser-native `EventSource`, auto-reconnect.
- Each SSE message: `id:` = transition `seq`, `event:` = watch event name from
  core `eventNameForState` (`task.started`, `task.question`, `task.completed`,
  `task.failed`, `task.cancelled`, `task.stalled`, `task.pending`,
  `task.queued`, …), `data:` = the task envelope pinned to the transition
  (same pinning rule as the long-poll).
- Reconnect: `Last-Event-ID` header maps to `since` — missed transitions replay
  in order. Bootstrap: `GET /tasks` for the envelope snapshot, then connect the
  stream from the returned `seq`.
- No `ids` filter in v1 — the stream carries all tasks; UIs filter client-side
  (single-user localhost, volume is small).

### Per-task logs

- `GET /tasks/:ref/logs?since=<offset>` — reads the task's log dir; returns
  `{ chunk, next, eof }` where `next` is the offset for the follow-up call.
  Tail-friendly: UIs poll on a short interval while a task is `running`, or
  re-fetch on SSE transitions. Exact chunking/framing is an execution detail;
  the offset-cursor shape is the contract.
- Report rides the task envelope. Question/answer history is a `qa` array on
  `GET /tasks/:ref` only (not on list envelopes): turns of
  `{ question, answer, question_id, asked_at, answered_at }` in ask order,
  written at ask time (`answer` null) and updated in place when answered. The
  outstanding-question fields on the envelope stay for lifecycle only.

### `@useparley/core` exports (the SDK)

- Task/state/envelope types (`TaskEnvelope`, `TasksResponse`,
  `InboxEventResponse`, `FollowEventResponse`, `StreamEvent`, detail companions)
  and the state machine constants (attention hierarchy + `eventNameForState` —
  UIs shouldn't re-derive them).
- The HTTP client (typed wrappers for the routes above).
- SSE helper (wraps `EventSource` wiring + snapshot/seq bootstrap).
- Discovery-file reader — how a same-machine process finds the daemon's
  ephemeral port. Browser UIs don't need it (they're served by the daemon —
  same origin); it exists for custom native/TUI frontends.

### Stability

The routes and envelope fields above are the versioned surface: breaking
changes bump `@useparley/core` major (pre-1.0 policy may still move the
contract per `docs/spec/release-process.md`). `GET /tasks` returning envelopes
instead of storage rows is such a move (#208). `GET /health` includes a
`version` field (daemon package version) so UIs can detect mismatch.

## Serving convention

- **Package marker**: the UI package's `package.json` declares
  `"parley": { "ui": "<dir>" }` — the directory (relative to the package root)
  holding the built static bundle, `index.html` at its root.
- **Discovery order** (first hit wins):
  1. Explicit path in parley home config (`ui.path`) — serve that dir directly.
  2. Package name in config (`ui.package`) — resolved via `createRequire` from
     the parley home dir, then from the daemon package itself.
  3. Default: `@useparley/ui`, same resolution.
  Nothing found → no UI routes; daemon behavior unchanged.
- **Routes**: API paths (`/tasks`, `/events`, `/health`, `/clean`, `/mcp`) are
  reserved; everything else serves the bundle with SPA fallback to
  `index.html`. UI lives at `/` on the daemon's port — same origin as the API,
  no CORS needed.
- **Security posture**: unchanged — daemon binds `127.0.0.1`, single-user, no
  auth chrome (ADR-0006 posture; the brief's "no multi-tenant" guardrail).
- A custom UI is therefore: any package with a static bundle + the
  `parley.ui` marker, set as `ui.package` in config. It talks to the same API
  from the same origin.

## Out of scope here

- Panel/feature composition of the first-party UI — ticket #52.
- Component system — ticket #53.
- How the bundle is built (Vite specifics) — first-party UI concern, not
  contract.
