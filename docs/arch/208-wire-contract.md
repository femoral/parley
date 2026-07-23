# #208 — Wire contract: report envelope as the single task shape

**Status**: exploration proposal (no implementation)  
**Issue**: [#208](https://github.com/femoral/parley/issues/208)  
**Related parallel explorations**: [#206](https://github.com/femoral/parley/issues/206) (transition module), [#210](https://github.com/femoral/parley/issues/210) (Cove display projection)

---

## 1. Problem restatement

Parley already has a *documented* wire contract in `@useparley/core`
(`packages/core/src/contract.ts`, `docs/spec/ui-interface-contract.md`), but
three concrete seams still treat **daemon storage rows** as the public task
shape:

1. **`GET /tasks` ships the SQLite row.** The handler returns
   `engine.list()` almost unchanged (`packages/daemon/src/server.ts:1581–1586`).
   JSON columns (`usage`, `report`, `report_schema`, `launch_command`,
   `eval_answers`) remain strings; `network` / `resumed` remain `0|1`. The CLI
   re-decodes them for presentation (`packages/cli/src/commands/tasks.ts:228–251`).

2. **Live streams ship a different shape for the same task.** Inbox, firehose,
   and SSE all call `buildEnvelope` (`packages/daemon/src/report.ts:233–276`)
   and pin `state`/`seq` to the transition (`server.ts:920–927`, `937–944`).
   That envelope deliberately omits identity fields the UI needs for session
   grouping and recency — notably `orchestrator_session_id` and `updated_at` —
   so Cove compensates with merge + row backfill
   (`packages/ui/src/app/hooks/useSnapshot.ts:73–98`, `199–219`).

3. **Daemon internals are a de-facto package API.**
   `@useparley/daemon` exports every source file via a wildcard map
   (`packages/daemon/package.json:12–26`). The CLI deep-imports storage and
   report modules for types and helpers (`db.js`, `report.js`, plus lifecycle
   modules like `discovery.js` / `lock.js`). Core already mirrors
   `TaskEnvelope` / `TaskRow` and keeps a compile-time assignability guard in
   the daemon (`packages/daemon/src/report.ts:211–217`), which is evidence the
   shapes are near-duplicates with no single owner of *production*.

The ticket's proposed deepening remains correct: **serialize storage →
envelope once at the HTTP seam; consumers import only `@useparley/core` for
task wire types.** This finishes ADR-0002's "transport-agnostic JSON behind a
transport adapter" intent and matches ADR-0009's pattern of moving public
shapes into core (adapters already did).

### Citation audit (ticket vs this checkout)

| Ticket claim | Status in this checkout |
|---|---|
| Daemon `package.json` wildcard `"./*": "./src/*.ts"` | **Accurate** — `packages/daemon/package.json:21–24` (plus `./*.js` twin at 17–20). |
| CLI deep-imports daemon internals in 10+ files | **Accurate** — wire-relevant: `tasks.ts`, `watch.ts`, `logs.ts` (`db`/`report`); also `client.ts`, `daemon.ts`, `delegate.ts`, `eval.ts`, `fix.ts`, `models.ts`, `init.ts`, `info.ts` for lifecycle/adapters/session-binding. Runner and some CLI tests deep-import too. |
| `tasks.ts` L88–96, L247–250 re-cast row / know `network` 0/1 and JSON columns | **Drift.** L85–97 is `formatState` for `queue_position` / `blocking_cap` (queue observability, not storage encoding). Storage decoding lives in **`presentRow` at L228–251** (`parseJsonColumn` for `usage`/`report`/`launch_command`/`eval_answers`; `network`/`resumed` as `=== 1`) and the table path at **L128–130** (`parseJsonColumn` for usage). L247–250 is the queue field cast in `presentRow`, not network. |
| `watch.ts` L10–32 re-declares `InboxEvent` / `FollowEvent` / `TasksResponse` | **Accurate** — local interfaces at L10–32; envelope/row types imported from daemon. Core has `TasksResponse` / `StreamEvent` but **no** inbox/firehose response types. |
| UI SSE envelope omits `orchestrator_session_id` / `updated_at`; backfill in `useSnapshot` L73–98, L200–219 | **Accurate** — `mergeEnvelope` L73–98 carries session forward and stamps `updatedAt` client-side; `adoptRowFields` / `fetchSession` L199–219 backfill from `GET /tasks/:ref`'s row. Envelope type (`report.ts:135–203`, core `TaskEnvelope` L31–109) still lacks those fields. |
| `eventNameForState` (`core/.../states.ts:132`) vs `watchEventFor` (`daemon/.../server.ts:772`) | **Accurate** — byte-for-byte same mapping (running→`task.started`, awaiting_answer→`task.question`, else `task.<state>`). Daemon does not import the core function. |
| Assignable guard `report.ts:211–217` | **Accurate** — `Envelope`↔`TaskEnvelope`, `TaskRow`↔wire `TaskRow`, `QaTurnRow`↔`QaTurn`. |

**Net:** evidence holds; only the `tasks.ts` line ranges for storage leakage need the correction above.

---

## 2. Exploration questions

### Q1 — Grow the envelope, or two named shapes (summary vs envelope)?

**Recommendation: one primary wire shape (`TaskEnvelope`), grown with the
fields live consumers already need; keep a *decoded* detail companion for
inspector-only columns — do not keep shipping the SQLite row as a second
list/stream shape.**

**What the code does today**

| Surface | Shape | Owner |
|---|---|---|
| `GET /tasks` | raw `TaskRow` (+ computed `queue_position` / `blocking_cap` when enriched) | `server.ts:1581–1586` |
| `GET /tasks/:ref` | `{ task: Envelope, row: TaskRow, qa, attempts, session, eval_detail }` | `server.ts:1611–1618` |
| `GET /tasks/inbox`, `/tasks/events`, SSE | `Envelope` with pinned `state`/`seq` | `server.ts:871–876`, `920–927`, `937–944` |
| Core public types | `TaskEnvelope` + storage-shaped `TaskRow` + `StreamEvent` / `TaskDetailResponse` | `contract.ts` |

Core's own comments already split intent: envelope is "the primary task shape
a UI renders" (`contract.ts:26–29`); row is "raw persisted columns" for the
inspector (`contract.ts:111–114`). That dual intent is sound for **detail**.
The bug is treating the raw row as the **list/bootstrap** contract and omitting
session/recency from the live envelope.

**Fields the envelope must gain** (minimum set justified by current consumers):

| Field | Why | Evidence |
|---|---|---|
| `orchestrator_session_id` | Session grouping / chips; without it SSE-first tasks need row fetch | `useSnapshot.ts:73–80`, `147–151`, `199–219`; CLI table `tasks.ts:120` |
| `updated_at` | Roster recency / terminal eviction order | `useSnapshot.ts:94–96`, `129–131`; row has it at `contract.ts:133` |
| `orch_harness` (optional: `orch_model`, `orch_effort`) | Cove already backfills harness from the row | `useSnapshot.ts:200–207` |
| `created_at`, `started_at`, `completed_at` | CLI duration column when not using `duration_ms` alone; human status | `tasks.ts:45–54` uses these timestamps |

Also keep existing envelope-only / decoded fields (`posture.network` boolean,
parsed `usage`/`report`, `duration_ms`, `logs_dir`, `eval_expected`, queue
fields) — these are the right presentation encodings.

**What not to do**

- **Two list shapes** ("summary" + "envelope") doubles the seam for little
  gain: list and stream already want the same lifecycle fields; bandwidth is
  not a stated constraint (single-user localhost; UI contract says volume is
  small).
- **Keep shipping storage-shaped `TaskRow` on `GET /tasks`** after growing
  the envelope — leaves CLI `presentRow` and dual UI merge forever.
- **Fold every row column into the envelope** (prompt, base_sha, eval JSON
  strings, launch_command) — bloats every SSE frame and re-encodes detail
  that already has a home on `GET /tasks/:ref`.

**Detail endpoint after the change:** keep
`TaskDetailResponse` but make its heavy fields **decoded** (today's
`session` / `eval_detail` / `attempts` / `qa` already are). Prefer dropping
wire `row` later, or replacing it with a `TaskRecord` whose JSON columns are
objects and booleans are booleans — same presentation rules as the envelope.
That is a follow-on; the critical path is list + stream + bootstrap.

### Q2 — Migration order: curate daemon exports first, or move types to core first?

**Types first (they largely *are* in core), then production path, then export
curation. Export curation first is the wrong order.**

Rationale from the graph and current ownership:

1. **`TaskEnvelope` / `TaskRow` / `StreamEvent` / `TasksResponse` already live
   in core** (`contract.ts`). Daemon `Envelope` is a parallel definition
   kept honest by the assignability guard (`report.ts:211–217`). The missing
   work is not inventing a contract module — it is **producing and consuming
   only that module**.

2. **CLI still types against daemon** (`TaskRow` from `db.js`, `Envelope` from
   `report.js` in `tasks.ts` / `watch.ts` / `logs.ts`). Switching imports to
   core is a pure type move and can land before response-shape changes.

3. **Curing the wildcard first** would break every deep import without a
   replacement. Lifecycle imports (`discovery`, `lock`, `identity`) are
   *process* concerns the monorepo layout intentionally left in daemon
   (`docs/spec/monorepo-layout.md`: CLI depends on daemon for spawn/discovery).
   Wire cleanup and export curation must not be conflated into one step.

4. **ADR-0009 precedent**: public types moved to core; daemon kept re-export
   shims for deep-import compatibility. Same playbook: grow core types →
   daemon `buildEnvelope` implements them → endpoints emit them → consumers
   switch → delete shims / narrow `exports`.

**Ordered rule:** never remove a daemon subpath export until zero
workspace importers remain (CLI, runner, tests).

### Q3 — What does CLI `tasks.ts` render once JSON columns are pre-decoded?

**A presentation layer over already-decoded fields — no `parseJsonColumn`, no
`network === 1`.**

Today:

- Table path: `formatUsage(parseJsonColumn(t.usage))` (`tasks.ts:128–130`).
- JSON path: `presentRow` spreads the row then rewrites storage encodings
  (`tasks.ts:228–251`).
- Duration: raw timestamps (`tasks.ts:45–54`).
- State: `queue_position` / `blocking_cap` with local casts (`tasks.ts:85–97`).
- Session column: `orchestrator_session_id` (`tasks.ts:120`).

After `GET /tasks` returns envelopes (or list items assignable to
`TaskEnvelope`):

| Concern | Consumes |
|---|---|
| USAGE column | `usage: Record<string, number> \| null` directly |
| network / resumed | `posture.network` / `resumed: boolean` |
| report body (status --json) | `report: Report \| null` object |
| duration | prefer `duration_ms` when set; else timestamps if added to envelope |
| STATE / queue | `state`, `queue_position`, `blocking_cap` (already on envelope) |
| SESSION | `orchestrator_session_id` (once added) |
| derived `cache_hit` | stays CLI-side (or moves into envelope later); today derived in `presentRow` from `cached_input_tokens` |

`presentRow` shrinks to optional CLI-only adornments (`cache_hit`) or
disappears for list JSON (envelope *is* the JSON). Human table helpers take
`TaskEnvelope` instead of daemon `TaskRow`.

`watch.ts` deletes its local `InboxEvent` / `FollowEvent` / `TasksResponse` in
favor of core types (see interface sketch). Exit codes still branch on
`task.state` via `exitFor` — unchanged.

---

## 3. Proposed interface

### Module ownership

| Module | Role |
|---|---|
| `packages/core/src/contract.ts` | **Sole** public task wire types and response envelopes. |
| `packages/core/src/states.ts` | Sole event-name mapping (`eventNameForState`); daemon deletes local `watchEventFor`. |
| `packages/daemon/src/report.ts` | Production: `buildEnvelope(row, …): TaskEnvelope` (return core type; drop parallel `Envelope` interface once identical). Keep validation helpers (`validateReport`, `DEFAULT_REPORT_SCHEMA`) here — they are engine concerns, not wire types. |
| `packages/daemon/src/db.ts` | **Internal** storage `TaskRow` only; never imported by CLI/UI for wire. |
| `packages/daemon/src/server.ts` | Seam: every task JSON body goes through `buildEnvelope` / detail builders. |
| `packages/core/src/sdk.ts` | UI client continues to type against contract (already does). |
| CLI commands | Import task types only from `@useparley/core`. |

### TypeScript sketches (target shape; not implemented)

```ts
// packages/core/src/contract.ts  (additions / changes)

/** Primary task shape on list, watch, and SSE. Storage never appears here. */
export interface TaskEnvelope {
  // --- existing fields (task_id, name, repo, worktree, branch, vendor, …) ---

  /** Orchestrator-run grouping (CONTEXT.md). Null when unbound. */
  orchestrator_session_id: string | null;
  /** ISO-8601 last activity on the storage row (for recency / eviction). */
  updated_at: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;

  /** Spawn-time orchestrator harness snapshot (#162); null when unbound. */
  orch_harness?: string | null;
  orch_model?: string | null;
  orch_effort?: string | null;

  // posture.network remains boolean; usage/report remain parsed objects;
  // seq/state remain pin-able on transition streams.
}

/** GET /tasks — bootstrap snapshot. tasks are envelopes, not storage rows. */
export interface TasksResponse {
  tasks: TaskEnvelope[];
  seq: number;
}

/** GET /tasks/inbox (CLI long-poll). */
export interface InboxEventResponse {
  event: string | null;
  seq: number;
  task: TaskEnvelope | null;
  all_done: boolean;
}

/** GET /tasks/events (watch --follow). */
export interface FollowEventResponse {
  event: string | null;
  seq: number;
  task: TaskEnvelope | null;
}

/**
 * GET /tasks/:ref — envelope plus decoded detail sections.
 * `row` is deprecated; prefer decoded sections. During migration it may remain
 * as a storage-shaped mirror assignable to the old TaskRow type.
 */
export interface TaskDetailResponse {
  task: TaskEnvelope;
  qa: QaTurn[];
  attempts: AttemptLineageEntry[];
  session: SessionProvenance;
  eval_detail: EvalDetail | null;
  /** @deprecated storage-shaped; remove after CLI/UI stop reading it. */
  row?: TaskRow;
}

// StreamEvent stays { seq, event, task: TaskEnvelope } — already correct.
```

```ts
// packages/daemon/src/report.ts

import type { TaskEnvelope, Report, JsonSchema } from "@useparley/core";
import type { TaskRow as StorageRow } from "./db.js";

/** Map one storage row (+ optional queue enrichment) to the public envelope. */
export function buildEnvelope(
  task: StorageRow,
  logsDir: string | null,
  queue: { position: number | null; blockingCap: string | null } | null,
): TaskEnvelope;

/** Decode a JSON text column; used only inside the daemon seam. */
export function parseJsonColumn<T>(value: string | null): T | null;
```

```ts
// packages/daemon/src/server.ts  (call graph)

// list:
//   engine.list() → map(row => envelopeFor(engine, row)) → TasksResponse

// detail:
//   { task: envelopeFor(...), qa, attempts, session, eval_detail }

// inbox / events / SSE:
//   envelopeFor + pin state/seq + eventNameForState(state) from @useparley/core
//   delete local watchEventFor
```

```ts
// packages/cli/src/commands/tasks.ts  (consumer sketch)

import type { TaskEnvelope, TasksResponse, TaskDetailResponse } from "@useparley/core";

function formatUsage(usage: Record<string, number> | null): string { /* unchanged */ }
function formatDuration(task: TaskEnvelope): string { /* use duration_ms or timestamps */ }
function formatState(task: TaskEnvelope): string { /* queue fields already typed */ }
function renderTable(ctx: CliContext, tasks: TaskEnvelope[]): void { /* no parseJsonColumn */ }
```

```ts
// packages/ui/src/app/hooks/useSnapshot.ts  (consumer sketch)

// Bootstrap TasksResponse.tasks is TaskEnvelope[] — fromRow becomes identity
// or a thin rename into RosterTaskInput.
// mergeEnvelope copies orchestrator_session_id + updated_at from the event;
// delete fetchSession / adoptRowFields for the common path.
// (Detail inspector may still GET /tasks/:ref for qa / eval / attempts.)
```

### Who calls what

```
storage (db.TaskRow)
        │
        ▼
 buildEnvelope  ──────────────────────────►  TaskEnvelope  (@useparley/core)
        │                                         │
        │                          ┌──────────────┼──────────────────┐
        ▼                          ▼              ▼                  ▼
   server routes              CLI list/watch   UI useSnapshot    ParleyClient SDK
   (HTTP / SSE)               (human + json)   (roster/inbox)    (any UI)
```

Daemon-internal engine methods keep returning storage rows; only the HTTP/MCP
edge converts. Child `submit_report` validation stays in `report.ts`
(daemon-owned).

### Daemon package exports (end state)

- Keep: `@useparley/daemon` barrel (`main` entry via package bin/path),
  lifecycle modules the CLI legitimately needs (`discovery`, `lock`,
  `identity`, `main`), adapter registry for `init`/`models` until those
  move or get a curated export.
- Drop wildcard `./*` once no importers remain; publishConfig mirrors the
  curated map.
- **Out of scope for the wire deepening but blocked by the same wildcard:**
  runner deep imports of `engine` / `context` / `worktree` — track separately
  so #208 does not wait on runner packaging.

---

## 4. Test-surface sketch

### Newly testable in-process (without HTTP)

| Behavior | Why new / better |
|---|---|
| Storage → envelope field mapping | Pure `buildEnvelope` unit tests already partial; assert **new** fields (`orchestrator_session_id`, `updated_at`, timestamps, orch_*) and that JSON/0-1 never leak. |
| `eventNameForState` sole authority | One table-driven test in core; daemon tests import core (or assert server uses it via integration). Delete any daemon-local mapping tests. |
| Assignability | Replace hand `Assignable<>` triple with "daemon buildEnvelope return type *is* `TaskEnvelope`" (structural). |
| List response shape | Server/integration: `GET /tasks` body parses as `TasksResponse` with object `usage`, boolean posture.network — fails if row reappears. |
| UI merge without backfill | `use-snapshot-sse` fixtures emit envelopes with session ids; assert no `getTask` row fetch for session adoption. |

### Suggested files

| File | Kind | Notes |
|---|---|---|
| `packages/daemon/tests/envelope.test.ts` (extend or add) | unit | Golden storage row → envelope; pinning state/seq helper if extracted. |
| `packages/core/tests/states-events.test.ts` (or extend states tests) | unit | `eventNameForState` matrix including `queued`. |
| `packages/daemon/tests/server-tasks-list.test.ts` (or extend existing server tests) | integration | HTTP `GET /tasks` / inbox / events shapes. |
| `packages/cli/tests/tasks-present.test.ts` | unit | Table/JSON helpers against envelope fixtures — no daemon `db` import. |
| `packages/ui/tests/use-snapshot-sse.test.ts` | integration (fake fetch) | Already exists; rewrite fixtures to full envelopes; delete session-backfill cases that become obsolete. |

### Unit vs integration split

- **Unit:** `buildEnvelope`, `eventNameForState`, CLI presenters, pure UI
  `mergeEnvelope` / `fromRow`.
- **Integration:** real HTTP handlers with a temp engine DB (existing daemon
  test style); CLI e2e only if presentation regressions need a live daemon.
- **Do not** add cross-package tests that import `@useparley/daemon/db.js`
  from CLI once the wire cut lands — that would re-encode the leak.

---

## 5. Migration plan

| Step | Change | Blast radius | Deletes |
|---|---|---|---|
| **1. Grow core `TaskEnvelope`** | Add session/timestamp/orch fields as required (or optional-then-required). Bump docs in `docs/spec/ui-interface-contract.md` in the implementing PR. | core types + UI fixtures + any exhaustive switches | none yet |
| **2. Expand `buildEnvelope`** | Emit new fields from storage row; return type becomes core `TaskEnvelope`. | daemon `report.ts` + its tests; assignability guard simplifies | parallel field drift on `Envelope` (collapse interface to type alias or delete) |
| **3. Switch producers** | `GET /tasks` maps through `envelopeFor`; detail still builds envelope; event paths already do. Replace `watchEventFor` with `eventNameForState`. | daemon `server.ts`; any client assuming list rows | `watchEventFor`; CLI `parseJsonColumn` path for list |
| **4. Switch typed consumers** | CLI `tasks`/`watch`/`logs` import core; UI `fromRow`/`mergeEnvelope` use session/`updated_at` from envelope; drop session backfill for happy path. | cli, ui | `useSnapshot` fetchSession loop (common path); local watch response interfaces |
| **5. Deprecate wire `TaskRow` on list** | Document `TaskRow` as storage/internal or detail-only. Stop exporting storage semantics in core comments. | docs + remaining `row` readers on detail | CLI `presentRow` storage rewrites |
| **6. Curate daemon exports** | Explicit export map for lifecycle/adapters still needed; remove `./*` wildcard when `rg '@useparley/daemon/'` is clean for wire paths. | package.json consumers (cli, runner, tests) | deep imports of `db.js` / `report.js` types from CLI |
| **7. Detail cleanup (optional follow-on)** | Drop or decode `TaskDetailResponse.row` | status --json, Cove inspector if any | last storage-shaped public field |

**Rollback posture:** steps 1–2 are additive (old clients ignore new JSON
fields). Step 3 is **breaking** for any client that reads `usage` as a string
or `network` as `0|1` from `GET /tasks` — coordinate with core minor/major
per `docs/spec/ui-interface-contract.md` stability section and
`docs/spec/release-process.md` (pre-1.0 contract may still move).

**What gets deleted (summary)**

- Daemon `watchEventFor` (`server.ts:772–776`)
- CLI dependency on `parseJsonColumn` / daemon `TaskRow` for list presentation
- UI compensating backfill for session/recency on the live path
- Parallel daemon `Envelope` interface (retain `buildEnvelope` + validation)
- Eventually: wildcard daemon exports; wire storage encodings in core `TaskRow`
  if detail is fully decoded

---

## 6. Risks and rejected alternatives

### Risks

| Risk | Mitigation |
|---|---|
| **Breaking list clients** that parse SQLite encodings | Ship envelope fields additively first; change `GET /tasks` body in a documented step; grep workspace + fixtures; pre-1.0 policy allows contract move with core version bump. |
| **SSE payload size** after adding timestamps/session | Small constant growth; single-user localhost; reject stuffing prompt/eval into every event. |
| **Transition pinning vs `updated_at`** | Stream still pins `state`/`seq` to the transition (`server.ts:920–926`). `updated_at` should reflect the row's last write (or the transition time if that is what the row stores) — document which. Do not pin `updated_at` backwards to a superseded transition if the row has moved on. |
| **#206 reorder** | If transition module lands mid-migration, keep envelope build at the HTTP edge; do not bury serialization inside `transition()`. |
| **#210 expecting row-shaped inputs** | Envelope growth must include fields Cove display needs (session, orch harness, vendor/model/state). State assumptions below. |
| **Runner / CLI non-wire deep imports** | Wildcard removal blocked by non-wire imports; phase 6 only after inventory, or split "curate wire-related exports" from full lockdown. |
| **TERMINAL_STATES dual definition** | CLI `logs.ts` imports daemon `TERMINAL_STATES`; core already has `isTerminalState` / `TERMINAL_STATES`. Prefer core for consumers (touches #206's "one state vocabulary" goal; not blocking for envelope work). |

### Rejected alternatives

1. **Keep dual list shapes (row + envelope) forever; only document them**  
   Rejected: UI backfill and CLI `presentRow` are ongoing tax; assignability
   guard proves near-identity without shared production.

2. **Curate daemon exports only (no envelope growth)**  
   Rejected: stops deep imports but leaves storage encodings and session-less
   SSE payloads; the hard bugs remain.

3. **Move `buildEnvelope` into core**  
   Rejected: needs storage row layout, `logsDir`, queue enrichment, and
   `readEvalExpected(repo)` (`report.ts:265`) — daemon/engine concerns. Core
   should own **types**, not SQLite-adjacent construction.

4. **RPC / OpenAPI codegen as the contract**  
   Rejected for this ticket: overkill vs deepening the existing TypeScript
   contract module; ADR-0002 already chose JSON over the wire with typed
   clients.

5. **Conclude "not worth it"**  
   Rejected: three packages already fight the same dual shape; core contract
   exists but is not authoritative at the producer; small envelope growth
   deletes real UI/CLI complexity. Worth doing.

---

## 7. Interactions with parallel explorations

### Assumptions about #206 (transition module)

- **#206 owns:** state write locality, seq bump, transition log append, waiter
  wake-up, queue drain, and collapsing duplicate state sets so
  `packages/core/src/states.ts` is vocabulary authority.
- **#208 owns:** serialization of a task to the public JSON shape and the
  event-name string on the wire (`eventNameForState` already in core).
- **Assumption:** after #206, producers still hand the HTTP layer a storage
  row (or a small transition DTO `{ task_id, state, seq }`). Envelope build
  remains at the **server/report seam**, not inside `transition()`, so stream
  pinning of superseded states (`server.ts:920–926`) stays local to the
  transport adapter.
- **Shared delete:** daemon-local `watchEventFor` vs core `eventNameForState`
  is #208's job and does not require the transition module to land first.
- **Non-blocking:** if #206 is delayed, #208 still lands; if #206 lands
  first, #208 only re-points `envelopeFor` call sites.

### Assumptions about #210 (Cove `toDisplayTask`)

- **#210 owns:** one display projection (glyph, coat, faction, attention
  order) consumed by roster/inbox/scene — layout islands shrink.
- **#208 owns:** the **input** to that projection on the live path: a single
  envelope-shaped task, not a merge of row + SSE.
- **Assumption:** `toDisplayTask` will accept either `TaskEnvelope` or a thin
  UI DTO (`RosterTaskInput`) **derived 1:1 from the envelope**, not from
  storage `TaskRow`. Therefore #208 must put `orchestrator_session_id`,
  `updated_at`, and orch harness on the envelope before or with #210 —
  otherwise #210 freezes the backfill dance into the projector.
- **Assumption:** #210's "hud never imports core" tension is #210's problem;
  #208 only requires that core remains the wire SDK (`useSnapshot` already
  imports `@useparley/core`).
- **Do not design** display tokens, faction maps, or attention legend order
  here.

### Explicit non-assumptions

- No assumed field list from an unimplemented #210 `DisplayTask` type —
  only fields **already read** by `useSnapshot` / roster today.
- No assumed `transition()` signature from #206 — only that seq/state still
  appear on the row or transition DTO the server already uses.
- No change to ADR-0007 inbox semantics, ack ids (= seq), or firehose vs
  inbox split — only the `task` payload type inside those responses.

---

## ADR / domain alignment

| Decision | Alignment |
|---|---|
| **ADR-0002** (CLI + daemon, HTTP long-poll, transport-agnostic JSON) | **Supports.** This proposal finishes the seam: messages are typed in core; daemon adapts storage → wire. |
| **ADR-0007 / 0008** (watch, inbox, attention) | **No change** to ack/priority/exit codes; envelope still carries `seq` and pinned `state`. |
| **ADR-0009** (adapter types in core) | **Same pattern** for task wire types. |
| **`docs/spec/ui-interface-contract.md`** | **Tension to resolve in the implementing PR:** today `GET /tasks` is specified as snapshot rows + seq; making `tasks` envelopes is a contract edit. SSE `data` remains envelope (already). Stability rule: breaking changes bump `@useparley/core` major (or pre-1.0 policy in release-process). |
| **CONTEXT.md** | Uses domain names: orchestrator session, report envelope, task states, inbox/ack/seq. Envelope growth of `orchestrator_session_id` matches glossary. |

---

## Conclusion

Deepen **`packages/core/src/contract.ts` as the only task wire contract**:
grow `TaskEnvelope` with session/recency/orch fields, make every task-bearing
HTTP/SSE response produce that shape via daemon `buildEnvelope`, point CLI and
Cove at core types, delete the duplicate event-name helper and the UI backfill
path, then curate daemon exports after importers move.

The dual **detail** sections (`qa`, `session`, `eval_detail`, `attempts`) stay
as named companions; the dual **storage row on the list plane** does not.
)
