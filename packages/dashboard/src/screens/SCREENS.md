# Screen lane contract — Parley Console

Owned by **#354 (app shell & chrome)**; shared component layer by **#367**.
The four center screens share one client and one component kit.

## Global ownership (shell + shared layer)

| Path | Owner | Notes |
| --- | --- | --- |
| `src/tokens.css` | #354 / #367 | Global tokens. Screens **consume** via `var(--*)` only. Hex and literal `font:` shorthands are banned outside this file (CI: `scripts/lint-tokens.mjs`). |
| `src/base.css` | #354 | Reset, focus, scrollbar. |
| `src/fonts.css` | #354 / #347 | Self-hosted faces. |
| `src/shell.css` | #354 | Board geometry, chrome, find, settings, skip links. |
| `src/Shell.tsx` | #354 / #367 | Frame composition; **sole** `new ParleyClient` site. |
| `src/App.tsx`, `src/main.tsx` | #354 | Root + client bootstrap. |
| `src/chrome/**` | #354 | Header, nav, find, settings, footer, accelerators. |
| `src/components/**` | #367 / #363 | Shared Panel, StateChip, CopyScaffold, Field/Select, AttentionCard. |
| `src/data/**` | #352 / #367 / #363 | Data hooks + `ConsoleDataProvider` + `usePolling` + attention rank + firehose feed. Extend via **new files only** if a projection is missing. |
| `src/chrome/LeftRail.tsx`, `RightRail.tsx`, `attentionItems.ts` | #363 | Shell rails: scope/state/burn · attention queue + firehose. |
| `index.html` | #354 | SPA shell. |
| `verify/lib/measure.mjs` `DEFAULT_SELECTORS` | #354 | Shell-owned. Screens **must not** edit it. |
| `verify/lib/contrast.mjs` | #354 | Shared contrast helper; screens may import. |

Screen tickets may **import** chrome types and shared components. They must not
edit chrome source, global CSS (except via the token-promotion path below), or
re-implement shared components.

## Shared component layer (#367)

Registered owned territory under `src/components/`:

| Component | Role |
| --- | --- |
| `Panel` | Header strip (uppercase label + faint meta) + body; optional honesty phase |
| `StateChip` | 7px square dot + uppercase mono label; one visual for a given state on every screen |
| `CopyScaffold` | Bordered mono copy control (the console's only "verb") |
| `Field` / `Select` | Register-styled controls (≥24px height; no `appearance: auto`) |
| `AttentionCard` | 2px state-color left rule, badge + age, title, reason, meta; rows variant (#363) |

### Extension path

1. Add or extend a component under `src/components/` (plus styles in
   `components.css`).
2. Export it from `src/components/index.ts`.
3. Prefer new CSS custom properties in `src/tokens.css` over literals.
4. Screens **import** the shared export — they do not copy the implementation
   into `src/screens/<name>/`.
5. Unit tests live under `packages/dashboard/tests/components/`.

`AttentionCard` and shell rail content landed with #363.

### Token / type lint

- Zero literal `font:` shorthands and zero hard-coded hex colors outside
  `tokens.css` in screen/chrome CSS.
- Enforced by `packages/dashboard/scripts/lint-tokens.mjs` (root `pnpm lint` and
  the unit suite).

## Mount points (one directory per screen)

| Screen | Route id | Mount file | Ticket |
| --- | --- | --- | --- |
| Fleet board | `fleet` | `src/screens/fleet/FleetScreen.tsx` | #355 |
| Run detail | `run` | `src/screens/run/RunScreen.tsx` | #356 |
| Task inspector | `task` | `src/screens/task/TaskScreen.tsx` | #357 |
| Metrics | `metrics` | `src/screens/metrics/MetricsScreen.tsx` | #358 |

### What each screen ticket **may** create/edit

- Everything under its own directory: `src/screens/<name>/**` (presentational
  logic, screen-local layout CSS with class prefix `pc-<name>-`)
- Unit/integration tests under `packages/dashboard/tests/` named for the screen
  (prefer own fixture files under `tests/<screen>/`; see fixtures rule below)
- Verify demos under `verify/demos/` and ledger under `verify/ledger/issue-NNN/`
  (via the registration protocol below)

### What each screen ticket **must not** touch

- `src/tokens.css`, `src/base.css`, `src/shell.css`, `src/fonts.css` except
  additive token promotions coordinated with #367 rules
- `src/chrome/**`, `src/Shell.tsx`, `src/App.tsx` (except importing exported types)
- `src/components/**` without following the extension path above
- Another screen's directory
- `src/data/**` except additive new projection files with a note in the PR
- `packages/ui/**`, daemon/core source, package.json **dependencies** / lockfile
- `verify/lib/measure.mjs` `DEFAULT_SELECTORS` (pass your own `targets` instead)
- Constructing a second `ParleyClient` or re-opening a second SSE/snapshot

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

### Data-flow rule (decided — #367)

**The shell owns the single `ParleyClient` and the shared snapshot / health /
runs poll.** It constructs the client once (`new ParleyClient({ baseUrl: "" })`),
runs `useSnapshot` / `useHealth` / `useRuns`, and provides them via
`ConsoleDataProvider`.

Screens call `useConsoleData()` / `useParleyClient()` and may run
**screen-specific** hooks (`useTaskDetail`, `useLogTail`, `useMetrics`,
`useRunners`, …) against that client. Screens must **not** construct a client or
a second snapshot SSE.

All interval polling goes through `usePolling` (or the same visibility pattern)
so nothing polls while `document.hidden` is true.

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
