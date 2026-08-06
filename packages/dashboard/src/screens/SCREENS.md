# Screen lane contract — Parley Console

Owned by **#354 (app shell & chrome)**. The four center-screen tickets build in
parallel; this file is the conflict fence.

## Global ownership (shell ticket — do not touch from screen tickets)

| Path | Owner | Notes |
| --- | --- | --- |
| `src/tokens.css` | #354 | Global tokens. Screens **consume** via `var(--*)` only. |
| `src/base.css` | #354 | Reset, focus, scrollbar. |
| `src/fonts.css` | #354 / #347 | Self-hosted faces. |
| `src/shell.css` | #354 | Board geometry, chrome, find, settings, skip links. |
| `src/Shell.tsx` | #354 | Frame composition. |
| `src/App.tsx`, `src/main.tsx` | #354 | Root + client bootstrap. |
| `src/chrome/**` | #354 | Header, nav, find, settings, footer, accelerators. |
| `src/data/**` | #352 | Extend via **new files only** if a projection is missing. |
| `index.html` | #354 | SPA shell. |
| `verify/lib/measure.mjs` `DEFAULT_SELECTORS` | #354 | Shell-owned. Screens **must not** edit it. |
| `verify/lib/contrast.mjs` | #354 | Shared contrast helper; screens may import. |

Screen tickets may **import** chrome types that are exported for them
(`ScreenId`, `ScreenMountProps`, settings helpers). They must not edit chrome
source or global CSS.

## Mount points (one directory per screen)

| Screen | Route id | Mount file | Ticket |
| --- | --- | --- | --- |
| Fleet board | `fleet` | `src/screens/fleet/FleetScreen.tsx` | #355 |
| Run detail | `run` | `src/screens/run/RunScreen.tsx` | #356 |
| Task inspector | `task` | `src/screens/task/TaskScreen.tsx` | #357 |
| Metrics | `metrics` | `src/screens/metrics/MetricsScreen.tsx` | #358 |

### What each screen ticket **may** create/edit

- Everything under its own directory: `src/screens/<name>/**`
- Screen-local CSS **inside that directory only** (prefix classes `pc-<name>-`)
- Unit/integration tests under `packages/dashboard/tests/` named for the screen
  (prefer own fixture files under `tests/<screen>/`; see fixtures rule below)
- Verify demos under `verify/demos/` and ledger under `verify/ledger/issue-NNN/`
  (via the registration protocol below)

### What each screen ticket **must not** touch

- `src/tokens.css`, `src/base.css`, `src/shell.css`, `src/fonts.css`
- `src/chrome/**`, `src/Shell.tsx`, `src/App.tsx` (except importing exported types)
- Another screen's directory
- `src/data/**` except additive new projection files with a note in the PR
- `packages/ui/**`, daemon/core source, package.json **dependencies** / lockfile
- `verify/lib/measure.mjs` `DEFAULT_SELECTORS` (pass your own `targets` instead)

## Props contract (shell → screen)

```ts
export type ScreenId = "fleet" | "run" | "task" | "metrics";

/** Real export name — use this, not ScreenProps. */
export interface ScreenMountProps {
  screen: ScreenId;
  navigate: (screen: ScreenId) => void;
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;
}
```

### Data-flow rule (decided)

**Screens fetch their own data.** Each screen constructs or receives a
`ParleyClient` the same way shell does (`new ParleyClient({ baseUrl: "" })`)
and calls `#352` hooks (`useSnapshot`, `useRuns`, `useTaskDetail`, …) itself.

The shell passes **only selection + navigation state** via `ScreenMountProps`.
It does **not** pass snapshot/health/honesty props. Screens must not re-open a
second SSE if they can share the same client instance later; for v1 parallel
tickets, same-origin `ParleyClient({ baseUrl: "" })` per screen is acceptable
and keeps lane isolation.

Shell mounts exactly one screen in `#main-content` (the center region).
Left/right rail content is screen territory once those tickets land; until then
shell leaves named empty slots for geometry proofs.

## Hash routing

Shell syncs `location.hash` as `#/fleet` | `#/run` | `#/task` | `#/metrics`.
Screen tickets must not introduce a second router.

---

## 1280 density decisions (shell chrome)

These are intentional floor-viewport tradeoffs, not accidents. Screens consume
the same breakpoints (`max-width: 1360px` media in `shell.css`) and must not
reintroduce the dropped chrome tokens without a new density plan.

