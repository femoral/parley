# #206 — Task-state transition module

**Status**: exploration proposal · **Ticket**: [#206](https://github.com/femoral/parley/issues/206) · **Date**: 2026-07-23

**Recommendation**: proceed. A thin transition module that owns **write + notify pairing** (and unifies state-set imports) is worth doing. A full edge-validating state machine is not — the real bug class is missed `transitioned()` pairing, not illegal edges.

---

## 1. Problem restatement

### What is wrong today

Task lifecycle writes are open-coded across the engine. Each site that mutates `tasks.state` must remember to call a second method that publishes the change. Nothing in the type system or API shape ties those steps together.

The publish path already exists as a private method:

```2121:2144:packages/daemon/src/engine.ts
  /**
   * Record a task-state transition (#34): stamp the row with the next global
   * `seq`, append it to the in-memory event log, and wake multi-task watchers
   * (`parley watch` inbox / firehose / SSE). Call this after every state
   * change — including `pending → running` and `awaiting_answer → running`.
   */
  private transitioned(taskId: string): void {
    const row = getTask(this.db, taskId);
    if (!row) return;
    const seq = bumpTaskSeq(this.db, taskId);
    this.transitions.push({ seq, task_id: taskId, state: row.state });
    this.wakeEventWaiters();
    // #171: terminal or stalled frees a concurrency slot — drain the FIFO queue.
    if (TERMINAL_STATES.has(row.state) || row.state === "stalled") {
      this.drainConcurrencyQueue();
    }
    // ... dry-run purge ...
  }
```

Callers write state with `updateTask(... { state })` and then (hopefully) call `this.transitioned(id)`. A missed pair is silent: the row changes, but seq, the in-memory transition log, inbox/firehose waiters, and concurrency drain do not. Symptoms land in `watch` / inbox / queue admission — far from the write site.

Separately, lifecycle vocabulary is split across packages. Core advertises a "canonical vocabulary" in `packages/core/src/states.ts`, but the daemon engine imports `TERMINAL_STATES` / `SETTLED_STATES` / `SLOT_HOLDING_STATES` from `packages/daemon/src/db.ts`, not from core. Two independent `TERMINAL_STATES` definitions can drift.

### Citation audit (ticket vs this checkout)

Every `file:line` claim from the ticket body was checked against this worktree.

| Ticket claim | Verified? | Notes |
|---|---|---|
| `transitioned()` at `engine.ts:2127` | **Yes** | Still `private transitioned(taskId: string)` at L2127; body L2127–2144. |
| `TERMINAL_STATES` in `core/src/states.ts:23` | **Yes** | Array form: `["completed", "failed", "cancelled"] as const`. |
| Independent `TERMINAL_STATES` in `db.ts:47` | **Yes** | `ReadonlySet` form; engine imports the db copy (engine.ts L72–74). |
| `db.ts` has `SETTLED_STATES` / `SLOT_HOLDING_STATES` with no core counterpart | **Yes** | `SETTLED_STATES` L58; `SLOT_HOLDING_STATES` L575. |
| Engine imports db state sets, not core's `TERMINAL_STATES` | **Yes** | engine.ts L72–74 from `./db.js`. |
| 10 separate `this.transitioned(id)` calls | **Yes** | Exactly 10 call sites: L1770, 1805, 1885, 1915, 1984, 2117, 2391, 2502, 2972, 3471. |
| 14 inline `updateTask(... { state })` sites | **Mostly, with drift** | See inventory below. The ticket's count and example list mix real `updateTask` state writes, `onSpawn` patch literals, and one non-write. |
| Example line L1319 is a state write | **No — drift** | L1319 is `state: "pending"` on a **peek** `TaskRow` object used only for `canAdmit` (fix-reattempt budget check). It never calls `updateTask`. |
| Example lines L3221–3276 are updateTask sites | **Partial drift** | These lines construct the `onSpawn` `TaskPatch` passed into `runChild`; the actual `updateTask` is at L3467, followed by `transitioned` at L3471. Four wrappers share one write. |
| Core's `ACTIONABLE_STATES` / `INBOX_PRIORITY` "are not consumed by the daemon" | **No — drift** | The daemon **does** consume them via helpers. engine.ts L13–14 imports `inboxRank` and `isActionableState` from `@useparley/core` and uses them in `ackEvent` (L2274) and `peekInbox` (L2291–2297). The aspirational-header critique still holds for **set ownership** (`TERMINAL_STATES` dual definition; daemon operational sets only in db), but the ticket overstates non-consumption. |

### State-write inventory in `engine.ts` (this checkout)

**Paired write + `transitioned` (the normal path):**

| Site | To state | Caller path |
|---|---|---|
| L1764–1770 | `running` (only if was `awaiting_answer`) | `submitReport` |
| L1792–1805 | `completed` | `completeAcceptedReport` |
| L1872–1885 | `awaiting_answer` | `askOrchestrator` |
| L1907–1915 | `stalled` | `stallOnAnswerTimeout` |
| L1981–1984 | `running` | `answer` (live pending question) |
| L2107–2117 | `cancelled` | `cancel` |
| L2385–2391 | `failed` | `fail` |
| L2498–2502 | `running` | `tryClaimRunnerTask` |
| L2971–2972 | `queued` | `enqueueTask` |
| L3467–3471 | `running` (via `onSpawn`) | `runChild` (shared by `run` / `resume` / `resumeFix` / `runFreshFix`) |

**State write without immediate `transitioned` (deliberate delayed notify):**

| Site | Behavior |
|---|---|
| L1999–2017 (`answer` stalled resume) | Writes `state: "running"` **without** `transitioned`. The later `runChild` path re-writes `running` + `transitioned` when the child is actually live (L3467–3471). Intermediate DB state is therefore "running" with a stale seq until spawn completes. |

**Non-state `updateTask` calls (must stay outside the transition module):** usage merges (L799), worktree clear (L1729), eval fields (L2069), session/usage stream patches (L2632, L3559), branch record (L2649), report-only patches inside `submitReport` when not leaving `awaiting_answer`.

**Out-of-engine state write:**

| Site | Behavior |
|---|---|
| `db.ts` `sweepInterruptedTasks` L904–920 | Bulk SQL `UPDATE … state = 'stalled'` + per-id `bumpTaskSeq`. Runs **before** the engine exists, so no in-memory transition log and no waiter wake. Documented intentional (L917–919). |

**Count correction for the ticket:** there are **10** write sites that should own a notify (the table above), implemented as **10** `transitioned` calls + **1** delayed-notify write on the stalled-resume path + **1** pre-engine bulk sweep. The "14" figure appears to count `onSpawn` literal sites (4) and the false-positive L1319.

### Why it matters

- **Locality**: the invariant "state change ⇒ seq + log + wake + maybe drain" is a comment on `transitioned`, not a type.
- **Leverage**: every future feature that moves a task (runner lease, retry, concurrency) will add another hand-paired site.
- **Downstream architecture**: #207 (inbox module) and #208 (wire contract) both assume transitions are a reliable published fact. Without a single write path, inbox collapse and envelope `seq` remain "hopefully correct."

### ADR posture

No ADR currently mandates a transition module. This proposal **implements plumbing for** ADR-0007 (acked inbox keyed by transition seq) and ADR-0012 (runner claim is a `pending → running` transition). It does not change those decisions. Tension called out later if we over-validate edges relative to the soft guards already in the engine.

---

## 2. Exploration questions

### Q1 — Interface shape: validate legal from→to edges, or stay a dumb recorder?

**Answer: dumb recorder for the write path; optional debug-time edge checks; no hard FSM reject in v1.**

Arguments from the code:

1. **The bug class is pairing, not illegal edges.** Every production state write already sits behind a local guard (`TERMINAL_STATES.has`, `SETTLED_STATES.has`, `report !== null`, etc.). Failures that reach production are "forgot `transitioned`" style — e.g. the stalled-resume path at L1999 deliberately writes state without notify, relying on L3467 later. An edge validator would not have forced that pairing.

2. **The real graph is wider than the diagram in `docs/spec/parley-v1.md` §2.** Spec shows `pending → running` and `stalled → running`. Code also has:
   - `pending|… → queued` (`enqueueTask` L2966–2972)
   - `queued → running` (`runChild` onSpawn)
   - `awaiting_answer → running` without a full re-spawn (`submitReport` L1764–1770; `answer` L1981–1984)
   - `running → awaiting_answer` (`askOrchestrator`)
   - terminal absorption races: `cancel` then child `close` must not overwrite `cancelled` with `failed` (comment at L2103–2104)
   - report-wins: accepted report diverts `fail` into `completeAcceptedReport` (L2378–2380)

   Encoding that as a closed edge table is possible but brittle; every new concurrency/retry/runner path becomes a table edit under pain of production reject.

3. **Pre-engine and bulk transitions exist.** `sweepInterruptedTasks` multi-updates without reading per-row from-states into the engine. A hard FSM sitting only on `transition(id, to)` does not cover it unless we special-case — better to leave sweep as an explicit "bootstrap transition" that still uses shared helpers for seq.

4. **What "dumb" still owns (the value):**
   - `updateTask` for the state (+ allowed co-fields)
   - `bumpTaskSeq`
   - append `Transition` to the log
   - wake waiters
   - drain concurrency when the new state frees a slot
   - dry-run terminal purge hook (today inside `transitioned`)

Optional: `assertLegalTransition(from, to)` behind a debug flag or test-only export, using a **permissive** table derived from observed paths (not as a production hard fail). That documents intent without rejecting races.

**Rejected (for now):** production-hard `transition()` that throws on unknown edges. Cost > benefit until we have property tests proving the table matches reality.

### Q2 — Where does it live — engine method, or its own module the engine composes?

**Answer: own module under the daemon package; engine composes it. Not a free function with a raw `DatabaseHandle` only, and not a pure core module.**

Proposed location: `packages/daemon/src/transition.ts` (name bikeshed-tolerant; `task-transition.ts` is fine if "transition" collides in greps).

Why not only an engine method?

- `transitioned` is already an engine method and that did not create a test surface: exercising it requires a full `TaskEngine` + waiter plumbing.
- #207 wants to consume "a transition happened" without owning engine guts; a module-level type (`Transition`, `TransitionSink`) is a cleaner dependency than `TaskEngine`.

Why not pure core?

- Seq counters, SQLite `updateTask`, and dry-run purge are daemon persistence concerns.
- Waiter sets and concurrency drain are process-local daemon runtime.
- Core already owns **vocabulary** (`TaskState`, `TERMINAL_STATES`, ranks). The transition module **uses** core vocabulary and **performs** daemon side effects.

Composition sketch:

```
TaskEngine
  ├─ owns: children, pending questions, eventWaiters, transitions[], admitted, dryRunTaskIds
  ├─ constructs: TaskTransitions({ db, log, wake, onSlotFreed, onTerminalDryRun })
  └─ call sites: answer / fail / cancel / ask / claim / enqueue / runChild / …
```

The module must accept **injected side-effect hooks** for wake and queue drain so it stays unit-testable with fakes. It should not import `TaskEngine`.

### Q3 — How to prevent future direct `updateTask({ state })` writes?

**Answer: type-level first; mechanical check second; no runtime proxy of `updateTask`.**

1. **Type-level (primary)**  
   Split today's `TaskPatch` (`db.ts` L926–963), which includes `"state"`:

   - `TaskDataPatch` — every mutable field **except** `state`
   - `StatePatch` / transition fields — only accepted by `transition(...)`
   - `updateTask(db, id, patch: TaskDataPatch)` — compile error if `state` is passed

   Call sites that today bundle `state` with `question_id` / `completed_at` / `error` move those co-fields into the transition API (they are transition metadata, not free-floating data).

2. **Mechanical guard (secondary)**  
   A small unit test or lint script: `rg 'state:' packages/daemon/src --glob '*.ts'` allowlisted to `transition.ts`, `db.ts` schema/sweep, and tests. Prefer a vitest that imports the daemon src graph and fails if `TaskPatch` still exposes `state` — types are the real fence; grep is the tripwire for SQL string updates.

3. **Do not** wrap `updateTask` in a Proxy or monkey-patch. Too clever; tests and scripts call `updateTask` directly with state for fixtures (many hits under `packages/daemon/tests/`). Test helpers can keep a `testUpdateTaskState` or use the transition module with a no-op sink.

4. **Bulk SQL** (`sweepInterruptedTasks`) stays an explicit exception documented next to the module: "bootstrap transitions use `recordBootstrapStalls` which bumps seq but does not wake waiters."

### Q4 — Interplay with runner-lease-driven transitions and retry flow

**Runner lease (consumer of the interface; related exploration #209):**

Today `tryClaimRunnerTask` (engine.ts L2495–2507):

1. `selectClaimablePendingTask` / `listCapablePendingTasks` — pure SELECT of oldest `pending` whose vendor the claimer advertises and whose affinity is unset or names the claimer (#315; replaces the former name-pinned claim); **not** atomic with the state write.
2. `updateTask(..., { state: "running", started_at })`
3. `this.transitioned(pending.id)`
4. arm heartbeat

Under a transition module this becomes one `transition(id, "running", { cause: "runner_claim", fields: { started_at } })`. Assumptions for #209:

- **Assume** #209 extracts lease protocol / `RunnerLeaseSpec` / REST verbs out of the engine; it does **not** invent a second state machine on the runner. The runner never writes task state locally — all lifecycle writes stay daemon-side (ADR-0012).
- **Assume** claim remains daemon-authoritative. If #209 adds compare-and-swap claim SQL, that SQL still ends in the same transition helper for seq/notify.
- Heartbeat loss already goes through `fail` (L2424–2426) → will automatically use the module.

**Retry / fix reattempt flow (related to #212 spawn plan, not a separate ticket here):**

- New attempt rows are created via `insertTask` with initial `pending` (engine.ts ~L1186, ~L1368) — **insert is not a transition** (no prior state; no seq requirement until first move). First published transition is still `pending → queued|running` via `scheduleLocalStart` / `enqueueTask` / `runChild`.
- Fix paths call the same `run` / `resumeFix` / `runFreshFix` wrappers that funnel to `runChild` onSpawn → one transition site.
- **Assume** #212 collapses the four spawn wrappers into a plan value but **keeps a single post-spawn state publication**. The transition module should be the notify side of that publication, not re-absorbed into `runChild`.

**Stalled-resume double-write (must design explicitly):**

Today L1999 writes `running` early; L3467 publishes. Options:

| Option | Pros | Cons |
|---|---|---|
| A. Keep delayed notify: data-patch clears question/error without state; only `runChild` transitions to `running` | Matches "watch sees start when child is live" | Row may still show `stalled` during prepare — better than silent running |
| B. Transition to an intermediate (none exists) | — | Spec has no such state |
| C. Immediate `stalled → running` transition at answer, second write is no-op if already running | Watch wakes early | May surface `running` before child exists; queue slot held sooner |

**Recommendation: A.** Transition module API should encourage "one published edge per real lifecycle move." Clearing question fields while still `stalled` is a `TaskDataPatch` (or a dedicated `clearQuestion(id)`), not a fake `running` write. That **fixes** the silent intermediate write as part of migration.

---

## 3. Proposed interface

### Module

- **Path**: `packages/daemon/src/transition.ts`
- **Package**: `@useparley/daemon` (internal; not a new package)
- **Depends on**: `db.ts` (`updateTask` data-only, `getTask`, `bumpTaskSeq`), `@useparley/core` state vocabulary
- **Does not depend on**: `engine.ts`, `server.ts`, inbox helpers

### TypeScript sketch

```typescript
// packages/daemon/src/transition.ts
import {
  isTerminalState,
  type TaskState,
} from "@useparley/core";
import {
  bumpTaskSeq,
  getTask,
  updateTaskData, // today's updateTask, state removed from the patch type
  type DatabaseHandle,
  type TaskRow,
} from "./db.js";

/** Same shape as today's engine Transition (engine.ts L218–222). */
export interface Transition {
  seq: number;
  task_id: string;
  state: string;
}

/**
 * Why the state moved — free-string / narrow union for logs and tests.
 * Not an edge key; not validated as a closed enum in v1.
 */
export type TransitionCause =
  | "spawn"
  | "runner_claim"
  | "enqueue"
  | "ask"
  | "answer"
  | "submit_report_unawait"
  | "complete"
  | "fail"
  | "cancel"
  | "answer_timeout"
  | "bootstrap_sweep"
  | "dry_run_purge" // not a state write; listed for symmetry in call-site docs
  | (string & {});

/** Co-fields frequently written with a state change today. */
export interface TransitionFields {
  error?: string | null;
  report?: string | null;
  question_id?: string | null;
  question?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  queued_at?: string | null;
  // allow other TaskDataPatch fields if a call site needs them in one round-trip
  [extra: string]: string | number | null | undefined;
}

export interface TransitionHooks {
  /** Append-only log (engine.transitions today). */
  append(transition: Transition): void;
  /** Wake inbox / firehose / SSE waiters. */
  wake(): void;
  /**
   * Called when the new state frees a concurrency slot.
   * Today: terminal or stalled → drainConcurrencyQueue (engine.ts L2134–2136).
   */
  onSlotFreed?(taskId: string, state: TaskState): void;
  /** Dry-run terminal purge scheduling (engine.ts L2140–2143). */
  onTerminal?(taskId: string, state: TaskState): void;
}

export interface TaskTransitions {
  /**
   * Read current row, write `to` + fields, bump seq, append log, wake, hooks.
   * No-op (return null) if the task is missing.
   * Idempotent skip: if row.state === to AND no fields change that require
   * republish — call sites that need forced republish pass `force: true`.
   */
  apply(
    taskId: string,
    to: TaskState,
    opts?: {
      cause?: TransitionCause;
      fields?: TransitionFields;
      force?: boolean;
    },
  ): Transition | null;

  /**
   * Startup sweep helper: tasks already bulk-updated to stalled in SQL.
   * Only bumps seq + append (if log is live) without re-writing state.
   * Used when engine constructs after sweepInterruptedTasks.
   */
  recordExternal(taskId: string, state: TaskState, cause: TransitionCause): Transition | null;
}

export function createTaskTransitions(
  db: DatabaseHandle,
  hooks: TransitionHooks,
): TaskTransitions {
  return {
    apply(taskId, to, opts) {
      const row = getTask(db, taskId);
      if (!row) return null;
      if (row.state === to && !opts?.force && !opts?.fields) {
        // optional: still return last transition identity; v1 may no-op
      }
      updateTaskData(db, taskId, { ...opts?.fields, /* state written here only */ });
      // implementation writes state via internal SQL or a privileged helper
      const seq = bumpTaskSeq(db, taskId);
      const transition: Transition = { seq, task_id: taskId, state: to };
      hooks.append(transition);
      hooks.wake();
      if (isTerminalState(to) || to === "stalled") {
        hooks.onSlotFreed?.(taskId, to);
      }
      if (isTerminalState(to)) {
        hooks.onTerminal?.(taskId, to);
      }
      return transition;
    },
    recordExternal(taskId, state, _cause) {
      const seq = bumpTaskSeq(db, taskId);
      const transition: Transition = { seq, task_id: taskId, state };
      hooks.append(transition);
      // no wake on bootstrap — matches today's sweep (db.ts L917–919)
      return transition;
    },
  };
}
```

### Privileged state write in `db.ts`

```typescript
// Only imported by transition.ts (and tests). Not part of the public TaskDataPatch path.
export function writeTaskState(
  db: DatabaseHandle,
  id: string,
  state: TaskState,
  fields?: TaskDataPatch,
): void;
```

Or keep a single internal `updateTask` with two exported wrappers: `updateTaskData` vs `writeTaskState`. The important part is **callers outside `transition.ts` cannot pass `state`**.

### Who calls what

| Caller (engine method) | Transition |
|---|---|
| `enqueueTask` | `apply(id, "queued", { cause: "enqueue", fields: { queued_at } })` |
| `runChild` (onSpawn) | `apply(id, "running", { cause: "spawn", fields: { started_at?, launch_command, queued_at: null } })` |
| `tryClaimRunnerTask` | `apply(id, "running", { cause: "runner_claim", fields: { started_at } })` |
| `askOrchestrator` | `apply(id, "awaiting_answer", { cause: "ask", fields: { question_id, question } })` |
| `answer` (live) | `apply(id, "running", { cause: "answer", fields: { question_id: null, question: null } })` |
| `answer` (stalled) | data patch only (clear question/error); spawn path publishes `running` |
| `submitReport` (was awaiting) | `apply(id, "running", { cause: "submit_report_unawait", fields: { report, … } })` |
| `completeAcceptedReport` | `apply(id, "completed", { cause: "complete", fields: { completed_at, … } })` |
| `fail` | `apply(id, "failed", { cause: "fail", fields: { error, completed_at, … } })` |
| `cancel` | `apply(id, "cancelled", { cause: "cancel", fields: { error, completed_at, … } })` |
| `stallOnAnswerTimeout` | `apply(id, "stalled", { cause: "answer_timeout", fields: { error } })` |
| `sweepInterruptedTasks` | remains SQL bulk update; optionally post-pass `recordExternal` once engine exists (today: seq only, no log) |

Engine keeps domain decisions (whether to fail vs complete, whether to stall, report-wins). The module only **commits** the decided state.

### State-set authority

| Set | Today | Proposal |
|---|---|---|
| `TASK_STATES` / `TaskState` | core | core (unchanged) |
| `TERMINAL_STATES` | **duplicated** core array + db Set | **core only**; daemon imports `isTerminalState` / a `terminalStatesSet` helper from core (or re-exports). Delete db copy. |
| `ACTIONABLE_STATES` / `INBOX_PRIORITY` | core; already used by engine via helpers | core (unchanged). Ticket drift corrected: daemon already consumes helpers. |
| `SETTLED_STATES` (= terminal ∪ `stalled`) | db only | Move to core next to `TERMINAL_STATES` **or** to `transition.ts` as operational vocabulary. Prefer **core** so CLI/UI can share "child may not move this task" if needed later; document as daemon-oriented. |
| `SLOT_HOLDING_STATES` | db only | Keep near concurrency (`db.ts` counts or a `concurrency.ts`) — **not** required inside the transition module. Transition only needs "does this state free a slot?" which is already `terminal ‖ stalled`. |

Deleting db `TERMINAL_STATES` forces `server.ts` L26 / L762 and `cli` `logs.ts` to import from core (aligned with #208's "stop leaking daemon db as wire contract," but independently correct).

### Optional debug edge table (not production-hard)

```typescript
/** Documented observed edges; used by tests / NODE_ENV development asserts. */
export const OBSERVED_EDGES: ReadonlyArray<readonly [TaskState, TaskState]> = [
  ["pending", "running"],
  ["pending", "queued"],
  ["pending", "cancelled"],
  ["pending", "stalled"], // bootstrap sweep / rare
  ["queued", "running"],
  ["queued", "cancelled"],
  ["queued", "stalled"],
  ["running", "awaiting_answer"],
  ["running", "completed"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["running", "stalled"],
  ["awaiting_answer", "running"],
  ["awaiting_answer", "stalled"],
  ["awaiting_answer", "completed"], // theoretically via report-then-settle paths
  ["awaiting_answer", "failed"],
  ["awaiting_answer", "cancelled"],
  ["stalled", "running"],
  ["stalled", "cancelled"],
  // terminal → * forbidden
];
```

---

## 4. Test-surface sketch

### What becomes testable in-process that was not

Today, proving "state write publishes seq + wakes waiters + drains queue" requires daemon integration (forked process, real HTTP). The transition module can be tested with:

- an in-memory or temp SQLite via existing `openDatabase`
- fake hooks recording `append` / `wake` / `onSlotFreed` calls
- no `TaskEngine`, no child processes, no MCP

### Unit tests (new)

**File**: `packages/daemon/tests/transition.test.ts`

| Case | Asserts |
|---|---|
| `apply` writes state + bumps seq | row.state, row.seq increased |
| `apply` always calls `append` then `wake` | hook order |
| terminal / stalled calls `onSlotFreed` | completed/failed/cancelled/stalled yes; running/queued no |
| terminal calls `onTerminal` | dry-run purge hook site |
| missing task → null, no hooks | |
| co-fields round-trip | question_id, error, completed_at |
| `updateTaskData` rejects `state` at type level | `expectTypeOf` / ts test |
| privileged write not used outside module | optional eslint boundary test |

### Integration tests (existing, light touch)

- Keep concurrency-queue, runner, watch/inbox integration tests as behavioral nets.
- After migration, add one focused integration case: "forgetful call site impossible" is compile-time; instead assert stalled-resume does **not** leave a silent `running` without seq change (regression for the L1999 pattern).

### Unit vs integration split

| Layer | Owns |
|---|---|
| `transition.test.ts` | pairing invariant, seq monotonicity, hook dispatch |
| engine / server integration | domain guards (report-wins, cancel vs child exit), inbox delivery, runner claim |
| core `states` tests (if added) | set membership, ranks — already partially covered via UI/cli |

No need to re-test full `askOrchestrator` MCP in the transition unit file.

---

## 5. Migration plan

Ordered steps; each should be a reviewable PR (or stacked commits). Blast radius is about **compile surface**, not runtime protocol — wire shapes and ADR-0007 behavior stay the same if seq still bumps once per published edge.

| Step | Work | Blast radius | Deletes |
|---|---|---|---|
| **1. Unify `TERMINAL_STATES`** | Daemon + CLI import terminal helpers from `@useparley/core`. Add `SETTLED_STATES` to core (or transition module) and re-point db consumers. | `db.ts`, `engine.ts`, `server.ts`, `cli/.../logs.ts`, any test importing db sets | db.ts `TERMINAL_STATES` export; eventually duplicate Set literals |
| **2. Split `TaskPatch`** | Introduce `TaskDataPatch` without `state`; keep temporary escape hatch `updateTask` deprecated wrapper if needed for one PR | All `updateTask` call sites in engine + tests | — |
| **3. Add `transition.ts` + port `transitioned` body** | Engine constructs `TaskTransitions`; `private transitioned` becomes thin delegate or dies | engine.ts only for wiring | body of `transitioned` (logic moves) |
| **4. Port paired call sites one cluster at a time** | (a) terminal: fail/cancel/complete (b) Q&A: ask/answer/stall/submitReport (c) scheduling: enqueue/spawn/claim | engine methods only; behavior unchanged | raw `updateTask`+`transitioned` pairs |
| **5. Fix stalled-resume double-write** | Data-patch question clear; single `running` publish from spawn | `answer` + watch timing for resume | silent L1999 state write |
| **6. Sweep documentation** | Comment on `sweepInterruptedTasks` pointing at bootstrap policy; optional `recordExternal` if we ever want stall events in the in-memory log after engine start | db startup path | — |
| **7. Fence** | Remove `state` from any public patch type; add unit tests + allowlist grep | CI | temporary deprecated wrappers |

**What gets deleted (end state):**

- `private transitioned` as the only publish API (replaced)
- Duplicate `TERMINAL_STATES` in `db.ts`
- Hand-paired `updateTask({ state })` + `this.transitioned` at the 10 sites
- (Optional later) engine.ts re-export of transition types once call sites are stable

**What does not get deleted:**

- `updateTask` for non-state fields
- `bumpTaskSeq` (used by module + sweep)
- Inbox methods (`peekInbox`, `ackEvent`, …) — those are #207
- Spec lifecycle; ADRs

---

## 6. Risks and rejected alternatives

### Risks

1. **Resume timing change** if we fix the L1999 double-write (recommended). Orchestrators that polled `status` and saw early `running` during prepare would see `stalled` until spawn finishes. Firehose/`watch --follow` already only saw the later transition; inbox actionable state for `stalled` remains until leave. Low risk; matches documented "transition on start."
2. **Over-validation** if a future PR hardens the edge table and rejects a legitimate race (cancel vs child exit). Mitigation: keep production dumb; put the table in tests only.
3. **Hook wiring bugs** when extracting `transitioned` (forget `onSlotFreed` → concurrency deadlock under caps). Mitigation: unit tests on hook dispatch; existing concurrency integration tests.
4. **Test fixture churn**: many tests call `updateTask(db, id, { state: "running" })`. They need `writeTaskState` test helper or `createTaskTransitions` with no-op wake. One-time cost.
5. **Parallel arch work (#207–#212)** may touch the same engine regions. Mitigation: land #206 types/module first (small), or accept short-lived merge conflict on engine.ts only.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Full production FSM with illegal-edge throws | Does not fix pairing; fights real races; high maintenance (Q1) |
| Keep only `engine.transitioned` but "be more careful" | Status quo; comment already says "call after every state change" and L1999 still special-cases |
| Put module in `@useparley/core` | Core must not own SQLite seq or waiter hooks |
| Event-sourcing entire task row from a transition log | Massive redesign; out of scope; ADRs assume row-primary state + seq stamp |
| DB trigger on `tasks.state` to bump seq | Hidden control flow; cannot wake in-process waiters from SQLite |
| Proxy/wrap every `updateTask` | Surprising; breaks tests; worse than types |
| Merge transition module into future inbox module (#207) | Different responsibilities: publish vs derive-pending-events; keep separate (see §7) |

### Is the deepening worth it?

**Yes**, scoped as **paired publisher + single state-set authority**. Evidence:

- 10 production notify sites and a growing set of consumers (inbox, firehose, SSE, concurrency, dry-run)
- Documented invariant only in a comment (engine.ts L2124–2125)
- Real delayed/missed-pairing pattern already in-tree (L1999 vs L3471)
- Dual `TERMINAL_STATES` is concrete drift risk (array vs Set; two packages)

**Not worth it** as a grand FSM or event-sourced rewrite — that fails the ticket's own deletion test (would relocate complexity into edge tables and migration stories without reducing call-site burden).

---

## 7. Interactions with parallel explorations

Stated assumptions only — these tickets are explored in parallel; do not design against imagined outcomes.

### Downstream: #207 inbox module

- **Assumption**: #207 extracts `peek · ack · waitFor · allDone` and treats the transition log / seq stamps as **inputs**, not something it writes.
- **This proposal provides**: reliable `Transition` append + `wake()` so level-triggered inbox re-checks see fresh state+seq.
- **Boundary**: transition module does **not** know about acks, priority, or orchestrator sessions. Inbox module does **not** write `tasks.state`.
- **If #207 wants the transition log**: consume `hooks.append` storage (engine's `transitions[]` today) or a small `TransitionLog` interface owned by either engine or a tiny shared type in daemon — not by inventing a second log inside inbox.

### Downstream: #208 wire contract

- **Assumption**: #208 moves `TaskRow` / envelope / event names into core's contract and stops CLI imports of `daemon/db.js`.
- **This proposal helps** by moving `TERMINAL_STATES` consumers off `db.js` toward core (same direction).
- **Non-goals for #206**: envelope shape, `watchEventFor` vs `eventNameForState` dedup, UI backfill — pure #208.
- **Shared type**: `Transition` may eventually live next to the wire firehose event in core; until #208 lands, keep it in `transition.ts` / engine re-export to avoid scope creep.

### Consumer: #209 runner lease protocol

- **Assumption**: #209 lifts `RunnerLeaseSpec`, headers, and REST verbs out of engine; runner remains a state-less executor (ADR-0012).
- **Consumer relationship**: lease claim's `pending → running` is a **call site** of `TaskTransitions.apply`, not a parallel state store.
- **Do not** put lease HTTP concerns into `transition.ts`.
- **Atomic claim**: if #209 upgrades `selectClaimablePendingTask` to `UPDATE … WHERE state='pending' RETURNING`, the transition helper still performs seq/log/wake after the winning update (or folds into one daemon-side function `claimAndTransition`).

### Consumer: #212 spawn-plan seam

- **Assumption**: #212 collapses `run` / `resume` / `resumeFix` / `runFreshFix` into plan data + one `runChild`; stream parse and exit disposition may split out.
- **Consumer relationship**: exactly one spawn-success transition (`→ running`) and disposition transitions (`→ completed|failed`) should call the transition module.
- **Avoid**: re-inlining `updateTask({ state })` inside a new `disposition.ts` — disposition decides *which* state; transition module commits it.
- **Launch templates (ADR-0015)**: unchanged; they only affect argv/plan, not state vocabulary.

### Explicit non-assumptions

- Do not assume inbox moves into this module.
- Do not assume runner gains authority to write task state.
- Do not assume a new package boundary beyond `packages/daemon/src/transition.ts`.
- Do not assume hard edge validation ships in the same change set as the pairing fix.

---

## Appendix A — ADR checklist

| ADR | Tension? |
|---|---|
| 0002 CLI/daemon HTTP long-poll | None — transport unchanged |
| 0004 spawn-per-turn adapters | None — adapters do not write task state |
| 0007 watch attention inbox | Supports — seq + wake remain the publish mechanism |
| 0008 single-flow watch-only | None |
| 0012 remote runners | Supports — claim/fail stay daemon transitions |
| 0015 launch templates | None — spawn plan only |

## Appendix B — Glossary alignment

`CONTEXT.md` task states omit `queued` (added for concurrency #171). Core `TASK_STATES` includes `queued`. This proposal treats `queued` as a first-class `TaskState` (already in core). A glossary update is editorial follow-up, not blocking for the module.
