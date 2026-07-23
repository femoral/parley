# #210 — One Cove display projection (`toDisplayTask`)

Exploration proposal only. No implementation in this change.

## 1. Problem restatement

Cove paints the same task identity — model-maker emblem, harness coat, faction
label, and a short `branch · id` meta line — in every place a task is
recognisable: roster rows, inbox cards, scene islands (and, unmentioned by the
ticket, the inspector header). Each projection re-resolves vendor + harness
from the same inputs and re-assembles the same strings. Separately, the kit
band's static state legend hand-copies core's attention order into the tokens
layer, guarded by a single equality test.

That is four *identity* emit sites plus one *order* hand-sync. Understanding
"why does this island look like that?" still requires walking
`useSnapshot` → `useCockpit` → roster/inbox/scene (and inspector) projections →
`hud/types.ts` plain shapes → `tokens/{state-meta,state-glyphs,factions}.ts`.
Inlining the three fleet projections would not shrink the rules — it would
concentrate the same thrice-written emit into one file still lacking a named
shared step. The missing piece is a single **display-identity** projector that
all layout projections consume.

### Citation audit (ticket vs this checkout)

| Ticket claim | This checkout | Drift? |
| --- | --- | --- |
| Vendor/coat/faction duplication in `packages/ui/src/app/hooks/roster.ts:157–175` | `toRosterTask` at `packages/ui/src/app/hooks/roster.ts:157–175` — `modelVendorFor` + `harnessColorFor`, then `coat` / `emblem` / `faction` / `meta` | **No drift** |
| Same pattern in `inbox.ts:31–45` | Inline map at `packages/ui/src/app/hooks/inbox.ts:31–45` — same vendor/harness/faction/meta assembly | **No drift** |
| Same pattern in `scene.ts:122–133` | `toSceneTask` at `packages/ui/src/app/hooks/scene.ts:122–133` — vendor/harness; projects `coat` / `coatDark` / `emblem` (no faction/meta string) | **No drift** (scene omits faction/meta by design; still duplicates the lookups) |
| Hand-synced order at `packages/ui/src/tokens/state-meta.ts:139` (`ATTENTION_DISPLAY_ORDER`) | `ATTENTION_DISPLAY_ORDER` starts at `packages/ui/src/tokens/state-meta.ts:139`; comment + drift test in `packages/ui/tests/state-legend-order.test.ts` | **No drift** |

**Omission in the ticket (not drift of a citation):** a fourth identity emit lives
in `packages/ui/src/app/hooks/inspector.ts:114–122` (`projectInspector` —
same `modelVendorFor` / `harnessColorFor` / `faction` string). Any deepening
that only rewires roster/inbox/scene leaves inspector as a silent twin.

**Wire path (for orientation, not cited by the ticket):**
`useSnapshot` adapts `TaskRow` / SSE envelopes into `RosterTaskInput`
(`packages/ui/src/app/hooks/useSnapshot.ts:58–98`), then projects roster,
inbox, and scene from that plain list
(`packages/ui/src/app/hooks/useSnapshot.ts` + `useCockpit.ts`). Functional
attention ranking already comes from `@useparley/core` (`attentionRank`,
`ATTENTION_ORDER` in `packages/core/src/states.ts:64–80`) via the hooks layer —
only the kit-band *legend* order is the hand-synced copy.

### ADR tension

None with accepted ADRs. Attention *delivery* order for the CLI inbox
(ADR-0007 `INBOX_PRIORITY`) is a different ladder from UI roster ranking
(`ATTENTION_ORDER`); this proposal never collapses them. Layering constraints
come from `docs/spec/ui-component-system.md` contracts 2, 4, and 6 — not from
ADRs. Those contracts are binding for this design (see §2 and §6).

## 2. Exploration questions

### Q1 — Does `toDisplayTask` live in `app/hooks` or `tokens`?

