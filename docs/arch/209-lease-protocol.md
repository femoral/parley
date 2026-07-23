# #209 — Runner lease-protocol module (exploration proposal)

**Status**: design exploration (no implementation)  
**Ticket**: #209  
**Related**: ADR-0012 (remote runners), #212 (spawn-plan seam), #206 (transition module)

---

## 1. Problem restatement

Parley runs remote tasks through a **lease wire contract**: a runner process long-polls the daemon, claims one affinity-tagged task, heartbeats while executing, streams vendor events, records the pushed branch, and fails when execution cannot complete (ADR-0012). That contract is real and already live — but its **types and constants live inside the daemon engine**, and the **runner package reaches across the process boundary by deep-importing daemon modules**.

Today:

- `RunnerLeaseSpec` is defined on `TaskEngine`'s home turf and re-imported by the runner client and loop.
- Child correlation uses `TASK_HEADER` (`x-parley-task`) exported from the same 3,640-line engine file; the runner hub-proxy and loop import it from there; the CLI child helper re-declares the string literal instead.
- `packages/runner/src/protocol.ts` is a thin re-export of daemon preamble / context / prompt-layer helpers; its docstring admits it "mirrors the daemon engine's preamble."
- `packages/runner/src/client.ts` is five near-identical `fetch` wrappers with untyped JSON casts.
- `RunnerLoop.execute` is a single ~180-line method that mixes repo mapping, worktree cut, context materialization, hub proxy, adapter prepare, spawn/stream, git push, and fail safety-net — with only one integration test covering the happy path.

The proposed deepening is a **first-class lease-protocol surface** so lease-shape changes cannot drift silently between processes, the shallow runner modules can die, and the untested failure branches become unit-testable against an in-process fake transport.

### Citation verification (ticket vs this checkout)

| Ticket claim | Verified in this checkout | Drift |
|---|---|---|
| `RunnerLeaseSpec` at `packages/daemon/src/engine.ts:492` | Yes — interface starts at line 492 | None |
| `TASK_HEADER` at `packages/daemon/src/engine.ts:154` | Yes — `export const TASK_HEADER = "x-parley-task"` | None |
| Engine is 3,640 lines | Yes — `wc -l` = 3640 | None |
| Runner imports `RunnerLeaseSpec` / `TASK_HEADER` from `@useparley/daemon/engine.js` | Yes — `client.ts:1`, `loop.ts:8–9`, `hub-proxy.ts:2` | None |
| Runner also pulls adapters, context, worktree from daemon | Yes — `loop.ts:7–17`, `protocol.ts:7–15` | None |
| `protocol.ts` is shallow pass-through | Yes — 82 LOC wrapping daemon builders | None |
| `client.ts` is five near-identical fetch wrappers | Yes — `lease` / `heartbeat` / `events` / `branch` / `fail` | None |
| Runner ≈ 986 src LOC, one test file 187 LOC | Yes — sum of `packages/runner/src/*.ts` = 986; `loop.test.ts` = 187 | None |
| `RunnerLoop.execute` at `loop.ts:92–271` | Yes — method spans 92–271 | None |
| Single end-to-end case in `loop.test.ts` | Yes — one `it(...)` happy path | None |

**No citation drift.** All ticket file:line references match this worktree.

### What "two adapters" actually means here

The ticket says the engine (local executor) and the remote runner become the protocol's two adapters. **That wording overstates symmetry.** Evidence from the code:

- Local tasks never call `/runner/*`. The engine's in-process path is `run` → `adapter.prepare` → `runChild` (`packages/daemon/src/engine.ts:3215–3223`, `3376+`).
- Only remote-affine tasks enter the lease surface: `leaseRunnerTask` / `runnerHeartbeat` / `processRunnerEvents` / `recordRunnerBranch` / `failRunnerTask` (`engine.ts:2495–2668`), routed from `server.ts:1319+`.

So the real dual adapters of a **lease wire protocol** are:

1. **Server** — daemon HTTP + engine claim/heartbeat/events/branch/fail methods.
2. **Client** — runner `RunnerClient` + loop.

A separate, broader goal (shared *execution* prep so local and remote do not fork semantics) is already half-done via daemon modules the runner deep-imports, and is the natural home of #212 (spawn-plan), not the lease wire itself. This proposal keeps those concerns distinct.

---

## 2. Exploration questions

### Q1 — Where does the module live: core, or a new shared package?