### Attention chip label

At `max-width: 1360px`, `.pc-shell__attention-label` ("needs orch") is
`display: none`. Only the amber count remains visible.

**Decision: keep hiding.** Rationale:

- The count element carries `aria-label` (`N need the orchestrator`) and the
  chip container has `title="Tasks and gates that need the orchestrator"` —
  AT and hover still get the full meaning.
- Visible pixels at the 1280 floor are reserved for the number (primary
  signal) and the live/stream value; the label is secondary chrome.
- Same pattern as `.pc-shell__live-status-label` and tab-sub.

### Footer doctrine note

Mock copy: `state = what a task IS · quality = how good work WAS · N unacked events`.

- **≥1460**: full doctrine string + live unacked count + honesty phase.
- **≤1360 (1280 floor)**: compact `state=IS · quality=WAS · N unacked · {phase}`
  so the state-vs-quality vocabulary lesson survives at every width.
- Footer flex: legend is `flex: 1 1 auto; min-width: 0` (shrinks first);
  note+meta row is `flex: 0 0 auto` (never shrinks). Gate proves
  `scrollWidth <= clientWidth` **with** the doctrine text present.

---

## Shared-file registration protocol

These five files are **shared** across shell + screen tickets. Editing them
without a protocol is how parallel agents collide. Rules:

### 1. `verify/demos/registry.mjs` (source of truth for runners)

Every demo registers here as one entry:

```js
{ ticket: "issue-355", id: "fleet-board", run: runFleetBoardDemo }
```

- **Shell-owned demos** (`issue-353`, `issue-354`) stay at the top.
- **Screen tickets append only** their entries (do not reorder or delete others).
- `run-all.mjs` and `check.mjs` **import this registry** — they do not hard-code
  demo lists beyond reading the registry.

### 2. `verify/check.mjs` `TICKETS` map + `gates`

Derived from the registry (group by `ticket` → list of demo `id`s). Screen
tickets do not hand-edit a parallel map; they add a registry entry and the
check picks it up.

Ticket-specific merge gates live on the registry entry, not in `check.mjs`:

```js
{
  ticket: "issue-355",
  id: "fleet-board",
  run: runFleetBoardDemo,
  gates: (entry, ledgerEntry) => {
    // throw if ledger proofs fail screen-specific invariants
  },
}
```

`check.mjs` calls `entry.gates(entry, ledgerEntry)` when present. Do **not**
add `if (ticket === "issue-NNN")` branches in check.mjs.

### 3. `verify/demos/run-all.mjs`

Runs `registry` entries in order. No manual renumbering of "demo 4/5".

### 4. `package.json` `verify:*` scripts

Screen tickets **may** add a script:

```json
"verify:fleet": "node --import tsx verify/demos/fleet-board.mjs"
```

Do not rename or remove existing `verify`, `verify:check`, `verify:shell`,
`verify:find`, or #353 scripts. Do not change `dependencies` / lockfile.

### 5. `verify/lib/measure.mjs` `DEFAULT_SELECTORS`

**Shell-owned.** Screens pass their own selector list:

```js
await measureAtViewports(page, {
  url,
  shotDir,
  shotPrefix: "fleet",
  targets: MY_FLEET_SELECTORS, // not DEFAULT_SELECTORS
});
```

The measure API already accepts `opts.targets`. If you need a shared helper for
a screen-family selector set, put it in `verify/lib/selectors-<screen>.mjs` —
never edit `DEFAULT_SELECTORS`.

### 6. `tests/fixtures.ts`

**Additive-only-at-end** for cross-cutting helpers. Prefer:

```
tests/fleet/fixtures.ts
tests/run/fixtures.ts
```

Do not rewrite existing exports in `tests/fixtures.ts`. If you must extend a
shared envelope helper, append new named exports only.

---

## Verify demo file naming

| Ticket | Demo file | Ledger dir |
| --- | --- | --- |
| #353 harness | `staged-daemon.mjs`, `intercept-error.mjs`, `reconnect.mjs` | `issue-353` |
| #354 shell | `shell-chrome.mjs`, `find-honesty.mjs` | `issue-354` |
| #355 fleet | `fleet-board.mjs` (suggested) | `issue-355` |
| #356 run | `run-detail.mjs` | `issue-356` |
| #357 task | `task-inspector.mjs` | `issue-357` |
| #358 metrics | `metrics-board.mjs` | `issue-358` |