**Answer: `app/hooks` (layer 4).** Recommended path:
`packages/ui/src/app/hooks/displayTask.ts`.

**Why not tokens (layer 0):**

- Tokens must stay free of `@useparley/core` (component-system contract 4;
  restated at `packages/ui/src/tokens/state-meta.ts:8–9` and
  `packages/ui/src/app/hooks/index.ts:2–4`). A module that also owns attention
  order *imported from core* cannot live in tokens without breaking that
  contract or splitting the "one module" story.
- Identity derivation already needs hooks-owned helpers (`shortId` at
  `packages/ui/src/app/hooks/roster.ts:92–94`) and hooks-owned input
  (`RosterTaskInput` at `packages/ui/src/app/hooks/roster.ts:35–59`). Tokens
  correctly own only the pure lookups: `modelVendorFor` /
  `harnessColorFor` (`packages/ui/src/tokens/factions.ts:147–163`) and
  `stateMetaFor` / `STATE_META` (`packages/ui/src/tokens/state-meta.ts`).
- Putting `toDisplayTask` in tokens would force tokens to depend on
  `RosterTaskInput` (hooks) or reinvent a parallel input shape — either way
  it pulls layer 0 upward.

**Why hooks fits:**

- Every consumer is already a hooks pure projector (`toRosterTask`,
  `projectInbox` map, `toSceneTask`, `projectInspector`).
- Hooks may import tokens downward and core sideways — exactly the merge the
  ticket describes.
- Keeps contract 4: hud/scene still never import core; they keep receiving
  plain projected props (contract 2).

**Split of ownership after the move:**

| Concern | Stays where | Notes |
| --- | --- | --- |
| Vendor/harness lookup tables | `tokens/factions.ts` | Pure data + `modelVendorFor` / `harnessColorFor` |
| State label/glyph/mark/colour | `tokens/state-meta.ts` (+ `state-glyphs.ts`) | `stateMetaFor` remains the runtime lookup for badges |
| Compose identity (coat, coatDark, emblem, faction, meta) | **new** `hooks/displayTask.ts` | One emit |
| Group/sort/filter layout | `roster.ts` / `inbox.ts` / `scene.ts` | Shrink to selection + layout |
| Inspector-only fields | `inspector.ts` | Brief/report/QA/attempts stay; header identity via `toDisplayTask` |

### Q2 — Do `hud/types.ts` plain shapes embed the display-task shape, or reference it?

**Answer: extract a shared identity slice and *embed* it (composition /
spread), not replace the per-view types.**

Today the overlapping fields are not identical:

| Field | `RosterTask` | `InboxTask` | `SceneTask` | `InspectorTask` |
| --- | --- | --- | --- | --- |
| `coat` | yes | yes | yes | yes |
| `coatDark` | no | no | yes | no |
| `emblem` | yes | yes | yes | yes |
| `faction` | yes | yes | no | yes |
| `meta` | yes | yes | no | no |
| `state` | on group, not task | yes | yes | yes |
| view-specific | `freshFailure?` | `question`, `sessionId` | — | brief/logs/report/… |

A single fat `DisplayTask` that every hud component accepts would either
over-deliver (roster rows get unused `coatDark`/`question`) or under-deliver
(scene needs `coatDark`; inbox needs `question`). Contract 2 wants plain props
sliced to what each composite renders — so:

1. Introduce a **`DisplayIdentity`** (name bikeshed-friendly) holding the
   always-shared visual identity:
   - `coat`, `coatDark`, `emblem`, `faction`, `meta`
   - optionally `id` / `name` / `state` if we want one constructor for the
     common header fields — but `state` is intentionally *not* on `RosterTask`
     (it lives on `RosterGroup.state`); do not force it onto every row.
2. `toDisplayTask(input)` returns that identity (+ whatever common header
   fields we settle on).
