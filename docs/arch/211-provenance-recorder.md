# #211 — Shared provenance recorder for harness plugins

**Status**: design exploration (no implementation)  
**Ticket**: #211  
**Scope**: `packages/core` session-state + `packages/plugins/*` write path  
**Related ADRs**: [ADR-0013](../adr/0013-harness-session-provenance-plugins.md) (in scope; env-first unchanged)

---

## 1. Problem restatement

Harness plugins are responsible for exporting orchestrator **session provenance**
(session id, harness, model, effort) so eval and listing can group runs without
the model self-reporting. ADR-0013 makes env vars the primary contract;
the session-state file under `vendors/<vendor>/sessions/<id>/state.json` is an
**interim** write channel when a harness cannot inject a complete env set.

Today three plugins re-implement the same *write* choreography against core
I/O helpers, and a fourth (pi) uses live env only:

| Plugin | Delivery | Core dependency |
|---|---|---|
| `@useparley/plugin-codex` | state file | `@useparley/core` |
| `@useparley/plugin-claude-code` | state file + `CLAUDE_ENV_FILE` shell exports | `@useparley/core` |
| `@useparley/plugin-grok` | state file only | `@useparley/core` |
| `@useparley/plugin-pi` | live `process.env` only | **none** |

The duplicated choreography is: resolve home → path → `readSessionState` →
merge observation with previous → optionally skip rewrite → `writeSessionState`.
Each plugin also carries a local non-empty-string guard. Vendor-specific
observation (transcript / summary / hook fields) is necessarily different and
should stay in plugins.

The CLI read path (`packages/cli/src/session-state-match.ts` +
`packages/cli/src/commands/session.ts`) already centralizes **env > state >
unknown** resolution and ancestry matching. That is the consumer of what plugins
write; it is not currently shared with plugin code.

### Citation verification (ticket → this checkout)

Every file:line from the ticket body was checked against this worktree:

| Ticket claim | This checkout | Drift? |
|---|---|---|
| grok `nonEmptyString`-style at grok:157 | `optionalNonEmptyString` at `packages/plugins/grok/src/index.ts:157` | Name only (`optionalNonEmptyString`, not `nonEmptyString`); line correct |
| codex validator at codex:98 | `nonEmptyString` at `packages/plugins/codex/src/index.ts:98` | None |
| claude-code validator at claude-code:157 | `nonEmpty` at `packages/plugins/claude-code/src/hook.ts:157` | Name only (`nonEmpty`); line correct |
| CLI reconcile at `session.ts` L88–132 | `packages/cli/src/commands/session.ts:88–132` — `resolveMatchedSessionState` → `resolveProvenanceFromEnvAndState` → `resolveOrchestratorSessionId` → daemon POST | None |

**Ticket oversimplifications (not wrong, but important for design):**

1. **Skip-if-unchanged is not shared.** Grok has a full identity/model/effort/pid
   skip (`packages/plugins/grok/src/index.ts:206–216`). Claude skips only on
   post-`SessionStart` when model+effort are unchanged (`hook.ts:62`). Codex
   always writes (`codex/src/index.ts:94`) — no skip.
2. **Merge policy is not identical.** Codex uses `new ?? previous ?? null`
   (`codex/src/index.ts:87–88`). Claude’s post-start path uses
   `transcript ?? previous` (`hook.ts:60–61`), but `SessionStart` sets
   `model: nonEmpty(input.model)` and `effort: null` with **no** previous fill
   (`hook.ts:46–47`) — a resume SessionStart can wipe lazy-filled model/effort.
   Grok, when `summary.found`, **trusts summary fields including honest nulls**
   (`grok/src/index.ts:189–192`); when the summary is missing it keeps previous.
3. **Transcript/summary readers are not interchangeable duplication.** Codex
   tails JSONL for `turn_context.payload.effort`; Claude reads head+tail for
   `system`/`init` model/effort; Grok walks `$GROK_HOME/sessions/**/summary.json`.
   Only the *recorder* frame is shareable, not the parsers.