**Recommendation: `@useparley/core`, not a new package.**

**Evidence**

- Package graph today (`packages/*/package.json`):
  - `core` → nothing
  - `daemon` → `core`
  - `runner` → `core` + **`daemon`**
  - `cli` → `core` + `daemon`
- Monorepo layout (`docs/spec/monorepo-layout.md`) still documents only core ← daemon ← cli (+ ui). The runner package was added by ADR-0012 and is not reflected there — package-boundary work for runners is unfinished.
- ADR-0009 already established the pattern: wire/plugin contracts that cross process or package boundaries live in `@useparley/core` (`VendorAdapter`, `TaskSpec`, `SpawnPlan` in `packages/core/src/adapter.ts`). The UI wire contract lives in `packages/core/src/contract.ts` with the same rationale ("versioned public surface").
- A new `@useparley/lease` (or similar) package would add publish/version/CI surface for roughly one types file + one client file. Nothing in the lease surface needs Node APIs that core cannot host (`fetch` is already used in `packages/core/src/client.ts`).

**What goes in core**

| Export | Why core |
|---|---|
| `TASK_HEADER` | Used by daemon MCP/child handlers, runner hub-proxy, and (should be) CLI child helper — currently triple-homed |
| `RunnerLeaseSpec` | JSON body of `POST /runner/lease` 200 — the cross-process payload |
| Route path helpers / verb names | Document the five REST shapes in one place |
| Request body types (`LeaseRequest`, `EventsBody`, `BranchBody`, `FailBody`) | Prevent client/server drift on field names |
| Heartbeat default constant (optional re-export) | Already documented in ADR-0012 as 90s; engine has `DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS` at `engine.ts:160` |
| Typed `RunnerLeaseClient` (or `LeaseTransport` interface + HTTP impl) | Same role as core's daemon client helpers: pure HTTP over a base URL |

**What stays out of core**

- Claim/long-poll/waiters, SQLite, heartbeat timers (`engine.ts:589–611`, `2421–2541`) — daemon-only runtime.
- Worktree cut, adapter registry, spawn, git push — execution host concerns (runner + daemon engine).
- Prompt assembly — see Q2.

**Rejected: keep types in daemon and "just export better."**  
That is the status quo. Runner must depend on `@useparley/daemon` merely to name a JSON shape; install/typecheck still couples the thin remote binary to the full engine surface (MCP SDK, etc. already sit on the daemon dep). Moving the *wire* types to core is the minimum that completes ADR-0012's "shared contract" half without pretending execution modules have moved.

**Rejected: new package.**  
Justified only if lease protocol gained substantial pure logic (codec, negotiation, multi-version envelopes). Today it does not.

### Q2 — Does prompt assembly belong to the protocol, or stay daemon-side?

**Recommendation: stay outside the lease-protocol module.** Keep builders where they already live (`packages/daemon/src/preamble.ts`, `prompt-layers.ts`, `context.ts`); delete the runner's shallow `protocol.ts` by importing those builders directly (or, later, via a shared spawn-prep module owned with #212).

**Evidence**

- Lease payload already ships the **brief** as `prompt: string` plus `contexts`, `report_schema`, `answer_timeout_ms`, `vendor`, `profile` (`RunnerLeaseSpec` at `engine.ts:492–518`). The daemon does **not** ship a fully assembled child prompt on the wire.
- Both sides assemble the child prompt **on the execution host after the worktree exists**:
  - Local: `initialPrompt` → `buildProtocolPreamble` + `composeOperatorInstructions` + `assembleChildPrompt` (`engine.ts:2809–2841`).
  - Remote: `fullPrompt` in `packages/runner/src/protocol.ts:53–82`, same daemon helpers, with `cwd` = runner worktree and home = runner host's parley home (comment at `protocol.ts:48–51` explicitly).
- Operator layers are host-local by design: project layers from workspace, home layers from the host home (`engine.ts:2822–2832` vs runner `protocol.ts:74–80`). That cannot be a pure wire concern without shipping operator prose over the lease (undesirable and not current behavior).
- `runner/src/protocol.ts` fails the deletion test: every function is one call to a daemon export.

**What the lease module *does* own around prompts**

- Document that `RunnerLeaseSpec.prompt` is the **orchestrator brief**, not the vendor argv prompt.
- Optionally export a type alias (`LeaseBrief` / field docs) so callers do not re-misread it.

**What it must not own**