3. View types **embed** by field inclusion (structural typing), not by
   extending a class hierarchy:
   - `RosterTask` = identity fields used by the row + `freshFailure?`
     (may omit `coatDark` from the public hud type even if the projector
     computed it — or keep it for free future use; either is fine if
     structural).
   - `InboxTask` = identity + `state` + `question` + `sessionId`
   - `SceneTask` = subset `{ id, name, state, coat, coatDark, emblem }`
     (drop `faction`/`meta` from the scene type; still produced once and
     discarded at the scene map step)
   - `InspectorTask` header fields = identity + `state` + inspector-only

Prefer **structural reuse** (same field names/types from one projector) over
forcing `RosterTask extends DisplayIdentity` if that would pull
`coatDark` into the roster panel's prop surface unnecessarily. TypeScript
sketches in §3 show both a base interface and view-specific picks.

**State meta / glyphs:** do **not** embed full `StateMeta` on the display
task. Hud already calls `stateMetaFor(state)` at render time
(`RosterPanel`, `InboxCard`, `Inspector` — see imports under
`packages/ui/src/hud/`). Re-projecting glyph/label into every task would
duplicate a pure token lookup and enlarge every snapshot for no layout gain.
`toDisplayTask` *may* re-export or document that badges use `stateMetaFor`,
but it should not own a second copy of glyph tables.

### Q3 — Can `state-meta.ts` consume core's `ATTENTION_ORDER` without breaking
"hud never imports core" — or does that contract move up a level?

**Clarify the real contract first.** The locked rule is not "hud never imports
core" alone — it is:

> **`app/hooks` is the only layer importing `@useparley/core`.** Everything
> below is testable with plain props.
> (`docs/spec/ui-component-system.md` contract 4;
> `packages/ui/src/app/hooks/index.ts:2–4`)

Verified: every `@useparley/core` import under `packages/ui/src` is inside
`app/hooks/` (roster, inbox, scene, inspector, useSnapshot, useCockpit,
metrics, …). Hud imports tokens only (`stateMetaFor`, `ATTENTION_DISPLAY_ORDER`,
factions).

**Can `tokens/state-meta.ts` import `ATTENTION_ORDER`?** No — not without
breaking contract 4. Tokens is layer 0; it is below hooks. Importing core
there would make the tokens barrel (and every hud consumer of state-meta) a
core client, undoing "everything below hooks is plain-props testable" in the
strong form the kit band currently relies on (zero props, pure token data —
`KitBand.tsx:12–13`).

**Does the contract move up a level?** Not for this deepening. Options for the
legend order:

| Option | Verdict |
| --- | --- |
| A. Keep `ATTENTION_DISPLAY_ORDER` literal + `state-legend-order.test.ts` equality guard | **Recommended for v1 of this work.** Cost is already paid; failure mode is loud. Orthogonal to identity duplication. |
| B. Tokens import core's `ATTENTION_ORDER` | Reject — breaks contract 4. |
| C. Delete tokens order; pass `ATTENTION_ORDER` as props from Cockpit into `KitBand` / `ChartKey` | Viable later; larger API change for a static style-guide strip that takes "no props at all" today. Not required to land `toDisplayTask`. |
| D. Re-export order from hooks and have hud import hooks | Reject — inverts layer direction (hud must not depend on hooks). |

**What `toDisplayTask` should own regarding attention:** the ticket's
"owning … attention order" is best read as *consuming core order for any
display-rank helpers colocated with identity*, not as *moving the kit-band
literal into the identity module*. Functional grouping/sort already uses
`attentionRank` in roster/inbox/scene (`roster.ts:16`, `inbox.ts:16`,
`scene.ts:24`). That stays in the layout projectors (or a tiny shared
`displayAttentionRank` already on roster — `roster.ts` exports it). The
hand-sync in `state-meta.ts:139–149` is a **separate, smaller** concern;
this proposal leaves it in place with its test guard unless a follow-up
explicitly wants option C.

## 3. Proposed interface

