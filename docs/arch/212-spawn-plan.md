# #212 — Spawn-plan seam exploration

**Status**: exploration proposal (not approved for implementation)
**Issue**: [#212](https://github.com/femoral/parley/issues/212)
**Checkout**: branch `parley/t20-arch-212-spawn-plan` against the 2026-07-22 architecture review claims
**Verdict**: **kill the proposed deepening as stated** (collapse four wrappers into a higher-level "spawn-plan" value). **Keep a narrower, better-evidenced move**: extract stream-line application and exit disposition out of `runChild`, and share the stream-apply path with the runner event ingest. Adapters and ADR-0004 stay untouched.

---

## 1. Problem restatement

The local child-execution path in `TaskEngine` has two layers of structure that the ticket conflates:

1. **Four thin entry methods** — `run`, `resume`, `resumeFix`, `runFreshFix` — each build a prompt, obtain a core `SpawnPlan` (adapter `prepare` / `resume`, or launch-template composition), and call `runChild`.
2. **One thick executor** — `runChild` (~264 lines) performs pre-spawn guards, hub/env injection, launch-command capture, file materialization, process spawn, dual-stream line handling with live `updateTask` side effects (session / usage / model / effort), and exit-code → task-state disposition.

The pure helpers that *do* have unit tests (`upgradeTraceField` in `packages/daemon/src/trace.ts`, `resolveSessionBinding` in `packages/daemon/src/session-binding.ts`) sit one call away from engine methods that are only exercised through a live child (or full daemon HTTP). That locality gap is real for the **stream-handling call site inside `runChild`**, not for the four wrappers.

**Naming collision (critical):** `@useparley/core` already exports `SpawnPlan` as the *adapter* plan (`argv` / `env` / `files` / `cwd` / optional `diagnostics`) — see `packages/core/src/adapter.ts:126–140` and ADR-0004. The ticket's proposed `buildSpawnPlan(task) → { prompt, mode, … }` is a *different*, higher-level concept. Any implementation **must not** reuse the name `SpawnPlan`. This proposal uses **`ChildRunIntent`** for that higher-level value if it is ever introduced, and prefers not introducing it at all (see §2 / §6).

### Citation audit (ticket vs this checkout)

| Ticket claim | This checkout | Drift? |
|---|---|---|
| Four methods at `packages/daemon/src/engine.ts:3215–3276` | `run` L3215–3224; `resume` L3232–3241; `resumeFix` L3248–3256; `runFreshFix` L3263–3279 | **Minor.** Range is **3215–3279** (ticket cut off mid-method at 3276). Bodies are ~10–17 executable lines each (~15–24 including signatures/JSDoc), matching "~15-line". |
| `runChild` at `engine.ts:3376–3639`, ~260 lines | **3376–3639**, **264** lines | **None** (rounding). |
| Trace-upgrade call site L3514–3559 | Model/effort `session_meta` upgrade is L3514–3541; the broader "conditionally write task" patch flush ends L3559 | **None** for the cited band; the pure `upgradeTraceField` calls are L3524 and L3535. |
| `bindOrchestrator` at `engine.ts:735` | **L735–768** | **None.** Note: this is **not** on the spawn path — it is session/provenance binding for delegate/eval. Useful as a *pattern* illustration of pure helper + impure call site; not evidence for a spawn-plan seam. |
| "four shallow **modules**" | Four **private methods** on `TaskEngine`, same file | **Wording drift.** They are not separate modules. |

All substantive file:line evidence from the ticket holds; only the range end for the four methods and the "modules" wording need correction.

### What the four methods actually differ on

| Method | Prompt | Plan source | Launch template? | `started_at` on spawn |
|---|---|---|---|---|
| `run` | `initialPrompt` | `adapter.prepare` **or** `buildTemplatePlan` | yes | always set |
| `resume` | `resumePrompt(answer)` | `adapter.resume` | **no** (ADR-0015) | preserve if set |
| `resumeFix` | `fixResumePrompt` | `adapter.resume` | no at call site | always set (new attempt) |
| `runFreshFix` | `freshFixPrompt` | `adapter.prepare` **or** `buildTemplatePlan` | yes | always set |

Call sites:

- `startAdmittedTask` (L3120–3164) → `resumeFix` / `runFreshFix` / `run` (and template forces "fresh" even when `resumed=1`).
- `answer` stalled path (L1989–2017) → `resume` if session present and not template, else `run`.

So the wrappers are not arbitrary duplication: they encode **domain modes** (fresh / stall-resume / fix-resume / fresh-fix) with different prompt composition and different `started_at` rules. They already funnel into one executor.

### What `runChild` actually mixes (L3376–3639)

Rough blocks, in order:

1. Terminal cancel guard (`getTask` + `TERMINAL_STATES`) — L3386–3391
2. Hub env inject (`PARLEY_HUB_URL`, `PARLEY_TASK_ID`) — L3395–3400
3. Launch-command capture (`captureLaunchCommand` / `appendLaunchCommand`) — L3403–3404
4. FS materialization (`.parley/child.json`, git-exclude, `plan.files`) — L3407–3436
5. Log streams (`vendor.jsonl`, `stderr.log`, `diag.log`) + spawn-time diagnostics — L3438–3452
6. `spawn` + register in `this.children` — L3454–3464
7. `onSpawn` task write + `transitioned` — L3466–3471
8. Dual-stream `handleLine`: parseEvent, usage merge, model/effort upgrade, session id, fatal/diag capture, `updateTask` — L3473–3564
9. Exit handling: supersession, settle pending ask, report→complete vs fail, auto-remove worktree — L3566–3637

The pure `upgradeTraceField` merge is tested in `packages/daemon/tests/trace.test.ts`; the policy that *when* to read the row, *when* to write the patch, and how that interacts with usage/session on the same line is only reachable via a spawned child (or full integration tests such as `launch-template.test.ts`).

### Parallel copy of stream apply (not in the ticket, but decisive)

`processRunnerEvents` (`engine.ts:2563–2633`) re-implements a **subset** of `handleLine`:

- Does: raw append, `parseEvent`, usage merge, session id, diag lines.
- **Does not:** model/effort `upgradeTraceField` (L3514–3541 on the local path has **no** counterpart).

So the locality problem is not only "helper tested, call site untested" — it is also **two call sites drifting**. Any design that extracts stream application once pays for both local `runChild` and remote runner event ingest (ADR-0012). Collapsing the four wrappers does not address that drift.

---

## 2. Answers to exploration questions

### Q1 — Is the spawn-plan value worth it, or is the real move decomposing `runChild`?

**Answer: the real move is decomposing `runChild`. The higher-level spawn-plan value is not worth it on current evidence.**

Arguments from code:

1. **Interface width.** The four methods are private, with two orchestrating call sites (`startAdmittedTask`, `answer`). "Shrink four entries to one" is not shrinking a public API; it is renaming four named domain steps into a discriminated union. The bodies are already shorter than a self-documenting `ChildRunIntent` switch would be once prompt builders, template branching, and `started_at` policy are inlined into the builder.

2. **What becomes testable.** A pure `buildChildRunIntent(task, mode, …)` still needs:
   - prompt assembly (`initialPrompt` / `resumePrompt` / fix variants) which pulls preamble, operator layers, attempt chains, and DB reads (`freshFixPrompt` → `collectAttemptChain` / `listTasks` at L3365–3372);
   - async adapter `prepare`/`resume` and config-hot `applyVendorConfig` / `buildTemplatePlan`.
   That is not an in-process pure unit without heavy fakes. By contrast, **stream-line → patch** and **exit facts → disposition decision** are pure (or pure-with-injected-row) and currently untested at the policy layer.

3. **Where bugs actually live.** Trace upgrade, declared-provenance non-upgrade (`upgradeTraceField` L85–87 when `source === "declared"`), dual-stream parse, report-wins-over-exit (#72), stall-superseded child (`isCurrentChild`), and the runner/local asymmetry above all sit **inside** `runChild` / `processRunnerEvents`, not in the four wrappers.

4. **Deletion test.** Inlining the four wrappers into one `spawnFromMode(...)` would *relocate* the same branches into a switch; it would not concentrate complexity that is currently duplicated. Deleting stream-apply *duplication* between `handleLine` and `processRunnerEvents` does pass the deletion test.

5. **`bindOrchestrator` is a false parallel for this ticket.** Its pure core is already extracted (`resolveSessionBinding`); the remaining method is policy (eval-on → throw). That pattern argues for extracting *policy next to pure helpers* on the **stream path**, not for inventing a plan value for spawn modes.

**Recommendation:** do **not** implement `buildSpawnPlan` / collapse wrappers as the primary change. Optionally keep the four methods as the readable domain surface forever. If a future change multiplies more spawn modes, revisit `ChildRunIntent` then — not now.

### Q2 — Does the launch-template path (ADR-0015) fit the same plan shape cleanly?

**Answer: yes for a `ChildRunIntent` if one existed; it already fits cleanly without one.**

Facts:

- Template composition is isolated in `buildTemplatePlan` (L3288–3340): full argv from profile template + `$VAR`/`$PROMPT` expansion; empty `files`; env = posture + vendor + profile (hub vars for expansion only).
- Only **fresh** paths consult the template: `run` L3217–3219 and `runFreshFix` L3269–3274. Resume paths always call `adapter.resume` and never `buildTemplatePlan`.
- ADR-0015: "Session resume is not composed for template profiles — reattempts use fresh composition." Enforced at orchestration:
  - `startAdmittedTask` L3134–3135 / L3138: template ⇒ ignore residual `resumed=1` for fix-resume.
  - `answer` L2005–2014: template ⇒ always `run` (fresh), never `resume`.
- Free-form vendors get `createGenericTemplateAdapter` (L250–273) so `runChild` still has a `VendorAdapter` for `parseEvent`/`sessionId` (no-ops) and preamble channel (`http`).

A hypothetical intent discriminant would look like:

```ts
type PlanSource =
  | { kind: "adapter-prepare" }
  | { kind: "adapter-resume" }
  | { kind: "launch-template" };
```

Template is one arm of **plan composition**, not a third executor. No tension with ADR-0015. No need for a separate `runChild` for templates.

**Declared provenance note:** stream upgrade must continue to refuse flipping `declared` → `vendor` (`trace.ts:85–87`). That rule lives in the pure helper today and must remain on any extracted stream-apply path (local *and* runner ingest once model/effort are unified).

### Q3 — How does this interact with the runner's copy of the flow (#209)?

**Answer: weakly for "spawn-plan"; strongly for stream-apply extraction. Assume #209 and #206 independently of this ticket's rejected wrapper collapse.**

#### What the runner actually does

`packages/runner/src/loop.ts` `execute` (L92–271) is a **fresh-only** path:

1. Lease → map repo → worktree → materialize context → hub proxy.
2. Build full prompt via runner `protocol.ts` (mirrors daemon preamble/layers).
3. `adapter.prepare` only (L196) — **no** `resume`, **no** fix modes, **no** launch-template composition.
4. Materialize files, `spawnAndStream` (L273–348): spawn, batch raw stdout lines to `POST /runner/tasks/:id/events`, log stderr.
5. Push branch; safety-net `fail` if still non-terminal (report wins via daemon `#72`).

There is **no** four-wrapper mirror on the runner. The process-boundary "copy" is:

| Concern | Local daemon | Remote runner |
|---|---|---|
| Mode selection (fresh/resume/fix) | `startAdmittedTask` / `answer` | Lease always fresh prepare |
| Prompt assembly | engine methods | `runner/src/protocol.ts` → daemon preamble/layers |
| Adapter plan | `prepare`/`resume`/template | `prepare` + `applyLeaseEnv` |
| Spawn + materialize | `runChild` | `execute` + `spawnAndStream` |
| Stream parse → task row | in-process `handleLine` | raw lines → `processRunnerEvents` |
| Exit disposition | in-process close handler | runner `fail` / branch / report HTTP |

#### Assumptions about #209 (runner lease protocol)

From issue #209 body (fetched for this exploration; parallel, not settled):

- Goal: extract lease **protocol** (spec shape, headers, REST verbs `lease · heartbeat · events · branch · fail`) so engine and runner are two adapters of one contract.
- Pain points: `RunnerLeaseSpec` / `TASK_HEADER` living in `engine.ts`; runner importing daemon internals; shallow `protocol.ts` / repetitive `client.ts`; thin runner tests.

**Assumptions we make (not design against an imagined outcome):**

1. #209 may move `RunnerLeaseSpec` and the five verbs out of `engine.ts`; it does **not** require a shared local "spawn-plan" type for mode selection the runner never performs.
2. #209 may re-home prompt assembly for remote tasks; local `initialPrompt` / fix prompts stay daemon-side.
3. Shared **stream-apply** (this proposal's keep) plugs into the existing `events` verb regardless of whether #209 renames modules — `processRunnerEvents` body is the extraction target either way.
4. Do **not** wait on #209 to extract local stream-apply + disposition; the local/remote drift (missing model/effort upgrade on runner ingest) is already a product bug surface.

#### Assumptions about #206 (transition module)

From issue #206 body:

- Goal: one `transition(id, to, cause)` that owns state write + seq + log + waiter wake + queue drain; eliminate hand-paired `updateTask({ state })` + `transitioned()`.
- Exit disposition today: `completeAcceptedReport` (L1780–1806) and `fail` (L2374–2392) each write state and call `transitioned`.

**Assumptions:**

1. #206 may own the *writes* for `running` (onSpawn), `completed`, `failed`. Extracted disposition should return a **decision** (`complete` | `fail(detail)` | `noop`), not call `updateTask` itself.
2. `onSpawn` patch today mixes state with `started_at` / `launch_command` / `queued_at` (L3467). A transition module that only knows pure state edges may still need a non-state field write beside it — #206 exploration should not be blocked by this ticket, and this ticket must not invent a second state-write path.
3. Speculative: if #206 is killed, disposition can keep calling `this.fail` / `this.completeAcceptedReport` as today.

---

## 3. Proposed interface (what *is* worth building)

### 3.1 Names and locations

| Piece | Module | Role |
|---|---|---|
| Stream apply | `packages/daemon/src/stream-apply.ts` (new) | Pure-ish: line → events → accumulator + `TaskPatch` + side-channel diag lines |
| Exit disposition | `packages/daemon/src/exit-disposition.ts` (new) | Pure: exit facts → decision |
| Orchestration | `packages/daemon/src/engine.ts` | Keeps four wrappers + `runChild` shell; calls the two modules; performs I/O and transitions |
| Core types | unchanged | Keep existing `SpawnPlan` / `VendorAdapter` / `VendorEvent` in `@useparley/core` |

**Do not add** `ChildRunIntent` / higher-level spawn-plan in the first implementation cut. Leave the four methods.

### 3.2 TypeScript sketches

```ts
// packages/daemon/src/stream-apply.ts
import type { VendorAdapter, VendorEvent } from "@useparley/core";
import type { TaskPatch, TaskRow } from "./db.js";
import {
  upgradeTraceField,
  type ResolvedTraceField,
} from "./trace.js";

/** Mutable per-stream (or per-chunk) accumulator. */
export interface StreamAccumulator {
  events: VendorEvent[];
  sessionId: string | undefined;
  usage: Record<string, number> | undefined;
  lastError: string | undefined;
  lastDiag: string | undefined;
}

export interface StreamLineResult {
  /** Fields to merge into the task row (may be empty). */
  patch: TaskPatch;
  /** Diag lines to append (timestamp left to caller or stamped here). */
  diagLines: string[];
  /** Whether usage on the accumulator changed this line. */
  usageChanged: boolean;
}

export function createStreamAccumulator(seed?: {
  sessionId?: string | null;
  usage?: Record<string, number> | null;
}): StreamAccumulator {
  const events: VendorEvent[] = [];
  if (seed?.sessionId) {
    events.push({ kind: "session_meta", session_id: seed.sessionId });
  }
  return {
    events,
    sessionId: seed?.sessionId ?? undefined,
    usage: seed?.usage ?? undefined,
    lastError: undefined,
    lastDiag: undefined,
  };
}

/**
 * Apply one raw vendor line through the adapter. Mutates `acc`.
 * `currentRow` is only needed when model/effort may upgrade (local path;
 * runner path should pass the latest row or a snapshot so declared provenance
 * is respected the same way).
 */
export function applyVendorStreamLine(
  acc: StreamAccumulator,
  adapter: VendorAdapter,
  line: string,
  currentRow: Pick<TaskRow, "model" | "model_source" | "effort" | "effort_source"> | null,
): StreamLineResult {
  // parseEvent → usage / model / effort / session / fatal / diag
  // use upgradeTraceField for model/effort (declared stays declared)
  // return patch + diagLines — no DB, no fs
  throw new Error("sketch only");
}

/** Fold usage into a TaskPatch the same way engine.usagePatch does. */
export function usageFieldsToPatch(
  usage: Record<string, number>,
): TaskPatch {
  throw new Error("sketch only");
}
```

```ts
// packages/daemon/src/exit-disposition.ts

export type ExitDisposition =
  | { action: "noop"; reason: "shutdown" | "superseded" | "already-settled" }
  | { action: "complete"; usage?: Record<string, number> }
  | { action: "fail"; detail: string };

export interface ExitFacts {
  exitCode: number | null;
  /** False when daemon is shutting down or child is not current. */
  isCurrentLifecycle: boolean;
  shuttingDown: boolean;
  /** Task row state + report presence after settlePending. */
  state: string;
  reportPresent: boolean;
  lastError?: string;
  lastDiag?: string;
}

/**
 * Pure policy for child close (mirrors runChild L3599–3630).
 * - report present → complete (report wins, #72)
 * - else fail with exit detail + optional lastError / lastDiag
 * - stalled / settled states → noop (SETTLED_STATES / stall path)
 */
export function decideExitDisposition(facts: ExitFacts): ExitDisposition {
  throw new Error("sketch only");
}
```

```ts
// engine.ts — runChild shell (conceptual)
private async runChild(
  task: TaskRow,
  adapter: VendorAdapter,
  plan: SpawnPlan, // core adapter plan — name unchanged
  prompt: string,
  onSpawn: TaskPatch,
): Promise<void> {
  // … guard, env, materialize, spawn, onSpawn write (unchanged ownership) …

  const acc = createStreamAccumulator();
  const handleLine = (line: string, raw: fs.WriteStream): void => {
    raw.write(`${line}\n`);
    const row = getTask(this.db, task.id);
    const result = applyVendorStreamLine(acc, adapter, line, row ?? null);
    for (const d of result.diagLines) diagLog.write(`${d}\n`);
    if (Object.keys(result.patch).length > 0) {
      updateTask(this.db, task.id, result.patch);
    }
  };
  // … wire stdout/stderr …

  child.on("close", (code) => {
    // … isCurrentChild / settlePending …
    const decision = decideExitDisposition({ /* facts from row + acc */ });
    if (decision.action === "complete") this.completeAcceptedReport(task.id, decision.usage);
    else if (decision.action === "fail") this.fail(task.id, decision.detail);
    this.maybeAutoRemoveWorktree(task.id);
  });
}

// processRunnerEvents — same applyVendorStreamLine, batch patch at end
processRunnerEvents(taskId: string, runnerName: string, lines: string[]): void {
  // … auth / adapter …
  const acc = createStreamAccumulator({
    sessionId: task.session_id,
    usage: parseJsonColumn(task.usage),
  });
  // for each line: applyVendorStreamLine(acc, adapter, line, task-or-refreshed)
  // append raw + diag; single updateTask with merged patch
  // **now includes model/effort upgrade** (fixes local/remote drift)
}
```

### 3.3 Who calls what

```
startAdmittedTask / answer
  └─ run | resume | resumeFix | runFreshFix   (unchanged)
       └─ runChild
            ├─ materialize / spawn / onSpawn     (engine I/O)
            ├─ applyVendorStreamLine             (stream-apply.ts)
            └─ decideExitDisposition → fail|complete  (exit-disposition.ts
                 → engine.fail / completeAcceptedReport
                 → optionally #206 transition later)

RunnerLoop.spawnAndStream
  └─ POST events
       └─ processRunnerEvents
            └─ applyVendorStreamLine             (same module)
```

Adapters (`prepare`/`resume`/`parseEvent`) — **unchanged** (ADR-0004 intact).

### 3.4 Optional later (not recommended now): `ChildRunIntent`

Only if more spawn modes appear (e.g. mid-turn re-spawn without stall):

```ts
// packages/daemon/src/child-run-intent.ts  — NOT in first cut
export type ChildRunMode =
  | "fresh"
  | "stall-resume"
  | "fix-resume"
  | "fresh-fix";

export interface ChildRunIntent {
  mode: ChildRunMode;
  prompt: string;
  /** How to obtain core SpawnPlan. */
  planSource: "prepare" | "resume" | "launch-template";
  startedAt: "fresh" | "preserve";
  fixBrief?: string;
  answer?: string;
}
```

This is recorded as a rejected-for-now alternative (§6), not the proposed interface.

---

## 4. Test-surface sketch

### What becomes testable in-process that was not

| Behavior | Today | After extraction |
|---|---|---|
| Model/effort upgrade + skip when `declared` | Only via live child stream | `stream-apply.test.ts` with fake adapter events + row snapshots |
| Usage shallow-merge across lines | Integration / untested policy | unit on accumulator |
| Session id extraction across lines / chunk seed | Partial (runner path seeds synthetic session_meta L2588–2592) | shared unit for seed + re-extract |
| Diag prefix capture vs fatal error | Buried in handleLine | unit |
| Exit: report wins over non-zero exit (#72) | Integration | `exit-disposition.test.ts` |
| Exit: detail includes lastError + lastDiag | Integration | unit table |
| Exit: shutdown / superseded → noop | Hard to isolate | unit |
| Runner ingest upgrades model/effort | **Missing entirely** | unit + one runner integration assertion |

### Test files

| File | Kind | Contents |
|---|---|---|
| `packages/daemon/tests/stream-apply.test.ts` | **unit** | Fake `VendorAdapter.parseEvent` / `sessionId`; table-driven lines; declared non-upgrade; dual concerns on one line (usage + model) |
| `packages/daemon/tests/exit-disposition.test.ts` | **unit** | Table of `ExitFacts` → decision |
| Existing `packages/daemon/tests/trace.test.ts` | unit (keep) | Pure `upgradeTraceField` stays; stream-apply tests import it indirectly |
| Existing `packages/daemon/tests/launch-template.test.ts` | **integration** (keep) | Still covers template → spawn → launch_command; no need to rewrite for this extraction |
| Existing `packages/daemon/tests/runner.test.ts` / `packages/runner` tests | **integration** | One case: runner-forwarded `session_meta` with model updates `model_source=vendor` (regression for today's gap) |

### Unit vs integration split

- **Unit:** stream-apply + exit-disposition only — no `spawn`, no sqlite required if patches are plain objects (optional: tiny in-memory row fixture).
- **Integration:** leave end-to-end fake-vendor paths as the confidence net for "wire-up still works"; do not move four-wrapper selection into unit tests unless `ChildRunIntent` is revisited.

### What we deliberately do *not* add

- Unit tests that only assert "mode X calls prepare vs resume" via a collapsed plan builder — low value while methods are 15 lines and call sites are two.
- Tests for `bindOrchestrator` under this ticket (out of scope; already covered via session-binding unit + sessions integration).

---

## 5. Migration plan

Ordered steps; each should be a reviewable PR. No adapter or ADR changes.

| Step | Change | Blast radius | Deletes |
|---|---|---|---|
| **1** | Add `stream-apply.ts` with `createStreamAccumulator` + `applyVendorStreamLine`; port logic from `handleLine` (L3494–3559) without changing behavior. Unit tests green first (TDD-friendly). | Low: new file + tests only until step 2. | Nothing yet. |
| **2** | Switch `runChild` `handleLine` to call `applyVendorStreamLine`; keep raw log write and `updateTask` in engine. | Medium: local spawn path only. Regression: fake-vendor / launch-template / adapter integration suites. | Inline handleLine policy (lines fold into module). |
| **3** | Switch `processRunnerEvents` to the same helper; **add** model/effort upgrade (intentional behavior fix for remote tasks — call out in PR, not a silent drive-by). | Medium: remote runner event path. | Duplicated parse/usage/session loop in `processRunnerEvents`. |
| **4** | Add `exit-disposition.ts` + unit tests; wire `runChild` close handler. | Low–medium: local exit only. Runner still uses HTTP `fail` (decision is daemon-side on report/fail endpoints already). | Inline disposition branches in close handler. |
| **5** (optional, separate decision) | If #206 lands, change disposition *callers* to `transition(...)` without changing `decideExitDisposition` pure core. | Depends on #206. | Hand-paired state writes inside `fail` / `completeAcceptedReport` (owned by #206, not this ticket). |
| **6** (not recommended) | Collapse four wrappers into `ChildRunIntent`. | Cosmetic churn across `startAdmittedTask` / `answer`. | Four method names — only if a later review reverses the kill. |

**What gets deleted overall (recommended path):** duplicated stream-processing logic in `processRunnerEvents`; the closed-over policy blob inside `runChild`'s `handleLine` / close handler. **Not deleted:** `run` / `resume` / `resumeFix` / `runFreshFix`, core `SpawnPlan`, any adapter code.

**What is not touched:** package.json, adapter plugins, CLI, UI, worktree module, preamble/prompt-layers (already extracted).

---

## 6. Risks and rejected alternatives

### Risks (of the recommended extraction)

| Risk | Mitigation |
|---|---|
| Behavioral drift when moving handleLine | Golden unit tables from current comments/cases (#72, declared provenance, dual stdout/stderr feed); keep integration tests green per step. |
| Step 3 changes remote behavior (model upgrade) | Explicit PR description; add regression test; matches ADR-0004 "thin normalization" intent and local path. |
| Over-abstracting accumulator with engine deps | Keep module free of `TaskEngine`, `DatabaseHandle`, and `spawn`. Inject row snapshot + adapter only. |
| #206 / #209 landing mid-migration | Steps 1–4 do not depend on either; disposition returns decisions, not writes. |
| Name confusion with core `SpawnPlan` | Never name the higher-level concept `SpawnPlan`; document in PR if anyone revives `ChildRunIntent`. |

### Rejected alternatives

1. **Ticket's primary proposal: `buildSpawnPlan` + single entry collapsing four wrappers.**  
   Rejected: private API, weak new test surface, name collision with core `SpawnPlan`, does not fix stream/local-remote drift. See §2 Q1.

2. **Only extract disposition, leave stream in place.**  
   Rejected as sole move: misses the higher-leverage shared path with `processRunnerEvents` and the untested trace-upgrade call site the ticket itself flags.

3. **Move stream-apply into `@useparley/core`.**  
   Rejected for now: depends on `TaskPatch` / row shape and `upgradeTraceField` (daemon). Keep daemon-side unless a third consumer appears. Runner does not need it (it forwards raw lines).

4. **Share one `runChild` implementation between daemon and runner package.**  
   Rejected: runner deliberately does not own disposition or sqlite; ADR-0012 lease + heartbeat + branch handoff differ. Shared piece is **line application policy**, not the full executor. Aligns with #209 treating engine and runner as two adapters of a lease protocol, not one process.

5. **Kill all decomposition; "engine.ts is fine".**  
   Rejected: 264-line `runChild` + duplicated/incomplete runner ingest is concrete evidence of missing locality. Ticket's *wrapper* collapse is the wrong lever; extraction still pays.

6. **Extract `bindOrchestrator` further under this ticket.**  
   Rejected: out of scope; already has a pure core and tests.

### ADR tensions

| ADR | Tension? |
|---|---|
| **0004** spawn-per-turn adapters | **None.** Adapters still return core `SpawnPlan`; resume still respawns. Extraction is engine-internal. |
| **0009** adapter plugin interface | **None.** |
| **0011** child HTTP/CLI channels | **None.** Hub inject stays in `runChild`. |
| **0012** remote runners | **Positive alignment** if stream-apply is shared with `processRunnerEvents`. Do not try to unify full executors. |
| **0015** launch templates | **None.** Template stays a plan-composition arm on fresh paths only. Declared provenance non-upgrade must remain in stream-apply. |
| **0008** / inbox / watch | Exit disposition still must result in `transitioned` (via existing `fail`/`completeAcceptedReport` or future #206). Pure decision module must not skip waiter wake — callers remain responsible. |

No ADR needs amendment for the recommended path. A future `ChildRunIntent` also needs no ADR if it remains private engine structure.

---

## 7. Interactions with parallel explorations

### #209 — runner lease protocol (parallel)

| Topic | This exploration's stance |
|---|---|
| Shared "spawn-plan" across process boundary | **No.** Runner has no resume/fix/template mode matrix. |
| Shared stream-apply | **Yes** — works with today's `processRunnerEvents` and with a future #209 re-home of the events verb. |
| Lease spec location | Owned by #209; do not move `RunnerLeaseSpec` under #212. |
| Prompt assembly on runner | Owned by #209 / existing `protocol.ts`; not part of stream-apply. |
| Sequencing | **Independent.** Prefer landing stream-apply before or after #209; no hard dependency either way. If both land, stream-apply should live next to whichever module ends up owning event ingest. |

**Assumption:** #209 may delete/replace `runner/src/protocol.ts` and thin `client.ts`; that does not revive the four-wrapper collapse.

### #206 — transition module (parallel)

| Topic | This exploration's stance |
|---|---|
| Exit disposition writes | #206 may own `failed`/`completed`/`running` writes; #212 extraction returns **decisions** only. |
| `onSpawn` non-state fields | `launch_command`, `started_at`, `queued_at` stay engine (or a patch merge beside transition). |
| Stream mid-run patches | Model/usage/session updates are **not** state transitions; they stay `updateTask` without `transitioned`. #206 must not force those through `transition()`. |
| Sequencing | Extract pure disposition first; wire to `fail`/`completeAcceptedReport` now; re-point callers when #206 lands. |

**Assumption:** #206 is accepted or not independently. This proposal does not require it and does not invent a competing state-machine module.

### Speculative kill (ticket permission used)

The ticket is marked speculative. **Evidence supports killing the stated deepening** (wrapper collapse → higher-level spawn-plan value). **Evidence does not support** doing nothing: stream-apply + exit-disposition extraction is the defensible residue of the review.

---

## Summary recommendation

| Proposed by ticket | Decision |
|---|---|
| `buildSpawnPlan` / collapse four wrappers | **Reject** |
| Stream parsing unit seam | **Accept** → `stream-apply.ts`, shared with runner events |
| Exit disposition unit seam | **Accept** → `exit-disposition.ts` |
| Trace-upgrade call-site locality | **Accept** via stream-apply (includes declared-provenance) |
| Keep ADR-0004 adapters unchanged | **Accept** (no change required) |
| Name anything new `SpawnPlan` | **Reject** (core name taken) |

**Next implementation ticket (if this proposal is approved):** implement steps 1–4 in §5 only; file a separate bugfix for "runner events do not upgrade model/effort" linked to step 3 so the behavior fix is intentional and reviewed.