- `buildProtocolPreamble`, `composeOperatorInstructions`, `assembleChildPrompt`, `materializeContext` — already modular; stuffing them into "lease-protocol" confuses wire contract with spawn prep and couples core (if lease lives there) to filesystem layout that correctly lives next to worktrees/adapters.

If #212 extracts a spawn-plan / execute-prep seam, prompt assembly is a natural **input step to that seam**, shared by local `run` and remote `execute`. Lease protocol remains the *how the runner learns there is work*; spawn-plan is *how either host turns work into a child process*.

### Q3 — How much of `RunnerLoop.execute` decomposes once the protocol is a value?

**Recommendation: extract a `LeaseTransport` (or inject `RunnerClient`) plus 4–5 pure-ish phase functions; leave process spawn and git push as thin host adapters.** Do not force local `runChild` through the same class — only share what is already isomorphic.

**Current shape** (`packages/runner/src/loop.ts:92–271`), ordered:

| Phase | Lines (approx.) | Failure mode today | Needs real I/O? |
|---|---|---|---|
| Arm heartbeat interval | 97–104 | Logged only | Transport |
| Resolve `runner.repos` mapping | 111–122 | `fail(...)` | Config/fs exists |
| Resolve adapter | 124–132 | `fail(...)` | Registry |
| `createWorktree` | 134–152 | `fail(...)` | git |
| Materialize context + hub proxy + child hub | 154–163 | Outer catch → fail | fs + listen |
| `fullPrompt` + `adapter.prepare` + `applyLeaseEnv` | 165–197 | Outer catch | adapter |
| Exclude + write plan files | 199–215 | Log exclude fail | fs/git |
| `spawnAndStream` (events batching) | 217, 273–347 | events errors logged | child + transport |
| Push branch + `branch` verb | 220–232 | fail handoff | git + transport |
| Safety-net `fail` if no report | 236–243 | ignored if terminal | transport |
| `finally`: clear heartbeat, close proxy, remove worktree | 252–269 | best-effort | — |

**Once `LeaseTransport` is an interface** (see §3):

```text
lease() → RunnerLeaseSpec | null
heartbeat(taskId)
events(taskId, lines)
branch(taskId, branch)
fail(taskId, error)
```

…these become unit-testable **without** a daemon:

1. **Missing repo mapping** — transport records `fail` with the configure message; no git.
2. **Unknown vendor** — same.
3. **Worktree create throws** — inject a fake `createWorktree`; assert `fail` text.
4. **Branch push throws** — inject `pushBranch`; assert `fail` with `branch handoff failed:`.
5. **Child exits without report** — fake spawn returns code; assert safety-net `fail`.
6. **Shutdown after claim** — `run()` path at `loop.ts:78–85` fails claimed lease.
7. **Events batching** — drive `spawnAndStream` with a fake child stdout; assert flush at 32 lines / 100ms (`loop.ts:301–324`).
8. **Hub-proxy allowlist** — unit test pathname filter (`hub-proxy.ts:33–39`) without a daemon.

**What does not magically decompose from "protocol as a value" alone**

- Worktree / adapter / spawn still need host seams (injectable functions or a small `RunnerHost` interface). Protocol alone only unlocks the transport half.
- Local engine `runChild` (`engine.ts:3376+`) parallels spawn/stream/file materialization but talks to DB and local hub, not lease verbs. Forcing both through one `Executor` class is a larger redesign than #209; coordinate with #212 if desired.

**Realistic decomposition target for an implementation PR**

```text
RunnerLoop
  uses LeaseTransport          // wire
  uses RunnerHost {            // local effects
    resolveRepo, createWorktree, removeWorktree,
    materializeContext, materializeChildHub,
    startHubProxy, pushBranch, spawnChild
  }
  uses PromptAssembler         // thin wrapper over preamble/layers (not lease module)
  uses VendorAdapter registry
```

That split makes the 986 LOC package testable in-process; the existing `loop.test.ts` integration remains the one true daemon-backed path.

---

## 3. Proposed interface

### Module location