### Module

- **Path:** `packages/ui/src/app/hooks/displayTask.ts`
- **Barrel:** re-export from `packages/ui/src/app/hooks/index.ts`
- **Depends on:** `tokens/factions.js` (`modelVendorFor`, `harnessColorFor`,
  `EmblemMark`), `./roster.js` (`shortId`, `RosterTaskInput` type only)
- **Does not depend on:** React, SSE, `@useparley/core` (unless a future
  helper needs `attentionRank` — prefer keeping rank helpers in roster/scene)

### TypeScript sketch (illustrative)

```ts
// packages/ui/src/app/hooks/displayTask.ts
import { harnessColorFor, modelVendorFor, type EmblemMark } from "../../tokens/factions.js";
import { shortId, type RosterTaskInput } from "./roster.js";

/** Shared visual identity every Cove surface can paint a task with. */
export interface DisplayIdentity {
  coat: string;
  coatDark: string;
  emblem: EmblemMark;
  /** e.g. "GPT via Codex" — accessible label / tooltip copy. */
  faction: string;
  /** e.g. "feat/x · a1b2c3d4" */
  meta: string;
}

/**
 * Project wire/plain task fields into display identity.
 * Single emit for coat / emblem / faction / meta.
 */
export function toDisplayTask(
  task: Pick<RosterTaskInput, "model" | "vendor" | "branch" | "id">,
): DisplayIdentity {
  const vendor = modelVendorFor(task.model, task.vendor);
  const harness = harnessColorFor(task.vendor);
  return {
    coat: harness.coat,
    coatDark: harness.coatDark,
    emblem: vendor.emblem,
    faction: `${vendor.label} via ${harness.label}`,
    meta: `${task.branch ?? "no branch"} · ${shortId(task.id)}`,
  };
}
```

Inspector input is not `RosterTaskInput` today (`projectInspector` reads
`TaskDetailResponse`). Keep the argument as a **narrow pick** of the fields
actually used (`model`, `vendor`, `branch`, `id`) so both the fleet list and
the detail envelope can call the same function without a second adapter:

```ts
// inspector.ts (call site sketch)
const identity = toDisplayTask({
  id: task.task_id,
  model: task.model,
  vendor: task.vendor,
  branch: task.branch,
});
// spread identity into InspectorTask header fields
```

### Call graph

```
useSnapshot
  ├─ fromRow / mergeEnvelope  → RosterTaskInput[]
  ├─ projectRoster(tasks)     → toDisplayTask per visible task → RosterTask
  ├─ projectInbox(tasks)      → toDisplayTask per blocked task → InboxTask
  └─ projectScene(tasks)      → toDisplayTask per task → SceneTask (pick fields)

useCockpit
  └─ projectInspector(detail) → toDisplayTask({ id: task_id, … }) → header fields
                                 + projectReport / projectQa / … (unchanged)

hud/*  — still receives plain RosterTask | InboxTask | InspectorTask
scene/* — still receives SceneTask / SceneView
tokens/* — unchanged lookups; ATTENTION_DISPLAY_ORDER stays
```

### Layout projectors after the shrink

```ts
// roster.ts — layout only (+ freshness)
function toRosterTask(task: RosterTaskInput, freshness: …): RosterTask {
  const d = toDisplayTask(task);
  return {
    id: task.id,
    name: task.name,
    coat: d.coat,
    emblem: d.emblem,
    faction: d.faction,
    meta: d.meta,
    freshFailure: task.state === "failed" ? isFreshFailure(…) : undefined,
  };
}

// inbox.ts
return blocked.map((task) => {
  const d = toDisplayTask(task);
  return {
    id: task.id,
    name: task.name,
    state: task.state,
    coat: d.coat,
    emblem: d.emblem,
    faction: d.faction,
    meta: d.meta,
    question: task.question,
    sessionId: task.orchestratorSession,
  };
});

// scene.ts
function toSceneTask(task: RosterTaskInput): SceneTask {
  const d = toDisplayTask(task);
  return {
    id: task.id,
    name: task.name,
    state: task.state,
    coat: d.coat,
    coatDark: d.coatDark,
    emblem: d.emblem,
  };
}
```