4. Core already owns schema + atomic I/O
   (`packages/core/src/session-state.ts`) and exports it from the package barrel
   (`packages/core/src/index.ts:19`). The gap is **policy on top of**
   read/write, not the wire schema.

---

## 2. Exploration questions

### Q1 — Depend on `@useparley/core`, or a tiny package?

**Answer: stay on `@useparley/core` (optionally a subpath export). Do not mint
`@useparley/session-state` / `@useparley/provenance` in this deepening.**

Evidence:

- Codex, Claude, and Grok already declare
  `"@useparley/core": "workspace:*"`
  (`packages/plugins/{codex,claude-code,grok}/package.json`). Pi does not and
  need not for pure env injection.
- ADR-0013 packaging already chose “one npm package per vendor plugin …
  same release train, **shared helper logic**”
  (`docs/adr/0013-harness-session-provenance-plugins.md`, Packaging bullet).
  A fourth published package for ~50 lines of merge policy adds release/version
  surface without removing the core dependency the three plugins already take
  for `SessionState` / `writeSessionState`.
- Core has **zero** runtime npm deps (`packages/core/package.json`) — the
  install cost for a plugin is the published core tarball, not a dep tree. The
  real cost is **API surface**: the barrel re-exports client, contract, config,
  rubric, etc. (~5k LOC under `packages/core/src/`). That is a #208 concern
  (export curation), not a reason for a new package if a subpath works.

**Recommended packaging shape:**

- Keep implementation in `packages/core/src/session-state.ts` (or a sibling
  `session-state-record.ts` re-exported from it / the barrel).
- Prefer adding an export map entry
  `"@useparley/core/session-state"` → the session-state module so plugins can
  import a narrow surface without implying “the whole SDK.” That cooperates
  with #208 rather than fighting it.
- Reject a new top-level package unless later evidence shows core’s published
  size or peer-version coupling is actually hurting foreign-harness installs.

### Q2 — Absorb CLI `session-state-match.ts` precedence, or write side only?

**Answer: write side (and optional pure resolve helpers). Do not move ancestry
matching into the recorder.**

Evidence of a clean split already in the tree:

| Concern | Where it lives today | Needs |
|---|---|---|
| Schema, path, atomic write, scan | `packages/core/src/session-state.ts` | fs only |
| Merge + skip + record | **plugins (duplicated)** | read + write + policy |
| Env > state field resolution (pure) | `packages/cli/src/session-state-match.ts:137–187` | strings only |
| Ancestry match, pid liveness, start_time | `session-state-match.ts:43–122` | `ProcessAnchor`, `process.kill` |
| Orchestrator registration wiring | `packages/cli/src/commands/session.ts:87–132` | daemon client, flags |

The ticket’s win “ADR-0013 resolution order lives in one module” is **almost**
true on the read side already: `resolveProvenanceField`,
`resolveProvenanceFromEnvAndState`, and `resolveOrchestratorSessionId` are
pure and unit-tested in `packages/cli/tests/session-state-match.test.ts`.
Moving those pure helpers into core is a small optional follow-on (single
vocabulary for env-first), but it is not required to de-dupe plugins and it
is not the same as absorbing `matchSessionState`.

Pulling `matchSessionState` into core would:

- Couple core to CLI ancestry types (`packages/cli/src/ancestry.ts`) or force
  those types into core for no plugin benefit (plugins never match — they
  *write* for a known harness session id).
- Expand the surface plugins install without them calling it.

**Recorder scope (in):** observation → merge policy → skip-if-unchanged →
atomic write; optional env materialization helpers for pi / Claude env-file.

**Recorder scope (out):** ancestry scan, pid liveness, `--session` flag
precedence, daemon session registration.

### Q3 — Keep pi’s live-env mechanism, or force state file?

**Answer: keep live env as pi’s primary path. Optionally dual-write state later;
do not force state-only.**