| Piece | Path | Package |
|---|---|---|
| Wire types + header + transport interface | `packages/core/src/lease.ts` | `@useparley/core` |
| Re-export from core barrel | `packages/core/src/index.ts` | `@useparley/core` |
| HTTP transport implementation | `packages/core/src/lease.ts` *or* `packages/runner/src/lease-http.ts` | prefer **core** if kept free of runner config; else runner |
| Compat re-exports | `packages/daemon/src/engine.ts` temporarily re-exports `TASK_HEADER` / `RunnerLeaseSpec` from core | avoid breaking deep imports in one PR |
| Server implementation (unchanged home) | `TaskEngine.leaseRunnerTask` etc. in `engine.ts`; routes in `server.ts` | `@useparley/daemon` |
| Client usage | `RunnerLoop` depends on `LeaseTransport` | `@useparley/runner` |

**Delete after migration:** `packages/runner/src/client.ts`, `packages/runner/src/protocol.ts` (functions inlined as imports of daemon builders or a future spawn-prep helper).

### TypeScript sketch (illustrative)

```typescript
// packages/core/src/lease.ts
import type { JsonSchema, SandboxMode } from "./adapter.js";

/** Correlation header children send on every hub request (ADR-0003 / ADR-0011). */
export const TASK_HEADER = "x-parley-task";

/** Default runner heartbeat window (ADR-0012 / #111). */
export const DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS = 90_000;

/**
 * One context file shipped by value on the lease (daemon-side materialization
 * of --context). Kept structural so core does not import daemon/context.ts.
 */
export interface LeaseContextFile {
  name: string;
  contents: string;
}

/**
 * Full task spec returned by POST /runner/lease (ADR-0012).
 * `prompt` is the orchestrator brief, not the assembled vendor prompt.
 */
export interface RunnerLeaseSpec {
  task_id: string;
  name: string | null;
  prompt: string;
  vendor: string;
  model: string | null;
  effort: string | null;
  profile: string | null;
  sandbox: SandboxMode;
  network: boolean;
  answer_timeout_ms: number;
  report_schema: JsonSchema;
  base_ref: string | null;
  base_sha: string | null;
  repo: string;
  contexts: LeaseContextFile[];
  extra_args: string[];
  env: Record<string, string>;
}

/** Client → daemon verb surface. HTTP is one implementation; tests use a fake. */
export interface LeaseTransport {
  /** Long-poll. null = 204 (window elapsed, nothing claimed). */
  lease(runnerName: string): Promise<RunnerLeaseSpec | null>;
  heartbeat(taskId: string): Promise<void>;
  events(taskId: string, lines: string[]): Promise<void>;
  branch(taskId: string, branch: string): Promise<void>;
  fail(taskId: string, error: string): Promise<void>;
}

export interface LeaseHttpOptions {
  daemonUrl: string;
  token: string;
  /** Optional fetch for tests. */
  fetch?: typeof globalThis.fetch;
}

/** Five REST verbs under /runner/* — single place for path + error mapping. */
export function createLeaseHttpTransport(opts: LeaseHttpOptions): LeaseTransport {
  // Body shapes:
  //   POST /runner/lease              { runner } → 200 RunnerLeaseSpec | 204
  //   POST /runner/tasks/:id/heartbeat {}
  //   POST /runner/tasks/:id/events    { lines: string[] }
  //   POST /runner/tasks/:id/branch    { branch: string }
  //   POST /runner/tasks/:id/fail      { error: string }
  // Auth: Authorization: Bearer <token> on every call (server.ts authenticateRunner).
  throw new Error("sketch only");
}
```

```typescript
// packages/runner/src/loop.ts (consumption sketch)
import {
  TASK_HEADER,
  type LeaseTransport,
  type RunnerLeaseSpec,
  createLeaseHttpTransport,
} from "@useparley/core";
import { materializeContext, materializeChildHub } from "@useparley/daemon/context.js";
import {
  buildProtocolPreamble,
} from "@useparley/daemon/preamble.js";
import {
  assembleChildPrompt,
  composeOperatorInstructions,
} from "@useparley/daemon/prompt-layers.js";
// createWorktree / adapters remain daemon imports until a later shared-exec move

export interface RunnerLoopOptions {
  config: RunnerConfig;
  transport?: LeaseTransport; // default: createLeaseHttpTransport from config
  // optional host hooks for tests — omitted here
}
```

### Who calls what