### Optional `hud/types.ts` documentation slice

```ts
// packages/ui/src/hud/types.ts — documentation / structural base only
/** Fields produced by hooks `toDisplayTask`; views pick what they need. */
export interface DisplayIdentity {
  coat: string;
  coatDark: string;
  emblem: EmblemMark;
  faction: string;
  meta: string;
}

// RosterTask keeps omitting coatDark if the panel never reads it:
export interface RosterTask {
  id: string;
  name: string;
  coat: string;
  emblem: EmblemMark;
  faction: string;
  meta: string;
  freshFailure?: boolean;
}
```

Duplicating the interface in hooks + hud is acceptable if we want hud free of
importing hooks types (hud must not import hooks). Prefer: define
`DisplayIdentity` in `hud/types.ts` (plain props world) and have
`toDisplayTask` return that type — same pattern as `RosterTask` today
(defined in hud, constructed in hooks).

**Final placement of the type:** `packages/ui/src/hud/types.ts` exports
`DisplayIdentity`; `displayTask.ts` imports it and returns it. Hooks build;
hud declares. Matches existing `RosterTask` / `InboxTask` ownership.

## 4. Test-surface sketch

### What becomes testable in-process that was weak before

- **Single-source identity:** one unit file can lock coat/emblem/faction/meta
  (and coatDark) for a matrix of `(model, vendor, branch, id)` without going
  through three projectors and comparing them pairwise.