Evidence:

- ADR-0013 addendum: only **pi** fully satisfies the four-var env contract from
  its live hook surface; the state file exists because *other* harnesses cannot
  (`docs/adr/0013-harness-session-provenance-plugins.md`, addendum). Env remains
  primary; state is interim fallback, not replacement.
- Pi’s implementation is ~50 lines of `process.env` assignment with **no**
  core import (`packages/plugins/pi/src/index.ts:32–47`). That is the target
  shape for harnesses that *can* inject env — not a defect.
- Claude already dual-delivers: state file *and* `CLAUDE_ENV_FILE` exports for
  session id / harness / model (`hook.ts:52–53`, `89–96`). So “env path and
  state-file path share one seam” is already partially real on one plugin; the
  missing piece is a shared **builder** for the four env names / values, not
  deleting env.
- Forcing pi onto state-only would regress ADR-0013 (env-first) and make every
  `parley session` under pi pay for ancestry matching when env is already set
  (`session-state-match.ts:228–233` already short-circuits when env/flag
  resolves).

**Recommendation:**

1. Keep pi env injection as-is for correctness and ADR alignment.
2. Teach the recorder an optional `applyEnv` / `toEnvExports` helper so pi and
   Claude stop hand-rolling the four names (and Claude’s shell quoting stays
   Claude-local, or becomes a thin wrapper).
3. Dual-writing a state file from pi is a **product choice** for belt-and-
   suspenders when someone runs `parley` outside the Pi process tree; not
   required for the deepening. If done, use the same `recordSessionState` API
   with fill policy and skip-if-unchanged.

---

## 3. Proposed interface

### Module placement

| Item | Location |
|---|---|
| Schema + I/O (existing) | `packages/core/src/session-state.ts` |
| Recorder API (new) | same file, or `packages/core/src/session-state-record.ts` imported/re-exported by `session-state.ts` |
| Public exports | keep `export * from "./session-state.js"` in `packages/core/src/index.ts`; add package.json export `"./session-state"` when #208 / packaging hygiene wants a narrow entry |
| Pure resolve helpers (optional later) | move from CLI → core `session-state.ts` as `resolveProvenanceField` / `resolveProvenanceFromEnvAndState` / `resolveOrchestratorSessionId` |
| Ancestry match (stays) | `packages/cli/src/session-state-match.ts` |

### TypeScript sketch

```ts
// packages/core/src/session-state.ts  (additions; existing SessionState /
// readSessionState / writeSessionState / sessionStatePath / scanSessionStates
// unchanged)

/** Non-empty trimmed string, or null. Shared by plugins + parser. */
export function nonEmptyString(value: unknown): string | null;

/**
 * How an observed field combines with a previously written value.
 *
 * - `fill` (default): `observed ?? previous ?? null` — never clobber a known
 *   value with “not available this event” (codex / claude post-start).
 * - `replace`: when the observation *supplies* the field (including explicit
 *   null from a successful read), that value wins (grok summary.found path).
 */
export type FieldMergePolicy = "fill" | "replace";

/**
 * Vendor-agnostic observation the plugin hands the recorder after parsing
 * harness-specific artifacts. Plugins own observation; core owns policy + I/O.
 */
export interface ProvenanceObservation {
  harness: string;
  harness_session_id: string;
  /** Absent or undefined ⇒ treat as “not observed this event”. */
  model?: string | null;
  effort?: string | null;
  pid: number;
  modelPolicy?: FieldMergePolicy;  // default "fill"
  effortPolicy?: FieldMergePolicy; // default "fill"
  /**
   * When policy is `replace`, whether this event actually produced a field
   * observation. Grok sets `{ model: true, effort: true }` only when
   * summary.found; otherwise both false and previous is kept.
   */
  observed?: { model?: boolean; effort?: boolean };
}

export interface RecordSessionOptions {
  parleyHome?: string;
  env?: NodeJS.ProcessEnv; // for resolveHome; default process.env
  now?: () => Date;
  /** Default true. First write always lands. */
  skipIfUnchanged?: boolean;
}

export interface RecordSessionResult {
  state: SessionState;
  previous: SessionState | null;
  /** False when skip-if-unchanged suppressed the write. */
  written: boolean;
}

/**
 * Read → merge → skip-if-unchanged → atomic write.
 * Throws only on write I/O failure (same contract as writeSessionState).
 * Returns null only when harness_session_id / pid are invalid.
 */
export function recordSessionState(
  observation: ProvenanceObservation,
  options?: RecordSessionOptions,
): RecordSessionResult | null;

/** Materialize the four ADR-0013 env names from a resolved state. */
export function provenanceEnvVars(
  state: Pick<SessionState, "harness_session_id" | "harness" | "model" | "effort">,
): {
  PARLEY_SESSION_ID: string;
  PARLEY_HARNESS: string;
  PARLEY_MODEL?: string;
  PARLEY_EFFORT?: string;
};

/** Apply provenanceEnvVars onto an env object (default process.env). */
export function applyProvenanceEnv(
  state: Pick<SessionState, "harness_session_id" | "harness" | "model" | "effort">,
  env?: NodeJS.ProcessEnv,
): void;
```