```text
parley-runner (main)
  └─ RunnerLoop
        ├─ LeaseTransport.lease / heartbeat / events / branch / fail
        │     └─ (prod) HTTP → daemon server.ts /runner/*
        │           └─ TaskEngine.leaseRunnerTask | runnerHeartbeat |
        │              processRunnerEvents | recordRunnerBranch | failRunnerTask
        │                 └─ (#206 assumption) state writes via transition module
        ├─ worktree + context + hub-proxy  (host)
        ├─ prompt builders (daemon preamble/layers — not lease module)
        └─ VendorAdapter.prepare → SpawnPlan
              └─ (#212 assumption) may become shared spawn-plan value / pipeline

Local engine path (unchanged by this module):
  TaskEngine.run → prepare/template → runChild
  does NOT use LeaseTransport
```

### Daemon-side type ownership after move

- `buildLeaseSpec` (`engine.ts:2464–2488`) returns `RunnerLeaseSpec` imported from core.
- `TASK_HEADER` imports from core in `engine.ts`, `child.ts`, `mcp.ts`, `hub-proxy.ts`, and preferably `packages/cli/src/commands/child.ts` (replace local `const TASK_HEADER = "x-parley-task"` at `child.ts:8`).
- `ContextFile` in daemon `context.ts` should remain assignable to `LeaseContextFile` (same shape); either re-export one type or keep structural compatibility without a hard import cycle.

---

## 4. Test-surface sketch

### What becomes testable in-process that is not today

| Behavior | Today | After |
|---|---|---|
| Lease 401 / non-OK mapping | Only via live daemon | Unit on HTTP transport with fake `fetch` |
| `fail` on missing repo mapping | Untested | `LeaseTransport` recording fake |
| `fail` on unknown vendor | Untested | same |
| `fail` on worktree error | Untested | inject host + transport |
| Branch push failure → `fail` | Untested | inject `pushBranch` |
| Safety-net fail when no report | Untested (happy path reports) | fake child exit |
| Claim-then-shutdown fail | Untested | transport + `stop()` |
| Events flush thresholds | Untested | fake stdout |
| Hub-proxy path allowlist | Untested | pure HTTP server unit |
| `RunnerLeaseSpec` field completeness on server build | Indirect via `daemon/tests/runner.test.ts` | Optional schema/assert helper shared by daemon tests |

### Proposed test files

| File | Kind | Scope |
|---|---|---|
| `packages/core/tests/lease-http.test.ts` | **Unit** | Path construction, 204→null, 401 message, empty events no-op, JSON body shapes |
| `packages/runner/tests/lease-transport.fake.ts` | Test util | In-memory `LeaseTransport` + recorded calls |
| `packages/runner/tests/loop-phases.test.ts` | **Unit** | Failure branches of execute/run with fake transport + fake host |
| `packages/runner/tests/hub-proxy.test.ts` | **Unit** | Only `/mcp` and `/child/*` forward; 404 otherwise; injects `TASK_HEADER` |
| `packages/runner/tests/loop.test.ts` | **Integration** (keep) | One (or few) real daemon + fake vendor E2E — contract smoke |
| `packages/daemon/tests/runner.test.ts` | **Integration** (keep) | Server auth, claim, heartbeat expiry, events, branch, fail — source of truth for server semantics |

### Unit vs integration split

- **Unit (no daemon, no git if host is faked):** transport error mapping, loop decision tree, hub-proxy rules.
- **Integration (daemon + sqlite + HTTP):** remains in `daemon/tests/runner.test.ts` and the existing runner loop E2E; do not re-implement claim/long-poll semantics in core.
- **Do not** move heartbeat timer / long-poll waiter tests into core — those are engine runtime.

---

## 5. Migration plan

Ordered steps; each should be shippable alone.