- **Cross-view agreement** already partially exists for *state* strings
  (`packages/ui/tests/scene-projection.test.ts` "scene / roster / inbox agree
  on state"). After the change, the same style of test can assert **coat /
  emblem / faction** agreement by construction (all three call
  `toDisplayTask`) — regression tests become "layout still passes fields
  through," not "three copies still match."
- **Inspector header** can share the same fixtures as roster/inbox (today
  `inspector-projection.test.ts` re-asserts faction strings independently).

### Proposed tests

| File | Kind | Focus |
| --- | --- | --- |
| `packages/ui/tests/display-task.test.ts` (**new**) | unit | `toDisplayTask` matrix: known vendors, unknown harness → white coat, null branch → `"no branch"`, shortId truncation, coatDark present |
| `packages/ui/tests/roster-projection.test.ts` | unit (existing) | Drop redundant identity asserts if any; keep grouping, session filter, freshness |
| `packages/ui/tests/inbox-projection.test.ts` | unit (existing) | Keep filter/sort; identity via shared module |
| `packages/ui/tests/scene-projection.test.ts` | unit (existing) | Keep geography + attention rollup; agreement tests can import `toDisplayTask` or simply rely on shared emit |
| `packages/ui/tests/inspector-projection.test.ts` | unit (existing) | Header fields still match `toDisplayTask` for the same model/vendor |
| `packages/ui/tests/task-identity.test.ts` | unit (existing) | Stays on `modelVendorFor` / `harnessColorFor` token lookups — not replaced |
| `packages/ui/tests/state-legend-order.test.ts` | unit (existing) | **Unchanged** while option A holds |

### Unit vs integration

- **Unit (no DOM, no SSE):** all of the above. Projectors remain pure functions
  over plain objects — the main win of this deepening.
- **Integration / component tests** (`roster-panel`, `inbox-panel`, scene
  renders): no new requirement; they already take plain hud props. Optionally
  one agreement test at the `useSnapshot` level is unnecessary if pure
  projectors share `toDisplayTask`.

Do **not** require a browser or daemon for this work.

## 5. Migration plan

Ordered for small, reviewable steps. Blast radius is UI-package-local;
daemon/CLI/core wire shapes untouched.

| Step | Change | Blast radius | Deletes |
| --- | --- | --- | --- |
| 1 | Add `DisplayIdentity` to `hud/types.ts` + `toDisplayTask` in `hooks/displayTask.ts` with unit tests | additive only | nothing |
| 2 | Switch `toRosterTask` to `toDisplayTask` | roster projection + its tests | local vendor/harness block in `roster.ts:161–170` |
| 3 | Switch `projectInbox` map body | inbox projection + tests | duplicate block in `inbox.ts:32–41` |
| 4 | Switch `toSceneTask` | scene projection + tests | duplicate block in `scene.ts:123–131` |
| 5 | Switch `projectInspector` header | inspector projection + tests | duplicate block in `inspector.ts:114–122` |
| 6 | Barrel export from `hooks/index.ts`; grep for leftover `modelVendorFor` in projectors (should remain only in `displayTask.ts` + token tests + KitBand harness swatches) | import graph | three (four) copy sites |
| 7 | *(optional follow-up)* KitBand order via props (option C) | hud kit/chart APIs | `ATTENTION_DISPLAY_ORDER` literal if replaced |

**Out of scope / not deleted:**

- `tokens/factions.ts` lookups (still the registry)
- `STATE_META` / `stateMetaFor` (still render-time badge source)
- `ATTENTION_DISPLAY_ORDER` + drift test (step 7 only)
- `RosterTaskInput`, session grouping, freshness window, scene geography

**Risk control:** each of steps 2–5 is independently shippable; behavior
should be byte-identical for faction strings and coats if the helper is a
straight extract.

## 6. Risks and rejected alternatives

### Risks

1. **Silent field drift on purpose-built subsets** — scene drops `faction`/
   `meta`; roster drops `coatDark`. A future edit to `DisplayIdentity` might
   not update every consumer. Mitigation: structural typing + unit tests on
   `toDisplayTask`; layout tests only check fields they need.
2. **Inspector input shape** — detail envelope uses `task_id` not `id`.
   Mitigation: accept a pick of fields, not full `RosterTaskInput`.
3. **Over-centralising state chrome** — stuffing `stateMetaFor` into
   `toDisplayTask` would re-project pure token data on every SSE tick.
   Mitigation: identity only; badges stay token lookups at render.
4. **Contract 4 pressure** — any urge to "just import `ATTENTION_ORDER` in
   tokens" must be refused or replaced with option C, not a silent exception.
5. **False sense of finishing the ticket's "8+ files"** — understanding an
   island still spans tokens (what does GPT look like?) + displayTask (how
   is it composed?) + scene (where does it sit?). The win is *composition*
   locality, not a single file for all of Cove.

### Rejected alternatives

| Alternative | Why reject |
| --- | --- |
| Put `toDisplayTask` in `tokens/` | Breaks contract 4 if it owns core order; wrong layer for `shortId` / task picks; tokens become task-aware |
| One mega `DisplayTask` hud prop for all panels | Violates contract 2's "slice of the envelope"; over-delivers props; couples scene to inbox fields |
| Hud imports core for `ATTENTION_ORDER` | Breaks contract 4; kit band loses zero-deps purity |
| Generate `ATTENTION_DISPLAY_ORDER` at build time from core | Extra toolchain for a list of ~8 strings already test-guarded |
| Only dedupe roster+inbox, leave scene/inspector | Leaves the same string template alive; scene still duplicates lookups for coatDark |
| Move faction tables into hooks | Tables are pure token data (layer 0); kit band reads them without hooks |
| Conclude "not worth it" | **Rejected as overall outcome** — four near-identical emits and a clear extract with zero behavior change is cheap and matches the deletion test. The *legend hand-sync* alone would be "not worth a contract change"; the *identity triple/quadruple* is worth the module. |

### Worth-it verdict

**Yes — implement the shared identity projector in hooks; leave legend order
as the hand-synced literal for now.** Highest value per line deleted; no ADR
conflict; contracts 2/4/6 preserved.

## 7. Interactions with parallel exploration #208

**#208 (report envelope as wire contract)** is explored in parallel. This
proposal **consumes** task identity fields that today live on the same wire
objects as the report, but it does **not** project the report body.

### Shape this proposal assumes (explicit)

Until #208 lands, assume the **current** `@useparley/core` contract in
`packages/core/src/contract.ts` remains the wire truth:

- **`TaskEnvelope`** (`contract.ts:31–109`) carries at least:
  - identity / lifecycle: `task_id`, `name`, `vendor`, `model`, `branch`,
    `state`, `question`, `worktree`, …
  - nested **`report: Report | null`** where
    `Report = { summary, outcome, files_changed }` (`contract.ts:17–21`)
- **`TaskRow`** (list/bootstrap) carries the flat columns
  `useSnapshot.fromRow` already maps (`vendor`, `model`, `branch`,
  `orchestrator_session_id`, `question`, …) —
  `packages/ui/src/app/hooks/useSnapshot.ts:58–70`
- SSE transition payloads remain **pinned envelopes** (not full rows), so
  session id continues to be merged from prior snapshot state
  (`useSnapshot.ts:82–98`)

### What `toDisplayTask` reads vs what #208 may change

| Field | Used by `toDisplayTask`? | Likely #208 impact |
| --- | --- | --- |
| `model`, `vendor` | yes (emblem/coat) | Stable if envelope remains the UI task shape; only rename/move would force a pick-adapter tweak |
| `branch`, `task_id` / `id` | yes (meta line) | Same |
| `report.summary` / `outcome` / `files_changed` | **no** | #208's home turf; already projected only in `projectReport` (`inspector.ts:36–44`) → `ReportView` |
| `report_schema` | no | irrelevant to identity |
| posture / usage / duration | no | stay in brief projection |

### Assumptions (not invented outcomes)

1. **#208 will not remove `vendor` / `model` / `branch` from the task
   envelope or list row** without a replacement path. Identity projection is
   meaningless without them. If #208 relocates them, `toDisplayTask`'s
   argument pick is the single adapter to update (that is part of the win).
2. **Report body remains a nested object** (or a clearly named sibling) with
   at least outcome + summary + files list assignable to today's `ReportView`
   after a thin map. Display identity does not block on report schema work.
3. **Cove continues to project wire → plain hud props in hooks** (contracts 2
   and 4). #208 should not push envelope types into hud components; if it
   introduces a stricter Zod/JSON-schema export, hooks validate or trust the
   client types — `toDisplayTask` still sees plain strings.
4. **No dependency on #208 shipping first.** Steps 1–6 of §5 are valid on
   today's contract. After #208, re-run the citation audit only if field
   names move.

### Boundary summary

```
#208  →  tightens / documents report envelope (and possibly TaskEnvelope)
         as the versioned wire contract in core

#210  →  pure UI display-identity function over model/vendor/branch/id
         already available on that envelope/row

projectReport (inspector)  →  the only Cove consumer of report.* fields
toDisplayTask              →  never opens report.*
```

If #208 proposes a breaking rename (e.g. `files_changed` → `files`), only
`projectReport` and `ReportView` move — not `toDisplayTask`. If #208 proposes
splitting "lifecycle envelope" from "completion report" on the wire, this
design still holds as long as lifecycle fields remain available to
`useSnapshot` / `useTaskDetail`.

---

## Recommendation (one line)

Add `toDisplayTask` in `packages/ui/src/app/hooks/displayTask.ts` returning a
`DisplayIdentity` declared in `hud/types.ts`; point roster, inbox, scene, and
inspector header emits at it; leave `ATTENTION_DISPLAY_ORDER` hand-synced
under its existing test until a dedicated kit-band props pass is justified.
