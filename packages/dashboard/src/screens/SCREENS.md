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

Screen tickets may **import** chrome types/hooks that are exported for them
(e.g. `ScreenId`, settings, selected-entity props). They must not edit chrome
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
- Screen-local CSS modules or `*.css` **inside that directory only**
  (class names must be prefixed `pc-<name>-` to avoid collisions)
- Unit/integration tests under `packages/dashboard/tests/` named for the screen
- Verify ledger demos under `verify/ledger/issue-NNN/` and optional demo scripts
  under `verify/demos/` (append-only; do not rewrite other tickets' demos)

### What each screen ticket **must not** touch

- `src/tokens.css`, `src/base.css`, `src/shell.css`, `src/fonts.css`
- `src/chrome/**`, `src/Shell.tsx`, `src/App.tsx` (except importing exported types)
- Another screen's directory
- `src/data/**` except additive new projection files with a note in the PR
- `packages/ui/**`, daemon/core source, package.json deps / lockfile

## Props contract (shell → screen)

```ts
export type ScreenId = "fleet" | "run" | "task" | "metrics";

export interface ScreenProps {
  /** Active screen id (the mounted component matches this). */
  screen: ScreenId;
  /** Navigate to another screen; shell owns the tablist. */
  navigate: (screen: ScreenId) => void;
  /** Selected task id (find combobox / attention / fleet row). */
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
  /** Selected run id (run tab / find / fleet). */
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;
  /** Live task snapshot + honesty from #352 — do not re-bootstrap SSE. */
  // Screens receive data via their own hooks using the shared client pattern,
  // or via props when the shell already holds selection state.
}
```

Shell mounts exactly one screen in `.pc-shell__center` (`#main-content`).
Left-rail filter/nav lists and the right-rail attention/firehose are **screen
territory** once those tickets land; until then the shell leaves rail slots as
named empty regions (`data-testid="rail-left"`, `data-testid="rail-right"`)
so geometry proofs stay stable. Screen tickets that need rail content should
coordinate through Shell composition only if a follow-up explicitly expands
the mount API — default is center-only.

## Hash routing

Shell syncs `location.hash` as `#/fleet` | `#/run` | `#/task` | `#/metrics`
(optional `?task=` / `?run=` query on the hash path is reserved for later).
Screen tickets must not introduce a second router.