### Who calls what

```
codex recordCodexSession
  → effortFromTranscript (plugin-local)
  → recordSessionState({ harness: "codex", …, modelPolicy: "fill", effortPolicy: "fill" })

claude runHook
  → parseInput / readTranscriptMetadata (plugin-local)
  → recordSessionState(…)
  → optional: shell-export provenanceEnvVars(state) into CLAUDE_ENV_FILE
    (quoting stays in the plugin)

grok runHook
  → resolveSessionId / findSessionSummaryPath / readSummaryProvenance (plugin-local)
  → recordSessionState({
        …,
        modelPolicy: "replace",
        effortPolicy: "replace",
        observed: { model: summary.found, effort: summary.found },
      })

pi parleyProvenance
  → applyProvenanceEnv({ harness_session_id, harness: "pi", model, effort })
  → (optional later) recordSessionState for dual-write

cli session / delegate / fix / eval
  → unchanged: session-state-match read path
  → optional later: import pure resolve* from @useparley/core instead of local copies
```

### Merge semantics (normative for the recorder)

For each of `model` / `effort`:

```
if policy === "fill":
  next = nonEmpty(observed) ?? previous ?? null
else: // replace
  if observed[field] === true:  // event produced a definitive read
    next = nonEmptyOrNull(observedValue)  // may be null (honest unknown)
  else:
    next = previous ?? null
```

Identity fields:

- `harness`, `harness_session_id`: always from this observation.
- `pid`: always from this observation (resume may update parent pid — matches
  Claude resume test at `packages/plugins/claude-code/tests/hook.test.ts:68–83`).
- `started_at`: `previous.started_at` if non-empty, else `now`.
- `updated_at`: always `now` when writing; if skip-if-unchanged, return previous
  without bumping `updated_at` (matches grok).

Skip-if-unchanged compares:
`harness`, `harness_session_id`, `model`, `effort`, `pid`
(not timestamps). Default **on**; Codex gains the optimization for free.

**Claude SessionStart wipe:** under this API, Claude should pass
`modelPolicy: "fill"` and omit effort when unknown so resume SessionStart no
longer clears prior lazy-filled values — a behavior fix that falls out of
shared policy (call out in migration; covered by an extended Claude test).

---

## 4. Test-surface sketch

### Newly testable in-process (core unit)

Today merge/skip is only exercised indirectly inside each plugin’s integration-
style hook tests. After the recorder:

| Behavior | Proposed tests | File |
|---|---|---|
| `fill` keeps previous when observation is null | unit | `packages/core/tests/session-state-record.test.ts` (new) |
| `replace` + `observed` clears previous to null | unit | same |
| `replace` without `observed` keeps previous | unit | same |
| skip-if-unchanged suppresses write (mtime / call spy / re-read) | unit | same |
| first write always lands; `started_at` preserved | unit | same |
| invalid session id / pid → null, no throw | unit | same |
| `nonEmptyString` edge cases | unit | same or fold into existing `session-state.test.ts` |
| `provenanceEnvVars` omits null model/effort | unit | same |

Existing `packages/core/tests/session-state.test.ts` stays focused on schema /
path safety / atomic write / scan degrade.

### Plugin tests after migration (integration / observation)

| Package | Keep testing | Drop / thin |
|---|---|---|
| codex | `effortFromTranscript` formats, missing session id, end-to-end write path smoke | re-stating merge matrices |
| claude-code | SessionStart env-file quoting, transcript edge parse, fail-open | generic merge/skip |
| grok | session id resolve, summary discovery, `summary.found` null trust | generic skip/merge |
| pi | handler registration, env set/clear on model-less session | unchanged unless dual-write |

### CLI

No required change. `packages/cli/tests/session-state-match.test.ts` and
`packages/cli/tests/session.test.ts` remain the read-path suite. If pure
`resolve*` moves to core, re-home those pure cases under core and leave match /
daemon integration tests in CLI.

### Unit vs integration split

- **Unit (core):** policy matrix, skip, env map — no harness fixtures.
- **Integration (plugins):** real fixture transcripts/summaries → observation →
  one call to `recordSessionState` → assert file (and env file for Claude).
- **CLI integration:** env vs state precedence with live ancestry fakes —
  already present; out of recorder scope.

---

## 5. Migration plan

Ordered for minimal blast radius; each step is independently shippable.