| Step | Change | Blast radius | Deletes |
|---|---|---|---|
| **1** | Add `packages/core/src/lease.ts` with `TASK_HEADER`, `RunnerLeaseSpec`, `LeaseTransport`, `createLeaseHttpTransport`. Export from core index. | Core API surface only; no behavior change until consumers switch. | — |
| **2** | Daemon: import types/constants from core; re-export from `engine.ts` for one release window so existing `@useparley/daemon/engine.js` deep imports keep typechecking. | Daemon + anything deep-importing engine types. | — |
| **3** | Runner: point `client.ts` at core transport **or** replace `RunnerClient` with `createLeaseHttpTransport`; loop/hub-proxy import `TASK_HEADER` from core. | Runner package only. | Eventually `client.ts` |
| **4** | CLI child helper: import `TASK_HEADER` from core (stop local string). | Tiny CLI change; child-channel tests still match header name. | Local const |
| **5** | Runner: delete `protocol.ts`; call daemon preamble/context/prompt-layers from `loop.ts` (or a private `prompt.ts` if line count hurts). | Runner only; behavior must stay byte-identical for prompts. | `protocol.ts` |
| **6** | Inject `LeaseTransport` into `RunnerLoop`; add unit tests for failure branches + hub-proxy. | Test-only + small loop constructor change. | — |
| **7** | (Optional follow-up) Drop engine re-exports of lease types; fix any remaining deep imports. | Search/replace across repo. | Re-export shims |
| **8** | (Out of scope for #209, note only) Shared worktree/adapters package so runner does not depend on full daemon — ADR-0012 leftover. | Large | — |

**What gets deleted (end state of #209):**

- `packages/runner/src/client.ts`
- `packages/runner/src/protocol.ts`
- Duplicate `TASK_HEADER` string in `packages/cli/src/commands/child.ts` (replaced by core import)

**What is not deleted:**

- Engine lease *methods* and server routes — they are the server adapter.
- `daemon/tests/runner.test.ts` — remains canonical server coverage.

---

## 6. Risks and rejected alternatives

### Risks

1. **Scope creep into "shared executor."** Lease wire extraction is small; merging local `runChild` and remote `execute` is not. Mitigate by hard boundary: no `SpawnPlan` construction inside `lease.ts`.
2. **`ContextFile` dual definition.** Core `LeaseContextFile` vs daemon `ContextFile` (`context.ts:19–23`) can drift. Mitigate: identical fields; daemon treats them as the same structural type; optional later move of `ContextFile` to core (touches CLI context shipping — slightly wider).
3. **Compat re-exports linger forever.** Engine re-exports are a migration crutch. Step 7 should have a deadline (next minor).
4. **Runner still depends on `@useparley/daemon` for execution modules.** Type move alone does not thin the install graph. Honest: #209 improves *contract cohesion and testability*, not full package isolation. Full isolation is the incomplete ADR-0012 "shared packages" line.
5. **Prompt parity regressions** when deleting `protocol.ts` if call sites reorder arguments. Mitigate: keep the existing `fullPrompt` body as a local function initially; only delete the file after a focused comparison or golden string test.
6. **#206 transition rewrite mid-migration.** Server methods currently call `updateTask` / `transitioned` / `fail` directly. If #206 lands first, re-point those call sites; lease *client* types are unaffected.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| New `@useparley/lease` package | Too little pure logic; extra publish unit; core already owns wire contracts (ADR-0009, `contract.ts`). |
| Put HTTP client only in runner, types only in daemon (status quo polish) | Does not stop cross-process drift; runner still types against engine belly. |
| Include prompt assembly in lease module | Prompt is host-assembled after worktree; builders already modular; would muddy core with FS/home concerns. |
| Daemon endpoint returns fully assembled prompt | Breaks host-local operator layers; bloats lease; couples daemon home to runner child. |
| Make local engine use `/runner/*` in-process | Pointless HTTP hop; contradicts ADR-0012's "tasks without affinity keep executing in-daemon." |
| "Deepening not worth it" entirely | Rejected: 986 LOC with one happy-path test + types buried in a 3640-line file is real coupling; core-sized extraction is proportional. |
| Giant `RunnerHost` + `LeaseTransport` mega-PR | Split per migration table; unit-test hooks can land after types move. |

### ADR tension check

| ADR | Relationship |
|---|---|
| **ADR-0012** | **Aligned.** Makes the lease-based executor contract an explicit shared surface; does not change registration, affinity, heartbeat semantics, or branch handoff. |
| **ADR-0009** | **Aligned.** Cross-boundary types belong in core. |
| **ADR-0003 / 0011** | **Aligned.** `TASK_HEADER` centralization strengthens the child correlation story; hub-proxy remains runner-local (children never dial daemon). |
| **ADR-0004** | **No change.** Adapters still return `SpawnPlan`; lease does not replace adapters. |
| **ADR-0007 / 0008** | **No tension.** Inbox/watch stay daemon-seq based; runner completion still flows through normal task state. |
| **monorepo-layout.md** | **Doc drift (not ADR):** layout spec omits `@useparley/runner`. Implementation should update that spec when packaging changes land — out of band for this proposal file. |

No silent ADR contradiction. The only tension is aspirational language in the ticket equating "local executor" with a lease adapter — corrected in §1.

---

## 7. Interactions with parallel explorations

### #212 — spawn-plan seam

**Assumption about #212 (explicit, not designed against a guessed outcome):**

- #212 will extract a value or pipeline around `adapter.prepare` / launch-template / `applyVendorConfig` → `SpawnPlan`, shared or shareable between daemon `run`/`runChild` and runner `execute`.
- It may or may not move worktree + file materialization.

**How lease-protocol interacts:**

- **Lease module ends where `RunnerLeaseSpec` is in hand.** It does not build `SpawnPlan`.
- Runner sequence stays:

  ```text
  LeaseTransport.lease()
    → RunnerLeaseSpec
    → (host) worktree + context + hub
    → (prompt builders) assembled prompt
    → (#212 spawn-plan) TaskSpec + HubInfo → SpawnPlan
    → spawn + LeaseTransport.events/branch/fail
  ```

- If #212 produces a pure function `buildSpawnPlan(spec, hub, configEnv) → SpawnPlan`, the runner should call it after lease+worktree; the lease module only supplies fields that already exist on `RunnerLeaseSpec` (`extra_args`, `env`, model/effort/sandbox/network, brief).
- **Conflict to avoid:** both proposals moving `applyLeaseEnv` / vendor env merge. Prefer env merge living next to spawn-plan (execution), with lease only *transporting* the resolved `env` map the daemon already puts on the spec (`buildLeaseSpec` / `configEnvFor` at `engine.ts:2445–2488`).

### #206 — transition module

**Assumption about #206:**

- #206 owns durable state writes and seq/inbox side effects for task state changes (`pending`→`running`, `fail`→`failed`, complete-via-report/branch, etc.).
- Engine methods become thin orchestrators that call transition helpers instead of scattering `updateTask` + `transitioned`.

**How lease-protocol interacts:**

- **Client/transport layer never writes task state.** It only POSTs verbs.
- **Server lease methods are transition *callers*, not owners:**

  | Lease server method | State effect today | #206 expectation |
  |---|---|---|
  | `tryClaimRunnerTask` | `pending`→`running`, `transitioned` (`engine.ts:2495–2506`) | Call transition "claim/start remote" |
  | `runnerHeartbeat` | Timer only; no state change (`2547–2556`) | Unchanged or "touch lease" without seq |
  | `processRunnerEvents` | usage/session patches; usually non-state (`2563–2632`) | May stay as patches, not transitions |
  | `recordRunnerBranch` | branch patch; may `completeAcceptedReport` (`2640–2653`) | Completion goes through transition module |
  | `failRunnerTask` → `fail` | terminal fail (`2660–2667`, `2374–2391`) | Transition `fail` |
  | Heartbeat timer fire | `fail` runner-lost (`2421–2427`) | Same |

- **Ordering assumption:** #209 types/client can land without #206. Server method bodies re-point to transitions when #206 exists; wire shapes stay stable.
- **Do not** put transition logic in `packages/core/src/lease.ts`.

### Combined picture

```text
                    ┌─────────────────────────┐
   runner process   │ LeaseTransport (core)   │
                    └───────────┬─────────────┘
                                │ HTTP /runner/*
                    ┌───────────▼─────────────┐
   daemon server    │ route auth + engine     │
                    │ lease* methods          │
                    └───────────┬─────────────┘
                                │ state writes
                    ┌───────────▼─────────────┐
                    │ #206 transition module  │
                    │ (assumed owner of seq)  │
                    └─────────────────────────┘

   either host, after lease or local admit:
                    ┌─────────────────────────┐
                    │ #212 spawn-plan seam    │
                    │ prepare/template→plan   │
                    └─────────────────────────┘
```

---

## Conclusion

**This deepening is worth doing**, scoped tightly:

1. **Do** lift the lease **wire contract** (`RunnerLeaseSpec`, `TASK_HEADER`, verb client + `LeaseTransport`) into `@useparley/core`.
2. **Do** inject the transport into `RunnerLoop` so failure branches and hub-proxy rules gain unit tests.
3. **Do** delete shallow `client.ts` / `protocol.ts` after call sites move.
4. **Do not** put prompt assembly or `SpawnPlan` construction in the lease module — those belong to existing daemon builders and/or #212.
5. **Do not** pretend the local engine is a lease client; the dual adapters are **HTTP server vs runner client**.

That completes the contract half of ADR-0012, unlocks the runner's missing unit surface, and stays conflict-free with parallel #206 / #212 work by stating explicit ownership boundaries.
