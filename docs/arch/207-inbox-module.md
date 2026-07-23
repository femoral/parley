# #207 — Inbox module: `peek · ack · waitFor · allDone`

Exploration proposal for issue #207. Design only; no implementation.

Related: #206 (transition module) — ticket claims this candidate mostly falls
out of that one. See [§7](#7-interactions-with-206-transition-module) for
assumptions and what survives independently.

---

## 1. Problem restatement

ADR-0007 defines the orchestrator **inbox** as a *derived* view: each watched
task contributes at most one pending event (its current actionable state, if
un-acked), delivered in priority order
(`awaiting_answer` > `stalled` > `failed` > `completed`, FIFO by seq within a
tier). Ack marks a handled event; leaving an actionable state *collapses* that
event (supersession); **all-done** is every watched task terminal *and* no
pending events left. `watch` is the only wait primitive (ADR-0008).

In this checkout the concept has vocabulary in `@useparley/core` but no
module. The four verbs live as methods on the 3600-line `TaskEngine`, ack
persistence lives in `db.ts`, HTTP wiring in `server.ts`, and envelope
shaping in `report.ts`. Grep finds **zero** direct unit tests of
`peekInbox` / `ackEvent` / `waitForInbox` / `isInboxAllDone` — ADR-0007 is
exercised only transitively by CLI integration tests that spawn a real
daemon (`packages/cli/tests/watch.test.ts`).

### Citation audit (ticket vs this checkout)

Every `file:line` citation in the ticket body was verified against this tree.
**No drift** — all anchors still land on the named symbols:

| Ticket claim | Verified |
|---|---|
| `packages/core/src/states.ts` — `ACTIONABLE_STATES` (L37), `INBOX_PRIORITY` (L49), `inboxRank` (L86) | Exact |
| `packages/daemon/src/engine.ts` — `ackEvent` (L2270), `peekInbox` (L2285), `isInboxAllDone` (L2308), `waitForInbox` (L2324) | Exact |
| `packages/daemon/src/db.ts` — `getTaskBySeq` (L757), `upsertEventAck` (L768), `isEventAcked` (L799) | Exact |
| `packages/daemon/src/server.ts` — `envelopeFor` (L779), `resolveWatchIds` (L794), `handleInbox` (L821) | Exact |
| `packages/daemon/src/report.ts` — `buildEnvelope` (L233) | Exact |
| Dual collapse sites: `ackEvent` L2273–2275 + `peekInbox` `isEventAcked` L2292 | Exact (see nuance below) |

**Nuance correction (not line drift):** the ticket says the collapse rule
"stops leaking into `server.ts`." `handleInbox` does **not** implement
collapse or supersession itself — it only parses query params, calls engine
verbs, and shapes JSON. The two disconnected rule sites are both under the
engine/db layer:

1. **Ack-side supersession** (`engine.ts` L2270–2277): resolve event id via
   `getTaskBySeq`; no-op if missing, non-actionable, or seq mismatch; else
   `upsertEventAck`.
2. **Peek-side filter** (`engine.ts` L2285–2301): skip non-actionable and
   `isEventAcked` rows; sort by `inboxRank` then seq.

Collapse is *structural* (derived view): a task leaving an actionable state
simply stops matching `isActionableState` on the next peek — there is no
explicit "collapse write." Supersession of a stale ack is the `getTaskBySeq`
miss (current `tasks.seq` no longer equals the old event id). Those two
checks are the dual expression of one ADR invariant, but they are not
centralized and neither has a direct unit test.

**Also present, not cited:** `getEventAck` at `db.ts` L784 (helper under
`isEventAcked`); `event_acks` table DDL at `db.ts` L377–383; CLI exit-code
map and session scoping in `packages/cli/src/commands/watch.ts` (not part of
the proposed daemon module surface).

---

## 2. Answers to exploration questions

### Q1 — Does the inbox module own the transition log too, or consume the transition module (#206)?

**Consume, do not own.**

Evidence:

- The in-memory transition log (`TaskEngine.transitions`, `engine.ts`
  L567–568, type at L218–222) is the **firehose** substrate: `peekEvent` /
  `waitForEvents` / `peekAnyEvent` scan it by `seq > since`
  (`engine.ts` L2194–2208). That is edge-triggered streaming for
  `watch --follow` and SSE — a different product surface from ADR-0007.
- The inbox is **level-triggered** over *current* task rows + acks
  (`peekInbox` L2285–2301). It never reads `this.transitions`. A task already
  `completed` before the orchestrator connects still surfaces — exactly the
  #89 fix ADR-0007 encodes.
- Seq still matters as the **event id** (`tasks.seq`, stamped in
  `transitioned` via `bumpTaskSeq`, `engine.ts` L2127–2132 / `db.ts` L718–725),
  but that is a field on the task row, not a log entry.

Therefore the inbox module should depend on:

| Dependency | Role |
|---|---|
| Task snapshot reader | `getTask(id)`, `getTaskBySeq(eventId)` — current state + seq |
| Ack store | `isEventAcked` / `upsertEventAck` (or a thin port over them) |
| Wake / subscribe (for `waitFor` only) | "call me when *any* task state may have changed" |

It must **not** append to, scan, or own the transition log. If #206 extracts a
`transition()` seam, the inbox *subscribes* to its wake bus (or today's
`eventWaiters` set at `engine.ts` L569 / `wakeEventWaiters` L2175–2181). The
firehose stays with transitions; the inbox stays a pure derived view.

### Q2 — Does `waitFor` (long-poll waiter plumbing) belong inside, or stay an engine concern?

**Split: the wait *algorithm* belongs in the inbox module; the wake *bus*
does not.**

Today `waitForInbox` (`engine.ts` L2324–2352) is:

1. Loop: `peekInbox` → if pending, return; if `isInboxAllDone`, return
   all-done.
2. Park a closure on `this.eventWaiters` with a timeout.
3. On wake, re-peek; on timeout, late re-peek then return `null` (poll
   window elapsed — CLI re-polls; ADR-0002 long-poll pattern).

Steps 1 and the late-recheck policy are **inbox policy**. Step 2 is
**shared infrastructure** also used by `waitForTransition` (L2217–2237) for
firehose/SSE and by runner lease long-polls (`server.ts` L1335). Duplicating
the Set/timer pattern into a private inbox copy would re-fragment the bus.

Proposed split:

```text
Inbox.waitFor(ids, timeoutMs, wake: WakeSource)
  → pure loop over peek / allDone + injected park-until-wake-or-timeout

WakeSource  (from engine today, transition module after #206)
  → subscribe(cb): unsubscribe   // or parkFor(timeoutMs): Promise<"woke"|"timeout">
```

`longPollWindowMs()` (`server.ts` L140–143) stays a server/env concern —
passed in as `timeoutMs`, not owned by the inbox.

**If the team wants a smaller first cut:** ship `peek` / `ack` / `allDone` in
the module and leave `waitForInbox` as a thin engine wrapper over those three
plus `eventWaiters`. That still unlocks the unit-test surface for ADR
invariants; long-poll wiring can move in a follow-up once #206 settles the
bus.

### Q3 — What does `server.ts handleInbox` shrink to?

Today (`server.ts` L821–878) it already is a thin HTTP adapter. After an
inbox module, it shrinks to the same shape with clearer names — **not** to a
one-liner that deletes domain logic (there is almost no domain logic left in
server once engine owns the verbs):

1. `resolveWatchIds(engine, params)` — stay (HTTP ref resolution / 404).
2. Validate optional `ack` query (non-negative integer) — stay.
3. `inbox.ack(seq)` if present — was `engine.ackEvent`.
4. `wait ? inbox.waitFor(ids, window) : nonBlocking(ids)` — was
   `engine.waitForInbox` / inline peek+allDone.
5. Map result → JSON: `{ event, seq, task, all_done }` using
   `watchEventFor` + `envelopeFor` — stay (HTTP/presentation, not inbox
   policy).

What **does not** move into the inbox module:

- `resolveWatchIds` (daemon identity / `engine.resolve`)
- `envelopeFor` / `buildEnvelope` (report schema, queue enrichment, logs dir)
- `watchEventFor` (wire event names; core already has `eventNameForState` in
  `states.ts` L132–136 — optional later dedup, out of scope for this module)
- Session scoping (CLI-side today, `watch.ts` L127–143)

Net: server shrink is modest (~the inline non-wait branch becomes one call).
The real win is **engine** shrinking by ~90 lines of policy and those lines
becoming unit-testable without a `TaskEngine` or vendor child.

---

## 3. Proposed interface

### Location and name

| Item | Choice |
|---|---|
| Module path | `packages/daemon/src/inbox.ts` |
| Package | `@useparley/daemon` (needs `TaskRow`-shaped state + ack persistence; not core) |
| Vocabulary | keep `ACTIONABLE_STATES` / `INBOX_PRIORITY` / `inboxRank` / `isActionableState` in `packages/core/src/states.ts` — already the shared domain surface (CONTEXT.md + monorepo-layout: core owns the task-state model) |
| Export | named functions + a small factory, not a second god-class |

Not `@useparley/core`: core must stay free of sqlite/`TaskRow`. The monorepo
layout (`docs/spec/monorepo-layout.md`) puts domain *vocabulary* in core and
engine/storage in daemon — this respects that split.

### TypeScript sketch

```ts
// packages/daemon/src/inbox.ts
import {
  inboxRank,
  isActionableState,
  isTerminalState, // or TERMINAL_STATES from db — pick one source; see risks
} from "@useparley/core";

/** Minimal task face the inbox needs (today: subset of TaskRow). */
export interface InboxTask {
  id: string;
  state: string;
  seq: number;
}

/** Port: load current task rows. Prod = db wrappers; tests = Map. */
export interface TaskSnapshot {
  get(id: string): InboxTask | undefined;
  /** ADR-0007 event id lookup: task whose *current* seq === eventId. */
  getBySeq(eventId: number): InboxTask | undefined;
}

/** Port: per-(task_id, state) acked seq. Prod = event_acks; tests = Map. */
export interface AckStore {
  /** True when current (id, state) has acked_seq === task.seq. */
  isAcked(task: InboxTask): boolean;
  /** Record ack for (task.id, task.state) at task.seq. */
  recordAck(task: InboxTask): void;
}

/**
 * Wake source for long-poll. Engine's eventWaiters today; transition
 * module's bus after #206. Not owned by the inbox.
 */
export interface WakeSource {
  /**
   * Park until a state-change wake or timeoutMs elapses.
   * Resolves true on wake, false on timeout.
   */
  park(timeoutMs: number): Promise<boolean>;
}

export type InboxResult =
  | { kind: "event"; task: InboxTask }
  | { kind: "all_done" }
  | { kind: "timeout" }; // non-blocking empty is also "timeout" / null — see below

export interface Inbox {
  /** Ack by event id (transition seq). Superseded / non-actionable → no-op. */
  ack(eventId: number): void;
  /** Highest-priority pending event among ids, or null. */
  peek(ids: readonly string[]): InboxTask | null;
  /** Every watched task terminal and no pending events (empty set → true). */
  allDone(ids: readonly string[]): boolean;
  /**
   * Level-triggered long-poll: pending event, all-done, or poll-window miss.
   * Requires a WakeSource; pure peeks do not.
   */
  waitFor(
    ids: readonly string[],
    timeoutMs: number,
    wake: WakeSource,
  ): Promise<
    | { task: InboxTask }
    | { allDone: true }
    | null
  >;
}

export function createInbox(tasks: TaskSnapshot, acks: AckStore): Inbox {
  function peek(ids: readonly string[]): InboxTask | null {
    const pending: InboxTask[] = [];
    for (const id of new Set(ids)) {
      const task = tasks.get(id);
      if (!task) continue;
      if (!isActionableState(task.state)) continue;
      if (acks.isAcked(task)) continue;
      pending.push(task);
    }
    if (pending.length === 0) return null;
    pending.sort((a, b) => {
      const rank = inboxRank(a.state) - inboxRank(b.state);
      return rank !== 0 ? rank : a.seq - b.seq;
    });
    return pending[0] ?? null;
  }

  function allDone(ids: readonly string[]): boolean {
    if (peek(ids) !== null) return false;
    for (const id of ids) {
      const task = tasks.get(id);
      if (!task) continue;
      if (!isTerminalState(task.state)) return false;
    }
    return true;
  }

  function ack(eventId: number): void {
    if (!Number.isInteger(eventId) || eventId < 1) return;
    const task = tasks.getBySeq(eventId);
    if (!task) return; // superseded or unknown
    if (!isActionableState(task.state)) return;
    if (task.seq !== eventId) return; // belt-and-suspenders with getBySeq
    acks.recordAck(task);
  }

  async function waitFor(
    ids: readonly string[],
    timeoutMs: number,
    wake: WakeSource,
  ): Promise<{ task: InboxTask } | { allDone: true } | null> {
    for (;;) {
      const pending = peek(ids);
      if (pending) return { task: pending };
      if (allDone(ids)) return { allDone: true };
      const woke = await wake.park(timeoutMs);
      if (!woke) {
        const late = peek(ids);
        if (late) return { task: late };
        if (allDone(ids)) return { allDone: true };
        return null;
      }
    }
  }

  return { ack, peek, allDone, waitFor };
}
```

### Production adapters (thin, live next to call sites or in the same file)

```ts
// Sqlite-backed ports — wrap existing db.ts helpers, no new SQL.
export function sqliteTaskSnapshot(db: DatabaseHandle): TaskSnapshot {
  return {
    get: (id) => getTask(db, id),
    getBySeq: (eventId) => getTaskBySeq(db, eventId),
  };
}

export function sqliteAckStore(db: DatabaseHandle): AckStore {
  return {
    isAcked: (task) => isEventAcked(db, task as TaskRow),
    recordAck: (task) => upsertEventAck(db, task.id, task.state, task.seq),
  };
}

// Engine (or post-#206 transition bus) → WakeSource
export function engineWakeSource(engine: {
  // park registers on eventWaiters; extracted for testability
  parkEventWaiter(timeoutMs: number): Promise<boolean>;
}): WakeSource {
  return { park: (ms) => engine.parkEventWaiter(ms) };
}
```

### In-memory adapters (tests only)

```ts
export function memoryInboxDeps(seed: InboxTask[] = []): {
  tasks: Map<string, InboxTask>;
  snapshot: TaskSnapshot;
  acks: AckStore;
} {
  const tasks = new Map(seed.map((t) => [t.id, { ...t }]));
  const ackMap = new Map<string, number>(); // key = `${id}\0${state}` → acked_seq

  const snapshot: TaskSnapshot = {
    get: (id) => tasks.get(id),
    getBySeq: (eventId) =>
      [...tasks.values()].find((t) => t.seq === eventId),
  };
  const acks: AckStore = {
    isAcked: (task) =>
      ackMap.get(`${task.id}\0${task.state}`) === task.seq,
    recordAck: (task) => {
      ackMap.set(`${task.id}\0${task.state}`, task.seq);
    },
  };
  return { tasks, snapshot, acks };
}
```

Two adapters (sqlite + memory) justify the port: production must hit
`event_acks`; unit tests should not need a full `TaskEngine`, vendor
registry, or worktree to prove priority / supersession / all-done.

### Who calls what

```text
CLI  watch.ts
  → GET /tasks/inbox?ids=&ack=&wait=true
    → server.handleInbox
         → resolveWatchIds / validate ack
         → inbox.ack / inbox.waitFor | peek+allDone
         → envelopeFor + watchEventFor → JSON
    ← exit codes from task.state (CLI stays presentation)

TaskEngine (today)
  → owns children, transitions, MCP, spawn…
  → after extract: constructs createInbox(sqlite…, sqlite…)
  → exposes thin delegates OR server holds Inbox + WakeSource directly

transitioned() / #206 transition module
  → still stamps seq + wakes waiters
  → never calls inbox; inbox re-derives on wake
```

`TaskEngine.ackEvent` / `peekInbox` / `isInboxAllDone` / `waitForInbox` become
one-line delegates (compat) or are deleted once `server.ts` and any other
callers bind the module (only `server.ts` / engine self-use today).

---

## 4. Test-surface sketch

### What becomes testable in-process that was not

| ADR-0007 invariant | Today | After |
|---|---|---|
| Priority order across tiers | CLI spawn (`watch.test.ts`) | pure `peek` unit |
| FIFO by seq within a tier | CLI spawn | pure `peek` unit |
| Un-acked redelivery | CLI spawn | `peek` twice without `ack` |
| Ack of superseded event is no-op | CLI spawn (answer path) | mutate state/seq in memory Map, `ack(oldSeq)`, assert next `peek` |
| Answer collapses question (leave actionable) | CLI spawn | set state `running`/`completed`, assert old event gone |
| All-terminal + all-acked → allDone | CLI spawn | pure `allDone` |
| Empty watch set → vacuous allDone | implicit | one-liner unit |
| Non-actionable states never surface | implicit | unit |
| `waitFor` level-trigger (already pending → immediate) | CLI spawn | fake `WakeSource` that must not be called |
| `waitFor` timeout → null with live work | env-shrunk long-poll integration | fake wake that resolves `false` |
| `waitFor` wake → re-peek | full daemon | controllable wake |

### Test files

| File | Kind | Contents |
|---|---|---|
| `packages/daemon/tests/inbox.test.ts` | **unit** (primary win) | memory ports; all invariants above; no sqlite required for policy tests |
| `packages/daemon/tests/inbox-sqlite.test.ts` | **unit/integration** (thin) | `openDatabase` + `insertTask`/`updateTask`/`bumpTaskSeq` + sqlite ports — proves adapters match production SQL semantics (re-entry into same state un-acks via new seq, PK on `(task_id, state)`) |
| `packages/cli/tests/watch.test.ts` | **integration** (keep) | end-to-end HTTP + exit codes + session scoping; can trim redundant pure-policy cases later, not in the first PR |

### Unit vs integration split

- **Unit (inbox.test.ts):** policy only — priority, collapse, supersession,
  all-done, wait loop with injected wake. Milliseconds, no daemon process,
  no fake vendor.
- **Adapter smoke (inbox-sqlite.test.ts):** ack table upsert / getBySeq
  behavior against real `node:sqlite` temp home (same pattern as
  `packages/daemon/tests/concurrency-queue.test.ts`).
- **Integration (existing watch.test.ts):** wire format, exit codes 0/3/4/5/6,
  CLI session filter, long-poll re-poll under `PARLEY_LONG_POLL_MS`. Remains
  the contract test for orchestrators.

Daemon package already constructs `TaskEngine` against real sqlite in-process
for concurrency tests — the claim that "the engine can only be tested by
spawning real daemons" is **overstated for TaskEngine generally**, but still
true for these four methods: nothing currently calls them from daemon unit
tests, and spinning a full engine + children for priority sorting is the
wrong fixture. The module makes the *right* fixture (three task rows + ack
map) trivial.

---

## 5. Migration plan

Ordered steps; each is a reviewable PR-sized chunk. No behavior change
intended until step 5 (optional API tidy).

| Step | Change | Blast radius | Deletes |
|---|---|---|---|
| **1. Extract pure module** | Add `packages/daemon/src/inbox.ts` with `createInbox` + memory helpers used only by new unit tests. Do not rewire engine yet. | New file + tests only. Zero production call graph change. | Nothing |
| **2. Sqlite ports** | Add `sqliteTaskSnapshot` / `sqliteAckStore` wrapping existing `db.ts` helpers. Optional thin sqlite test. | `db.ts` exports unchanged; no migration SQL. | Nothing |
| **3. Engine delegates** | Implement `TaskEngine.ackEvent` / `peekInbox` / `isInboxAllDone` / `waitForInbox` as thin wrappers over a private `this.inbox` + wake adapter over `eventWaiters`. | `engine.ts` only. Server untouched. | Inline bodies of the four methods (~90 lines) |
| **4. WakeSource helper** | Extract the park-on-`eventWaiters` promise into something both `waitForTransition` and `waitFor` can share (or leave duplicated one more PR if #206 is imminent). | `engine.ts` wait paths. | Duplicated timer/Set blocks if unified |
| **5. Optional server bind** | `handleInbox` takes `Inbox` (or `engine.inbox`) explicitly; drop public engine inbox methods if unused. | `server.ts` + engine public API. | `TaskEngine` public inbox methods if no other callers |
| **6. Keep CLI integration** | Leave `watch.test.ts`; optionally delete cases fully covered by unit tests *only after* a full green cycle and human judgment. | CLI test suite. | Redundant integration cases (later, optional) |

**What is never deleted in this deepening:** `event_acks` table, `upsertEventAck` /
`isEventAcked` / `getTaskBySeq`, ADR-0007 HTTP route, CLI exit-code map, core
`INBOX_PRIORITY` vocabulary, firehose `/tasks/events`.

**What is not part of this work:** UI `projectInbox` (`packages/ui`) — a
different, attention-only projection for the cockpit (not the ack loop). No
shared module required; both may import `inboxRank` / attention helpers from
core if desired later.

---

## 6. Risks and rejected alternatives

### Risks

1. **`TERMINAL_STATES` dual definition.** Core exports an array
   (`states.ts` L23); daemon `db.ts` L47–51 exports a `ReadonlySet` used by
   `isInboxAllDone` today. The module must pick one (`isTerminalState` from
   core is the portable choice) so all-done does not diverge if vocabularies
   ever drift.
2. **`waitFor` without a shared wake bus.** If step 3 wires inbox wait to a
   *private* waiter set that `transitioned` forgets to signal, long-poll
   hangs. Mitigation: only one bus (`eventWaiters` or #206's), injected as
   `WakeSource`; never a second set.
3. **Over-porting.** A heavy repository hierarchy for three SQL helpers is
   ceremony. Keep ports as two small interfaces implemented by thin
   functions — not a package of classes.
4. **False security about integration tests.** Unit tests will not catch HTTP
   envelope / exit-code regressions. Keep `watch.test.ts` for the wire.
5. **#206 merge conflicts.** Both extractions touch `engine.ts` wait /
   `transitioned`. Mitigate with migration order: pure peek/ack/allDone first
   (low conflict); wait/wake last or after #206.

### Rejected alternatives

| Alternative | Why reject |
|---|---|
| **Put the module in `@useparley/core`** | Would drag task-row/ack persistence concepts into the SDK layer, or force awkward generics. Vocabulary already lives in core; *behavior* belongs in daemon. |
| **Inbox owns the transition log** | Conflates firehose (edge, seq cursor) with inbox (level, ack). Breaks #89-class correctness if someone "unifies" them naively. |
| **Stored queue table for pending events** | Contradicts ADR-0007 and CONTEXT.md ("derived view… Avoided synonyms: queue"). Collapse becomes write-time complexity; size ≤ task count is free when derived. |
| **Only extract without ports (call db.ts directly)** | Still an improvement, but unit tests then always need sqlite + full task rows. Two adapters are justified and small. |
| **Move `handleInbox` domain into server** | Wrong direction — server should stay transport (ADR-0002). |
| **"Not worth it — leave on TaskEngine"** | Rejected as the *default* outcome: the four methods are already a coherent interface; the missing piece is the test seam and a named home. Leaving them on a 3600-line class perpetuates zero direct coverage of ADR invariants. A *smaller* deepening (peek/ack/allDone only, wait stays on engine) remains acceptable if wait/wake is deferred to #206 — see §7. |

### ADR tension check

| ADR | Tension? |
|---|---|
| **0007** watch = acked attention inbox | **None** — this implements its module boundary. Decision stands. |
| **0008** watch is the only wait | **None** — does not reintroduce per-task `--wait`. |
| **0002** HTTP long-poll CLI plane | **None** — `waitFor` remains long-poll behind HTTP; window stays server-side. |
| Others (0001, 0003–0006, 0009–0015) | **None** — orthogonal. |

No ADR needs amendment. If a future change introduced a stored event queue, that
*would* require revisiting ADR-0007 — explicitly out of scope.

---

## 7. Interactions with #206 (transition module)

### Explicit assumptions about #206

This proposal assumes a **plausible** transition seam, not a committed
design:

1. Something like `transition(taskId)` (today's private `transitioned`) remains
   the single place that: bumps `tasks.seq`, appends a firehose log entry, and
   **wakes long-poll waiters**.
2. Waiters are a shared bus: subscribe/park until the next transition (today
   `eventWaiters` + `wakeEventWaiters`).
3. Firehose/SSE continue to read an ordered transition log; they are *not*
   rewritten to use the inbox.
4. #206 does **not** redefine ack, priority, or all-done — those stay ADR-0007
   inbox concerns.

If the parallel #206 exploration lands a different shape, only the
`WakeSource` adapter and migration step 4 need revisiting.

### Ticket claim: "mostly falls out of #206"

**Partially true, overstated.**

| Inbox piece | Depends on #206? |
|---|---|
| `peek` / priority / collapse filter | **No** — pure over task rows + acks |
| `ack` / supersession | **No** — pure over getBySeq + ack store |
| `allDone` | **No** |
| `waitFor` park/wake | **Yes, weakly** — needs *a* wake bus; today's `eventWaiters` suffices |
| Firehose / seq log | Owned by transitions, not inbox |

So three of four verbs (and most of the test win) can land **without** #206.
The "falls out of" relationship is really: *once transitions expose a clean
wake + seq stamp, `waitFor` becomes a five-line client of that seam.* The
inbox module is not a byproduct of the transition log extraction.

### What survives if #206 lands differently or not at all

| Scenario | Survives | Changes |
|---|---|---|
| **#206 lands as assumed** | Full four-verb module; `WakeSource` = transition bus | Engine loses both transition log *and* inbox bodies |
| **#206 delayed / abandoned** | `peek` / `ack` / `allDone` + unit tests; `waitFor` parks on `TaskEngine.eventWaiters` via a private adapter | Still ship the module; wake stays an engine detail |
| **#206 absorbs waiters but not the log** | Same as assumed for inbox | Only firehose placement differs |
| **#206 proposes inbox+transitions as one module** | **Push back** — level vs edge, ack vs cursor are different domains (this doc). Prefer two modules, one wake bus | Reject merge of firehose into inbox |
| **#206 renames seq / event id** | Policy tests and ports | Wire event-id type only |

### Recommended sequencing relative to #206

1. Land **#207 peek/ack/allDone** (module + unit tests + engine delegates)
   anytime — independent.
2. Land or design **#206** wake/seq seam.
3. Move **waitFor** fully onto the inbox + `WakeSource` (or leave the thin
   engine wrapper permanently if the bus API is awkward — still fine).

### Worth doing?

**Yes.** The four-verb interface already exists de facto on `TaskEngine`; the
deepening is extraction + a two-adapter port so ADR-0007 invariants get a
first-class, in-process test home. It does **not** require waiting for #206,
does **not** contradict any ADR, and does **not** need to own transitions.
The only piece that should wait on (or share a PR with) #206 is consolidating
the long-poll wake bus — optional for the first merge.