| Step | Change | Blast radius | Deletes |
|---|---|---|---|
| 1 | Add `nonEmptyString`, `recordSessionState`, merge/skip, `provenanceEnvVars` / `applyProvenanceEnv` + core unit tests | core only; no plugin behavior change | nothing |
| 2 | Migrate **codex** `recordCodexSession` to recorder (`fill`); add skip | `@useparley/plugin-codex` | local `nonEmptyString`; inline merge block |
| 3 | Migrate **grok** `runHook` with `replace` + `observed` from `summary.found` | `@useparley/plugin-grok` | local skip block; local `optionalNonEmptyString` if unused |
| 4 | Migrate **claude-code** write path; keep shell quoting local; fix SessionStart to `fill` so resume preserves model/effort | `@useparley/plugin-claude-code` | local merge/skip; local `nonEmpty` if unused |
| 5 | (Optional) pi: `applyProvenanceEnv` helper only — still no state file | `@useparley/plugin-pi` | duplicated env key strings |
| 6 | (Optional) pi dual-write state via `recordSessionState` | pi + docs; CLI gains ancestry fallback when env stripped | nothing required |
| 7 | (Optional) move pure CLI `resolve*` helpers into core; CLI re-exports or imports | cli + core; update imports | duplicate pure helpers in CLI source |
| 8 | (Hygiene, with #208) add `package.json` export `./session-state`; document plugin import path | publish surface | nothing |

**What does not get deleted:** `session-state-match.ts` matching, CLI session
command, vendor transcript/summary parsers, Claude env-file quoting, pi’s env-
first design, ADR-0013 resolution order.

**What never moves in this plan:** daemon session registration, eval grouping,
plugin install UX (`packages/cli/src/commands/plugins/*`).

---

## 6. Risks and rejected alternatives

### Risks

1. **Policy unification footgun.** Encoding only `fill` would break grok’s
   “summary found with null effort ⇒ honest null” behavior
   (`grok/src/index.ts:189–192`). The dual policy + `observed` flags are
   mandatory, not optional sugar.
2. **Silent behavior change on Claude resume.** Fixing SessionStart wipe is
   desirable but is a behavior change; call it out in the PR and extend
   `hook.test.ts` so CI owns it.
3. **Core export surface / #208.** Growing the barrel without a subpath makes
   #208’s curation harder. Mitigate with `./session-state` export and keep
   recorder next to existing session-state symbols.
4. **Fail-open vs throw.** Claude wraps `runHook` in try/catch (`hook.ts:70–72`);
   codex/grok let `writeSessionState` throw. Recorder must **not** swallow I/O
   errors — callers choose fail-open. Document that invariant on
   `recordSessionState`.
5. **Skip-if-unchanged vs pid churn.** Comparing pid means a new harness pid
   always rewrites (correct for ancestry matching). Do not exclude pid from the
   equality set.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| New `@useparley/provenance` package | Plugins already depend on core for schema/I/O; ADR-0013 wants shared helpers on the same release train; extra version coupling for foreign installs |
| Recorder owns env-vs-state *resolution* for CLI | Resolution + ancestry are read-side CLI concerns; plugins never resolve — they observe and write |
| Force all plugins (including pi) to state-file only | Contradicts ADR-0013 env primacy and the addendum’s finding that pi *can* do env |
| Drop state file entirely | Codex/Grok still cannot inject complete env; would leave honest-unknown holes ADR deliberately closed with the interim channel |
| Share transcript tail readers in core | Vendor formats churn; ADR-0013 explicitly keeps harness-format parsing inside each plugin |
| Macro / codegen per plugin | Overkill for ~30 lines of policy once; harder to test than one function |
| “Not worth it” | **Rejected as conclusion.** Three plugins already share core I/O and re-test merge; Claude SessionStart wipe is a real bug-class the shared policy prevents; cost is one core function + migration. Worth doing at the interface above. |

### ADR tension

- **No contradiction** with ADR-0013 if env remains primary and the state file
  remains interim. Concentrating *write* policy is what the ADR’s “shared
  helper logic” line anticipated.
- **Tension only if** implementation treats the state file as equal or preferred
  to env, or removes pi’s env path. This proposal does neither.
- No other ADR (0009 adapters, 0014 allowlist, 0015 launch templates) governs
  plugin write path; launch-template “declared provenance” is daemon/CLI spawn
  territory, not harness plugins.

---

## 7. Interactions with related explorations

**Direct coupling:** none. This exploration is plugins + core session-state only.

**#208 (assumed: contract-module / core export curation)** — assumptions stated
explicitly, not designed against an imagined PR:

1. **Assumption:** #208 will narrow or structure `@useparley/core` public exports
   (barrel hygiene, subpaths, and/or a dedicated contract module) without
   removing session-state as a concept plugins need.
2. **Constraint this proposal places on #208:** whatever curation lands,
   `SessionState`, `readSessionState`, `writeSessionState`, `sessionStatePath`,
   and the new `recordSessionState` / `nonEmptyString` / env helpers must remain
   importable by published plugins. Prefer a stable subpath
   `@useparley/core/session-state` so #208 can shrink the root barrel without
   breaking plugins.
3. **Constraint #208 does *not* take from this:** ancestry matching and CLI
   resolve helpers need not be public core exports for the recorder to ship.
4. **No ordering hard-dependency:** recorder can land before or after #208; if
   #208 lands first and removes accidental barrel exports, plugins should import
   the session-state subpath (or the curated named exports) rather than deep
   relative paths.

No assumptions about other parallel arch tickets beyond independence.

---

## Recommendation

Proceed with a **write-side provenance recorder in `@useparley/core`**
(`session-state` module), dual merge policy (`fill` | `replace`+`observed`),
default skip-if-unchanged, optional env materialization helpers. Leave CLI
ancestry matching in place. Keep pi on live env. Migrate codex → grok →
claude-code; optionally thin pi afterward.

This deepening is **worth it**: the shared frame is real and already half-present
in core I/O; the divergent merge policies are expressible without losing grok’s
honest-null behavior; and Claude’s SessionStart wipe is evidence that
un-shared policy is already costing correctness, not just lines of code.
